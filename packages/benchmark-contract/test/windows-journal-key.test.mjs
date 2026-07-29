import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

if(process.platform === "win32"){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),script=path.join(root,"scripts","windows-journal-key.ps1"),temp=fs.mkdtempSync(path.join(os.tmpdir(),"naia-dpapi-test-"));
  try{
    const key=path.join(temp,"journal-key.dpapi"),probe=path.join(temp,"probe.mjs");
    fs.writeFileSync(probe,`const key=process.env.NAIA_BENCHMARK_JOURNAL_KEY||'',state={key_length:Buffer.from(key,'base64').length,args:process.argv.slice(2)};process.stdout.write(JSON.stringify(state));if(state.key_length!==32||state.args.join(',')!=='alpha,beta')process.exit(3);process.stdout.write(' probe-ok');`);
    const init=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",script,"-Action","init","-KeyFile",key],{encoding:"utf8",shell:false});
    assert.equal(init.status,0,init.stderr);assert(fs.statSync(key).size>32,"DPAPI ciphertext must not be a plaintext 32-byte key");
    const duplicate=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",script,"-Action","init","-KeyFile",key],{encoding:"utf8",shell:false});assert.notEqual(duplicate.status,0,"init must not overwrite an existing key");
    const encodedArguments=Buffer.from(JSON.stringify(["alpha","beta"]),"utf8").toString("base64");
    const run=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",script,"-Action","exec","-KeyFile",key,"-NodeScript",probe,"-NodeArgumentsBase64",encodedArguments],{encoding:"utf8",shell:false});assert.equal(run.status,0,`${run.stderr}\n${run.stdout}`);assert.match(run.stdout,/probe-ok/u);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}

console.log("Windows journal key: PASS (DPAPI CurrentUser, no plaintext key, no WSL dependency)");
