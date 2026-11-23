import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadRegistry,deliver} from '../role-wake.mjs';
import {ledgerPath} from './ledger.mjs';
import {writeLedgerWake,watch as ledgerWatch} from './ledger-watch.mjs';
import {dueWake,receiptPath} from './due-timer.mjs';
import {cardWakePublisher} from './card-wake.mjs';
const NOW=Date.parse('2026-01-10T00:00:00Z'),SOURCE_CHANNEL='300000000000000002',ORIGINAL_MESSAGE='300000000000000003',STAGE_MESSAGE='300000000000000004';
const ledgerRow=(id,patch={})=>({id,title:id,status:'open',from:{channel:SOURCE_CHANNEL,msg_id:ORIGINAL_MESSAGE,quote:''},due:'2026-01-11T00:00:00Z',checked_at:null,note:'',worker:null,...patch});
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-ledger-')),root=path.join(dir,'live'),file=path.join(dir,'registry.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const doc={schema_version:1,root,wake_root:'wake',state_dir:path.join(dir,'state'),pane:{kind:'herdr',bin:'/fake/herdr'},delivery:{command:['/fake/receive','{role}','{file}']},roles:{'role-a':{tools:['codex'],find:{pane_id:'fixture:p1'},wake_subdir:''}}};
 const write=()=>fs.writeFileSync(file,JSON.stringify(doc));write();const state={runs:[]};
 const deps={now:()=>NOW,run:(bin,args)=>{assert.equal(bin,'/fake/receive');state.runs.push(args);return'';},paneProcesses:()=>[{pid:101,args:'codex'}],processes:()=>[{pid:101,args:'codex'}],crontab:()=>''};
 return{dir,root,doc,write,state,deps,load:()=>loadRegistry(file)};
}
function ledgerWatcher(f,items,role='role-a'){
 f.doc.wake_root='.agents/work/l4/wake';f.doc.delivery.max_per_run=100;f.write();const inbox=path.join(f.root,f.doc.wake_root),ledger=ledgerPath(f.root,role);fs.mkdirSync(inbox,{recursive:true});
 const save=()=>{fs.mkdirSync(path.dirname(ledger),{recursive:true});fs.writeFileSync(ledger,JSON.stringify({version:1,role,items,report:{every_min:0,channel:'',last_msg_id:null,last_at:null}}));};save();
 const config=path.join(f.dir,'ledger.json'),clock=path.join(f.dir,'clock.cjs');fs.writeFileSync(config,JSON.stringify({roles:[{role,channels:[],human_ids:[]}]}));fs.writeFileSync(clock,'Date.now=()=>Number(process.env.LEDGER_FIXTURE_NOW);\n');
 const cli=fileURLToPath(new URL('./ledger-watch.mjs',import.meta.url));const scan=(minutes=0)=>{const out=JSON.parse(execFileSync(process.execPath,['--require',clock,cli,'--root',f.root,'--config',config],{env:{...process.env,ADK_FORBID_SYSTEM_RUNNER:'1',LEDGER_FIXTURE_NOW:String(NOW+minutes*60000)},encoding:'utf8'}));assert.deepEqual(out.errors,[]);return out.wakes;};
 return{inbox,scan,save,pending:()=>fs.readdirSync(inbox).filter(name=>name.endsWith('.md')).sort()};
}

