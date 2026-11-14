import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { MessengerStore, MAX_LIST_LIMIT, approvalDocWarning } from '../messenger-store.js'
import { MessengerWatch } from '../messenger-watch.js'
import { validateAttachment, parseMultipartAttachment, MAX_ATTACHMENT_BYTES } from '../messenger-attachments.js'
import { messengerRoles } from '../messenger-roles.js'

export interface MessengerOptions {
  dbPath?: string; now?: () => number; dashboardUrl?: string; tokensFile?: string
  /** Folder the API writes wakes into; defaults to NAIA_MESSENGER_WAKE_SPOOL_DIR or wake-spool next to the DB. */
  wakeSpoolDir?: string
  /** Total bytes one uploader may keep; defaults to NAIA_MESSENGER_UPLOAD_QUOTA_BYTES or 500 MB. */
  uploadQuotaBytes?: number
  /** How often an open agent SSE stream re-checks its token. */
  identityRecheckMs?: number
  /** Shared with /api/portal; set to false when the messenger cannot start. */
  status?: { enabled: boolean }
}
const DEFAULT_UPLOAD_QUOTA_BYTES = 500 * 1024 * 1024
const ORPHAN_UPLOAD_MS = 24 * 3600_000
/** NAIA_MESSENGER_ENABLED=0 (or false/off) leaves every messenger route and the response watch unregistered. */
export function messengerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off)$/i.test((env.NAIA_MESSENGER_ENABLED ?? '').trim())
}
// Same shape as the login gate's account names; the display name is never an identity.
const ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{1,31}$/
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), {statusCode})

