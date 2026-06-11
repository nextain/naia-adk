/**
 * beh-receipts — Behavior Enforcement Harness §3.2 core (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.2, §6.2).
 *
 * Completion-claim authenticity. A "done" item must carry a structured RECEIPT
 * proving its pre-declared verification actually ran and is still valid:
 *   receipt = {item_id, cmd, exit, ts, output_hash, closure:[{path,hash}],
 *              tree_state_id}
 *
 * Builds on §3.1: an item declares `verify = {cmd_pattern, closure:[globs]}`.
 * When a matching command succeeds (exit 0), the adapter records a receipt
 * capturing the closure files' content hashes at that moment. At a termination
 * event (Report phase / Tasks all-checked / Stop), each done item is checked:
 *   - no exit-0 receipt              → "no verification" (inject/block)
 *   - receipt's closure hash ≠ now   → stale (a dependency changed)  → block
 *   - undeclared-input flag set      → fail-closed                   → block
 *
 * §3.1 "pre-criteria met 0 yet marked done" is an INDEPENDENT double-catch.
 *
 * Threat model (plan §0): IN-SCOPE = sincere drift (claiming done without
 * having verified; stale evidence after a later change). NOT trivial-cmd
 * spoofing / forged receipts — backstopped by user. The DEEPER hermetic
 * completeness (measured strace read-set, full input-class capture,
 * generation-provenance closure) is the explicitly BOUNDED impl-phase item;
 * here closure = the item's DECLARED closure, content-hash bound, plus the
 * §3.1 progress-0 backstop.
 *
 * Pure split: evaluateCompletion() is PURE (takes current closure hashes as
 * input). Hashing the filesystem is an I/O helper the adapter calls.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── receipt store I/O (append-only jsonl) ─────────────────────────────────
function receiptsPath(harnessDir, sessionId) {
	const sid = String(sessionId || "no-session").replace(/[^A-Za-z0-9_.-]/g, "_");
	return path.join(harnessDir, "receipts", `${sid}.jsonl`);
}

function appendReceipt(receiptsFile, receipt) {
	fs.mkdirSync(path.dirname(receiptsFile), { recursive: true });
	fs.appendFileSync(receiptsFile, JSON.stringify(receipt) + "\n");
}

function readReceipts(receiptsFile) {
	let raw;
	try {
		raw = fs.readFileSync(receiptsFile, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* skip torn line */
		}
	}
	return out;
}

// ── filesystem hashing (I/O helper; adapter-side) ─────────────────────────
function hashFile(absPath) {
	try {
		const buf = fs.readFileSync(absPath);
		return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
	} catch {
		return null; //  missing/unreadable → null (distinct from a real hash)
	}
}

/**
 * Resolve an item's declared closure globs to a sorted {path,hash} list at the
 * current moment. Simple, deterministic: globs are matched against a provided
 * candidate file list (the adapter supplies repo-relative paths), OR treated
 * as literal paths when no glob chars. Returns sorted by path for stable
 * tree_state_id. I/O helper (reads fs); pure logic lives in evaluateCompletion.
 * @param {string} cwd
 * @param {string[]} closureSpecs  globs or literal repo-relative paths
 * @param {(glob:string)=>RegExp} globToRe  injected from beh-ledger
 * @param {string[]} [candidatePaths]  repo-relative files to glob-match against
 */
function captureClosure(cwd, closureSpecs, globToRe, candidatePaths) {
	const picked = new Set();
	for (const spec of closureSpecs || []) {
		if (/[*?[\]]/.test(spec)) {
			const re = globToRe(spec);
			for (const c of candidatePaths || []) if (re.test(c)) picked.add(c);
		} else {
			picked.add(spec);
		}
	}
	const out = [];
	for (const rel of [...picked].sort()) {
		out.push({ path: rel, hash: hashFile(path.join(cwd, rel)) });
	}
	return out;
}

/**
 * Repo-relative candidate file list for glob closures. Uses `git ls-files`
 * (fast, tracked files) with a bounded fallback. Called ONLY when a verify
 * command actually matches (cold path), so the cost is not on every tool call.
 */
function listCandidates(cwd) {
	try {
		const { execFileSync } = require("child_process");
		const out = execFileSync("git", ["-C", cwd, "ls-files"], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"], //  suppress "not a git repo" noise
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function treeStateId(closure) {
	const h = crypto.createHash("sha256");
	for (const { path: p, hash } of closure) h.update(`${p}:${hash}\n`);
	return h.digest("hex").slice(0, 16);
}

// ── the evaluator (PURE) ──────────────────────────────────────────────────
/**
 * @param {object} state
 *   state.items        scope items (with state, verify:{cmd_pattern,closure})
 *   state.receipts     recorded receipts (this session)
 *   state.currentClosureById  { item_id: [{path,hash}] }  // adapter-measured NOW
 * @returns {{ incomplete: Array<{item:string, reason:string}> }}
 */
function evaluateCompletion(state) {
	const items = state.items || [];
	const receipts = state.receipts || [];
	const currentById = state.currentClosureById || {};
	const incomplete = [];

	for (const it of items) {
		if (it.state !== "done") continue; //  only completion claims
		// no verify spec declared → cannot prove → fail (measurability at start).
		if (!it.verify || !it.verify.cmd_pattern) {
			incomplete.push({ item: it.id, reason: "검증조건(verify) 미선언 — 완료 입증 불가" });
			continue;
		}
		// latest exit-0 receipt for this item.
		const rs = receipts.filter((r) => r.item_id === it.id && r.exit === 0);
		if (rs.length === 0) {
			incomplete.push({ item: it.id, reason: "성공한 검증 receipt 없음 (산문만 = 검증 없음)" });
			continue;
		}
		const r = rs[rs.length - 1];
		if (r.undeclared_input) {
			incomplete.push({ item: it.id, reason: "검증 입력 클래스 미포착 → fail-closed (plan §3.2)" });
			continue;
		}
		// stale: any closure file's current hash differs from receipt-time hash.
		const now = currentById[it.id] || [];
		const nowMap = new Map(now.map((e) => [e.path, e.hash]));
		let stale = null;
		for (const e of r.closure || []) {
			const cur = nowMap.get(e.path);
			if (cur !== e.hash) {
				stale = e.path;
				break;
			}
		}
		// also catch a closure file added/removed since the receipt.
		if (!stale && now.length !== (r.closure || []).length) stale = "(closure 구성 변경)";
		if (stale) {
			incomplete.push({ item: it.id, reason: `receipt stale — 검증 의존성 변경: ${stale}` });
		}
	}
	return { incomplete };
}

/** Does a successful command match an item's pre-declared verify cmd_pattern? */
function isVerifyCommand(item, bashCommandCanon) {
	if (!item || !item.verify || !item.verify.cmd_pattern) return false;
	const cmd = bashCommandCanon.startsWith("bash:") ? bashCommandCanon.slice(5) : bashCommandCanon;
	try {
		return new RegExp(item.verify.cmd_pattern).test(cmd);
	} catch {
		return false;
	}
}

module.exports = {
	receiptsPath,
	appendReceipt,
	readReceipts,
	hashFile,
	captureClosure,
	listCandidates,
	treeStateId,
	evaluateCompletion,
	isVerifyCommand,
};