test('semantic deadline and report facts remain one event pending and after consumer receipts', t => {
  for (const consume of [false, true]) {
    const f = setup(t), cards = [ledgerRow('due-card', { due: '2026-01-09T00:00:00Z' }), ledgerRow('human-card', { due: '2026-01-09T00:00:00Z', status: 'waiting_human' })];
    const flow = ledgerWatcher(f, cards);
    f.doc.roles['role-a'].ledger = path.relative(f.root, ledgerPath(f.root, 'role-a')); f.write();
    const file = ledgerPath(f.root, 'role-a'), ledger = JSON.parse(fs.readFileSync(file));
    ledger.report = { every_min: 180, channel: SOURCE_CHANNEL, last_at: null, last_msg_id: null }; fs.writeFileSync(file, JSON.stringify(ledger));
    const registry = f.load(), pump = () => deliver(registry, f.deps, { only: 'role-a' }).roles['role-a']; pump();
    const initial = flow.scan(); assert.equal(initial.length, 3); const original = flow.pending();
    assert.ok(original.every(name => name.startsWith('event-')));
    if (consume) assert.equal(pump().delivered, 3);
    const received = f.state.runs.length;
    for (const minutes of [31, 61, 180, 360, 2 * 24 * 60]) {
      assert.deepEqual(flow.scan(minutes), []); assert.deepEqual(flow.pending(), original);
      if (consume) assert.equal(pump().delivered, 0);
    }
    assert.equal(f.state.runs.length, received);
    assert.equal(JSON.parse(fs.readFileSync(file)).items[1].due, cards[1].due);
    // The pending originals and their existing receipts survive a real revision.
    const revise = mutate => { const j = JSON.parse(fs.readFileSync(file)); mutate(j); fs.writeFileSync(file, JSON.stringify(j)); };
    for (const [i, mutate] of [
      j => { j.items[0].due = '2026-01-08T00:00:00Z'; },
      j => { j.items[0].status = 'waiting_human'; },
      j => { j.items[0].result = 'actual-result.md'; },
      j => { j.report.last_at = '2026-01-10T00:00:00Z'; j.report.last_msg_id = STAGE_MESSAGE; },
    ].entries()) {
      revise(mutate); assert.equal(flow.scan(2 * 24 * 60 + i + 1).length, 1);
      assert.deepEqual(flow.scan(2 * 24 * 60 + i + 1), []);
      if (consume) assert.equal(pump().delivered, 1);
    }
    const prior = flow.pending(); revise(j => { j.items[0].status = 'done'; }); assert.deepEqual(flow.scan(3000), []);
    assert.deepEqual(flow.pending(), prior); revise(j => { j.items[0].status = 'open'; }); assert.equal(flow.scan(3001).length, 1);
  }
});

test('semantic overdue upgrade adopts matching legacy pending and delivered facts but publishes a changed due', async t => {
  const f = setup(t), card = ledgerRow('due-card', { due: '2026-01-09T00:00:00Z' }), flow = ledgerWatcher(f, [card]);
  const registry = f.load(), pump = () => deliver(registry, f.deps, { only: 'role-a' }).roles['role-a']; pump();
  await writeLedgerWake(flow.inbox, { stamp: new Date(NOW).toISOString().replace(/\D/g, ''), role: 'role-a', id:card.id,
    reason:'기한 넘음',title:card.title,details:`출처: ${card.from.channel}/${card.from.msg_id}\n기한: ${card.due}\n결과: (없음)` });
  assert.equal(pump().delivered, 1); const before = fs.readFileSync(path.join(registry.stateDir, 'delivered-role-a.jsonl'));
  const sent = { [JSON.stringify(['role-a',card.id,'기한 넘음',card.due])]:NOW, [JSON.stringify(['role-a',card.id,'기한 넘음'])]:NOW };
  fs.writeFileSync(path.join(path.dirname(ledgerPath(f.root,'role-a')),'watch-state.json'),JSON.stringify({version:1,sent}));
  assert.deepEqual(flow.scan(61),[]);assert.equal(pump().delivered,0);assert.deepEqual(fs.readFileSync(path.join(registry.stateDir,'delivered-role-a.jsonl')),before);
  card.due='2026-01-08T00:00:00Z';flow.save();assert.equal(flow.scan(62).length,1);assert.equal(pump().delivered,1);
});

