#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReviewOutput } from "./validate-review-output.mjs";
import {
	SUBJECTS,
	EFFECTS,
	RENDER_POLICIES,
	COVERAGE_STATUSES,
	VERDICTS,
	OUTSIDE_SCOPE_VALUE,
	FINDING_REQUIRED_KEYS,
	ATOM_KEYS,
	FRAME_OBLIGATIONS,
	AGY_TOOL_POLICY,
} from "./review-output-contract.mjs";
import {
	resolveRepoRoot,
	resolveCostLogPath,
	extractUsage,
	createCostLogEntry,
	recordReviewCost,
	appendCostLog,
} from "./review-cost-log.mjs";

export { validateReviewOutput };
export {
	COVERAGE_STATUSES,
	VERDICTS,
	OUTSIDE_SCOPE_VALUE,
	FINDING_REQUIRED_KEYS,
	FRAME_OBLIGATIONS,
	AGY_TOOL_POLICY,
} from "./review-output-contract.mjs";
export {
	resolveRepoRoot,
	resolveCostLogPath,
	extractUsage,
	createCostLogEntry,
	recordReviewCost,
	appendCostLog,
} from "./review-cost-log.mjs";

export function stdinPayload(tool, prompt) {
	if (tool !== "agy") return prompt;
	return `${JSON.stringify({
		event: "user",
		message: { role: "user", content: prompt },
	})}\n`;
}

const OPENCODE_REVIEW_AGENT = "adk-adversarial-review";
const MAX_REVIEW_OUTPUT_BYTES = 1024 * 1024;

let childEnvironmentHelpersPromise;

function findWorkspaceRoot(start) {
	let current = path.resolve(start);
	for (;;) {
		const helper = path.join(current, ".agents", "skills", "manage-discord-sessions", "helper", "backend-child-environment.mjs");
		if (existsSync(helper)) return current;
		const parent = path.dirname(current);
		if (parent === current) throw new Error("Alpha child-environment helper is unavailable");
		current = parent;
	}
}

async function loadChildEnvironmentHelpers() {
	if (!childEnvironmentHelpersPromise) {
		const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
		const helper = path.join(root, ".agents", "skills", "manage-discord-sessions", "helper", "backend-child-environment.mjs");
		childEnvironmentHelpersPromise = import(pathToFileURL(helper).href);
	}
	return childEnvironmentHelpersPromise;
}

async function pinOpenCodeModels(environment, model) {
	const explicitModel = typeof model === "string" ? model.trim() : "";
	if (!explicitModel) throw new Error("OpenCode reviewer model is required");
	const overlayPath = environment.OPENCODE_CONFIG;
	if (typeof overlayPath !== "string" || !overlayPath) throw new Error("OpenCode read-only configuration is unavailable");
	const overlay = JSON.parse(await readFile(overlayPath, "utf8"));
	// The child-environment helper owns the permission policy. Reuse its build
	// policy for the selected review agent instead of maintaining a second map
	// here that could drift from the runtime boundary.
	if (!overlay.agent?.build) throw new Error("OpenCode read-only agent policy is unavailable");
	overlay.agent[OPENCODE_REVIEW_AGENT] = overlay.agent.build;
	overlay.model = explicitModel;
	overlay.small_model = explicitModel;
	await writeFile(overlayPath, `${JSON.stringify(overlay)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(overlayPath, 0o600);

	// The helper copies only the provider/authentication fields into the private
	// XDG tree. Pin both model slots there as well so a provider config cannot
	// select a different small model during an otherwise read-only review.
	const providerPath = path.join(environment.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
	if (existsSync(providerPath)) {
		const provider = JSON.parse(await readFile(providerPath, "utf8"));
		provider.model = explicitModel;
		provider.small_model = explicitModel;
		await writeFile(providerPath, `${JSON.stringify(provider)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(providerPath, 0o600);
	}
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`invalid argument: ${argv[i] || "<missing>"}`);
		out[argv[i].slice(2)] = argv[i + 1];
	}
	return out;
}

function parseBoolean(value, name) {
	if (value === undefined) return false;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`--${name} must be true or false`);
}

