"use strict";
const os=require("node:os"),fs=require("node:fs");
function childEnvironment(preserveLegacyData=false){const user=os.userInfo();const env={HOME:user.homedir,USER:user.username,LOGNAME:user.username,PATH:"/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8",TMPDIR:"/tmp",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};if(preserveLegacyData)for(const name of["DEPLOY_AUDIT_PATH","DEPLOY_APPROVAL_STATE_DIR","XDG_STATE_HOME","CLAUDE_PROJECT_DIR","NAIA_ADK_ROOT","NAIA_DEPLOY_GUARD_WATCHDOG_MS"])if(process.env[name]!==undefined)env[name]=process.env[name];return env;}
function isRegisteredWatchdogChild(entry,registrationSha){
 if(process.env.NAIA_HOOK_WATCHDOG_CHILD!=="1"||Number(process.env.NAIA_REGISTERED_WATCHDOG_PARENT)!==process.ppid)return false;
 try{const argv=fs.readFileSync(`/proc/${process.ppid}/cmdline`,"utf8").split("\0");return argv[1]===entry&&argv[2]==="hook"&&argv[argv.indexOf("--sha256")+1]===registrationSha;}catch{return false;}
}
module.exports={childEnvironment,isRegisteredWatchdogChild};
