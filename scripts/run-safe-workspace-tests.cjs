"use strict";
require('./test-signal-safety.cjs');
const cp=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..');
// Preserve the original package suites and standalone workspace tests.
let failed=false;
for(const [command,args] of [['pnpm',['-r','test']],[process.execPath,['--experimental-test-isolation=none','--test','scripts/adk-setup.test.mjs','scripts/adk-board.test.mjs','scripts/doc-size-refactor.test.mjs']]]){
 const r=cp.spawnSync(command,args,{cwd:root,stdio:'inherit'});if(r.error||r.status!==0)failed=true;
}
process.exitCode=failed?1:0;
