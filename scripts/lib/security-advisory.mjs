import { readFile, readdir, mkdir, open, unlink, rename, lstat, link } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { parseLedgerYaml, validateWorkLedger, serializeLedgerYaml } from './ledger.mjs';
const run = promisify(execFile);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const string = (v, label) => { if (typeof v !== 'string' || !v.trim() || /[\x00-\x1f\x7f]/.test(v)) throw Error(`invalid ${label}`); return v; };
export function publicUrl(value) {
  const url = new URL(string(value, 'public URL'));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw Error('public HTTPS URL required (no credentials, query, IP or internal host)');
  return url;
}
export function validateAdvisory(a) {
  if (!object(a) || a.schemaVersion !== 1 || typeof a.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(a.id)) throw Error('invalid advisory id/schema');
  const keys = ['schemaVersion','id','sourceUrl','affected','severity','action','dueAt'];
  if (Object.keys(a).some(k => !keys.includes(k))) throw Error('unknown advisory field');
  publicUrl(a.sourceUrl);
  if (!['critical','high','medium','low','unknown'].includes(a.severity)) throw Error('invalid severity');
  string(a.action, 'action');
  if (a.action.length > 4000 || /(?:https?:\/\/|(?:token|password|secret)\s*[:=])/i.test(a.action)) throw Error('action must contain public instructions without URLs or secrets');
  if (typeof a.dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(a.dueAt) || !Number.isFinite(Date.parse(a.dueAt)) || new Date(a.dueAt).toISOString() !== a.dueAt.replace('Z','.000Z')) throw Error('invalid dueAt');
  if (!Array.isArray(a.affected) || !a.affected.length) throw Error('affected assets required');
  for (const p of a.affected) {
    if (!object(p) || Object.keys(p).some(k => !['ecosystem','name','versions'].includes(k)) || !['npm','os','service'].includes(p.ecosystem)) throw Error('invalid affected asset');
    if (!/^[a-zA-Z0-9@][a-zA-Z0-9@/._+:-]{0,199}$/.test(string(p.name,'asset name'))) throw Error('invalid asset name');
    if (p.versions !== undefined && (!Array.isArray(p.versions) || !p.versions.length || p.versions.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9._+~:-]+$/.test(v)))) throw Error('versions must be exact versions');
  }
  return a;
}
export async function loadConfig(path) {
  const c = JSON.parse(await readFile(path,'utf8')); const base = dirname(resolve(path));
  if (!object(c) || !object(c.shared) || Boolean(c.shared.directory) === Boolean(c.shared.url)) throw Error('configure one shared directory or HTTPS index URL');
  if (c.shared.url) publicUrl(c.shared.url);
  c.shared = { ...c.shared, ...(c.shared.directory ? {directory: resolve(base,c.shared.directory)} : {}) };
  string(c.role,'role'); c.workLedger = resolve(base,string(c.workLedger,'workLedger'));
  if (!object(c.assets)) throw Error('assets configuration required');
  for (const k of ['files','lockfiles']) { if (!Array.isArray(c.assets[k] ?? [])) throw Error(`invalid ${k}`); c.assets[k] = (c.assets[k] ?? []).map(p => resolve(base,string(p,k))); }
  if (!Array.isArray(c.assets.osCommands ?? [])) throw Error('invalid osCommands');
  for (const cmd of c.assets.osCommands ?? []) if (!object(cmd) || typeof cmd.command !== 'string' || !cmd.command || !Array.isArray(cmd.args) || cmd.args.some(x => typeof x !== 'string')) throw Error('OS command requires command and argv');
  if (!c.assets.files.length && !c.assets.lockfiles.length && !(c.assets.osCommands ?? []).length) throw Error('at least one asset source required');
  return c;
}
export async function publish(c, input, {dry = false} = {}) {
  if (!c.shared.directory) throw Error('publish requires a local shared directory');
  const list = Array.isArray(input.advisories) ? input.advisories : [input];
  list.forEach(validateAdvisory);
  if (new Set(list.map(a=>a.id)).size !== list.length) throw Error('duplicate advisory id in batch');
  const results = [];
  // Preflight the entire collection before creating any files.
  for (const a of list) {
    const path = resolve(c.shared.directory,`${a.id}.json`); let exists = false;
    try { await lstat(path); exists = true; } catch(e) { if(e.code !== 'ENOENT') throw e; }
    results.push({id:a.id,status: exists ? 'exists' : dry ? 'would-publish' : 'published',path});
  }
  if (!dry) {
    await mkdir(c.shared.directory,{recursive:true});
    for (let i=0;i<list.length;i++) if(results[i].status === 'published') {
      const temporary = `${results[i].path}.${process.pid}.${crypto.randomUUID()}.tmp`; let h;
      try { h = await open(temporary,'wx',0o600); await h.writeFile(JSON.stringify(list[i],null,2)+'\n'); await h.close(); h=null; await link(temporary,results[i].path); } catch(e) { if(e.code === 'EEXIST') results[i].status='exists'; else throw e; } finally { await h?.close(); await unlink(temporary).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
    }
  }
  return results;
}
async function httpsJson(url) {
  publicUrl(url); const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw Error(`advisory HTTP ${response.status}`);
  const text = await response.text(); if(text.length > 2_000_000) throw Error('advisory response too large'); return JSON.parse(text);
}
export async function readAdvisories(c) {
  let list;
  if(c.shared.directory) {
    const files = (await readdir(c.shared.directory)).filter(p=>p.endsWith('.json')).sort();
    list = await Promise.all(files.map(async p => { const path=resolve(c.shared.directory,p); const st=await lstat(path); if(!st.isFile() || st.isSymbolicLink() || st.size>2_000_000) throw Error('regular advisory file required'); return JSON.parse(await readFile(path,'utf8')); }));
  } else {
    const index = await httpsJson(c.shared.url);
    if(!object(index) || !Array.isArray(index.advisories) || index.advisories.some(p=>typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(p))) throw Error('invalid advisory index');
    list = await Promise.all(index.advisories.map(p=>httpsJson(new URL(p,c.shared.url).href)));
  }
  list.forEach(validateAdvisory); if(new Set(list.map(a=>a.id)).size !== list.length) throw Error('duplicate advisory id'); return list;
}
export async function collectAssets(c) {
  const assets=[];
  const add = p => { if(!object(p) || !['npm','os','service'].includes(p.ecosystem)) throw Error('invalid inventory asset'); string(p.name,'inventory name'); if(p.version !== undefined) string(p.version,'inventory version'); assets.push(p); };
  for(const file of c.assets.files) { const doc=JSON.parse(await readFile(file,'utf8')); if(!Array.isArray(doc.assets)) throw Error('inventory requires assets array'); doc.assets.forEach(add); }
  for(const file of c.assets.lockfiles) {
    if(basename(file) !== 'package-lock.json' && basename(file) !== 'npm-shrinkwrap.json') throw Error('supported lockfiles: package-lock.json and npm-shrinkwrap.json');
    const doc=JSON.parse(await readFile(file,'utf8'));
    if(!object(doc.packages) && !object(doc.dependencies)) throw Error('invalid npm lockfile');
    for(const [path,p] of Object.entries(doc.packages ?? {})) if(path.includes('node_modules/') && p.version) add({ecosystem:'npm',name:p.name ?? path.split('node_modules/').at(-1),version:p.version});
    function deps(items) { for(const [name,p] of Object.entries(items ?? {})) { if(p.version) add({ecosystem:'npm',name,version:p.version}); deps(p.dependencies); } } deps(doc.dependencies);
  }
  for(const command of c.assets.osCommands ?? []) {
    const {stdout}=await run(command.command,command.args,{timeout:15000,maxBuffer:2_000_000,encoding:'utf8'});
    for(const line of stdout.split(/\r?\n/).filter(Boolean)) { const fields=line.split('\t'); if(fields.length !== 2) throw Error('OS command output must be name TAB version'); add({ecosystem:'os',name:fields[0],version:fields[1]}); }
  }
  return assets;
}
export const matches = (a,assets) => a.affected.some(p=>assets.some(q=>p.ecosystem===q.ecosystem && p.name===q.name && (!p.versions || !q.version || p.versions.includes(q.version))));
export async function consume(c,{dry=false,now=Date.now()}={}) {
  const advisories=await readAdvisories(c), assets=await collectAssets(c);
  const lockPath=`${c.workLedger}.lock`; let lock;
  if(!dry) lock=await open(lockPath,'wx',0o600);
  try {
    if(lock) await lock.writeFile(JSON.stringify({pid:process.pid,started:now}));
    const meta=await lstat(c.workLedger); if(!meta.isFile() || meta.isSymbolicLink()) throw Error('regular work ledger required');
    const doc=parseLedgerYaml(await readFile(c.workLedger,'utf8')); validateWorkLedger(doc,now);
    const results=[]; const time=new Date(now).toISOString();
    for(const a of advisories) {
      const id=`security:${a.id}`;
      const status=doc.work.some(r=>r.id===id) ? 'exists' : !matches(a,assets) ? 'not-applicable' : dry ? 'would-add' : 'added';
      results.push({id:a.id,status});
      if(status==='added') doc.work.push({id,role:c.role,task:`[${a.severity}] ${a.id}: ${a.action}`,status:'진행 중',requested_at:time,updated_at:time,due_at:a.dueAt,evidence:a.sourceUrl,result:null});
    }
    if(results.some(r=>r.status==='added')) {
      validateWorkLedger(doc,now); const tmp=`${c.workLedger}.${process.pid}.tmp`; let h;
      try { h=await open(tmp,'wx',meta.mode & 0o777); await h.writeFile(serializeLedgerYaml(doc)); await h.close(); h=null; await rename(tmp,c.workLedger); } finally { await h?.close(); await unlink(tmp).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
    }
    return results;
  } finally { if(lock) { await lock.close(); await unlink(lockPath); } }
}
