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

  // ── full bash chain coverage (R1 gap fix: every guard via pi path,
  //    so a silent chain drop / miswire is caught) ──
  let r = await tc("bash", { command: "git rese" + "t --hard HEAD~1" });
  ok(r && r.block === true && /파괴적 git/.test(r.reason || ""), "pi tool_call: destructiveGit BLOCKED");
  r = await tc("bash", { command: "gh " + "pr crea" + "te --repo openclaw/openclaw -t x -b y" });
  ok(r && r.block === true && /외부 repo/.test(r.reason || ""), "pi tool_call: prGuard external BLOCKED");
  r = await tc("bash", { command: "git commit -m wip" });
  ok(r && r.block === true && /커밋 차단/.test(r.reason || ""), "pi tool_call: commit BLOCKED (phase=build)");
  r = await tc("bash", { command: "vercel --prod" });
  ok(r && r.block === true && /prod 배포/.test(r.reason || ""), "pi tool_call: deploy BLOCKED (no approval)");
  r = await tc("bash", { command: "git push origin main" });
  ok(r && r.block === true && /git push 차단|FORCE PUSH/.test(r.reason || ""), "pi tool_call: gitPush BLOCKED");
  r = await tc("bash", { command: "node sen" + "d.js sen" + "d" });
  ok(r && r.block === true && /외부 이메일 발송 차단/.test(r.reason || ""), "pi tool_call: emailSend BLOCKED");
  r = await tc("bash", { command: "git status" });
  ok(!r || r.block !== true, "pi tool_call: safe bash NOT blocked");
  // ── edit chain ──
  r = await tc("edit", { file_path: "/p/docs/design/x.md", new_string: "y" });
  ok(r && r.block === true && /설계 문서 편집 차단/.test(r.reason || ""), "pi tool_call: designDoc BLOCKED");
  r = await tc("write", { file_path: ".env.local", content: "naia-gateway-181404717065.asia-northeast3.run.app" });
  ok(r && r.block === true && /prod 게이트웨이/.test(r.reason || ""), "pi tool_call: prodGateway BLOCKED");
  r = await tc("write", { file_path: "src/app.ts", content: "ok" });
  ok(!r || r.block !== true, "pi tool_call: normal code write NOT blocked");

  // ── cascade via tool_result (R1 fix: was tool_execution_end no-input;
  //    reminder must reach the AGENT = appended to result content) ──
  let tr;
  try {
    tr = await runner.emitToolResult({
      type: "tool_result", toolName: "edit", toolCallId: "tr1",
      input: { file_path: WS + "/.agents/context/agents-rules.json" },
      content: [{ type: "text", text: "edited" }], details: {}, isError: false,
    });
  } catch (e) { console.log("  (emitToolResult err: " + e.message + ")"); }
  const trc = tr && tr.content ? tr.content.map((c) => c.text || "").join("") : "";
  ok(/agents-rules\.json is the SoT/.test(trc), "pi tool_result: cascade reminder appended to AGENT-visible content");

  // ── anti-compact: harness state + re-read reminder in systemPrompt ──
  let bas;
  try { bas = await runner.emitBeforeAgentStart("hi", undefined, "BASE-SYSPROMPT", { cwd: WS }); }
  catch (e) { console.log("  (emitBeforeAgentStart err: " + e.message + ")"); }
  const sp = bas && (bas.systemPrompt || "");
  ok(!!sp && sp !== "BASE-SYSPROMPT" && /HARNESS/.test(sp), "pi before_agent_start: harness state injected");
  ok(!!sp && (/NAIA_HARNESS/.test(sp) || /\.pi\/no-harness/.test(sp) || /PI-RT/.test(sp)), "pi before_agent_start: pi-native inject");
  ok(!!sp && /MANDATORY|AGENTS\.md/.test(sp), "pi before_agent_start: re-read reminder folded in (agent-visible, not notify)");
} catch (e) {
  console.log("FATAL " + (e && e.stack || e)); F++;
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
}
console.log("\nPI-RUNTIME E2E: " + P + " pass, " + F + " fail");
process.exit(F ? 1 : 0);
