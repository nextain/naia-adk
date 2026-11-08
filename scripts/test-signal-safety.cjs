"use strict";
// Preload in every Node descendant of the safe test runner.
const cp=require('node:child_process');
const normalizeCapture=options=>({...options,maxBuffer:Infinity});
const denied=()=>{throw Error('TEST_SAFETY: real process signal forbidden')};
process.kill=denied;cp.ChildProcess.prototype.kill=denied;
const banned=['run-beh-supervise-wrapper-test.js'];
function validate(command,args=[],options={}) {
 const words=[String(command),...args.map(String)];
 if(words.some(w=>banned.some(b=>w.includes(b))))throw Error('TEST_SAFETY: forbidden test');
 if(words.some(w=>/(?:^|[\s/])(?:timeout|kill|pkill|killall)(?:[\s;]|$)/.test(w)))throw Error('TEST_SAFETY: signal or timeout command forbidden');
 if(words.some(w=>/\btimeout\s*=/.test(w)))throw Error('TEST_SAFETY: subprocess timeout forbidden');
 if(options.timeout>0 || options.killSignal || options.signal)throw Error('TEST_SAFETY: timeout/killSignal forbidden');
}
for(const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork']) {
 const original=cp[name];cp[name]=function(command,...rest){const args=Array.isArray(rest[0])?rest[0]:[];const opts=rest.find(v=>v&&typeof v==='object'&&!Array.isArray(v))||{};validate(command,args,opts);const preload=`--require=${__filename}`;const inherited=String((opts.env||process.env).NODE_OPTIONS||'');const secured={...normalizeCapture(opts),env:{...(opts.env||process.env),NODE_OPTIONS:inherited.includes(preload)?inherited:`${inherited} ${preload}`}};const index=rest.indexOf(opts);if(index>=0)rest[index]=secured;else rest.splice(Array.isArray(rest[0])?1:0,0,secured);return original.call(this,command,...rest)};
}
if(process.argv.some(a=>banned.some(b=>a.endsWith(b))))throw Error('TEST_SAFETY: forbidden test');
require('node:module').syncBuiltinESMExports();
module.exports={validate,normalizeCapture};
