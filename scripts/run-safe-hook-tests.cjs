#!/usr/bin/env node
"use strict";
// This runner never sends signals or wraps tests in a wall-clock kill timeout.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const safety=path.resolve(__dirname,'test-signal-safety.cjs');require(safety);
const root=path.resolve(process.argv[2]||'.'),out=path.resolve(process.argv[3]||'safe-hook-results');fs.mkdirSync(out,{recursive:true});
const walk=dir=>fs.existsSync(path.join(root,dir))?fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]):[];
const files=[...walk('.claude/hooks'),...walk('.agents/hooks'),...walk('.codex/hooks'),...walk('.opencode')].filter(f=>(f.startsWith('.claude/hooks/test/run-')||/^\.claude\/hooks\/test-[^/]+$/.test(f)||f.startsWith('.claude/hooks/')&&/\.test\.(?:c?js)$/.test(f)||/\.test\.(?:c?js)$/.test(f)&&f.startsWith('.agents/hooks/')||f.startsWith('.agents/hooks/core/test-')||f.startsWith('.codex/hooks/test-')||/^\.opencode\/(?:plugins\/|tests\/)?test-/.test(f))&&/\.(?:c?js)$/.test(f));
const results=[];for(const file of files){
 if(file.endsWith('run-beh-supervise-wrapper-test.js')){results.push({file,excluded:'forbidden real-signal wrapper'});continue;}
 const res=cp.spawnSync(process.execPath,['--require',safety,path.join(root,file)],{cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=${safety}`},maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(out,file.replaceAll('/','_')+'.log'),(res.stdout||'')+(res.stderr||''));results.push({file,status:res.status,error:res.error?.message});
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({tests:results.length,failed:results.filter(r=>r.status!==undefined&&r.status!==0).map(r=>r.file),excluded:results.filter(r=>r.excluded)},null,2));