test('semantic deadline recovery keeps one durable original across receipt/state/flush crash boundaries', async t => {
  for (const boundary of ['before-observe','after-receipt','after-state','after-flush','timer-after-publish']) {
    const f = setup(t), card = ledgerRow('due-card',{due:'2026-01-09T00:00:00Z'}), flow = ledgerWatcher(f,[card]);
    const stateFile = path.join(path.dirname(ledgerPath(f.root,'role-a')),'watch-state.json');
    const state = {version:1,sent:{},card_events:{}}, wakes=[];
    const publisher = cardWakePublisher({root:f.root,wakeDir:flow.inbox,state,wakes,oldWakeFiles:[]});
    const details=`출처: ${card.from.channel}/${card.from.msg_id}\n기한: ${card.due}\n결과: (없음)`;
    const observe=async()=>{
      if(boundary==='before-observe')throw Error('simulated crash');
      await publisher.observe({role:'role-a',item:card,reason:'기한 넘음',details,
        revision:[card.status,card.title,card.due,card.from.channel,card.from.msg_id,null,null],
        legacyKey:JSON.stringify(['role-a',card.id,'기한 넘음',card.due])});
      assert.equal(fs.readdirSync(path.join(flow.inbox,'.ledger-card-outbox')).length,1);
    };
    const emit=async()=>{
      assert.equal(JSON.parse(fs.readFileSync(receiptPath(f.root,'role-a',card.id,card.due))).status,'claimed');
      if(boundary==='after-flush'){
        fs.writeFileSync(stateFile,JSON.stringify(state));await publisher.flush(true);throw Error('simulated crash');
      }
      if(boundary==='timer-after-publish'){
        await writeLedgerWake(flow.inbox,{stamp:new Date(NOW).toISOString().replace(/\D/g,''),role:'role-a',id:card.id,reason:'정한 시각',title:card.title,details});
        throw Error('simulated crash');
      }
    };
    const options={root:f.root,role:'role-a',id:card.id,due:card.due,now:NOW,source:boundary==='timer-after-publish'?'timer':'watch',emit,...(boundary==='timer-after-publish'?{}:{observe})};
    if(['before-observe','after-flush','timer-after-publish'].includes(boundary)) await assert.rejects(dueWake(options),/simulated crash/);
    else { assert.equal(await dueWake(options),true); if(boundary==='after-state')fs.writeFileSync(stateFile,JSON.stringify(state)); }
    if(boundary==='before-observe')assert.equal(fs.existsSync(receiptPath(f.root,'role-a',card.id,card.due)),false);
    const runner=async()=>{throw Error('system operation forbidden')};
    const config={roles:[{role:'role-a',channels:[]}],due_timer:{enabled:true}};
    for(const minutes of [1,31,61]){
      const result=await ledgerWatch({root:f.root,config,runner,now:NOW+minutes*60000});assert.deepEqual(result.errors,[]);
      assert.equal(flow.pending().length,1,boundary);
    }
    assert.equal(JSON.parse(fs.readFileSync(receiptPath(f.root,'role-a',card.id,card.due))).status,'sent');
    assert.equal(fs.existsSync(path.join(flow.inbox,'.ledger-card-outbox'))?fs.readdirSync(path.join(flow.inbox,'.ledger-card-outbox')).length:0,0);
  }
});

test('disabled timer repairs an existing claimed receipt without repeating the published original', async t => {
 const f=setup(t),card=ledgerRow('due-card',{due:'2026-01-09T00:00:00Z'}),flow=ledgerWatcher(f,[card]);
 const receipt=receiptPath(f.root,'role-a',card.id,card.due);fs.mkdirSync(path.dirname(receipt),{recursive:true});
 fs.writeFileSync(receipt,JSON.stringify({role:'role-a',id:card.id,due:card.due,status:'claimed',at:NOW-60000}));
 const config={roles:[{role:'role-a',channels:[]}],due_timer:{enabled:false}};
 const forbidden=async()=>assert.fail('disabled recovery must not call a system runner');
 const first=await ledgerWatch({root:f.root,config,now:NOW,runner:forbidden});
 assert.equal(first.wakes.length,1);assert.equal(JSON.parse(fs.readFileSync(receipt)).status,'sent');
 for(const minutes of [31,61,360]){assert.deepEqual((await ledgerWatch({root:f.root,config,now:NOW+minutes*60000,runner:forbidden})).wakes,[]);assert.equal(flow.pending().length,1);}
});
