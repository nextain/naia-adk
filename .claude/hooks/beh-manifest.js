#!/usr/bin/env node
/**
 * BEH manifest CLI (§5, §6.7) — publish/verify the managed harness region.
 *
 * Logic = .agents/hooks/core/beh-manifest.js. This reads the managed region
 * (beh-* hooks + cores + registry), signs/verifies with a key (env
 * BEH_SIGN_KEY or .claude/beh-sign-key — NEVER printed).
 *
 * Usage:
 *   node beh-manifest.js generate <cwd> <epoch>   # SoT: publish beh-manifest.lock
 *   node beh-manifest.js verify <cwd> [--min-epoch N]   # fork/CI: check drift+rollback
 * Exit: 0 ok | 1 drift/rollback/bad-sig | 2 usage/key-missing.
 */
const fs = require("fs");
const path = require("path");
const m = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-manifest.js"));

const LOCK_REL = path.join(".agents", "hooks", "beh-manifest.lock");

function loadKey(cwd) {
	if (process.env.BEH_SIGN_KEY && process.env.BEH_SIGN_KEY.length >= 8) return process.env.BEH_SIGN_KEY;
	try {
		const k = fs.readFileSync(path.join(cwd, ".claude", "beh-sign-key"), "utf8").trim();
		if (k.length >= 8) return k;
	} catch {
		/* none */
	}
	return null;
}

/** Enumerate the managed region: beh-* hooks + cores + registry (sorted, rel). */
function managedFiles(cwd) {
	const out = [];
	const add = (rel) => {
		try {
			out.push({ path: rel, content: fs.readFileSync(path.join(cwd, rel)) });
		} catch {
			/* skip missing */
		}
	};
	const hooksDir = path.join(cwd, ".claude", "hooks");
	try {
		for (const f of fs.readdirSync(hooksDir).sort()) {
			if (/^beh-.*\.(js|sh)$/.test(f)) add(path.join(".claude", "hooks", f));
		}
	} catch {
		/* none */
	}
	const coreDir = path.join(cwd, ".agents", "hooks", "core");
	try {
		for (const f of fs.readdirSync(coreDir).sort()) {
			if (/^beh-.*\.js$/.test(f)) add(path.join(".agents", "hooks", "core", f));
		}
	} catch {
		/* none */
	}
	add(path.join(".agents", "hooks", "beh-registry.json"));
	return out;
}

function main() {
	const [cmd, cwdArg] = [process.argv[2], process.argv[3]];
	const cwd = cwdArg || process.cwd();
	if (cmd !== "generate" && cmd !== "verify") {
		console.error("usage: beh-manifest.js generate <cwd> <epoch> | verify <cwd> [--min-epoch N]");
		process.exit(2);
	}
	const key = loadKey(cwd);
	if (!key) {
		console.error("[beh-manifest] FAIL: 서명 키 없음 (env BEH_SIGN_KEY 또는 .claude/beh-sign-key, ≥8자).");
		process.exit(2);
	}

	if (cmd === "generate") {
		const epoch = parseInt(process.argv[4], 10);
		if (!Number.isFinite(epoch)) {
			console.error("[beh-manifest] FAIL: epoch(정수) 필요.");
			process.exit(2);
		}
		const manifest = m.generateManifest(managedFiles(cwd), { epoch, key });
		fs.writeFileSync(path.join(cwd, LOCK_REL), JSON.stringify(manifest, null, 2) + "\n");
		console.log(`[beh-manifest] published epoch=${epoch}, ${manifest.entries.length} files → ${LOCK_REL}`);
		process.exit(0);
	}

	// verify
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(cwd, LOCK_REL), "utf8"));
	} catch {
		console.error(`[beh-manifest] FAIL: ${LOCK_REL} 없음/손상.`);
		process.exit(1);
	}
	const minIdx = process.argv.indexOf("--min-epoch");
	const minEpoch = minIdx >= 0 ? parseInt(process.argv[minIdx + 1], 10) : undefined;
	const v = m.verifyManifest(manifest, { key, minEpoch });
	if (!v.ok) {
		console.error(`[beh-manifest] FAIL: ${v.reason}`);
		process.exit(1);
	}
	const cur = {};
	for (const f of managedFiles(cwd)) cur[f.path] = m.hashContent(f.content);
	const d = m.diffManagedRegion(manifest, cur);
	if (!d.ok) {
		if (d.drifted.length) console.error(`[beh-manifest] DRIFT: ${d.drifted.join(", ")}`);
		if (d.missing.length) console.error(`[beh-manifest] MISSING: ${d.missing.join(", ")}`);
		process.exit(1);
	}
	console.log(`[beh-manifest] OK epoch=${manifest.epoch}, managed region intact (${manifest.entries.length} files).`);
	process.exit(0);
}
main();
