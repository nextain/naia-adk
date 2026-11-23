"use strict";
// Read-only Git queries shared by registered installation and runtime paths.
const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
function canonicalDirectory(root){
 if(typeof root!=="string"||!path.isAbsolute(root)||path.resolve(root)!==root||/[\x00-\x1f\x7f]/.test(root)||fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw new Error("Registered Git root is not canonical");
 return root;
}
function filesystemGitRoot(cwd){
 let current=canonicalDirectory(cwd);
 for(;;){
  try{const st=fs.lstatSync(path.join(current,".git"));if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())throw new Error("Registered Git marker is not regular");return current;}catch(error){if(error.code!=="ENOENT")throw error;}
  const parent=path.dirname(current);if(parent===current)throw new Error("Registered Git root is missing");current=parent;
 }
}
function registeredGitResult(cwd,args,{encoding="utf8",maxBuffer=8*1024*1024}={}){
 const root=filesystemGitRoot(cwd),env={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"};
 return spawnSync("/usr/bin/git",["--no-optional-locks","-c",`safe.directory=${root}`,"-c","core.fsmonitor=false","-C",cwd,...args],{env,encoding,maxBuffer,timeout:8000});
}
function registeredGit(cwd,args,options){
 const result=registeredGitResult(cwd,args,options);
 if(result.status!==0||result.error){const error=new Error("Registered Git query failed");error.status=result.status;error.code=result.error?.code;throw error;}
 return result.stdout;
}
function assertRegisteredGitIdentity({root,commit}){
 const fail=()=>{throw new Error("Registered Git identity: engine root/commit must identify a clean checkout");};
 if(typeof commit!=="string"||!/^[a-f0-9]{40}$/.test(commit))fail();
 try{canonicalDirectory(root);if(registeredGit(root,["rev-parse","--show-toplevel"]).trim()!==root||registeredGit(root,["rev-parse","HEAD"]).trim()!==commit||registeredGit(root,["status","--porcelain","--untracked-files=all"]).trim())fail();}catch{fail();}
}
module.exports=Object.freeze({assertRegisteredGitIdentity,registeredGit,registeredGitResult});
