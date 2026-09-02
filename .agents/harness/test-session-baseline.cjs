const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sessionBaseline = require("./session-baseline.cjs");
const contractCore = require("../hooks/core/session-contract.js");

// ── validateBaseline: the contract-side shape is the gate's foundation ──
assert.equal(contractCore.validateBaseline(undefined), null, "baseline is optional");
const validBaseline = {
	schema_version: "session-baseline-v1",
	intent: "one durable intent",
	flow: { current: "build", next: "verify", done_when: "tests green" },
	required_reads: [".agents/progress/x.json"],
	reack_after_mutations: 25,
};
assert.equal(contractCore.validateBaseline(validBaseline), null, "valid baseline passes");
assert.equal(contractCore.validateBaseline({ ...validBaseline, schema_version: "v2" }), "invalid_baseline_schema_version");
assert.equal(contractCore.validateBaseline({ ...validBaseline, intent: " " }), "invalid_baseline_intent");
assert.equal(contractCore.validateBaseline({ ...validBaseline, extra: 1 }), "baseline_additional_property");
assert.equal(contractCore.validateBaseline({ ...validBaseline, required_reads: [] }), "invalid_baseline_required_reads");
assert.equal(contractCore.validateBaseline({ ...validBaseline, required_reads: ["/etc/passwd"] }), "baseline_required_read_not_relative");
assert.equal(contractCore.validateBaseline({ ...validBaseline, required_reads: ["C:/x.json"] }), "baseline_required_read_not_relative");
assert.equal(contractCore.validateBaseline({ ...validBaseline, required_reads: ["../escape.json"] }), "baseline_required_read_escapes_root");
assert.equal(contractCore.validateBaseline({ ...validBaseline, required_reads: ["docs/*.md"] }), "baseline_required_read_no_wildcards");
assert.equal(contractCore.validateBaseline({ ...validBaseline, reack_after_mutations: -1 }), "invalid_baseline_reack_after_mutations");
assert.equal(contractCore.validateBaseline({ ...validBaseline, flow: { current: "x", bogus: "y" } }), "baseline_flow_additional_property");

// A contract carrying a valid baseline passes whole-contract validation;
// an invalid one fails the WHOLE contract closed (no silent gate-off).
const shapeContract = {
	schema_version: "1.0", id: "c", status: "active", project_root: ".",
	goal: "g", scope: ["s"], non_goals: [], success_criteria: ["ok"],
	allowed_paths: ["a.txt"], target_ownership: ["a.txt"], audiences: ["dev"],
	source_refs: ["USR:1"], session_bindings: [{ session_id: "S", contract_digest: "0".repeat(64) }],
	progress_file: ".agents/progress/p.json", contract_digest: "0".repeat(64),
	baseline: validBaseline,
};
assert.equal(contractCore.validateContractShape(shapeContract), null, "contract with valid baseline is valid");
assert.equal(
	contractCore.validateContractShape({ ...shapeContract, baseline: { ...validBaseline, intent: "" } }),
	"invalid_baseline_intent",
	"invalid baseline fails the whole contract",
);