export function validateAtoms(value) {
	if (!Array.isArray(value) || value.length === 0) throw new Error("atoms must be a non-empty JSON array");
	const ids = new Set();
	for (const [index, atom] of value.entries()) {
		if (!atom || typeof atom !== "object" || Array.isArray(atom) || Object.keys(atom).length !== ATOM_KEYS.length || ATOM_KEYS.some((key) => !(key in atom))) throw new Error(`atom ${index} must use the canonical projection`);
		for (const key of ["id", "source_id", "text", "subject", "effect", "render_policy"]) {
			if (typeof atom?.[key] !== "string" || !atom[key].trim()) throw new Error(`atom ${index} missing ${key}`);
		}
		for (const key of ["directive_ids", "target_ids", "criterion_ids", "evidence_ids"]) {
			if (!Array.isArray(atom?.[key]) || atom[key].some((id) => typeof id !== "string" || !id.trim()) || new Set(atom[key]).size !== atom[key].length) throw new Error(`atom ${atom?.id || index} has invalid ${key}`);
		}
		if (!SUBJECTS.has(atom.subject)) throw new Error(`atom ${atom.id} has invalid subject`);
		if (!EFFECTS.has(atom.effect)) throw new Error(`atom ${atom.id} has invalid effect`);
		if (!RENDER_POLICIES.has(atom.render_policy)) throw new Error(`atom ${atom.id} has invalid render_policy`);
		if (ids.has(atom.id)) throw new Error(`duplicate atom id: ${atom.id}`);
		ids.add(atom.id);
	}
	return value;
}

export function composePrompt(base, atoms, delta, request, tool) {
	const ledger = atoms.map((a) => JSON.stringify(a)).join("\n");
	// The original ask goes in ahead of the author's framing so the two can be
	// compared instead of one standing in for the other.
	const original = request && request.trim()
		? `--- ORIGINAL REQUEST (verbatim, not the author's summary) ---\n${request.trim()}`
		: `--- ORIGINAL REQUEST ---\nNot supplied. Record this in missing_concerns: without it you cannot judge whether the atom ledger covers what was actually asked.`;
	const toolName = typeof tool === "string" ? tool : tool?.tool;
	const agyPolicy = toolName === "agy" ? `\n\n${AGY_TOOL_POLICY}` : "";
	return `${base.trimEnd()}\n\n${original}\n\n${FRAME_OBLIGATIONS}\n\n--- DYNAMIC ATOM LEDGER ---\n${ledger}\n\n--- REVIEWER DELTA ---\n${delta.trim()}${agyPolicy}\n`;
}

export function commandFor(tool, repo, model, options = {}) {
	const optionalModel = model ? ["--model", model] : [];
	if (tool === "claude") return ["claude", ["-p", "--input-format", "text", "--output-format", "json", "--no-session-persistence", "--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...optionalModel]];
	if (tool === "codex") return ["codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", repo, ...optionalModel, "-"]];
	if (tool === "opencode") return ["opencode", ["run", "--pure", "--agent", OPENCODE_REVIEW_AGENT, "--title", OPENCODE_REVIEW_AGENT, "--dir", repo, "--format", "json", ...(model ? ["--model", model] : [])]];
	// AGY's stream protocol is required for headless review.  In particular,
	// text/json mode can return a plausible review without proving that the
	// provider reached a terminal result, while stream-json exposes that result
	// explicitly and keeps the invocation in its read-only sandbox.
	// The installed AGY CLI accepts the headless stream protocol without
	// --print. With --print it treats the following option as the prompt and
	// exits before consuming the NDJSON request.
	if (tool === "agy") return ["agy", ["--input-format", "stream-json", "--output-format", "stream-json", "--sandbox", "--mode", "plan", "--print-timeout", "240s", ...optionalModel]];
	if (tool === "grok") {
		if (typeof options.promptFile !== "string" || !options.promptFile) throw new Error("grok prompt file is required");
		return ["grok", ["--output-format", "json", "--permission-mode", "plan", "--verbatim", "--prompt-file", options.promptFile, ...optionalModel]];
	}
	throw new Error(`unsupported tool: ${tool}`);
}

function diagnosticExcerpt(text) {
	return text
		.replace(/(https:\/\/openrouter\.ai\/workspaces\/[^/\s]+\/keys\/)[A-Za-z0-9_-]+/gi, "$1<redacted>")
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "<redacted>")
		.replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(-2048);
}

export function safeFailureReason(tool, error) {
	const message = String(error?.message || "").toLowerCase();
	if (/denied tool action and returned no review/.test(message)) return "agy denied tool action and returned no review";
	if (error?.kind === "invalid_output") return `${tool} reviewer returned invalid output`;
	const timeoutPhase = message.match(/\b(startup|idle|total) timeout\b/)?.[1];
	if (timeoutPhase) return `${tool} reviewer ${timeoutPhase} timed out`;
	if (/timeout/.test(message)) return `${tool} reviewer timed out`;
	if (/output (?:exceeds|has no structured|misses|duplicates|contains|has an invalid)/.test(message)) return `${tool} reviewer returned invalid output`;
	if (/enoent|not found|cannot find/.test(message)) return `${tool} reviewer CLI is unavailable`;
	if (/\b(?:unauthenticated|unauthorized|authentication|login|credentials?|api[ _-]?key)\b/.test(message)) return `${tool} reviewer authentication or account access is unavailable`;
	if (/quota|rate.?limit|key limit|capacity|credit/.test(message)) return `${tool} reviewer provider capacity is unavailable`;
	const exitCode = Number.isInteger(error?.exitCode) ? ` (exit ${error.exitCode})` : "";
	return `${tool} reviewer process failed${exitCode}`;
}

