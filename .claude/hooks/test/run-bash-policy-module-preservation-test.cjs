"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),Module=require("node:module"),{execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,"../../.."),file=path.join(root,".agents/hooks/policies/bash.js"),current=require(file);
const baseline=new Module(file,module);baseline.filename=file;baseline.paths=Module._nodeModulePaths(path.dirname(file));baseline._compile(execFileSync("/usr/bin/git",["show","995405a67fa07bdf376f71fb631e2028a776d85b:.agents/hooks/policies/bash.js"],{cwd:root,encoding:"utf8"}),file);
test("policy modules preserve every public export and unchanged policy decisions",async t=>{
 assert.deepEqual(Object.keys(current).sort(),Object.keys(baseline.exports).sort());
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"bash-module-preservation-"));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));const script=path.join(tmp,"untracked.py");fs.writeFileSync(script,"print('fixture')\n");
 const cases={destructiveGit:["git reset --hard","git status","printf git reset --hard"],catastrophicDelete:["rm -rf /","rm -rf /tmp/ordinary-cleanup","printf rm -rf /"],commit:["git commit -m fixture","git status"],gitPush:["git push --force origin main","git push origin feature","git push origin :main"],emailSend:["node send.js send","node send.js preview"],prGuard:["gh pr merge 1 --admin","gh pr create --repo nextain/naia-adk","gh pr create --repo external/example"],uncommittedArtifact:[`python ${script} out.nva`,`python ${script} ordinary.txt`,`env python ${script} out.exe`],detachedWorker:["codex exec 'fixture' &","printf fixture"]};
 for(const [name,commands]of Object.entries(cases))for(const command of commands){const args=[command,{cwd:tmp},{cwd:tmp}];assert.deepEqual(await current[name](...args),await baseline.exports[name](...args),name+": "+command);}
 for(const name of["DEFAULT_ARTIFACT_EXTENSIONS","DEFAULT_ARTIFACT_SCRIPT_DIRS","ARTIFACT_DRIFT_MESSAGE","PR_FAIL_REASON"])assert.deepEqual(current[name],baseline.exports[name]);
});
