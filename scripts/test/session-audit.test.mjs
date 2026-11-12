import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixture, collectSignals, defaultEvidencePaths } from '../lib/audit-signals.mjs';
import { evaluate, initialState, validReset } from '../lib/audit-rules.mjs';
import { runFixture } from '../session-audit.mjs';

const root = 'scripts/test/fixtures/session-audit/';
const incident = `${root}case-20261111`, normal = `${root}case-normal`;
const ms = s => Date.parse(s), end = ms('2026-11-12T03:40:00Z');
const data = await readFixture(incident), sig = collectSignals(data, { now: end });
const known = value => ({ value, unknown: false, reason: null });
const absent = { value: null, unknown: true, reason: 'unreadable' };

for (const [id, check] of Object.entries({
  S1: v => assert.deepEqual(v.map(p => p.files.length), [35,19,17,15,5]),
  S2: v => assert.equal(v[0].results[0].blocking, 5),
  S3: v => { const max = Math.max(...v.gaps.map(g => g.hours)); assert.ok(max > 7.59 && max < 7.61); },
  // The fixture includes the 03Z hour, which the design's 3,363 excludes.
  S4: v => assert.equal(v.hours.reduce((n,h) => n+h.total,0), 3363),
  // The fixture contains 26 matching edits, one fewer than the design's 27.
  S5: v => assert.equal(v.edits.filter(e => e.file === 'deploy-readiness.js').length, 26),
  S6: v => assert.equal(v.length, 78),
  S7: v => assert.equal(v.count, 1259),
  S8: v => assert.ok(v.rows.length > 0),
  S10: v => assert.equal(v.length, 143),
})) test(`collector ${id}`, () => { assert.equal(sig[id].unknown, false); check(sig[id].value); });

test('S3 evidence paths include role documents by default and support strict paths', () => {
  assert.deepEqual(defaultEvidencePaths, ['priority','role-doc']);
  const strict = collectSignals(data, { now: end, evidencePaths: ['priority'] }).S3.value;
  assert.ok(Math.max(...strict.gaps.map(g => g.hours)) > 17.2);
  assert.ok(Math.max(...sig.S3.value.gaps.map(g => g.hours)) < 7.7);
  assert.ok(sig.S3.value.gaps.some(g => g.hours > 7.04 && g.hours < 7.06));
});
test('unreadable fixture inputs remain unknown', async () => {
  const input = await readFixture('unused', { read: async () => { throw Error('denied'); } });
  for (const signal of Object.values(collectSignals(input, { now: end }))) assert.equal(signal.unknown, true);
});

test('T1 fixture replay transitions use observed file times and half-hour ticks', async () => {
  const { timeline } = await runFixture({ fixture: incident, from: ms('2026-11-11T07:00Z'), to: ms('2026-11-12T03:30Z') });
  const find = (code, target, stage) => timeline.filter(e => e.code === code && e.target === target && e.stage === stage);
  // The fourth file is already present at 09:30; the design's 10:00 is illustrative.
  assert.equal(find('repeat-review','plan-01','warn')[0].at, ms('2026-11-11T09:30Z'));
  assert.equal(find('cap-ignored','plan-01','report')[0].at, ms('2026-11-11T10:00Z'));
  assert.equal(find('priority-idle','priority','warn')[0].at, ms('2026-11-11T12:30Z'));
  assert.equal(find('priority-idle','priority','report')[0].at, ms('2026-11-11T15:30Z'));
  assert.equal(find('self-gate-change','','report')[0].at, ms('2026-11-11T15:00Z'));
  assert.ok(new Set(timeline.filter(e => e.code === 'repeat-review' && e.stage === 'warn').map(e => e.target)).size >= 4);
  assert.ok(timeline.filter(e => e.code === 'cap-ignored' && e.stage === 'report').length >= 2);
  assert.ok(find('wake-backlog','','warn').length);
});
test('T2 normal fixture has no alerts', async () => {
  const { timeline } = await runFixture({ fixture: normal, from: ms('2026-11-13T00:00Z'), to: ms('2026-11-13T20:00Z') });
  assert.deepEqual(timeline, []);
});
const base = ms('2026-01-01T00:00:00Z');
function stable() { return { S1: known([]), S2: known([]), S3: known({lastAt: base - 5*3600000,idleHours: 5}), S4: known({hours:[{at: base-4*3600000,total: 100}]}), S5: known({edits:[],commits:[]}), S6: known([]), S7: known({count:0,oldestAt:null,oldestHours:0}), S8: known({rows:[]}), S10: known([]) }; }
function run(s, state, minute, options) { return evaluate(s, state, base + minute*60000, options); }
function started() { return { ...initialState(), initialized: true }; }