function structuredErrorExcerpt(raw) {
	for (const line of raw.split(/\r?\n/).reverse()) {
		try {
			const event = JSON.parse(line);
			const message = event?.error?.data?.message || event?.error?.message;
			if (typeof message === "string") return diagnosticExcerpt(message);
		} catch {}
	}
	return "";
}


export async function invoke({ tool, repo, model, prompt, atomIds = [], startupMs, idleMs, totalMs, executable, killGraceMs = 2000, validateOutput = true, costLog, reviewId, stage, round, reviewerIndex, requireReview = true }) {
	for (const [name, value] of Object.entries({ startupMs, idleMs, totalMs, killGraceMs })) {
		if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a finite positive timer value`);
	}
	if (tool === "opencode" && (typeof model !== "string" || !model.trim())) throw new Error("OpenCode reviewer model is required");
	const startTime = Date.now();
	let rawOutput = "";
	let temporaryDir;
	let childEnvironment;
	let outcome = "failed";
	let failureReason = null;
	let verdict = null;
	let findingsCount = null;
	let notRunResult = null;
	try {
		let promptFile;
		if (tool === "grok" || tool === "opencode") temporaryDir = await mkdtemp(path.join(os.tmpdir(), `review-${tool}-`));
		if (tool === "grok") {
			promptFile = path.join(temporaryDir, "prompt.txt");
			await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
			await chmod(promptFile, 0o600);
		}
		if (tool === "opencode") {
			const helpers = await loadChildEnvironmentHelpers();
			childEnvironment = helpers.prepareChildEnvironment({
				backendId: "opencode",
				attemptId: "review",
				runtimeRoot: path.join(temporaryDir, "runtime"),
				parentEnv: process.env,
				authRoot: process.env.HOME,
				workspacePath: repo,
				prepareAuthentication: true,
				readOnly: true,
			});
			await pinOpenCodeModels(childEnvironment.env, model);
		}
		const [defaultExecutable, args] = commandFor(tool, repo, model, { promptFile });
		const childEnv = childEnvironment?.env || { ...process.env };
		const detached = process.platform !== "win32";
		const child = spawn(executable || defaultExecutable, args, { cwd: repo, detached, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
		let idleTimer;
		let killTimer;
		let escalationDone = Promise.resolve();
		let timeoutReason;
		let closed = false;
		const signalTree = (signal) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				const treeKill = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], { stdio: "ignore", windowsHide: true });
				treeKill.once("error", () => { try { child.kill(signal); } catch {} });
				treeKill.unref();
			}
			else {
				try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
			}
		};
		const timeOut = (reason) => {
			if (timeoutReason || closed) return;
			timeoutReason = reason;
			signalTree("SIGTERM");
			escalationDone = new Promise((resolve) => {
				killTimer = setTimeout(() => { signalTree("SIGKILL"); resolve(); }, killGraceMs);
			});
		};
		const armIdle = () => {
			if (timeoutReason) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => timeOut("idle"), idleMs);
		};
		idleTimer = setTimeout(() => timeOut("startup"), startupMs);
		const totalTimer = setTimeout(() => timeOut("total"), totalMs);
		const stdout = [];
		let stdoutBytes = 0;
		let outputOverflow = false;
		let stderrTail = "";
		let stdinError;
		child.stdout.on("data", (chunk) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_REVIEW_OUTPUT_BYTES) {
				outputOverflow = true;
				timeOut("output-limit");
				return;
			}
			stdout.push(chunk);
			armIdle();
		});
		child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4096); armIdle(); });
		child.stdin.on("error", (error) => { stdinError = error; });
		let result;
		const completion = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
		});
		if (tool === "grok") child.stdin.end(); else child.stdin.end(stdinPayload(tool, prompt));
		try {
			result = await completion;
		} finally {
			clearTimeout(idleTimer); clearTimeout(totalTimer);
		}
		if (timeoutReason) {
			await escalationDone;
			clearTimeout(killTimer);
			if (outputOverflow) throw Object.assign(new Error(`${tool} review output exceeds ${MAX_REVIEW_OUTPUT_BYTES} bytes`), { exitCode: 1 });
			throw Object.assign(new Error(`${tool} ${timeoutReason} timeout (${result.signal || "exit"})`), { exitCode: 124 });
		}
		const raw = Buffer.concat(stdout).toString("utf8");
		rawOutput = raw;
		if (result.signal) throw Object.assign(new Error(`${tool} terminated by ${result.signal}`), { exitCode: 1 });
		if (result.code !== 0) {
			const diagnostic = structuredErrorExcerpt(raw) || diagnosticExcerpt(stderrTail);
			throw Object.assign(new Error(`${tool} exited ${result.code}${diagnostic ? `: ${diagnostic}` : ""}`), { exitCode: result.code || 1 });
		}
		if (stdinError) throw Object.assign(new Error(`${tool} stdin failed: ${stdinError.code || stdinError.message}`), { exitCode: 1 });
		const review = validateOutput ? validateReviewOutput(raw, atomIds) : undefined;
		outcome = "reviewed";
		verdict = review?.verdict ?? null;
		findingsCount = Array.isArray(review?.findings) ? review.findings.length : null;
		return { raw, review };
	} catch (error) {
		error.raw = rawOutput;
		failureReason = safeFailureReason(tool, error);
		if (!requireReview) {
			outcome = "not_run";
			notRunResult = {
				status: "NOT_RUN",
				reviewer: tool,
				blocking: false,
				reason: failureReason,
				cross_validation: false,
				usable_as_evidence: false,
			};
			return { raw: rawOutput, review: notRunResult, notRun: notRunResult };
		}
		outcome = "failed";
		throw error;
	} finally {
		const durationMs = Date.now() - startTime;
		const promptChars = typeof prompt === "string" ? prompt.length : 0;
		await recordReviewCost({
			costLog,
			reviewId,
			stage,
			round,
			reviewerIndex,
			tool,
			model,
			repo,
			promptChars,
			durationMs,
			outcome,
			failureReason,
			verdict,
			findingsCount,
			rawOutput,
		});
		if (childEnvironment) {
			try {
				const helpers = await loadChildEnvironmentHelpers();
				helpers.cleanupChildEnvironment(childEnvironment.childHome);
			} catch {}
		}
		if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function runCli(argv) {
	const a = parseArgs(argv);
	for (const key of ["tool", "repo", "base", "atoms", "delta"]) if (!a[key]) throw new Error(`--${key} is required`);
	// Fails closed by default. A reviewer that could not run is not a reviewer
	// that found nothing, and the two used to be indistinguishable to the caller:
	// a quota-limited or timed-out reviewer exited zero with a NOT_RUN object, and
	// the orchestrating agent read a successful exit and moved on. Opting out is
	// still possible, but it now has to be said out loud.
	const requireReview = parseBoolean(a["require-review"] ?? "true", "require-review");
	const [base, atomsText, delta] = await Promise.all([readFile(a.base, "utf8"), readFile(a.atoms, "utf8"), readFile(a.delta, "utf8")]);
	const atoms = validateAtoms(JSON.parse(atomsText));
	// The original ask, verbatim. Without it the reviewer can only compare the
	// change against the author's summary of what was wanted.
	const request = a.request ? await readFile(a.request, "utf8") : "";
	const prompt = composePrompt(base, atoms, delta, request, a.tool);
	// Grok receives its owner-only prompt path only after the invocation temp
	// directory exists; use a placeholder for this early supported-tool check.
	commandFor(a.tool, a.repo, a.model, a.tool === "grok" ? { promptFile: "<temporary-prompt-file>" } : {});
	const timers = {
		startupMs: Number(a["startup-sec"] || 300) * 1000,
		idleMs: Number(a["idle-sec"] || 180) * 1000,
		totalMs: Number(a["total-sec"] || 900) * 1000,
	};
	for (const [name, value] of Object.entries(timers)) if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a finite positive timer value`);

	const parseNumOrStr = (v) => (v === undefined || v === null ? null : (/^-?\d+$/.test(String(v).trim()) ? Number(v) : v));
	const reviewId = a["review-id"] ?? null;
	const stage = a.stage ?? null;
	const round = parseNumOrStr(a.round);
	const reviewerIndex = parseNumOrStr(a["reviewer-index"]);

	try {
		const { review } = await invoke({
			tool: a.tool,
			repo: a.repo,
			model: a.model,
			prompt,
			atomIds: atoms.map(({ id }) => id),
			...timers,
			costLog: a["cost-log"],
			reviewId,
			stage,
			round,
			reviewerIndex,
			requireReview,
		});
		return review;
	} catch (error) {
		const reason = safeFailureReason(a.tool, error);
		throw Object.assign(new Error(reason), { exitCode: error.exitCode || 1 });
	}
}

async function main() {
	process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`review invocation failed: ${diagnosticExcerpt(error.message)}`); process.exit(error.exitCode || 1); });
