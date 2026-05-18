/**
 * naia-adk harness — pi adapter (G-OC01 part2).
 *
 * Makes the SAME tool-agnostic harness that Claude Code runs available to
 * pi, with ZERO change to the core. Reuses:
 *   .agents/hooks/core/harness-core.js   (session/anti-compact + sanitizers)
 *   .agents/hooks/policies/bash.js|edit.js (guard policies, host-neutral)
 * — exactly the modules the .claude/hooks/* adapters consume.
 *
 * pi event mapping (see docs/extensions.md):
 *   tool_call (bash)  → bash policies in settings.json order; first
 *                       {reason} ⇒ { block:true, reason }. pr-guard
 *                       fail-CLOSED on throw.
 *   tool_call (edit|write) → edit policies; {block}⇒block, {allow}⇒allow.
 *   before_agent_start → harness-core.buildSessionInject(...) appended to
 *                       systemPrompt (anti-compact; survives compaction).
 *   session_start     → compact/re-read reminder via ctx.ui.notify.
 *   tool_execution_end (edit|write) → cascade mirror reminder via notify
 *                       (pi analog of Claude PostToolUse additionalContext).
 *
 * pi-native host conventions (part1 parameterization, S1 M1/M2/L1):
 *   hostConfigDir ".pi"  · optOutEnvVar "NAIA_HARNESS" · entryPoint
 *   "AGENTS.md" · design-doc unlock = <ws>/.pi/design-doc-unlock.
 * Deploy approvals are workspace-level (.claude/deploy) → shared.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(__filename);
// .pi/extensions/ → ws → .agents/hooks/...
const WS = path.resolve(__dirname, "..", "..");
const core = require(path.join(WS, ".agents", "hooks", "core", "harness-core.js"));
const bash = require(path.join(WS, ".agents", "hooks", "policies", "bash.js"));
const edit = require(path.join(WS, ".agents", "hooks", "policies", "edit.js"));

const DEPLOY_DIR = path.join(WS, ".claude", "deploy"); // workspace-level approvals
const UNLOCK_FILE = path.join(WS, ".pi", "design-doc-unlock"); // pi-native marker
const HOST = { optOutEnvVar: "NAIA_HARNESS", hostConfigDir: ".pi", entryPoint: "AGENTS.md" };

export default function (pi: ExtensionAPI) {
	// ── Bash guards: settings.json order; first block wins; pr fail-closed
	pi.on("tool_call", async (event: any) => {
		try {
			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");
				const data = { cwd: process.cwd(), tool_input: event.input };
				const chain = [
					() => bash.prGuard(command, data),
					() => bash.destructiveGit(command),
					() => bash.commit(command, data),
					() => bash.deploy(command, data, { deployDir: DEPLOY_DIR }),
					() => bash.gitPush(command),
					() => bash.emailSend(command),
				];
				for (const run of chain) {
					const r = run();
					if (r && r.reason) return { block: true, reason: r.reason };
				}
				return;
			}
			if (event.toolName === "edit" || event.toolName === "write") {
				const data = { tool_input: event.input };
				const dd = edit.designDoc(data, { unlockFile: UNLOCK_FILE });
				if (dd && dd.block !== undefined) return { block: true, reason: dd.block };
				// {allow:true} → do not block (pi has no explicit allow; absence = proceed)
				const pg = edit.prodGateway(data);
				if (pg && pg.block !== undefined) return { block: true, reason: pg.block };
				return;
			}
		} catch {
			// pr-guard is the only fail-CLOSED guard; a thrown error in the
			// bash chain must block GitHub-write-class operations safely.
			if (event.toolName === "bash") {
				return { block: true, reason: bash.PR_FAIL_REASON };
			}
		}
	});

	// ── Anti-compact: inject harness session state into the system prompt
	pi.on("before_agent_start", async (event: any) => {
		try {
			const res = core.buildSessionInject({
				cwd: process.cwd(),
				sessionId: (event && event.sessionId) || null,
				hooksDir: __dirname,
				...HOST,
			});
			if (res && res.text) {
				return { systemPrompt: (event.systemPrompt || "") + "\n\n" + res.text };
			}
		} catch {
			// inject is best-effort; never break the agent
		}
	});

	// ── Re-read reminder on (new/resume/compact) session start
	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			ctx?.ui?.notify?.(core.compactReminderMessage({ entryPoint: "AGENTS.md" }), "info");
		} catch {
			// best-effort
		}
	});

	// ── Mirror cascade reminder (pi analog of Claude PostToolUse context)
	pi.on("tool_execution_end", async (event: any, ctx: any) => {
		try {
			if (event.toolName === "edit" || event.toolName === "write") {
				const r = edit.cascadeCheck({ tool_input: event.input });
				if (r && r.postContext) ctx?.ui?.notify?.(r.postContext, "info");
			}
		} catch {
			// best-effort
		}
	});
}
