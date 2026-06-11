/**
 * beh-manifest — BEH §5 propagation enforcement core (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§5, §6.7).
 *
 * Propagation = enforcement (not just copying). A SoT (naia-adk) publishes a
 * SIGNED MANIFEST of the managed harness region: each file's content hash + a
 * MONOTONIC EPOCH (anti-rollback) + an HMAC signature. Downstream forks
 * (org-adk, user-adk/alpha-adk) are verified against it:
 *   - signature invalid           → tampered / not from SoT
 *   - epoch < required (rollback)  → a stale fork can't pass as current
 *   - managed-region file mismatch → drift (3-way: only the MANAGED region is
 *     compared, so a fork's own out-of-region files are never flagged)
 * A central scheduled CI runs verify so an unaware / CI-less / stale fork is
 * caught (plan §5).
 *
 * Pure: hashing/HMAC over provided {path, content} pairs + a key. No fs here
 * (the CLI reads files and calls these). The key is NEVER logged.
 */

const crypto = require("crypto");

function hashContent(content) {
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function canonicalBody(epoch, entries) {
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return JSON.stringify({ epoch, entries: sorted });
}

function sign(body, key) {
	return crypto.createHmac("sha256", key).update(body).digest("hex");
}

/**
 * @param {Array<{path:string, content:(string|Buffer)}>} files  managed region
 * @param {{epoch:number, key:string}} opts
 * @returns {{version:number, epoch:number, entries:Array<{path,hash}>, sig:string}}
 */
function generateManifest(files, opts) {
	const entries = files.map((f) => ({ path: f.path, hash: hashContent(f.content) }));
	const body = canonicalBody(opts.epoch, entries);
	return { version: 1, epoch: opts.epoch, entries, sig: sign(body, opts.key) };
}

/**
 * Verify a manifest's signature + anti-rollback epoch.
 * @param {object} manifest
 * @param {{key:string, minEpoch?:number}} opts
 * @returns {{ok:boolean, reason:string}}
 */
function verifyManifest(manifest, opts) {
	if (!manifest || !Array.isArray(manifest.entries)) return { ok: false, reason: "manifest 형식 오류" };
	const body = canonicalBody(manifest.epoch, manifest.entries);
	const expect = sign(body, opts.key);
	// constant-time compare
	const a = Buffer.from(expect);
	const b = Buffer.from(String(manifest.sig || ""));
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "서명 불일치(변조/키 불일치)" };
	if (opts.minEpoch != null && manifest.epoch < opts.minEpoch) {
		return { ok: false, reason: `epoch 롤백(${manifest.epoch} < 요구 ${opts.minEpoch}) — anti-rollback` };
	}
	return { ok: true, reason: "유효" };
}

/**
 * 3-way managed-region diff: compare a downstream's CURRENT file hashes against
 * the SoT manifest. ONLY the managed region (manifest entries) is compared;
 * files the downstream has outside the region are never flagged.
 * @param {object} sotManifest
 * @param {Object<string,string>} downstreamHashes  { path: hash } (current)
 * @returns {{ok:boolean, drifted:string[], missing:string[]}}
 */
function diffManagedRegion(sotManifest, downstreamHashes) {
	const drifted = [];
	const missing = [];
	for (const e of sotManifest.entries || []) {
		const cur = downstreamHashes[e.path];
		if (cur == null) missing.push(e.path);
		else if (cur !== e.hash) drifted.push(e.path);
	}
	return { ok: drifted.length === 0 && missing.length === 0, drifted, missing };
}

module.exports = { hashContent, generateManifest, verifyManifest, diffManagedRegion };
