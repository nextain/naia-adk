#!/usr/bin/env node
"use strict";

const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");

const cwd=path.resolve(process.argv[2]||process.cwd()),settings=path.join(cwd,".claude","settings.json"),core=path.join(cwd,".agents","hooks","core");
const fail=(reason)=>{process.stderr.write(`[beh-launch] FAIL: ${reason}\n`);process.exit(1);};
if(!fs.existsSync(settings))fail(`no ${settings}`);
const settingsBytes=fs.readFileSync(settings);
let registry;
try{registry=JSON.parse(settingsBytes.toString("utf8"));}catch(error){fail(`settings.json is not valid JSON: ${error.message}`);}
const commandTokens=(value)=>String(value||"").match(/"[^"]*"|'[^']*'|\S+/g)?.map((token)=>token.replace(/^["']|["']$/g,""))||[];
const isRequiredNodeHook=(hook,hookName)=>{
	if(hook?.type!=="command")return false;
	const tokens=commandTokens(hook.command);
	const args=Array.isArray(hook.args)?hook.args:[];
	const executable=path.basename(tokens[0]||"").toLowerCase();
	const splitForm=tokens.length===1&&args.length===1;
	const inlineForm=tokens.length===2&&args.length===0;
	if(!splitForm&&!inlineForm)return false;
	const script=(splitForm?args[0]:tokens[1])||"";
	const normalized=String(script).replace(/\\/g,"/").replace(/^\.\//,"");
	return (executable==="node"||executable==="node.exe")
		&&normalized===`.claude/hooks/${hookName}`;
};
const required={UserPromptSubmit:"beh-tick.js",PostToolUse:"beh-record.js",Stop:"beh-stop.js",PreToolUse:"beh-pretool.js"};
for(const [eventName,hookName] of Object.entries(required)){
	const registered=(registry.hooks?.[eventName]||[]).some((entry)=>(entry.hooks||[]).some((hook)=>isRequiredNodeHook(hook,hookName)));
	if(!registered)fail(`hook '${hookName}' not registered for ${eventName} in settings.json`);
}
for(const name of ["beh-ledger","beh-receipts","beh-supervise-core","beh-launch-core"]){const file=path.join(core,`${name}.js`);try{require(file);}catch{fail(`core '${name}.js' not loadable`);}}
const digest=crypto.createHash("sha256").update(settingsBytes).digest("hex"),directory=path.join(cwd,".claude"),destination=path.join(directory,"beh-handshake"),temporary=`${destination}.${process.pid}.tmp`;
fs.mkdirSync(directory,{recursive:true});
try{fs.writeFileSync(temporary,`${JSON.stringify({ts:Date.now(),settings_hash:digest})}\n`,{encoding:"utf8",flag:"wx"});fs.copyFileSync(temporary,destination);fs.unlinkSync(temporary);}catch(error){try{fs.unlinkSync(temporary);}catch{}fail(`cannot publish handshake: ${error.code||error.message}`);}
process.stdout.write(`[beh-launch] handshake OK — hooks registered, cores load, settings_hash=${digest.slice(0,12)}\n`);
