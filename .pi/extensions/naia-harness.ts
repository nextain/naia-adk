/**
 * naia-adk harness — pi adapter (G-OC01 part2).
 *
 * Makes the SAME tool-agnostic harness Claude Code runs available to pi
 * with ZERO core change. Reuses:
 *   .agents/hooks/core/harness-core.js   (session/anti-compact + sanitizers)
 *   .agents/hooks/policies/bash.js|edit.js (guard policies, host-neutral)
 *
 * pi event mapping (docs/extensions.md; src/core/extensions/types.ts):
 *   tool_call(bash)  → bash policies in settings.json order; first
 *                      {reason} ⇒ {block:true,reason}. PER-GUARD fail
 *                      mode: pr-guard throw ⇒ fail-CLOSED block; the
 *                      other 5 throw ⇒ fail-OPEN (continue) — matches
 *                      each Claude guard's main().catch (5 exit0, pr
 *                      blocks). [part2 ④ R1 fix: was whole-chain catch.]
 *   tool_call(edit|write) → edit policies; {block}⇒block, {allow}⇒no block.
 *   before_agent_start → harness session-state + the post-compact
 *                      re-read reminder, appended to systemPrompt
 *                      (AGENT-visible; survives compaction). [R1 fix:
 *                      reminder was session_start ctx.ui.notify =
 *                      user-only, agent-invisible.]
 *   tool_result(edit|write) → cascade mirror reminder appended to the
 *                      tool result content (AGENT-visible — pi analog of
 *                      Claude PostToolUse additionalContext). [R1 fix:
 *                      was tool_execution_end (no input field) + notify.]
 *
 * pi has no per-extension session id (ExtensionContext exposes cwd +
 * sessionManager only; BeforeAgentStartEvent has no sessionId). So pi's
 * binding is cwd + active-progress presence (buildSessionInject handles
 * sessionId=null → candidate/unbound). P0/P1 session_id binding is
 * Claude-stdin-specific and intentionally absent here. [R1: honest, not
 * faked.] cwd comes from ctx.cwd (real pi workspace).
 *
 * pi-native: hostConfigDir ".pi" · optOutEnvVar "NAIA_HARNESS" ·
 * entryPoint "AGENTS.md" · unlock <ws>/.pi/design-doc-unlock. Deploy
 * approvals are workspace-level (.claude/deploy) → shared across hosts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(__filename);
const WS = path.resolve(__dirname, "..", ".."); // .pi/extensions → ws
const core = require(path.join(WS, ".agents", "hooks", "core", "harness-core.js"));
const bash = require(path.join(WS, ".agents", "hooks", "policies", "bash.js"));
const edit = require(path.join(WS, ".agents", "hooks", "policies", "edit.js"));

const DEPLOY_DIR = path.join(WS, ".claude", "deploy"); // workspace-level approvals
const UNLOCK_FILE = path.join(WS, ".pi", "design-doc-unlock"); // pi-native marker
const HOST = { optOutEnvVar: "NAIA_HARNESS", hostConfigDir: ".pi", entryPoint: "AGENTS.md" };

export default function (pi: ExtensionAPI) {
	// ── Bash guards: settings.json order; first block wins. Per-guard
	//    fail mode matches the Claude adapters (pr fail-CLOSED; the
	//    other 5 fail-OPEN — a throw must NOT block for them).
	pi.on("tool_call", async (event: any, ctx: any) => {
		const cwd = (ctx && ctx.cwd) || process.cwd();
		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			const data = { cwd, tool_input: event.input };
			// pr-guard: fail-CLOSED
			try {
				const r = bash.prGuard(command, data);
				if (r && r.reason) return { block: true, reason: r.reason };
			} catch {
				return { block: true, reason: bash.PR_FAIL_REASON };
			}
			// the other 5: fail-OPEN (a throw ⇒ skip that guard, continue)
			const failOpen = [
				() => bash.destructiveGit(command),
				() => bash.commit(command, data),
				() => bash.deploy(command, data, { deployDir: DEPLOY_DIR }),
				() => bash.gitPush(command),
				() => bash.emailSend(command),
			];
			for (const run of failOpen) {
				try {
					const r = run();
					if (r && r.reason) return { block: true, reason: r.reason };
				} catch {
					// fail-open: this guard errored → do not block, try next
				}
			}
			return;
		}
		if (event.toolName === "edit" || event.toolName === "write") {
			const data = { tool_input: event.input };
			try {
				const dd = edit.designDoc(data, { unlockFile: UNLOCK_FILE });
				if (dd && dd.block !== undefined) return { block: true, reason: dd.block };
				// {allow:true} → no block (pi has no explicit allow; absence = proceed)
			} catch {
				// design-doc original is fail-OPEN
			}
			try {
				const pg = edit.prodGateway(data);
				if (pg && pg.block !== undefined) return { block: true, reason: pg.block };
			} catch {
				// prod-gateway original is fail-OPEN
			}
			return;
		}
	});

	// ── Anti-compact: session state + post-compact re-read reminder,
	//    appended to the system prompt (AGENT-visible, compaction-proof).
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		try {
			const cwd = (ctx && ctx.cwd) || process.cwd();
			const parts: string[] = [];
			const res = core.buildSessionInject({
				cwd,
				sessionId: null, // pi exposes no per-extension session id (Claude-stdin only)
				hooksDir: __dirname,
				...HOST,
			});
			if (res && res.text) parts.push(res.text);
			parts.push(core.compactReminderMessage({ entryPoint: "AGENTS.md" }));
			if (parts.length) {
				return { systemPrompt: (event.systemPrompt || "") + "\n\n" + parts.join("\n\n") };
			}
		} catch {
			// inject is best-effort; never break the agent
		}
	});

	// ── Mirror cascade reminder → appended to the tool RESULT content so
	//    the AGENT sees it (faithful analog of Claude PostToolUse
	//    additionalContext). tool_result carries input + content.
	pi.on("tool_result", async (event: any) => {
		try {
			if (event.toolName === "edit" || event.toolName === "write") {
				const r = edit.cascadeCheck({ tool_input: event.input });
				if (r && r.postContext) {
					return {
						content: [
							...(event.content || []),
							{ type: "text", text: "\n" + r.postContext },
						],
					};
				}
			}
		} catch {
			// best-effort
		}
	});
}
