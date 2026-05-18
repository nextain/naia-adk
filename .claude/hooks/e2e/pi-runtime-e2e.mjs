// REAL pi-runtime E2E for G-OC01 part2 — committed gate.
//
// pi's actual extension loader + runner execute our actual
// .pi/extensions/naia-harness.ts. NOT simulation:
//   pi.discoverAndLoadExtensions (jiti) loads the .ts;
//   pi.ExtensionRunner.emitToolCall / .emitBeforeAgentStart dispatch its
//   handlers exactly as pi does at runtime. Mirrors pi's own
//   extensions-runner.test.ts harness construction.
//
// PREREQ (not a zero-dep gate — pi runtime required):
//   mkdir -p /tmp/pi-e2e && cd /tmp/pi-e2e \
//     && npm i @earendil-works/pi-coding-agent@0.74.1
//   node --experimental-vm-modules \
//     -e "process.env.NODE_PATH='/tmp/pi-e2e/node_modules'" ...   (or:)
//   cd /tmp/pi-e2e && node <path-to-this-file>
// i.e. run with cwd / NODE_PATH where the pi package is installed so
// `import "@earendil-works/pi-coding-agent"` resolves. Repo paths are
// derived from this file's location (portable across ADK forks).
import * as pi from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// <repo>/.claude/hooks/e2e/this → naia-adk root = up 4
const HERE = path.dirname(fileURLToPath(import.meta.url));
// naia-adk root: env override (for run from a pi-installed scratch dir) or
// derived from this file's location (<root>/.claude/hooks/e2e/ → up 3).
const NAK = process.env.NAIA_ADK_ROOT || path.resolve(HERE, "..", "..", "..");
let P = 0, F = 0;
const ok = (c, m) => { c ? P++ : F++; console.log((c ? "PASS " : "FAIL ") + m); };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rt-e2e-"));
fs.cpSync(path.join(NAK, ".agents/hooks"), path.join(WS, ".agents/hooks"), { recursive: true });
fs.mkdirSync(path.join(WS, ".pi/extensions"), { recursive: true });
fs.copyFileSync(path.join(NAK, ".pi/extensions/naia-harness.ts"), path.join(WS, ".pi/extensions/naia-harness.ts"));
fs.mkdirSync(path.join(WS, ".agents/progress"), { recursive: true });
fs.writeFileSync(path.join(WS, ".agents/progress/t.json"),
  JSON.stringify({ issue: "PI-RT", current_phase: "build", session_id: "RTSID" }));
fs.mkdirSync(path.join(WS, ".claude/deploy"), { recursive: true });
fs.writeFileSync(path.join(WS, ".claude/deploy/config.json"), '{"projects":{}}');
fs.writeFileSync(path.join(WS, ".claude/deploy/approvals.json"), '{"approvals":[]}');
process.chdir(WS);

try {
  const res = await pi.discoverAndLoadExtensions([], WS, WS);
  ok((res.errors || []).length === 0, `pi loader: no load errors (${JSON.stringify(res.errors || [])})`);
  ok((res.extensions || []).length >= 1, `pi loader: naia-harness.ts loaded (${(res.extensions || []).length} ext)`);

  const runner = new pi.ExtensionRunner(
    res.extensions, res.runtime, WS,
    pi.SessionManager.inMemory(),
    pi.ModelRegistry.create(pi.AuthStorage.create(path.join(WS, "auth.json"))),
  );
  try {
    runner.bindCore(
      { sendMessage(){}, sendUserMessage(){}, appendEntry(){}, setSessionName(){}, getSessionName(){}, setLabel(){}, getActiveTools(){return[]}, getAllTools(){return[]}, setActiveTools(){}, refreshTools(){}, getCommands(){return[]}, setModel: async()=>false, getThinkingLevel(){return"off"}, setThinkingLevel(){} },
      { getModel(){}, isIdle(){return true}, getSignal(){}, abort(){}, hasPendingMessages(){return false}, shutdown(){}, getContextUsage(){}, compact(){}, getSystemPrompt(){return""} },
    );
  } catch (e) { console.log("  (bindCore skipped: " + e.message + ")"); }

  const tc = async (toolName, input) =>
    runner.emitToolCall({ type: "tool_call", toolCallId: "c", toolName, input });

  let r = await tc("bash", { command: "git rese" + "t --hard HEAD~1" });
  ok(r && r.block === true && /파괴적 git/.test(r.reason || ""), "pi-runtime tool_call: destructive bash BLOCKED");
  r = await tc("bash", { command: "git status" });
  ok(!r || r.block !== true, "pi-runtime tool_call: safe bash NOT blocked");
  r = await tc("bash", { command: "gh " + "pr crea" + "te --repo openclaw/openclaw -t x -b y" });
  ok(r && r.block === true && /외부 repo/.test(r.reason || ""), "pi-runtime tool_call: external gh pr BLOCKED");
  r = await tc("edit", { file_path: "/p/docs/design/x.md", new_string: "y" });
  ok(r && r.block === true && /설계 문서 편집 차단/.test(r.reason || ""), "pi-runtime tool_call: design-doc edit BLOCKED");
  r = await tc("write", { file_path: "src/app.ts", content: "ok" });
  ok(!r || r.block !== true, "pi-runtime tool_call: normal code write NOT blocked");

  let bas;
  try { bas = await runner.emitBeforeAgentStart("hi", undefined, "BASE-SYSPROMPT", { cwd: WS }); }
  catch (e) { console.log("  (emitBeforeAgentStart err: " + e.message + ")"); }
  const sp = bas && (bas.systemPrompt || "");
  ok(!!sp && sp !== "BASE-SYSPROMPT" && /HARNESS/.test(sp), "pi-runtime before_agent_start: harness state injected");
  ok(!!sp && (/NAIA_HARNESS/.test(sp) || /\.pi\/no-harness/.test(sp) || /PI-RT/.test(sp)), "pi-runtime before_agent_start: pi-native inject");
} catch (e) {
  console.log("FATAL " + (e && e.stack || e)); F++;
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
}
console.log("\nPI-RUNTIME E2E: " + P + " pass, " + F + " fail");
process.exit(F ? 1 : 0);
