import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, watch, validateApproval } from './msg.mjs';
import { updateTokens, hashToken } from './issue-agent-token.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from './setup.mjs';
// Fixture roles; a real install names its own in NAIA_MESSENGER_ROLES (default: naia).
process.env.NAIA_MESSENGER_ROLES = 'coder,planner,reviewer,writer,naia,designer'
const temporary = () => mkdtempSync(join(tmpdir(),'messenger-test-'));
test('approval original checks and tables', () => {
 const valid='1. 제목: [배포] 조치\n2. 요약: 승인 부탁합니다\n3. 문서: https://dashboard.example.com/d/test\n4. 승인 코드 (다음 글)';
 assert.doesNotThrow(()=>validateApproval(valid,'업무-요청'));
 assert.throws(()=>validateApproval(valid,'자유'),/업무-요청/);
 assert.throws(()=>validateApproval('승인 부탁합니다','업무-요청'),/양식 아님/);
 assert.doesNotThrow(()=>validateApproval('| 이름 | 값 |\n|---|---|\n| 하나 | 둘 |','자유'));
});
test('approval document: first 3. 문서 line only, pinned to NAIA_DASHBOARD_PUBLIC_URL, closed when it is not an https origin', () => {
 const form=(doc)=>`1. 제목: [배포] 조치\n2. 요약: 승인 부탁합니다\n${doc}\n4. 승인 코드 (다음 글)`;
 const pinned={NAIA_DASHBOARD_PUBLIC_URL:'https://dashboard.example.com/'};
 assert.doesNotThrow(()=>validateApproval(form('3. 문서: https://dashboard.example.com/d/a1'),'업무-요청',pinned));
 assert.throws(()=>validateApproval(form('3. 문서: https://evil.test/d/a1'),'업무-요청',pinned),/양식 아님/);
 assert.throws(()=>validateApproval(form('3. 문서: https://evil.test/login\n3. 문서: https://dashboard.example.com/d/a1'),'업무-요청',pinned),/양식 아님/);
 assert.throws(()=>validateApproval(form('3. 문서: https://evil.test/login\n3. 문서: https://dashboard.example.com/d/a1'),'업무-요청',{}),/양식 아님/);
 assert.doesNotThrow(()=>validateApproval(form('3. 문서: https://any.example/d/a1'),'업무-요청',{}));
 for (const bad of ['http://localhost:3242','https://dashboard.example.com/sub'])
  assert.throws(()=>validateApproval(form('3. 문서: https://evil.test/d/x'),'업무-요청',{NAIA_DASHBOARD_PUBLIC_URL:bad}),/양식 아님/);
});
test('tokens store hashes only, rotate/revoke, no accidental replacement', () => {
 const file=join(temporary(),'tokens.json'); const first=updateTokens(file,'issue','tester');
 assert.equal(JSON.parse(readFileSync(file))[hashToken(first)],'tester'); assert.ok(!readFileSync(file,'utf8').includes(first));
 assert.throws(()=>updateTokens(file,'issue','tester'),/이미/);
 const second=updateTokens(file,'rotate','tester'); assert.notEqual(first,second); assert.equal(JSON.parse(readFileSync(file))[hashToken(first)],undefined);
 updateTokens(file,'revoke','tester'); assert.deepEqual(JSON.parse(readFileSync(file)),{});
});
test('token issuer accepts only role names the server accepts', () => {
 const file=join(temporary(),'tokens.json');
 for (const role of ['리뷰어','Planner','1alpha','-a','a'.repeat(65),'a b']) assert.throws(()=>updateTokens(file,'issue',role),/역할 이름/);
 for (const role of ['planner','role_2','a-b','a'.repeat(64)]) assert.ok(updateTokens(file,'issue',role));
});
test('fake HTTP server post/read/react/attachments and reconnect filtered SSE', async t => {
 let reconnect=0, lastEvent, uploaded='', posted; const received=[];
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers['x-ax-agent-token'],'test-only');
  const url=new URL(req.url,'http://localhost'); const path=url.pathname.replace('/api/portal/messenger','');
  if(path==='/stream') {
   reconnect++; lastEvent=req.headers['last-event-id']; res.writeHead(200,{'Content-Type':'text/event-stream'});
   if(reconnect===1) { res.write('id: 0\r'); await new Promise(r=>setTimeout(r,5)); res.write('\ndata: {"body":"@other ignore"}\r\n\r'); await new Promise(r=>setTimeout(r,5)); res.write('\n'); return res.end('id: 1\nevent: message\ndata: {"id":"m1","body":"@other 무시"}\n\nid: 2\nevent: message\ndata: {"id":"m2","body":"@tester 첫째"}\n\n'); }
   res.end('id: 2\nevent: message\ndata: {"id":"m2","body":"@tester 첫째"}\n\nid: 3\nevent: message\ndata: {"id":"m3","body":"@tester-more 무시"}\n\nid: 4\nevent: message\ndata: {"id":"m4","body":"안녕 @tester 둘째"}\n\n'); return;
  }
  let body=''; for await (const chunk of req) body+=chunk;
  res.setHeader('Content-Type','application/json');
  if(path==='/channels') return res.end(JSON.stringify([{id:'c',name:'자유'}]));
  if(path==='/channels/c/messages' && req.method==='POST') {posted=JSON.parse(body); return res.end(JSON.stringify({id:'new',...posted}));}
  if(path==='/channels/c/messages') {
   const page=url.searchParams.has('before') ? [{id:'000',body:'old'}] : Array.from({length:50},(_,i)=>({id:String(100-i).padStart(3,'0'),body:'hello'}));
   return res.end(JSON.stringify({messages:page}));
  }
  if(path==='/messages/new/reactions') {res.statusCode=204;return res.end();}
  if(path==='/attachments') {assert.equal(url.searchParams.get('message_id'),'new');uploaded=body; return res.end('{"id":"file"}');}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const client=createClient({url:`http://127.0.0.1:${server.address().port}`,token:'test-only'});
 const dir=temporary(),file=join(dir,'body.md'),attachment=join(dir,'note.txt');writeFileSync(file,'| 표 | 허용 |');writeFileSync(attachment,'attached');
 const message=await client.post('자유','-',file,[attachment]);assert.equal(message.id,'new');assert.equal(posted.reply_to_id,undefined);assert.doesNotMatch(uploaded,/name="message_id"/);assert.match(uploaded,/attached/);
 await client.post('c','parent',file);assert.equal(posted.reply_to_id,'parent');
 assert.equal((await client.read('c','050')).length,50);assert.equal(await client.react('new','👍'),null);
 const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),3000);
 await watch(client,{role:'tester',signal:controller.signal,reconnectMs:5,output:line=>{received.push(JSON.parse(line));if(received.length===2)controller.abort();}});clearTimeout(timeout);
 assert.equal(reconnect,2);assert.equal(lastEvent,'2');assert.deepEqual(received.map(m=>m.id),['m2','m4']);
});
test('setup twice preserves rows and tokens using core-compatible schema', async()=>{
 const root=temporary(),lines=[];const options={root,env:{NAIA_MESSENGER_URL:'http://localhost:5678'},roles:['tester'],output:line=>lines.push(line)};
 const first=await setup(options);const tokens=readFileSync(first.tokenFile,'utf8');const {DatabaseSync}=await import('node:sqlite');const seeded=new DatabaseSync(first.dbFile);seeded.prepare("INSERT INTO messages(id,channel_id,author_id,author_kind,body,created_at) VALUES(?,?,?,?,?,?)").run('saved','자유','person','human','keep me',Date.now());seeded.close();const second=await setup(options);
 assert.deepEqual(first,second);assert.equal(readFileSync(first.tokenFile,'utf8'),tokens);assert.equal(lines.filter(l=>l.startsWith('tester:')).length,1);
 const db=new DatabaseSync(first.dbFile);assert.equal(db.prepare('SELECT body FROM messages WHERE id=?').get('saved').body,'keep me');assert.equal(db.prepare('SELECT count(*) AS n FROM channels').get().n,3);assert.equal(db.prepare("SELECT type FROM pragma_table_info('messages') WHERE name='created_at'").get().type,'INTEGER');assert.equal(db.prepare("SELECT [notnull] AS required FROM pragma_table_info('attachments') WHERE name='message_id'").get().required,0);db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run('unlinked',null,'test.txt','text/plain',1,'hash','test');assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='channel_members'").get());db.close();
 assert.equal(lines.at(-1),'http://localhost:5678/messages 를 여세요');
});

