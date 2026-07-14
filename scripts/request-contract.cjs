#!/usr/bin/env node
/** Operator CLI for the tool-neutral request-contract runtime. */

const fs = require("fs");
const path = require("path");
const core = require("../.agents/hooks/core/request-contract.js");

function usage(code = 0) {
	process.stderr.write(`Usage:
  node scripts/request-contract.cjs enable|disable|status|compact
  node scripts/request-contract.cjs status --unit <opaque-id>
  node scripts/request-contract.cjs bind --unit <opaque-id> --file <contract.json>
  node scripts/request-contract.cjs authority-challenge --unit <opaque-id> --file <canonical-presentation.json>
  node scripts/request-contract.cjs review-challenge --unit <opaque-id> --writer-session <id>
  node scripts/request-contract.cjs resume --unit <opaque-id> --file <authority-receipt.json>

REQUEST_CONTRACT=on or .agents/harness/request-contract-on enables governed mode.
Contract authority signatures are verified against the configured pinned public key.
`);
	process.exit(code);
}

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
		else out._.push(argv[i]);
	}
	return out;
}

function locate(cwd, unitId) {
	if (!unitId || !/^[a-f0-9]{32}$/.test(unitId)) throw Object.assign(new Error("--unit must be an opaque 32-character id"), { code: "unit_id_invalid" });
	if (!core.listUnits(cwd).includes(unitId)) throw Object.assign(new Error("unit not found"), { code: "unit_not_found" });
	return { id: unitId, paths: core.unitPaths(cwd, unitId), head: core.readJson(core.unitPaths(cwd, unitId).head) };
}

function jsonFile(file) {
	if (!file) throw Object.assign(new Error("--file is required"), { code: "file_required" });
	return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function controlJsonFile(cwd, unit, kind, file) {
	const expected = core.controlInputPath(unit, kind);
	if (path.resolve(cwd, file || "") !== expected) throw Object.assign(new Error(`--file must use the private ${kind} control input path`), { code: "control_input_path_invalid" });
	try { fs.chmodSync(expected, core.FILE_MODE); } catch (error) { if (error.code !== "ENOENT") throw error; }
	return jsonFile(expected);
}

function status(cwd, unitId) {
	const ids = unitId ? [unitId] : core.listUnits(cwd);
	return {
		governed: core.governed(cwd),
		config_digest: core.loadConfig(cwd).digest,
		unconsumed_quarantine: core.listUnconsumedQuarantine(cwd).length,
		units: ids.map((id) => {
			const p = core.unitPaths(cwd, id);
			const head = core.readJson(p.head, {});
			const state = core.readJson(p.state, {});
			return {
				unit_id: id,
				lifecycle: head.lifecycle,
				source_count: head.source_count || 0,
				scope_epoch: head.scope_epoch || 0,
				work_revision: head.work_revision || 0,
				contract_bound: Boolean(head.contract_digest),
				terminal_status: state.terminal ? state.terminal.status : null,
			};
		}),
	};
}

function main() {
	const parsed = args(process.argv.slice(2));
	const command = parsed._[0];
	if (!command || parsed.help) usage(command ? 0 : 2);
	const cwd = path.resolve(parsed.cwd || process.cwd());
	let output;
	if (command === "enable") {
		core.secureWrite(path.join(cwd, ".agents", "harness", "request-contract-on"), `${Date.now()}\n`);
		output = { governed: true };
	} else if (command === "disable") {
		if (core.hasStickyGovernanceState(cwd)) throw Object.assign(new Error("active request-contract state cannot be disabled"), { code: "request_contract_disable_blocked_active_state" });
		try {
			fs.unlinkSync(path.join(cwd, ".agents", "harness", "request-contract-on"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		output = { governed: core.loadConfig(cwd).enabled_by_default };
	} else if (command === "status") {
		output = status(cwd, parsed.unit);
	} else if (command === "compact") {
		output = { compacted: core.compactExpiredUnits(cwd) };
	} else {
		const unit = locate(cwd, parsed.unit);
		if (command === "bind") {
			core.captureWorkspaceOccurrences(unit, cwd);
			const contract = controlJsonFile(cwd, unit, "contract", parsed.file);
			output = core.bindContract(unit, contract, { publicKeyPem: core.loadAuthorityKey(cwd), cwd, now: Date.now() });
		} else if (command === "authority-challenge") {
			output = core.issueAuthorityChallenge(unit, cwd, controlJsonFile(cwd, unit, "authority", parsed.file));
		} else if (command === "review-challenge") {
			if (!parsed["writer-session"]) throw Object.assign(new Error("--writer-session is required"), { code: "writer_session_required" });
			const challenge = core.issueReviewInvocation(unit, cwd, parsed["writer-session"]);
			output = { manifest: challenge.manifest, bundle_locator: challenge.manifest.bundle_locator };
		} else if (command === "resume") {
			output = core.resumeIncomplete(unit, controlJsonFile(cwd, unit, "resume", parsed.file), cwd);
		} else usage(2);
	}
	process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

try {
	main();
} catch (error) {
	process.stderr.write(JSON.stringify({ error: error.code || "request_contract_cli_error" }) + "\n");
	process.exit(1);
}
