#!/usr/bin/env node
"use strict";

/**
 * BEH PreToolUse gate. Disabled projects exit silently; once `.claude/beh-on`
 * opts in, malformed input, missing cores, handshake drift, and unexpected
 * runtime failures all block the tool call.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HANDSHAKE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const OFF_VALUES = new Set(["0", "false", "off", "disabled"]);

function block(reason) {
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) input += chunk;
	} catch (error) {
		block(`[BEH] fail-CLOSED: hook input could not be read (${error.code || error.message}).`);
	}

	let data;
	try { data = JSON.parse(input || "{}"); }
	catch {
		const defaultConfig = path.join(process.cwd(), ".claude");
		const defaultEnabled = fs.existsSync(path.join(defaultConfig, "beh-on"))
			&& !fs.existsSync(path.join(defaultConfig, "no-harness"))
			&& !OFF_VALUES.has(String(process.env.BEH || "").trim().toLowerCase());
		if (defaultEnabled) block("[BEH] fail-CLOSED: hook input is not valid JSON.");
		process.exit(0);
	}
	const cwd = path.resolve(data.cwd || process.cwd());
	const configDir = path.join(cwd, ".claude");
	const enabled = fs.existsSync(path.join(configDir, "beh-on"))
		&& !fs.existsSync(path.join(configDir, "no-harness"))
		&& !OFF_VALUES.has(String(process.env.BEH || "").trim().toLowerCase());
	if (!enabled) process.exit(0);

	let beh, lc;
	try {
		const hostRoot = path.resolve(__dirname, "..", "..");
		beh = require(path.join(hostRoot, ".agents", "hooks", "core", "beh-ledger.js"));
		lc = require(path.join(hostRoot, ".agents", "hooks", "core", "beh-launch-core.js"));
	} catch (error) {
		block(`[BEH] fail-CLOSED: enforcement core could not be loaded (${error.code || error.message}).`);
	}
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

	const tool = data.tool_name;
	const toolInput = data.tool_input || {};
	const command = tool === "Bash" ? String(toolInput.command || "") : "";
	if (lc.isLauncher(command)) process.exit(0);

	const bypass = path.join(configDir, "beh-launch-bypass");
	if (fs.existsSync(bypass)) {
		try { fs.unlinkSync(bypass); }
		catch (error) { block(`[BEH] fail-CLOSED: one-time bypass could not be consumed (${error.code || error.message}).`); }
		process.exit(0);
	}

	let handshake = null;
	try { handshake = JSON.parse(fs.readFileSync(path.join(configDir, "beh-handshake"), "utf8")); } catch {}
	let currentHash = null;
	try { currentHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(configDir, "settings.json"))).digest("hex"); } catch {}
	const result = lc.evaluateHandshake({ handshake, currentHash, now: Date.now(), maxAgeMs: HANDSHAKE_MAX_AGE_MS });
	if (!result.ok) {
		const launcher = process.platform === "win32"
			? `node .claude/hooks/beh-launch.cjs "${cwd}"`
			: `bash .claude/hooks/beh-launch.sh "${cwd}"`;
		block(
			`[BEH] session-start fail-CLOSED: ${result.reason}.\n`
			+ `Recovery: ${launcher}\n`
			+ "One-time administrator bypass: node -e \"require('fs').writeFileSync('.claude/beh-launch-bypass','')\"",
		);
	}

	if (tool === "Bash" && (lc.isBackgrounded(command) || toolInput.run_in_background === true) && !lc.isSuperviseWrapper(command)) {
		block(
			"[BEH] Unsupervised background execution is blocked. Use the bounded wrapper:\n"
			+ "node .claude/hooks/beh-supervise.js --probe-type <type> --probe-arg <path> "
			+ "--max-wall <seconds> --max-stall <seconds> -- <command...>",
		);
	}
	process.exit(0);
}

main().catch((error) => block(`[BEH] fail-CLOSED: unexpected gate failure (${error.code || error.message}).`));
