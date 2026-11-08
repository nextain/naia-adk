"use strict";
require('./test-signal-safety.cjs');
const cp=require('node:child_process'),path=require('node:path');
let failed=false;
for(const script of ['run-safe-workspace-tests.cjs','run-safe-hook-tests.cjs']){
 const r=cp.spawnSync(process.execPath,[path.join(__dirname,script)],{stdio:'inherit',cwd:path.resolve(__dirname,'..')});
 if(r.error||r.status!==0)failed=true;
}
process.exitCode=failed?1:0;
