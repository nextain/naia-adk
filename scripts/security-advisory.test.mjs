import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLedgerYaml, serializeLedgerYaml } from './lib/ledger.mjs';
import { publish, consume, collectAssets, loadConfig, validateAdvisory, matches } from './lib/security-advisory.mjs';
const advisory = () => ({schemaVersion:1,id:'CVE-2026-1234',sourceUrl:'https://example.com/advisory',affected:[{ecosystem:'npm',name:'widget',versions:['1.0.0']}],severity:'high',action:'Upgrade the affected package',dueAt:'2026-11-09T00:00:00Z'});
async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'advisory-')); const c={shared:{directory:join(dir,'shared')},role:'security-owner',workLedger:join(dir,'work.yaml'),assets:{files:[join(dir,'assets.json')],lockfiles:[],osCommands:[]}};
 await writeFile(c.workLedger,'version: 1\nwork: []\n'); await writeFile(c.assets.files[0],JSON.stringify({assets:[{ecosystem:'npm',name:'widget',version:'1.0.0'}]})); return {c,dir};
}
test('publish immutable IDs, reject duplicates and dry publish makes no directory',async()=>{
 const {c}=await fixture(); const a=advisory(); assert.equal((await publish(c,a,{dry:true}))[0].status,'would-publish'); await assert.rejects(readdir(c.shared.directory));
 assert.equal((await publish(c,a))[0].status,'published'); const before=await readFile(join(c.shared.directory,`${a.id}.json`),'utf8');
 assert.equal((await publish(c,{...a,action:'Different action'}))[0].status,'exists'); assert.equal(await readFile(join(c.shared.directory,`${a.id}.json`),'utf8'),before);
 await assert.rejects(publish(c,{advisories:[a,a]}),/duplicate/);
});
test('matching, dry consume, append once and preserve completed existing row',async()=>{
 const {c}=await fixture(); await publish(c,{advisories:[advisory(),{...advisory(),id:'OTHER',affected:[{ecosystem:'service',name:'other'}]}]});
 const before=await readFile(c.workLedger,'utf8'); assert.deepEqual((await consume(c,{dry:true})).map(r=>r.status),['would-add','not-applicable']); assert.equal(await readFile(c.workLedger,'utf8'),before); assert.deepEqual((await readdir((await import('node:path')).dirname(c.workLedger))).sort(),['assets.json','shared','work.yaml']);
 assert.deepEqual((await consume(c)).map(r=>r.status),['added','not-applicable']); const added=await readFile(c.workLedger,'utf8'); assert.match(added,/진행 중/); assert.match(added,/security-owner/);
 assert.equal((await consume(c))[0].status,'exists'); assert.equal(await readFile(c.workLedger,'utf8'),added);
 const doc=parseLedgerYaml(added); const row=doc.work[0]; assert.equal(row.due_at,advisory().dueAt); assert.equal(row.evidence,advisory().sourceUrl); assert.match(row.task,/Upgrade the affected package/); assert.equal(row.requested_at,row.updated_at); assert(Number.isFinite(Date.parse(row.requested_at)));
 row.status='끝'; row.result='docs/security/result.md'; row.requested_at='2026-01-01T00:00:00Z'; row.updated_at='2026-01-02T00:00:00Z'; const completed=serializeLedgerYaml(doc); await writeFile(c.workLedger,completed); assert.equal((await consume(c))[0].status,'exists'); assert.equal(await readFile(c.workLedger,'utf8'),completed);
});
test('reject malformed advisories before ledger changes',async()=>{
 const {c}=await fixture(); const before=await readFile(c.workLedger,'utf8');
 for(const bad of [{...advisory(),id:'../oops'},{...advisory(),sourceUrl:'http://example.com'},{...advisory(),sourceUrl:'https://127.0.0.1/x'},{...advisory(),sourceUrl:'https://x.internal/x'},{...advisory(),sourceUrl:'https://user:pass@example.com/x'},{...advisory(),severity:'urgent'},{...advisory(),dueAt:'2026-02-30T00:00:00Z'},{...advisory(),affected:[]},{...advisory(),secret:'hidden'},{...advisory(),action:'password=abc'},{...advisory(),affected:[{ecosystem:'npm',name:'widget',versions:['<2.0.0']}]}]) assert.throws(()=>validateAdvisory(bad));
 await publish(c,advisory()); await writeFile(join(c.shared.directory,'bad.json'),'{}'); await assert.rejects(consume(c)); assert.equal(await readFile(c.workLedger,'utf8'),before);
});
test('npm transitive scoped lockfile and OS argv inventory',async()=>{
 const {c,dir}=await fixture(); const file=join(dir,'package-lock.json'); await writeFile(file,JSON.stringify({packages:{'':{},'node_modules/@scope/a':{version:'2.0.0'},'node_modules/a/node_modules/widget':{version:'1.0.0'}}}));
 c.assets.lockfiles=[file]; c.assets.osCommands=[{command:process.execPath,args:['-e','process.stdout.write("openssl\\t3.0.0\\n")']}]; const assets=await collectAssets(c);
 assert(assets.some(a=>a.name==='@scope/a')); assert(matches({...advisory(),affected:[{ecosystem:'os',name:'openssl',versions:['3.0.0']}]},assets)); assert(!matches({...advisory(),affected:[{ecosystem:'npm',name:'widget',versions:['2.0.0']}]},assets));
});
test('config paths resolve relative and argv validation',async()=>{
 const {dir}=await fixture(); const path=join(dir,'config.json'); const c={shared:{directory:'shared'},role:'owner',workLedger:'work.yaml',assets:{files:['assets.json']}}; await writeFile(path,JSON.stringify(c)); assert.equal((await loadConfig(path)).workLedger,join(dir,'work.yaml'));
 await writeFile(path,JSON.stringify({...c,assets:{osCommands:[{command:'echo',args:'bad'}]}})); await assert.rejects(loadConfig(path),/argv/);
 await writeFile(path,JSON.stringify({...c,assets:{}})); await assert.rejects(loadConfig(path),/asset source/);
});
test('HTTPS index transport validates every path and fails closed',async()=>{
 const {c}=await fixture(); delete c.shared.directory; c.shared.url='https://example.com/advisories/index.json';
 const original=globalThis.fetch; const calls=[];
 try {
  globalThis.fetch=async (url,options)=> { calls.push([url,options]); return {ok:true,text:async()=>JSON.stringify(url.endsWith('index.json')?{advisories:['CVE-2026-1234.json']}:advisory())}; };
  assert.equal((await consume(c,{dry:true}))[0].status,'would-add'); assert.equal(calls[1][0],'https://example.com/advisories/CVE-2026-1234.json'); assert.equal(calls[0][1].redirect,'error');
  globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({advisories:['https://internal/x.json']})}); await assert.rejects(consume(c,{dry:true}),/index/);
  globalThis.fetch=async()=>({ok:false,status:302}); await assert.rejects(consume(c,{dry:true}),/HTTP 302/);
 } finally { globalThis.fetch=original; }
});
test('unknown local version remains potentially affected',()=>{
 assert(matches(advisory(),[{ecosystem:'npm',name:'widget'}]));
});