// ── state machine: epoch / ack / periodic re-arm ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-baseline-"));
const write = (relative, value) => {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
try {
	write(".agents/context/agents-rules.json", "{}");
	write(".codex/hooks.json", "{}");
	assert.throws(() => sessionBaseline.statePath(root, "../evil"), /invalid_session_id/, "session id is sanitized");

	const contract = {
		schema_version: "1.0", id: "bl", status: "active", project_root: ".",
		goal: "baseline unit", scope: ["p.txt"], non_goals: [], success_criteria: ["ok"],
		allowed_paths: ["p.txt"], target_ownership: ["p.txt"], audiences: ["dev"],
		source_refs: ["USR:1"], session_bindings: [{ session_id: "S1" }],
		progress_file: ".agents/progress/bl.json",
		baseline: {
			schema_version: "session-baseline-v1",
			intent: "unit intent",
			required_reads: ["docs/a.md", "docs/b.md"],
			reack_after_mutations: 3,
		},
	};
	const digest = contractCore.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	write(".agents/session-contracts/bl.json", contract);
	write(".agents/progress/bl.json", { contract_id: "bl", contract_digest: digest });
	write(".agents/session-contracts/.session-map.json", {
		schema_version: "1.0",
		bindings: { S1: { contract_id: "bl", contract_path: ".agents/session-contracts/bl.json", contract_digest: digest } },
	});
	write("docs/a.md", "alpha content A\n");

	// no baseline declared → gate not required
	assert.deepEqual(
		sessionBaseline.gateStatus(root, "S1", { id: "x" }).required, false,
		"contracts without baseline are untouched",
	);

	// fresh session → required + unacked at epoch 1
	let gate = sessionBaseline.gateStatus(root, "S1", contract);
	assert.equal(gate.required, true);
	assert.equal(gate.acked, false, "a brand-new session starts unacked");
	assert.equal(gate.epoch, 1);
	assert.match(gate.ackCommand, /ack --session S1$/);

	// ack fails atomically when any required read is missing (docs/b.md absent)
	assert.throws(() => sessionBaseline.ack(root, "S1", contractCore), /baseline_read_missing:docs\/b\.md/);
	assert.equal(sessionBaseline.readState(root, "S1"), null, "failed ack writes no state");

	write("docs/b.md", "bravo content B\n");
	const output = sessionBaseline.ack(root, "S1", contractCore);
	assert.match(output, /unit intent/, "ack prints the intent");
	assert.match(output, /alpha content A/, "ack prints file A");
	assert.match(output, /bravo content B/, "ack prints file B");
	assert.match(output, /required read: docs\/a\.md \(sha256 [0-9a-f]{12}\)/, "ack names each read with its digest");

	gate = sessionBaseline.gateStatus(root, "S1", contract);
	assert.equal(gate.acked, true, "ack unlocks the epoch");

	// periodic re-arm: threshold 3 → two mutations keep it acked, third bumps
	sessionBaseline.noteMutation(root, "S1", contract);
	sessionBaseline.noteMutation(root, "S1", contract);
	assert.equal(sessionBaseline.gateStatus(root, "S1", contract).acked, true, "below threshold stays acked");
	sessionBaseline.noteMutation(root, "S1", contract);
	gate = sessionBaseline.gateStatus(root, "S1", contract);
	assert.equal(gate.acked, false, "threshold re-arms the gate — the client-agnostic compaction stand-in");
	assert.equal(gate.epoch, 2);

	// compaction bump on an unacked epoch still moves forward monotonically
	sessionBaseline.ack(root, "S1", contractCore);
	sessionBaseline.bumpEpoch(root, "S1", "post_compact");
	gate = sessionBaseline.gateStatus(root, "S1", contract);
	assert.equal(gate.acked, false, "compaction forces a fresh ack");
	assert.equal(gate.epoch, 3);

	// ack refuses to run for an unbound session
	assert.throws(() => sessionBaseline.ack(root, "S-UNBOUND", contractCore), /session_not_bound/);

	// corrupted state reads as unacked (fail-closed, recoverable through ack)
	fs.writeFileSync(sessionBaseline.statePath(root, "S1"), "{broken");
	gate = sessionBaseline.gateStatus(root, "S1", contract);
	assert.equal(gate.acked, false, "unreadable state is unacked, never silently open");
	sessionBaseline.ack(root, "S1", contractCore);
	assert.equal(sessionBaseline.gateStatus(root, "S1", contract).acked, true, "ack recovers from corrupted state");

	// tool-use id dedup: a host that delivers the same call twice counts once
	sessionBaseline.noteMutation(root, "S1", contract, "call-1");
	sessionBaseline.noteMutation(root, "S1", contract, "call-1");
	assert.equal(sessionBaseline.readState(root, "S1").mutations_since_ack, 1, "a redelivered tool-use id is counted once");
	sessionBaseline.noteMutation(root, "S1", contract, "call-2");
	assert.equal(sessionBaseline.readState(root, "S1").mutations_since_ack, 2, "a new tool-use id counts");

	// the ack is bound to the contract digest: editing the contract re-arms
	sessionBaseline.ack(root, "S1", contractCore);
	const edited = { ...contract, goal: "baseline unit — scope revised", session_bindings: [{ session_id: "S1" }] };
	delete edited.contract_digest;
	const editedDigest = contractCore.contractDigest(edited);
	edited.contract_digest = editedDigest;
	edited.session_bindings[0].contract_digest = editedDigest;
	write(".agents/session-contracts/bl.json", edited);
	write(".agents/progress/bl.json", { contract_id: "bl", contract_digest: editedDigest });
	write(".agents/session-contracts/.session-map.json", {
		schema_version: "1.0",
		bindings: { S1: { contract_id: "bl", contract_path: ".agents/session-contracts/bl.json", contract_digest: editedDigest } },
	});
	gate = sessionBaseline.gateStatus(root, "S1", edited);
	assert.equal(gate.acked, false, "a contract edited after the ack is unacked again");
	assert.equal(gate.reason, "contract_changed");
	assert.match(sessionBaseline.ack(root, "S1", contractCore), /unit intent/, "re-ack reads the edited contract");
	assert.equal(sessionBaseline.gateStatus(root, "S1", edited).acked, true, "re-ack binds to the new digest");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("session baseline: PASS");
