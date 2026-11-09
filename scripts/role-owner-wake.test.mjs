import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gateway from './bot-mention-wake.mjs';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-wake-')); t.after(()=>{for(const r of active)r.stop();fs.rmSync(dir,{recursive:true,force:true});}); const active=[];
 const roles=[{id:'builder',botUserId:'100000000000000001',wakeDir:path.join(dir,'a')},{id:'reviewer',botUserId:'100000000000000002',wakeDir:path.join(dir,'b')}];
 let now=0; const timers=[]; const opts={stateFile:path.join(dir,'owners.json'),now:()=>now,schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},cancel:()=>{}};
 const create=()=>{const r=gateway.createOwnerRouting(roles,opts);active.push(r);return r;}; const message={id:'200000000000000001',guild_id:'300000000000000001',channel_id:'400000000000000001',author:{id:'500000000000000001'},content:`<@${roles[1].botUserId}> <@${roles[0].botUserId}> please help`,mentions:roles.map(r=>({id:r.botUserId}))};
 return {dir,roles,timers,create,message,setNow:n=>now=n,files:()=>roles.flatMap(r=>fs.existsSync(r.wakeDir)?fs.readdirSync(r.wakeDir).filter(f=>f.endsWith('-owner.md')):[])};
}
test('actual gateway routing elects one owner and suppresses other wake handoffs',t=>{
 const f=fixture(t),r=f.create();t.after(()=>r.stop());
 assert.equal(r.allow(f.message,f.roles[0]),false);assert.equal(r.allow(f.message,f.roles[1]),true);
 assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,600000);
});
test('unclaimed owner wakes once across duplicate dispatch and restart; concurrent watcher fails closed',t=>{
 const f=fixture(t);let r=f.create();r.allow(f.message,f.roles[1]);assert.throws(()=>f.create(),/EEXIST/);
 f.setNow(600000);f.timers[0].fn();assert.equal(f.files().length,1);r.stop();
 r=f.create();t.after(()=>r.stop());r.allow(f.message,f.roles[0]);for(const timer of f.timers)timer.fn();assert.equal(f.files().length,1);
});
test('only referenced owner claim with finish time cancels the scheduled wake',t=>{
 const f=fixture(t),r=f.create();t.after(()=>r.stop());r.allow(f.message,f.roles[1]);
 r.observe({...f.message,id:'200000000000000002',author:{id:f.roles[0].botUserId},message_reference:{message_id:f.message.id},content:'맡음 12:30까지'});
 r.observe({...f.message,id:'200000000000000003',author:{id:f.roles[1].botUserId},message_reference:{message_id:f.message.id},content:'맡음'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'owners.json')))[f.message.id].claimed,false);
 r.observe({...f.message,id:'200000000000000004',author:{id:f.roles[1].botUserId},message_reference:{message_id:f.message.id},content:'맡음 12:30까지'});
 f.setNow(600000);for(const timer of f.timers)timer.fn();assert.equal(f.files().length,0);
});
test('routing resumes an unclaimed timer after restart without extending ten minute deadline',t=>{
 const f=fixture(t);let r=f.create();r.allow(f.message,f.roles[1]);r.stop();f.setNow(300000);r=f.create();t.after(()=>r.stop());assert.equal(f.timers.at(-1).ms,300000);f.setNow(600000);f.timers.at(-1).fn();assert.equal(f.files().length,1);
});
