import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { roleSessionFlowFixture as fixture } from './test/role-session-flow-fixture.mjs';

for(const mode of ['execve','node-child','daemon'])test(`actual common CLI model-free normal startup: ${mode}`,async t=>{
  const f=await fixture(t,mode);assert.equal(f.send().code,0);assert.equal(f.verify().status,'accepted');
  assert.equal(f.send().code,0);assert.equal(await f.count(),1);assert.equal(await fs.readFile(f.input,'utf8'),f.text);
});

test('actual common CLI preserves an unknown attempt and accepts late native ACK without reinput',async t=>{
  const f=await fixture(t,'node-child');await fs.writeFile(f.meta,JSON.stringify({...f.data,ack:false}));
  assert.equal(f.send().code,75);assert.equal(await f.count(),1);
  assert.equal(f.verify().status,'unknown');assert.equal(f.send().code,75);assert.equal(await f.count(),1);
  await fs.appendFile(f.native,JSON.stringify({type:'response_item',payload:{role:'user',content:[{type:'input_text',text:f.text}]}})+'\n');
  assert.equal(f.verify().status,'accepted');assert.equal(await f.count(),1);
});

for(const mode of ['execve','node-child','daemon'])test(`model-free prepare automatically publishes normal startup lease: ${mode}`,async t=>{
  const f=await fixture(t,mode,{prepare:true,ownerRpc:mode==='daemon'});
  assert.equal(f.send().code,0);assert.equal(f.verify().status,'accepted');assert.equal(await f.count(),1);
});