test('setup creates kind columns for members, reactions and read cursors like the server', async()=>{
 const {dbFile}=await setup({root:temporary(),env:{},roles:[],output:()=>{}});const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(dbFile);
 const key=table=>db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk>0 ORDER BY pk`).all().map(r=>r.name);
 assert.deepEqual(key('channel_members'),['channel_id','member_id','member_kind']);
 assert.deepEqual(key('reactions'),['message_id','author_id','author_kind','emoji']);
 assert.deepEqual(key('read_cursors'),['channel_id','reader_id','reader_kind']);
 db.close();
});

test('CLI token file and environment precedence; rejects wrong arity', async t => {
 const headers=[];const server=createServer((req,res)=>{headers.push(req.headers['x-ax-agent-token']);res.setHeader('Content-Type','application/json');res.end('[]');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const file=join(temporary(),'token.txt');writeFileSync(file,'from-file\n');
 const invoke=(args,token)=>new Promise(resolve=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./msg.mjs',import.meta.url)),...args],{env:{PATH:process.env.PATH,NAIA_MESSENGER_URL:`http://127.0.0.1:${server.address().port}`,...(token ? {NAIA_MESSENGER_TOKEN:token} : {})}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolve({code,stdout,stderr}));});
 assert.equal((await invoke(['channels','--token-file',file])).code,0);
 assert.equal((await invoke(['channels','--token-file',file],'from-env')).code,0);
 assert.deepEqual(headers,['from-file','from-env']);
 const bad=await invoke(['react','one'],'from-env');assert.equal(bad.code,1);assert.match(bad.stderr,/msg.mjs/);assert.equal(headers.length,2);
});

test('watch accepts CR-only events and flushes final split CR delimiter', async()=>{
 const controller=new AbortController(),received=[];
 const encoder=new TextEncoder();
 const chunks=['id: cr1\revent: message\rdata: {"id":"cr1","body":"@tester 첫 글"}\r\rid: cr2\revent: message\rdata: {"id":"cr2","body":"@tester 끝 글"}\r','\r'];
 const client={request:async()=>({body:(async function*(){for(const chunk of chunks)yield encoder.encode(chunk);})()})};
 const timeout=setTimeout(()=>controller.abort(),1000);
 await watch(client,{role:'tester',signal:controller.signal,reconnectMs:5,output:line=>{received.push(JSON.parse(line));if(received.length===2)controller.abort();}});
 clearTimeout(timeout);assert.deepEqual(received.map(m=>m.id),['cr1','cr2']);
});
