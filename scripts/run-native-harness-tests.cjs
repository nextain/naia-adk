#!/usr/bin/env node
"use strict";

const cp=require("node:child_process");
const fs=require("node:fs");
const path=require("node:path");

const root=path.resolve(__dirname,"..");
const poisonEnv={...process.env,WSL_INTEROP:"NAIA_NATIVE_WINDOWS_POISON",BASH_ENV:"NAIA_NATIVE_WINDOWS_POISON",MSYSTEM:"NAIA_NATIVE_WINDOWS_POISON"};
const runs=[
  ["entry-point sync",[".claude/hooks/test/run-sync-entry-points-test.cjs"]],
  ["agents context mirror",[".claude/hooks/test/run-agents-context-mirror-test.cjs"]],
  ["BEH ledger",[".claude/hooks/test/run-beh-ledger-test.js"]],
  ["BEH receipts",[".claude/hooks/test/run-beh-receipts-test.js"]],
  ["BEH supervise",[".claude/hooks/test/run-beh-supervise-test.js"]],
  ["BEH pretool",[".claude/hooks/test/run-beh-pretool-test.js"]],
  ["BEH registry",[".claude/hooks/test/run-beh-registry-test.js"]],
  ["BEH manifest",[".claude/hooks/test/run-beh-manifest-test.js"]],
  ["BEH adapter",[".claude/hooks/test/run-beh-adapter-test.js"]],
  ["BEH supervise wrapper",[".claude/hooks/test/run-beh-supervise-wrapper-test.js"]],
  ["BEH watchdog",[".claude/hooks/beh-watchdog.js","--selftest"]],
  ["request contract",["scripts/run-request-contract-tests.cjs"]]
];

for(const [label,args] of runs){
  if(!/\.(?:c?js|mjs)$/.test(args[0]))throw new Error(`${label}: aggregate entrypoint must be native Node, got ${args[0]}`);
  const resolved=path.join(root,args[0]);
  if(!fs.existsSync(resolved))throw new Error(`${label}: missing native test entrypoint ${args[0]}`);
  const result=cp.spawnSync(process.execPath,[resolved,...args.slice(1)],{cwd:root,env:poisonEnv,encoding:"utf8",shell:false,maxBuffer:32*1024*1024,timeout:180000});
  if(result.error||result.status!==0){process.stderr.write(`${label}: FAIL\n${result.stderr||result.stdout||result.error?.message||"no diagnostic"}\n`);process.exit(1);}
  process.stdout.write(`${label}: PASS\n`);
}

const privateGcsFixture=path.join(root,".claude","hooks","test","gcs-guard.fixtures.json");
if(fs.existsSync(privateGcsFixture))throw new Error("public naia-adk must not contain a private GCS bucket fixture");
process.stdout.write("GCS guard: NOT_APPLICABLE (public base has no private bucket config or fixture; downstream must add its own native gate)\n");

const entrypoints=["AGENTS.md","CLAUDE.md","GEMINI.md"].map(file=>fs.readFileSync(path.join(root,file)));
if(!entrypoints.slice(1).every(bytes=>bytes.equals(entrypoints[0])))throw new Error("native entry-point byte equality failed");
process.stdout.write(`native harness: PASS (${runs.length} native Node entrypoints, 1 explicit downstream-only skip; Node ${process.version}; platform ${process.platform}; direct entrypoints are shell-free; the Windows BEH test separately pins native CPython and rejects command-wrapper redirection; this is not an OS-wide process audit)\n`);
