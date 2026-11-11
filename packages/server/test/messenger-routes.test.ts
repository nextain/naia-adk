import { describe,it,expect,afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer } from '../src/server.js'
// Fixture roles; a real install names its own in NAIA_MESSENGER_ROLES (default: naia).
process.env.NAIA_MESSENGER_ROLES = 'coder,planner,reviewer,writer,naia,designer'
// Approval documents must live on this dashboard.
process.env.NAIA_DASHBOARD_PUBLIC_URL = 'https://dashboard.example.com'
const cleanups: (()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0)) await cleanup()})
const hash=(token:string)=>crypto.createHash('sha256').update(token).digest('hex')
async function fixture(messenger:Record<string,unknown>={},tokens:Record<string,string>={'agent-test':'coder'},existingRoot?:string){
 const root=existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(),'messenger-route-'))
 const tokensFile=path.join(root,'tokens.json')
 const writeTokens=(map:Record<string,string>)=>fs.writeFileSync(tokensFile,JSON.stringify(Object.fromEntries(Object.entries(map).map(([token,role])=>[hash(token),role]))))
 writeTokens(tokens)
 const app=await createServer({root,port:3241,host:'127.0.0.1',messenger:{tokensFile,...messenger}})
 ;(app as any).proxySecret='fixture-secret'
 let closed=false
 app.addHook('onClose',async()=>{closed=true})
 await app.ready()
 cleanups.push(async()=>{if(!closed) await app.close();if(!existingRoot) fs.rmSync(root,{recursive:true,force:true})})
 const headers={host:'localhost:3241','x-naia-proxy-secret':'fixture-secret','x-naia-peer':'127.0.0.1','x-naia-local':'1','x-naia-origin-ok':'1','x-naia-gate-verified':'1','x-ax-account-key':'test-human'}
 const agent={host:'localhost:3241','x-ax-agent-token':'agent-test'}
 const url='/api/portal/messenger'
 const post=(body:string,h=headers)=>app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent('업무-요청')+'/messages',headers:h,payload:{body}})
 const upload=(name:string,text:string,h:Record<string,string>=headers)=>app.inject({method:'POST',url:url+'/attachments',headers:{...h,'content-type':'multipart/form-data; boundary=b0'},payload:Buffer.from(`--b0\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--b0--\r\n`)})
 return {app,headers,agent,url,post,root,upload,writeTokens}
}
// Reads an SSE response for a fixed window, optionally running an action once connected.
async function readStream(app:any,url:string,headers:Record<string,string>,ms:number,during?:(host:string)=>Promise<unknown>){
 const address=app.server.listening?`http://127.0.0.1:${app.server.address().port}`:await app.listen({port:0,host:'127.0.0.1'})
 const controller=new AbortController()
 const stream=await fetch(address+url+'/stream',{headers:{...headers,host:new URL(address).host},signal:controller.signal})
 const reader=stream.body!.getReader();let text='';let done=false
 const pump=(async()=>{try{for(;;){const chunk=await reader.read();if(chunk.done){done=true;return};text+=new TextDecoder().decode(chunk.value)}}catch{}})()
 await new Promise(resolve=>setTimeout(resolve,150))
 if(during) await during(new URL(address).host)
 await new Promise(resolve=>setTimeout(resolve,ms))
 const closedByServer=done
 controller.abort();await pump
 return {status:stream.status,text,closedByServer}
}
describe('messenger REST',()=>{
 it('writes, lists, reacts, reads and accepts 64000 characters',async()=>{
  const {app,headers,url,post}=await fixture()
  const response=await post('한'.repeat(64000));expect(response.statusCode).toBe(200)
  const message=response.json();expect(message.body.length).toBe(64000)
  expect((await post('a'.repeat(64001))).statusCode).toBe(400)
  const list=await app.inject({url:url+'/channels/'+encodeURIComponent('업무-요청')+'/messages',headers});expect(list.json().messages[0].id).toBe(message.id)
  const reaction=await app.inject({method:'POST',url:url+'/messages/'+message.id+'/reactions',headers,payload:{emoji:'👍'}})
  expect(reaction.json().reactions).toEqual([{emoji:'👍',count:1,mine:true}])
  expect((await app.inject({method:'DELETE',url:url+'/messages/'+message.id+'/reactions?emoji='+encodeURIComponent('👍'),headers})).json().reactions).toEqual([])
  expect((await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent('업무-요청')+'/read',headers,payload:{last_message_id:message.id}})).statusCode).toBe(200)
 })
 it('requires human approval, rejects plain messages and creates human code post',async()=>{
  const {app,headers,agent,url,post}=await fixture()
  const form='1. 제목: [배포] 조치\n2. 요약: 시험\n3. 문서: https://dashboard.example.com/d/test\n4. 승인 코드\nPLAN-ABC123 STEP-DEF456'
  const message=(await post(form,agent as any)).json();expect(message.author_kind).toBe('agent')
  expect((await app.inject({method:'POST',url:url+'/approvals/'+message.id,headers:agent,payload:{decision:'approve'}})).statusCode).toBe(403)
  expect((await app.inject({method:'POST',url:url+'/approvals/'+message.id,headers,payload:{decision:'approve'}})).json().approval.status).toBe('approved')
  const plain=(await post('ordinary')).json()
  expect((await app.inject({method:'POST',url:url+'/approvals/'+plain.id,headers,payload:{decision:'approve'}})).statusCode).toBe(400)
  const list=(await app.inject({url:url+'/channels/'+encodeURIComponent('업무-요청')+'/messages',headers})).json().messages
  expect(list.find((m:any)=>m.body==='PLAN-ABC123 STEP-DEF456').author_kind).toBe('human')
 })
 it('rejects anonymous and invalid agent identities even with human header',async()=>{
  const {app,url,headers}=await fixture()
  expect((await app.inject({url:url+'/channels',headers:{host:'localhost:3241'}})).statusCode).toBe(403)
  expect((await app.inject({url:url+'/channels',headers:{...headers,'x-ax-agent-token':'wrong'}})).statusCode).toBe(401)
 })
 it('uploads and downloads safely',async()=>{
  const {app,url,headers}=await fixture()
  const payload=Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--boundary--\r\n')
  const uploaded=await app.inject({method:'POST',url:url+'/attachments',headers:{...headers,'content-type':'multipart/form-data; boundary=boundary'},payload})
  expect(uploaded.statusCode).toBe(200)
  const downloaded=await app.inject({url:uploaded.json().url,headers})
  expect(downloaded.body).toBe('hello');expect(downloaded.headers['x-content-type-options']).toBe('nosniff');expect(downloaded.headers['content-disposition']).toContain('attachment')
 })
 it('opens an empty SSE stream before the first keepalive',async()=>{
  const {app,headers,url}=await fixture()
  const address=await app.listen({port:0,host:'127.0.0.1'})
  const controller=new AbortController()
  const timeout=setTimeout(()=>controller.abort(),3000)
  try {
   const stream=await fetch(address+url+'/stream',{headers:{...headers,host:new URL(address).host},signal:controller.signal})
   expect(stream.status).toBe(200)
   const reader=stream.body!.getReader()
   expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected')
   controller.abort()
  } finally { clearTimeout(timeout);controller.abort() }
 })
 it('recovers SSE events after Last-Event-ID',async()=>{
  const {app,headers,url,post}=await fixture()
  const first=(await post('first')).json();const second=(await post('second')).json()
  // Use an actual development listener to exercise streaming response and reconnect cursor.
  const address=await app.listen({port:0,host:'127.0.0.1'})
  const controller=new AbortController()
  const stream=await fetch(address+url+'/stream',{headers:{...headers,host:new URL(address).host,'Last-Event-ID':'1'},signal:controller.signal})
  expect(stream.status).toBe(200)
  const reader=stream.body!.getReader();const chunk=await reader.read();const text=new TextDecoder().decode(chunk.value)
  expect(text).toContain(second.id);expect(text).not.toContain(first.id);expect(text).toContain('event: message')
  controller.abort();await reader.cancel().catch(()=>{})
 })
 it('isolates DM lists, message reads and mutations from another human',async()=>{
  const {app,headers,agent,url}=await fixture()
  const other={...headers,'x-ax-account-key':'other-human'}
  const channels=(await app.inject({url:url+'/channels',headers})).json()
  const dm=channels.find((c:any)=>c.id==='dm:test-human:coder')
  expect(dm).toMatchObject({kind:'dm'})
  const privateUrl=url+'/channels/'+encodeURIComponent(dm.id)
  const form='1. 제목: [배포] 조치\n2. 요약: 시험\n3. 문서: https://dashboard.example.com/d/test\nPLAN-ABC123 STEP-DEF456'
  const created=await app.inject({method:'POST',url:privateUrl+'/messages',headers,payload:{body:form}})
  expect(created.statusCode).toBe(200)
  const message=created.json()
  expect(message.approval).toBeNull()
  expect((await app.inject({url:url+'/channels',headers:other})).json().some((c:any)=>c.id===dm.id)).toBe(false)
  expect((await app.inject({url:url+'/channels',headers:agent})).json().some((c:any)=>c.id===dm.id)).toBe(true)
  expect((await app.inject({url:privateUrl+'/messages',headers:agent})).json().messages[0].id).toBe(message.id)
  const forbidden=[
   {method:'GET' as const,url:privateUrl+'/messages'},
   {method:'POST' as const,url:privateUrl+'/messages',payload:{body:'intrusion'}},
   {method:'POST' as const,url:url+'/messages/'+message.id+'/reactions',payload:{emoji:'👍'}},
   {method:'DELETE' as const,url:url+'/messages/'+message.id+'/reactions?emoji='+encodeURIComponent('👍')},
   {method:'POST' as const,url:privateUrl+'/read',payload:{last_message_id:message.id}},
   {method:'POST' as const,url:url+'/approvals/'+message.id,payload:{decision:'approve'}}
  ]
  for(const request of forbidden) expect((await app.inject({...request,headers:other})).statusCode).toBe(403)
  const retained=(await app.inject({url:privateUrl+'/messages',headers})).json().messages
  expect(retained).toHaveLength(1)
  expect(retained[0]).toMatchObject({reactions:[],approval:null})
  expect((await app.inject({method:'POST',url:url+'/approvals/'+message.id,headers,payload:{decision:'approve'}})).statusCode).toBe(400)
 })
 it('binds uploaded attachment ids to a message and prevents stealing an unbound upload',async()=>{
  const {app,headers,url}=await fixture()
  const other={...headers,'x-ax-account-key':'other-human'}
  const payload=Buffer.from('--binding\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nattached text\r\n--binding--\r\n')
  const uploaded=await app.inject({method:'POST',url:url+'/attachments',headers:{...headers,'content-type':'multipart/form-data; boundary=binding'},payload})
  expect(uploaded.statusCode).toBe(200)
  const file=uploaded.json()
  const messageUrl=url+'/channels/'+encodeURIComponent('업무-요청')+'/messages'
  expect((await app.inject({url:file.url,headers:other})).statusCode).toBe(403)
  expect((await app.inject({method:'POST',url:messageUrl,headers:other,payload:{body:'stolen',attachment_ids:[file.id]}})).statusCode).toBe(403)
  const created=await app.inject({method:'POST',url:messageUrl,headers,payload:{body:'with attachment',attachment_ids:[file.id]}})
  expect(created.statusCode).toBe(200)
  expect(created.json().attachments).toEqual([expect.objectContaining({id:file.id,message_id:created.json().id,name:'note.txt',size:13})])
  const read=(await app.inject({url:messageUrl,headers})).json().messages
  expect(read).toHaveLength(1)
  expect(read[0].attachments[0].id).toBe(file.id)
  expect((await app.inject({url:file.url,headers:other})).body).toBe('attached text')
  expect((await app.inject({method:'POST',url:messageUrl,headers,payload:{body:'duplicate',attachment_ids:[file.id]}})).statusCode).toBe(403)
 })
 it('accepts an attachment-only message with an empty body, but not an empty body alone',async()=>{
  const {app,headers,url}=await fixture()
  const payload=Buffer.from('--only\r\nContent-Disposition: form-data; name="file"; filename="only.txt"\r\nContent-Type: text/plain\r\n\r\nonly\r\n--only--\r\n')
  const file=(await app.inject({method:'POST',url:url+'/attachments',headers:{...headers,'content-type':'multipart/form-data; boundary=only'},payload})).json()
  const messageUrl=url+'/channels/'+encodeURIComponent('자유')+'/messages'
  expect((await app.inject({method:'POST',url:messageUrl,headers,payload:{body:''}})).statusCode).toBe(400)
  expect((await app.inject({method:'POST',url:messageUrl,headers,payload:{body:'  ',attachment_ids:[]}})).statusCode).toBe(400)
  const created=await app.inject({method:'POST',url:messageUrl,headers,payload:{body:'',attachment_ids:[file.id]}})
  expect(created.statusCode).toBe(200)
  expect(created.json()).toMatchObject({body:'',attachments:[expect.objectContaining({id:file.id})]})
 })
 it('closes an active SSE connection when the application closes',async()=>{
  const {app,headers,url,post}=await fixture()
  await post('stream close test')
  const address=await app.listen({port:0,host:'127.0.0.1'})
  const controller=new AbortController()
  const stream=await fetch(address+url+'/stream',{headers:{...headers,host:new URL(address).host,'Last-Event-ID':'0'},signal:controller.signal})
  const reader=stream.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('stream close test')
  try {
   await app.close()
   expect(controller.signal.aborted).toBe(false)
   expect((await reader.read()).done).toBe(true)
  } finally {controller.abort();await reader.cancel().catch(()=>{})}
 },5000)

 it('starts a cursorless SSE stream at the newest event and clamps a future cursor',async()=>{
  const {app,headers,url,post}=await fixture()
  const old=(await post('old history')).json()
  let fresh:any
  const first=await readStream(app,url,headers,600,async host=>{fresh=(await post('fresh',{...headers,host})).json()})
  expect(first.text).not.toContain(old.id);expect(first.text).toContain(fresh.id)
  let later:any
  const future=await readStream(app,url,{...headers,'Last-Event-ID':'999999'},600,async host=>{later=(await post('after future cursor',{...headers,host})).json()})
  expect(future.text).toContain(later.id);expect(future.text).not.toContain(fresh.id)
 })
 it('separates human and agent members with the same name',async()=>{
  const {app,headers,url}=await fixture({}, {'agent-test':'coder','agent-owner':'test-human'})
  const dm='dm:test-human:coder'
  await app.inject({url:url+'/channels',headers})
  const posted=await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers,payload:{body:'private'}})
  expect(posted.statusCode).toBe(200)
  const humanCoder={...headers,'x-ax-account-key':'coder'}
  expect((await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:humanCoder})).statusCode).toBe(403)
  expect((await app.inject({url:url+'/channels',headers:humanCoder})).json().some((c:any)=>c.id===dm)).toBe(false)
  const agentNamedLikeHuman={host:'localhost:3241','x-ax-agent-token':'agent-owner'}
  expect((await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:agentNamedLikeHuman})).statusCode).toBe(403)
  expect((await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:{host:'localhost:3241','x-ax-agent-token':'agent-test'}})).statusCode).toBe(200)
 })
 it('limits total upload bytes per uploader with 413',async()=>{
  const {upload,headers}=await fixture({uploadQuotaBytes:20})
  expect((await upload('a.txt','0123456789abc')).statusCode).toBe(200)
  expect((await upload('b.txt','0123456789abc')).statusCode).toBe(413)
  expect((await upload('c.txt','0123456789abc',{...headers,'x-ax-account-key':'other-human'})).statusCode).toBe(200)
 })
 it('removes uploads left unattached for 24 hours, at quota time and at startup',async()=>{
  let time=Date.UTC(2026,10,9)
  const now=()=>time
  const {app,upload,url,headers,root}=await fixture({uploadQuotaBytes:20,now})
  const orphan=(await upload('a.txt','0123456789abc')).json()
  const attached=(await upload('k.txt','keep')).json()
  expect((await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent('자유')+'/messages',headers,payload:{body:'kept',attachment_ids:[attached.id]}})).statusCode).toBe(200)
  const dir=path.join(root,'data-company/messenger/attachments')
  time+=24*3600_000+1
  expect((await upload('b.txt','0123456789')).statusCode).toBe(200)
  expect(fs.existsSync(path.join(dir,orphan.id))).toBe(false)
  expect((await app.inject({url:orphan.url,headers})).statusCode).toBe(404)
  expect(fs.existsSync(path.join(dir,attached.id))).toBe(true)
  const pending=(await upload('c.txt','x')).json()
  await app.close()
  time+=24*3600_000+1
  const restarted=await fixture({now},undefined,root)
  expect(fs.existsSync(path.join(dir,pending.id))).toBe(false)
  expect(fs.existsSync(path.join(dir,attached.id))).toBe(true)
  expect((await restarted.app.inject({url:attached.url,headers})).statusCode).toBe(200)
 })
 it('creates approval cards only for dashboard.example.com forms in #업무-요청',async()=>{
  const {app,headers,agent,url}=await fixture()
  const form='1. 제목: [배포] 조치\n2. 요약: 시험\n3. 문서: https://dashboard.example.com/d/test\n4. 승인 코드\nPLAN-ABC123 STEP-DEF456'
  const send=(channel:string,body:string)=>app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent(channel)+'/messages',headers:agent,payload:{body}})
  expect((await send('업무-요청',form.replace('dashboard.example.com','evil.example'))).json().approval).toBeNull()
  const elsewhere=(await send('자유',form)).json()
  expect(elsewhere.approval).toBeNull()
  expect((await app.inject({method:'POST',url:url+'/approvals/'+elsewhere.id,headers,payload:{decision:'approve'}})).statusCode).toBe(400)
  expect((await send('업무-요청',form)).json().approval).toMatchObject({status:'pending'})
 })
 it('accepts the same list limit the store returns',async()=>{
  const {app,headers,url}=await fixture()
  const list=(limit:number)=>app.inject({url:url+'/channels/'+encodeURIComponent('자유')+'/messages?limit='+limit,headers})
  expect((await list(100)).statusCode).toBe(200)
  expect((await list(101)).statusCode).toBe(400)
 })
 it('ends an open agent SSE stream after its token is revoked',async()=>{
  const {app,agent,url,writeTokens}=await fixture({identityRecheckMs:100})
  const result=await readStream(app,url,agent,600,async()=>writeTokens({}))
  expect(result.status).toBe(200)
  expect(result.closedByServer).toBe(true)
 })
 it('reports the messenger as enabled on /api/portal by default',async()=>{
  const {app,headers}=await fixture()
  expect((await app.inject({url:'/api/portal',headers})).json().messenger).toEqual({enabled:true})
 })
 it('lists the configured roles for the dashboard and refuses callers without identity',async()=>{
  const {app,headers,agent,url}=await fixture()
  const ids=(h:Record<string,string>)=>app.inject({url:url+'/roles',headers:h}).then(r=>r.json().roles.map((x:any)=>x.id))
  expect(await ids(headers)).toEqual(['coder','planner','reviewer','writer','naia','designer'])
  expect(await ids(agent as any)).toEqual(['coder','planner','reviewer','writer','naia','designer'])
  expect((await app.inject({url:url+'/roles',headers:{host:'localhost:3241'}})).statusCode).toBeGreaterThanOrEqual(400)
 })
 it('turns the messenger off with NAIA_MESSENGER_ENABLED=0',async()=>{
  const previous=process.env.NAIA_MESSENGER_ENABLED
  process.env.NAIA_MESSENGER_ENABLED='0'
  try {
   const {app,headers,url,root}=await fixture()
   expect((await app.inject({url:url+'/channels',headers})).statusCode).toBe(404)
   expect((await app.inject({url:url+'/stream',headers})).statusCode).toBe(404)
   expect(fs.existsSync(path.join(root,'data-company/messenger/messenger.db'))).toBe(false)
   // The dashboard reads this to hide its 대화 tab.
   expect((await app.inject({url:'/api/portal',headers})).json().messenger).toEqual({enabled:false})
  } finally { if(previous===undefined) delete process.env.NAIA_MESSENGER_ENABLED; else process.env.NAIA_MESSENGER_ENABLED=previous }
 })
 it('keeps the rest of the API up and reports the messenger off when its DB folder cannot be created',async()=>{
  const previous=process.env.NAIA_MESSENGER_DB
  delete process.env.NAIA_MESSENGER_DB
  // Like production 3141: read-only data root and no NAIA_MESSENGER_DB drop-in.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'messenger-ro-root-'))
  fs.writeFileSync(path.join(root,'README.md'),'x')
  fs.chmodSync(root,0o555)
  const app=await createServer({root,port:3241,host:'127.0.0.1'})
  app.log.level='fatal'
  ;(app as any).proxySecret='fixture-secret'
  cleanups.push(async()=>{await app.close();fs.chmodSync(root,0o755);fs.rmSync(root,{recursive:true,force:true});if(previous!==undefined) process.env.NAIA_MESSENGER_DB=previous})
  await app.listen({host:'127.0.0.1',port:0})
  const base='http://127.0.0.1:'+(app.server.address() as any).port
  expect((await fetch(base+'/api/health')).status).toBe(200)
  expect((await fetch(base+'/api/portal/messenger/channels')).status).toBe(503)
  expect((await fetch(base+'/api/portal/messenger/stream')).status).toBe(503)
  const portal=await app.inject({url:'/api/portal',headers:{host:'localhost:'+(app.server.address() as any).port,'x-naia-proxy-secret':'fixture-secret','x-naia-peer':'127.0.0.1','x-naia-local':'1'}})
  expect(portal.statusCode,portal.body.slice(0,200)).toBe(200)
  expect(portal.json().messenger).toEqual({enabled:false})
  expect(fs.existsSync(path.join(root,'data-company'))).toBe(false)
 })
 it('keeps reaction "mine" and read cursors apart for a human and an agent with the same name',async()=>{
  const {app,headers,agent,url,post}=await fixture()
  const humanCoder={...headers,'x-ax-account-key':'coder'}
  const message=(await post('공개 글',agent as any)).json()
  const react=(h:Record<string,string>)=>app.inject({method:'POST',url:url+'/messages/'+message.id+'/reactions',headers:h,payload:{emoji:'👍'}})
  expect((await react(agent)).json().reactions).toEqual([{emoji:'👍',count:1,mine:true}])
  expect((await react(humanCoder)).json().reactions).toEqual([{emoji:'👍',count:2,mine:true}])
  const unread=async(h:Record<string,string>)=>(await app.inject({url:url+'/channels',headers:h})).json().find((c:any)=>c.id==='업무-요청').unread
  expect(await unread(humanCoder)).toBe(1)
  expect(await unread(agent)).toBe(0)
  expect((await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent('업무-요청')+'/read',headers:agent,payload:{last_message_id:message.id}})).statusCode).toBe(200)
  expect(await unread(humanCoder)).toBe(1)
 })
 it('spools wakes next to the messenger DB, or in NAIA_MESSENGER_WAKE_SPOOL_DIR, never in the wake folder',async()=>{
  const {post,root}=await fixture()
  expect((await post('@coder 확인 부탁')).statusCode).toBe(200)
  expect(fs.readdirSync(path.join(root,'data-company/messenger/wake-spool'))).toEqual([expect.stringMatching(/-route-coder\.json$/)])
  expect(fs.existsSync(path.join(root,'.agents/work/l4/wake'))).toBe(false)
  const previous=process.env.NAIA_MESSENGER_WAKE_SPOOL_DIR
  const spool=fs.mkdtempSync(path.join(os.tmpdir(),'messenger-spool-'))
  process.env.NAIA_MESSENGER_WAKE_SPOOL_DIR=spool
  try {
   const second=await fixture()
   expect((await second.post('@planner 확인 부탁')).statusCode).toBe(200)
   expect(fs.readdirSync(spool)).toEqual([expect.stringMatching(/-route-planner\.json$/)])
   expect(fs.existsSync(path.join(second.root,'data-company/messenger/wake-spool'))).toBe(false)
  } finally { if(previous===undefined) delete process.env.NAIA_MESSENGER_WAKE_SPOOL_DIR; else process.env.NAIA_MESSENGER_WAKE_SPOOL_DIR=previous; fs.rmSync(spool,{recursive:true,force:true}) }
 })
})
describe('messenger human identity',()=>{
 const channel=encodeURIComponent('업무-요청')
 it('refuses a person the login gate did not vouch for, and reads and writes once it did',async()=>{
  const {app,headers,url,post}=await fixture()
  const {'x-naia-gate-verified':_mark,...noMark}=headers
  const list=(h:Record<string,string>)=>app.inject({url:url+'/channels/'+channel+'/messages',headers:h})
  const channels=await app.inject({url:url+'/channels',headers})
  const dm=channels.json().find((c:any)=>c.kind==='dm'&&c.id.endsWith(':coder')).id
  const dmPost=await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers,payload:{body:'비밀 DM'}})
  expect(dmPost.statusCode).toBe(200)
  // No mark: the DM stays closed and a post under a person's name is refused, even with both names sent.
  const spoof={...noMark,'x-ax-user':encodeURIComponent('대표님')}
  expect((await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:spoof})).statusCode).toBe(401)
  expect((await post('사람 행세',spoof)).statusCode).toBe(401)
  expect((await list(spoof)).statusCode).toBe(401)
  expect((await app.inject({url:url+'/stream',headers:spoof})).statusCode).toBe(401)
  // A mark without the dashboard secret is not a mark.
  const {'x-naia-proxy-secret':_secret,...noSecret}=headers
  expect((await list(noSecret)).statusCode).toBe(403)
  // A display name alone or a malformed account key is not an identity.
  const {'x-ax-account-key':_account,...noAccount}=headers
  expect((await list({...noAccount,'x-ax-user':'test-human'})).statusCode).toBe(401)
  for (const bad of ['Owner','x','대표님','a,b','has space']) expect((await list({...noAccount,'x-ax-account-key':encodeURIComponent(bad)})).statusCode).toBe(401)
  const read=await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers})
  expect(read.statusCode).toBe(200)
  expect(read.json().messages.map((m:any)=>m.body)).toEqual(['비밀 DM'])
 })
 it('keys a person by account: a new display name keeps the DM and the same name does not share it',async()=>{
  const {app,headers,url}=await fixture()
  const asName=(account:string,name:string)=>({...headers,'x-ax-account-key':account,'x-ax-user':encodeURIComponent(name)})
  const dmOf=async(h:Record<string,string>)=>(await app.inject({url:url+'/channels',headers:h})).json().find((c:any)=>c.kind==='dm'&&c.id.endsWith(':coder')).id
  const kim=asName('kim','김 대리')
  const dm=await dmOf(kim)
  expect(dm).toBe('dm:kim:coder')
  const posted=await app.inject({method:'POST',url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:kim,payload:{body:'안녕'}})
  expect(posted.json()).toMatchObject({author_id:'kim',author_kind:'human',author_name:'김 대리'})
  const renamed=asName('kim','김 과장')
  expect(await dmOf(renamed)).toBe(dm)
  const read=await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:renamed})
  expect(read.json().messages.map((m:any)=>[m.body,m.author_name])).toEqual([['안녕','김 과장']])
  const sameName=asName('kim2','김 과장')
  expect(await dmOf(sameName)).toBe('dm:kim2:coder')
  expect((await app.inject({url:url+'/channels/'+encodeURIComponent(dm)+'/messages',headers:sameName})).statusCode).toBe(403)
 })
 it('takes no display name from a broken header and names no agent',async()=>{
  const {app,headers,url,agent,post}=await fixture()
  const broken=await post('이름 깨짐',{...headers,'x-ax-user':'%E0%A4%A'})
  expect(broken.statusCode).toBe(200)
  expect(broken.json()).toMatchObject({author_id:'test-human',author_name:null})
  const byAgent=await app.inject({method:'POST',url:url+'/channels/'+channel+'/messages',headers:{...agent,'x-ax-user':'가짜'},payload:{body:'agent'}})
  expect(byAgent.json()).toMatchObject({author_id:'coder',author_kind:'agent',author_name:null})
 })
})
describe('messenger attachment events',()=>{
 it('sends the message again with its attachment once a file is attached to it',async()=>{
  const {app,headers,url,post}=await fixture()
  let messageId=''
  const result=await readStream(app,url,headers,600,async host=>{
   messageId=(await post('첨부 붙일 글',{...headers,host})).json().id
   const uploaded=await app.inject({method:'POST',url:url+'/attachments?message_id='+messageId,headers:{...headers,host,'content-type':'multipart/form-data; boundary=b'},payload:'--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n'})
   expect(uploaded.statusCode).toBe(200)
  })
  const events=[...result.text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m=>[m[1],JSON.parse(m[2])] as const)
  const message=events.find(([type,data])=>type==='message'&&data.id===messageId)
  expect(message).toBeTruthy()
  const attachment=events.find(([type,data])=>type==='attachment'&&data.id===messageId)
  expect(attachment?.[1].attachments.map((a:any)=>a.name)).toEqual(['a.txt'])
 })
 it('does not announce an upload that belongs to no message yet',async()=>{
  const {app,headers,url,upload}=await fixture()
  const result=await readStream(app,url,headers,400,async host=>{expect((await upload('a.txt','hello',{...headers,host})).statusCode).toBe(200)})
  expect(result.text).not.toContain('event: attachment')
 })
})
describe('messenger file permissions',()=>{
 it('starts on an open DB folder and leaves it as it is',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'messenger-open-dir-'))
  const dbDir=path.join(root,'open');fs.mkdirSync(dbDir);fs.chmodSync(dbDir,0o755)
  const {app}=await fixture({dbPath:path.join(dbDir,'messenger.db')})
  expect(fs.statSync(dbDir).mode&0o777).toBe(0o755)
  expect((await app.inject({url:'/api/health',headers:{host:'localhost:3241'}})).statusCode).toBe(200)
  await app.close()
  fs.rmSync(root,{recursive:true,force:true})
 })
})