test('T5 one warning and one report per continuing episode', () => {
  const s = stable(); let state = started(), events = [];
  for (let i=0;i<=1440;i+=30) { const r=run(s,state,i); state=r.state; events.push(...r.events); }
  assert.deepEqual(events.filter(e => e.code === 'priority-idle').map(e => e.stage), ['warn','report']);
});
test('T7 approval waiting excludes the linked priority', () => {
  const s = stable(); s.S8 = known({rows:[{target:'priority',approvalWaiting:true}]});
  assert.equal(run(s,initialState(),0).events.length,0);
});
test('T10 self claims cannot reset the counter and defer once', () => {
  assert.equal(validReset({target:'p',kind:'method-claim',at:base},'p',base), false);
  assert.equal(validReset({target:'p',kind:'other-role-review',authorRole:'a',auditedRole:'a',at:base},'p',base), false);
  assert.equal(validReset({target:'p',kind:'human-approval',humanMessageId:'message-1',at:base},'p',base), false);
  assert.equal(validReset({target:'p',kind:'human-approval',humanMessageId:'message-1',at:base},'p',base, () => true), true);
  assert.equal(validReset({target:'p',kind:'upstream-pr',verified:true,otherRoleReview:true,at:base},'p',base, () => true), true);
  const s=stable(); let r=run(s,started(),0); const evidence=[{id:'a',kind:'method-claim',target:'priority',at:base+60*60000}];
  r=run(s,r.state,60,{evidence}); assert.equal(r.events.length,0); assert.equal(r.state.episodes['priority-idle:priority'].note,'방식 바꿈 주장(미검증)');
  r=run(s,r.state,90,{evidence}); assert.equal(r.events[0].stage,'report');
});
test('T10 plan changes do not reset reviews and delay the cap report for one cycle', () => {
  const s=stable(); s.S3=known({lastAt:base,idleHours:0});
  const files=Array.from({length:7},(_,i)=>({name:String(i),at:new Date(base-i*60000).toISOString()}));
  s.S1=known([{plan:'p',files}]); let r=run(s,started(),0);
  assert.equal(r.state.episodes['repeat-review:p'].startCount,7);
  const evidence=[{id:'claim',kind:'method-claim',target:'p',at:base+30*60000}];
  s.S1=known([{plan:'p',files:[...files,{name:'7',at:new Date(base+15*60000).toISOString()},{name:'8',at:new Date(base+20*60000).toISOString()}]}]);
  r=run(s,r.state,30,{evidence}); assert.ok(!r.events.some(e=>e.code==='cap-ignored'));
  assert.equal(r.state.episodes['cap-ignored:p'].note,'방식 바꿈 주장(미검증)');
  r=run(s,r.state,60,{evidence}); assert.ok(r.events.some(e=>e.code==='cap-ignored' && e.stage==='report'));
});
test('review deletion cannot prove recovery or hide an episode', () => {
  const s=stable(); s.S3=known({lastAt:base,idleHours:0});
  s.S1=known([{plan:'p',files:Array.from({length:7},(_,i)=>({name:String(i),at:new Date(base-i*60000).toISOString()}))}]);
  let r=run(s,started(),0); assert.ok(r.state.episodes['repeat-review:p']);
  s.S1=known([{plan:'p',files:[]}]); r=run(s,r.state,30);
  assert.ok(r.state.episodes['repeat-review:p']);
});
test('S4 excludes the incomplete hour during replay', () => {
  const at = ms('2026-11-12T04:00Z');
  const s = collectSignals(data,{now:at});
  assert.equal(s.S4.value.hours.reduce((n,h)=>n+h.total,0),3588);
});
test('first observation establishes a silent baseline', () => {
  const s=stable(); let r=run(s,initialState(),0); assert.deepEqual(r.events,[]);
  r=run(s,r.state,30); assert.equal(r.events[0].stage,'warn');
});
test('T11 two core read failures for two runs report blindness once', () => {
  const s=stable(); s.S1=absent; s.S3=absent; let r=run(s,initialState(),0);
  assert.equal(r.events.length,0); r=run(s,r.state,30); assert.equal(r.events.filter(e=>e.code==='audit-blind').length,1);
  r=run(s,r.state,60); assert.equal(r.events.filter(e=>e.code==='audit-blind').length,0);
});
test('T13 same-status updates are not response evidence', () => {
  const s=stable(); let r=run(s,started(),0);
  const evidence=[{id:'a',target:'priority',kind:'status-transition',from:'blocked',to:'blocked',at:base+30*60000}];
  r=run(s,r.state,60,{evidence}); assert.equal(r.events[0].stage,'report');
});
test('T14 only two resolving transitions defer a report', () => {
  const s=stable(); let r=run(s,started(),0); const evidence=[];
  for (const minute of [60,90,120]) { evidence.push({id:String(minute),target:'priority',kind:'status-transition',from:'blocked',to:'waiting',at:base+minute*60000}); r=run(s,r.state,minute,{evidence}); }
  assert.equal(r.events[0].stage,'report'); assert.equal(r.state.episodes['priority-idle:priority'].deferrals,3);
});
