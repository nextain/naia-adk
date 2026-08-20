#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SUBJECTS = new Set(["agent_workflow", "artifact_runtime", "artifact_content", "end_user_flow"]);
const EFFECTS = new Set(["background", "precondition", "outcome", "constraint", "presentation", "verification", "audience"]);
const RENDER_POLICIES = new Set(["deny", "derive", "quote", "require"]);
const COVERAGE_STATUSES = new Set(["COVERED", "NOT_COVERED"]);
const ATOM_KEYS = ["id", "source_id", "text", "directive_ids", "subject", "effect", "render_policy", "target_ids", "criterion_ids", "evidence_ids"];
const OPENCODE_READ_ONLY_CONFIG = JSON.stringify({ permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow" } });
const MAX_REVIEW_OUTPUT_BYTES = 1024 * 1024;

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

export function composePrompt(base, atoms, delta) {
	const ledger = atoms.map((a) => JSON.stringify(a)).join("\n");
	return `${base.trimEnd()}\n\n--- DYNAMIC ATOM LEDGER ---\n${ledger}\n\n--- REVIEWER DELTA ---\n${delta.trim()}\n`;
}

export function commandFor(tool, repo, model) {
	const optionalModel = model ? ["--model", model] : [];
	if (tool === "claude") return ["claude", ["-p", "--input-format", "text", "--output-format", "json", "--no-session-persistence", "--permission-mode", "plan", "--allowedTools", "Read,Glob,Grep", ...optionalModel]];
	if (tool === "codex") return ["codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", repo, ...optionalModel, "-"]];
	if (tool === "opencode") return ["opencode", ["run", "--pure", "--title", "adk-adversarial-review", "--dir", repo, "--format", "json", ...(model ? ["--model", model] : [])]];
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

function safeFailureReason(tool, error) {
	const message = String(error?.message || "").toLowerCase();
	const timeoutPhase = message.match(/\b(startup|idle|total) timeout\b/)?.[1];
	if (timeoutPhase) return `${tool} reviewer ${timeoutPhase} timed out`;
	if (/timeout/.test(message)) return `${tool} reviewer timed out`;
	if (/output (?:exceeds|has no structured|misses|duplicates|contains|has an invalid)/.test(message)) return `${tool} reviewer returned invalid output`;
	if (/enoent|not found|cannot find/.test(message)) return `${tool} reviewer CLI is unavailable`;
	if (/login|auth|account|credential|api.?key/.test(message)) return `${tool} reviewer authentication or account access is unavailable`;
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

function findReview(value, depth = 0) {
	if (depth > 32) return undefined;
	if (typeof value === "string") {
		try { return findReview(JSON.parse(value), depth + 1); } catch { return undefined; }
	}
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value.coverage)) return value;
	for (const nested of Object.values(value)) {
		const found = findReview(nested, depth + 1);
		if (found) return found;
	}
}

function collectTextFields(value, out, depth = 0) {
	if (depth > 32 || !value || typeof value !== "object") return;
	if (typeof value.text === "string") out.push(value.text);
	for (const nested of Object.values(value)) collectTextFields(nested, out, depth + 1);
}

export function validateReviewOutput(raw, atomIds) {
	const candidates = [];
	const eventTexts = [];
	try { candidates.push(JSON.parse(raw)); } catch {}
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		try {
			const event = JSON.parse(line);
			candidates.push(event);
			collectTextFields(event, eventTexts);
		} catch {}
	}
	const reconstructed = eventTexts.join("");
	try { candidates.push(JSON.parse(reconstructed)); } catch {}
	for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		try { candidates.push(JSON.parse(match[1])); } catch {}
	}
	for (const match of reconstructed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		try { candidates.push(JSON.parse(match[1])); } catch {}
	}
	const review = candidates.map(findReview).find(Boolean);
	if (!review) throw new Error("review output has no structured coverage array");
	if (!["CLEAN", "NOT_CLEAN"].includes(review.verdict) || !Array.isArray(review.findings)) throw new Error("review output has an invalid verdict or findings array");
	const expected = new Set(atomIds);
	const seen = new Set();
	for (const row of review.coverage) {
		if (!row || typeof row.atom_id !== "string" || !COVERAGE_STATUSES.has(row.status)) throw new Error("review output has an invalid coverage row");
		if (!expected.has(row.atom_id)) throw new Error(`review output has unknown atom: ${row.atom_id}`);
		if (seen.has(row.atom_id)) throw new Error(`review output duplicates atom: ${row.atom_id}`);
		seen.add(row.atom_id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	if (missing.length) throw new Error(`review output misses atoms: ${missing.join(", ")}`);
	for (const [index, finding] of review.findings.entries()) {
		if (!expected.has(finding?.atom_id)) throw new Error(`review finding ${index} has an unknown atom_id`);
		for (const key of ["file_location", "impact", "minimal_fix"]) {
			if (typeof finding[key] !== "string" || !finding[key].trim()) throw new Error(`review finding ${index} has an invalid ${key}`);
		}
	}
	if (review.verdict === "CLEAN" && (review.findings.length || review.coverage.some(({ status }) => status !== "COVERED"))) throw new Error("CLEAN review contains findings or uncovered atoms");
	if (review.verdict === "NOT_CLEAN" && !review.findings.length && review.coverage.every(({ status }) => status === "COVERED")) throw new Error("NOT_CLEAN review has no finding or uncovered atom");
	return review;
}

export async function invoke({ tool, repo, model, prompt, atomIds = [], startupMs, idleMs, totalMs, executable, killGraceMs = 2000, validateOutput = true }) {
	for (const [name, value] of Object.entries({ startupMs, idleMs, totalMs, killGraceMs })) {
		if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a finite positive timer value`);
	}
	const [defaultExecutable, args] = commandFor(tool, repo, model);
	const toolEnv = tool === "opencode" ? { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_ONLY_CONFIG } : {};
	const detached = process.platform !== "win32";
	const child = spawn(executable || defaultExecutable, args, { cwd: repo, detached, env: { ...process.env, ...toolEnv }, stdio: ["pipe", "pipe", "pipe"] });
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
	child.stdin.end(prompt);
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
	if (result.signal) throw Object.assign(new Error(`${tool} terminated by ${result.signal}`), { exitCode: 1 });
	if (result.code !== 0) {
		const diagnostic = structuredErrorExcerpt(raw) || diagnosticExcerpt(stderrTail);
		throw Object.assign(new Error(`${tool} exited ${result.code}${diagnostic ? `: ${diagnostic}` : ""}`), { exitCode: result.code || 1 });
	}
	if (stdinError) throw Object.assign(new Error(`${tool} stdin failed: ${stdinError.code || stdinError.message}`), { exitCode: 1 });
	const review = validateOutput ? validateReviewOutput(raw, atomIds) : undefined;
	return { raw, review };
}

export async function runCli(argv) {
	const a = parseArgs(argv);
	for (const key of ["tool", "repo", "base", "atoms", "delta"]) if (!a[key]) throw new Error(`--${key} is required`);
	const requireReview = parseBoolean(a["require-review"], "require-review");
	const [base, atomsText, delta] = await Promise.all([readFile(a.base, "utf8"), readFile(a.atoms, "utf8"), readFile(a.delta, "utf8")]);
	const atoms = validateAtoms(JSON.parse(atomsText));
	const prompt = composePrompt(base, atoms, delta);
	commandFor(a.tool, a.repo, a.model);
	const timers = {
		startupMs: Number(a["startup-sec"] || 300) * 1000,
		idleMs: Number(a["idle-sec"] || 180) * 1000,
		totalMs: Number(a["total-sec"] || 900) * 1000,
	};
	for (const [name, value] of Object.entries(timers)) if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a finite positive timer value`);
	try {
		const { review } = await invoke({ tool: a.tool, repo: a.repo, model: a.model, prompt,
			atomIds: atoms.map(({ id }) => id),
			...timers });
		return review;
	} catch (error) {
		const reason = safeFailureReason(a.tool, error);
		if (requireReview) throw Object.assign(new Error(reason), { exitCode:error.exitCode || 1 });
		return { status:"NOT_RUN", reviewer:a.tool, blocking:false, reason };
	}
}

async function main() {
	process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`review invocation failed: ${diagnosticExcerpt(error.message)}`); process.exit(error.exitCode || 1); });