export const portalMessengerRoutes: FastifyPluginAsync<MessengerOptions> = async (app, opts) => {
  const root = (app as any).adkRoot as string
  const dbPath = opts.dbPath ?? process.env.NAIA_MESSENGER_DB ?? path.join(root, 'data-company/messenger/messenger.db')
  const now = opts.now ?? Date.now
  const wakeSpoolDir = opts.wakeSpoolDir ?? (process.env.NAIA_MESSENGER_WAKE_SPOOL_DIR || path.join(path.dirname(dbPath), 'wake-spool'))
  let store: MessengerStore
  let watch: MessengerWatch
  // A messenger that cannot create its DB or spool (read-only root, missing drop-in) answers 503
  // and reports itself off on /api/portal; the rest of the API still starts.
  try {
    store = new MessengerStore(dbPath, opts.now)
    if (store.permissionWarning) app.log.warn({ dbPath }, store.permissionWarning)
    const docWarning = approvalDocWarning()
    if (docWarning) app.log.warn(docWarning)
    try {
      fs.mkdirSync(wakeSpoolDir, { recursive: true, mode: 0o700 })
      fs.accessSync(wakeSpoolDir, fs.constants.W_OK)
      watch = new MessengerWatch(store, wakeSpoolDir, opts.now, opts.dashboardUrl ?? process.env.NAIA_DASHBOARD_PUBLIC_URL ?? 'http://localhost:3242')
      store.db.exec('CREATE TABLE IF NOT EXISTS messenger_upload_owners(attachment_id TEXT PRIMARY KEY REFERENCES attachments(id), author_id TEXT NOT NULL, author_kind TEXT NOT NULL, created_at INTEGER)')
      if (!store.db.prepare('PRAGMA table_info(messenger_upload_owners)').all().some((column:any)=>column.name==='created_at')) {
        // Earlier uploads have no time; give them a full grace period from this start.
        store.db.exec('ALTER TABLE messenger_upload_owners ADD COLUMN created_at INTEGER')
        store.db.prepare('UPDATE messenger_upload_owners SET created_at=? WHERE created_at IS NULL').run(now())
      }
    } catch (error) { store.close(); throw error }
  } catch (error: any) {
    app.log.warn({ code: error?.code, dbPath, wakeSpoolDir, message: String(error?.message ?? error) }, 'Messenger disabled: initialization failed (set NAIA_MESSENGER_DB to a writable path)')
    if (opts.status) opts.status.enabled = false
    const unavailable = async (_req: FastifyRequest, reply: any) => reply.code(503).send({ error: 'Messenger unavailable' })
    app.all('/', unavailable)
    app.all('/*', unavailable)
    return
  }
  const streams = new Set<ServerResponse>()
  const stopStreams = () => {for (const stream of streams) stream.end();streams.clear()}
  app.server.on('messengerShutdown',stopStreams)
  const attachmentDir = path.join(path.dirname(dbPath), 'attachments')
  const envQuota = Number(process.env.NAIA_MESSENGER_UPLOAD_QUOTA_BYTES)
  const uploadQuota = opts.uploadQuotaBytes ?? (Number.isSafeInteger(envQuota) && envQuota > 0 ? envQuota : DEFAULT_UPLOAD_QUOTA_BYTES)
  const removeOrphanUploads = () => {
    const stale = store.db.prepare('SELECT a.id,a.path FROM attachments a LEFT JOIN messenger_upload_owners o ON o.attachment_id=a.id WHERE a.message_id IS NULL AND COALESCE(o.created_at,0)<?').all(now()-ORPHAN_UPLOAD_MS) as any[]
    for (const file of stale) {
      try { fs.unlinkSync(String(file.path)) } catch (error:any) { if (error?.code !== 'ENOENT') { app.log.error(error,'Messenger orphan upload removal failed'); continue } }
      store.db.prepare('DELETE FROM messenger_upload_owners WHERE attachment_id=?').run(file.id)
      store.db.prepare('DELETE FROM attachments WHERE id=? AND message_id IS NULL').run(file.id)
    }
  }
  removeOrphanUploads()
  const displayName = (req: FastifyRequest): string | undefined => {
    const raw = req.headers[(process.env.NAIA_NOTE_USER_HEADER || 'x-ax-user').toLowerCase()]
    if (typeof raw !== 'string' || !raw || raw.includes(',')) return undefined
    try {
      const name = decodeURIComponent(raw).trim()
      return name && name.length <= 128 && !/[\x00-\x1f\x7f]/.test(name) ? name : undefined
    } catch { return undefined }
  }
  const identity = (req: FastifyRequest) => {
    const token = req.headers['x-ax-agent-token']
    if (token !== undefined) {
      if (typeof token !== 'string' || !token || token.includes(',')) throw failure(401, 'Invalid agent token')
      const tokenPath = opts.tokensFile ?? process.env.NAIA_MESSENGER_AGENT_TOKENS_FILE
      let roles: Record<string,string> = {}
      try { if (tokenPath) roles = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) } catch { throw failure(503, 'Agent authentication unavailable') }
      const role = roles[crypto.createHash('sha256').update(token).digest('hex')]
      if (typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(role)) throw failure(401, 'Invalid agent token')
      return {id:role,kind:'agent' as const}
    }
    const trust = (req as any).trust
    if (!trust?.trusted || !trust?.secretValid || (req.method !== 'GET' && !trust.originOk)) throw failure(403, 'Trusted dashboard required')
    // Only the dashboard writes x-naia-*, and it writes this mark only when the login gate's secret matched.
    if (req.headers['x-naia-gate-verified'] !== '1') throw failure(401, 'Login gate required')
    const account = req.headers['x-ax-account-key']
    if (typeof account !== 'string' || !ACCOUNT_KEY_RE.test(account)) throw failure(401, 'Human identity required')
    return {id:account,kind:'human' as const,name:displayName(req)}
  }
  app.addHook('preHandler', async req => {
    const who = identity(req)
    ;(req as any).messengerActor = who
    if (who.kind === 'human' && who.name) store.rememberHumanName(who.id,who.name)
    const params = req.params as any
    if (params?.id) {
      const channelId = req.routeOptions.url?.includes('/channels/') ? params.id :
        (store.message(params.id,who)?.channel_id ?? (store.db.prepare('SELECT m.channel_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=?').get(params.id) as any)?.channel_id)
      if (channelId && !store.canAccess(channelId,who)) throw failure(403,'Channel membership required')
    }
  })
  const actor = (req: FastifyRequest) => (req as any).messengerActor as {id:string,kind:'human'|'agent'}
  const id = (req: FastifyRequest) => (req.params as any).id as string
  const publish = (type:string,data:unknown) => store.addEvent(type,data)
  app.get('/channels', async req => store.channels(actor(req)))
  // The roles @mentions and DMs reach, so the dashboard offers the same list the server wakes.
  app.get('/roles', async req => { actor(req); return { roles: messengerRoles() } })
  app.get('/channels/:id/messages', async req => {
    const q = req.query as any
    const limit = q.limit === undefined ? 50 : Number(q.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw failure(400,'Invalid limit')
    return {messages:store.messages(id(req),actor(req),q.before,limit)}
  })
  app.post('/channels/:id/messages', {bodyLimit: 1024*1024}, async req => {
    const body = req.body as any
    if (!body || typeof body.body !== 'string' || (body.reply_to_id !== undefined && typeof body.reply_to_id !== 'string')) throw failure(400,'Invalid message')
    if (body.attachment_ids !== undefined) {
      if (!Array.isArray(body.attachment_ids) || body.attachment_ids.length > 20 || body.attachment_ids.some((value:unknown)=>typeof value !== 'string')) throw failure(400,'Invalid attachments')
      for (const attachmentId of body.attachment_ids) {
        const owner = store.db.prepare('SELECT o.*,a.message_id FROM messenger_upload_owners o JOIN attachments a ON a.id=o.attachment_id WHERE attachment_id=?').get(attachmentId) as any
        if (!owner || owner.author_id !== actor(req).id || owner.author_kind !== actor(req).kind || owner.message_id) throw failure(403,'Unattached upload owner required')
      }
    }
    // A message may be attachments only; the uploads were checked above.
    const message = store.createMessage(id(req),actor(req),body.body,body.reply_to_id,(body.attachment_ids?.length ?? 0) > 0)
    if (body.attachment_ids !== undefined) {
      for (const attachmentId of body.attachment_ids) store.db.prepare('UPDATE attachments SET message_id=? WHERE id=?').run(message.id,attachmentId)
    }
    watch.onMessage(message)
    const result = store.message(message.id,actor(req))!
    publish('message',result)
    const codes = result.body.match(/\b(PLAN-[A-Z0-9]{6})\s+(STEP-[A-Z0-9]{6})\b/)
    if (codes && !result.approval) {
      const form = store.db.prepare('SELECT a.message_id FROM approvals a JOIN messages m ON m.id=a.message_id WHERE m.channel_id=? AND m.author_id=? AND m.author_kind=? AND a.plan_code=? AND a.step_code=? ORDER BY m.id DESC LIMIT 1').get(result.channel_id,result.author_id,result.author_kind,codes[1],codes[2])
      if (form) publish('approval',store.message(String(form.message_id),actor(req)))
    }
    return result
  })
  app.post('/messages/:id/reactions', async req => {
    const emoji = (req.body as any)?.emoji
    if (typeof emoji !== 'string') throw failure(400,'Invalid emoji')
    store.react(id(req),actor(req),emoji)
    const message = store.message(id(req),actor(req))
    publish('reaction',message); return message
  })
  app.delete('/messages/:id/reactions', async req => {
    const emoji = (req.query as any)?.emoji
    if (typeof emoji !== 'string') throw failure(400,'Invalid emoji')
    store.react(id(req),actor(req),emoji,true)
    const message = store.message(id(req),actor(req))
    publish('reaction',message); return message
  })
  app.post('/channels/:id/read', async req => {
    const last = (req.body as any)?.last_message_id
    if (typeof last !== 'string') throw failure(400,'Invalid read cursor')
    store.markRead(id(req),actor(req),last)
    const data = {channel_id:id(req),reader_id:actor(req).id,reader_kind:actor(req).kind,last_message_id:last}
    publish('read',data); return data
  })
  app.post('/approvals/:id', async req => {
    const who = actor(req)
    if (who.kind !== 'human') throw failure(403,'Human approval required')
    const decision = (req.body as any)?.decision
    if (decision !== 'approve' && decision !== 'reject') throw failure(400,'Invalid decision')
    const result = store.decideApproval(id(req),who,decision)
    publish('approval',result.message)
    if (result.codeMessage) publish('message',result.codeMessage)
    return result.message
  })
  app.get('/alerts', async req => store.db.prepare("SELECT w.*,m.channel_id,m.body FROM watch_state w JOIN messages m ON m.id=w.message_id WHERE stage='alert30'").all().filter(row=>store.canAccess(String(row.channel_id),actor(req))))
  app.addContentTypeParser(/^multipart\/form-data/i,{parseAs:'buffer',bodyLimit:MAX_ATTACHMENT_BYTES+65536},(_req,body,done)=>done(null,body))
  app.post('/attachments',{bodyLimit:MAX_ATTACHMENT_BYTES+65536}, async req => {
    const {name,data} = parseMultipartAttachment(String(req.headers['content-type'] ?? ''),req.body as Buffer)
    const {mime,sha256} = validateAttachment(name,data)
    const messageId = (req.query as any)?.message_id ?? null
    if (messageId) {
      const message = store.message(messageId,actor(req)) as any
      if (!message || message.author_id !== actor(req).id || message.author_kind !== actor(req).kind) throw failure(403,'Attachment owner required')
    }
    removeOrphanUploads()
    const used = Number((store.db.prepare('SELECT COALESCE(sum(a.size),0) AS used FROM attachments a JOIN messenger_upload_owners o ON o.attachment_id=a.id WHERE o.author_id=? AND o.author_kind=?').get(actor(req).id,actor(req).kind) as any).used)
    if (used + data.length > uploadQuota) throw failure(413,'Upload quota exceeded')
    const attachmentId = crypto.randomUUID()
    fs.mkdirSync(attachmentDir,{recursive:true,mode:0o700})
    const target = path.join(attachmentDir,attachmentId)
    fs.writeFileSync(target,data,{flag:'wx',mode:0o600})
    store.db.prepare('INSERT INTO attachments(id,message_id,name,mime,size,sha256,path) VALUES(?,?,?,?,?,?,?)').run(attachmentId,messageId,name,mime,data.length,sha256,target)
    store.db.prepare('INSERT INTO messenger_upload_owners(attachment_id,author_id,author_kind,created_at) VALUES(?,?,?,?)').run(attachmentId,actor(req).id,actor(req).kind,now())
    // The CLI posts first and uploads after, so a live screen would otherwise keep the message without its file.
    if (messageId) publish('attachment',store.message(messageId,actor(req)))
    return {id:attachmentId,message_id:messageId,name,mime,size:data.length,sha256,url:`/api/portal/messenger/attachments/${attachmentId}`}
  })
  app.get('/attachments/:id', async (req,reply) => {
    const file = store.db.prepare('SELECT * FROM attachments WHERE id=?').get(id(req)) as any
    if (!file) throw failure(404,'Attachment not found')
    if (!file.message_id) {
      const owner = store.db.prepare('SELECT * FROM messenger_upload_owners WHERE attachment_id=?').get(file.id) as any
      if (!owner || owner.author_id !== actor(req).id || owner.author_kind !== actor(req).kind) throw failure(403,'Upload owner required')
    }
    reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).header('X-Content-Type-Options','nosniff').type(file.mime)
    return reply.send(fs.createReadStream(file.path))
  })
  app.get('/stream', async (req,reply) => {
    const last = req.headers['last-event-id'] ?? (req.query as any)?.last_event_id
    if (last !== undefined && (typeof last !== 'string' || !/^\d+$/.test(last) || !Number.isSafeInteger(Number(last)))) throw failure(400,'Invalid event cursor')
    // No cursor means "from now" (no history replay); a cursor past the newest event (new database) is clamped.
    const newest = store.lastEventId()
    const who = actor(req)
    reply.hijack()
    streams.add(reply.raw)
    reply.raw.once('close',()=>streams.delete(reply.raw))
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'})
    reply.raw.write(': connected\n\n')
    let cursor = last === undefined ? newest : Math.min(Number(last),newest)
    const flush = () => {
      for (const event of store.eventsAfter(cursor) as any[]) {
        cursor = Number(event.id)
        if (event.data?.channel_id && !store.canAccess(event.data.channel_id,who)) continue
        const data = ['message','reaction','approval','attachment'].includes(event.type) && event.data?.id ? store.message(event.data.id,who) : event.data
        reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`)
        cursor = Number(event.id)
      }
    }
    flush()
    const poll = setInterval(flush,250)
    const keepalive = setInterval(()=>reply.raw.write(': keepalive\n\n'),15000)
    // A revoked or reassigned agent token ends the open stream.
    const recheck = who.kind === 'agent' ? setInterval(()=>{
      let current: {id:string,kind:string} | undefined
      try { current = identity(req) } catch {}
      if (current?.id !== who.id || current?.kind !== who.kind) shutdown()
    },opts.identityRecheckMs ?? 5000) : undefined
    const cleanup = () => {clearInterval(poll);clearInterval(keepalive);if (recheck) clearInterval(recheck)}
    reply.raw.on('close',cleanup)
    const shutdown = () => {cleanup();reply.raw.end()}
    app.server.once('close',shutdown)
    reply.raw.once('close',()=>app.server.removeListener('close',shutdown))
  })
  const timer = setInterval(()=> {try {watch.tick()} catch(error) {app.log.error(error,'Messenger watch failed')}},15000)
  timer.unref()
  const orphanTimer = setInterval(()=> {try {removeOrphanUploads()} catch(error) {app.log.error(error,'Messenger orphan cleanup failed')}},3600_000)
  orphanTimer.unref()
  app.addHook('onClose',async ()=>{app.server.removeListener('messengerShutdown',stopStreams);clearInterval(timer);clearInterval(orphanTimer);store.close()})
}
