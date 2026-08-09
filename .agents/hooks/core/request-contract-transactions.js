"use strict";
module.exports = function createRequestContractModule(api) {
const {
	fs, path, cp, VERSION, DIR_MODE, WINDOWS_CURRENT_PROCESS_IDENTITY, ZERO_HASH, HELD_LOCKS,
	CONTROL_INPUT_NAMES, PRESERVATION_REVIEW_ROLES, sha256, opaqueId, canonicalJson, ensureDir, durableRename, durableUnlink,
	durableRemoveTree, secureJson, appendJsonl, readJson, requiredJson, stateDigest, readUnitState, readJsonlStrict,
	normalizeRel, boundedInteger,
} = api;
function listUnconsumedQuarantine(...args) { return api.listUnconsumedQuarantine(...args); }
function validateSuccessfulTerminalUnlocked(...args) { return api.validateSuccessfulTerminalUnlocked(...args); }
function loadConfig(...args) { return api.loadConfig(...args); }
function loadAuthorityKey(...args) { return api.loadAuthorityKey(...args); }
function loadConfiguredKey(...args) { return api.loadConfiguredKey(...args); }
function loadReviewerKey(...args) { return api.loadReviewerKey(...args); }
function loadReviewRunnerKey(...args) { return api.loadReviewRunnerKey(...args); }
function preservationRunnerContext(...args) { return api.preservationRunnerContext(...args); }
function harnessRoot(...args) { return api.harnessRoot(...args); }
function hasStickyGovernanceState(...args) { return api.hasStickyGovernanceState(...args); }
function governed(...args) { return api.governed(...args); }
function unitPaths(...args) { return api.unitPaths(...args); }
function controlInputPath(...args) { return api.controlInputPath(...args); }
function processIdentity(...args) { return api.processIdentity(...args); }
function lockOwnerAlive(...args) { return api.lockOwnerAlive(...args); }
function directoryIdentity(...args) { return api.directoryIdentity(...args); }
function sameDirectoryIdentity(...args) { return api.sameDirectoryIdentity(...args); }
function reapStaleDirectoryLock(...args) { return api.reapStaleDirectoryLock(...args); }
function withDirectoryLock(...args) { return api.withDirectoryLock(...args); }
function withUnitLock(...args) { return api.withUnitLock(...args); }
function withRepositoryLock(...args) { return api.withRepositoryLock(...args); }
function claimGlobalId(...args) { return api.claimGlobalId(...args); }
function claimGlobalIds(...args) { return api.claimGlobalIds(...args); }
function verifyGlobalClaim(...args) { return api.verifyGlobalClaim(...args); }

function transactionPath(unit, kind) {
	return path.join(unit.paths.transactions, `${kind}.json`);
}

function applyStateTransaction(unit, transaction, opts = {}) {
	secureJson(unit.paths.state, transaction.state);
	if (opts.afterStateWritten) opts.afterStateWritten(transaction);
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "state"));
	unit.head = transaction.head;
}

function applySourceTransaction(unit, transaction) {
	const records = readJsonlStrict(unit.paths.sources, "source_log_corrupt", { allowMissing: true });
	const expected = transaction.expected;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.sources, transaction.record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.record.record_hash) {
		throw Object.assign(new Error("source transaction conflicts with source log"), { code: "source_transaction_conflict" });
	}
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "source"));
}

function applyScopeTransactionRecord(unit, transaction) {
	const records = readJsonlStrict(unit.paths.scopeHistory, "scope_history_corrupt", { allowMissing: true });
	const expected = transaction.expected_scope;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.scopeHistory, transaction.scope_record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.scope_record.record_hash) {
		throw Object.assign(new Error("binding transaction conflicts with scope history"), { code: "binding_transaction_conflict" });
	}
	secureJson(unit.paths.scopeHead, transaction.scope_head);
}

function applyBindTransaction(unit, transaction) {
	applyScopeTransactionRecord(unit, transaction);
	secureJson(unit.paths.contract, transaction.contract);
	secureJson(unit.paths.binding, transaction.binding);
	secureJson(unit.paths.state, transaction.state);
	secureJson(unit.paths.head, transaction.head);
	for (const pending of transaction.pending_updates || []) secureJson(path.join(unit.paths.pending, pending.name), pending.value);
	durableUnlink(transactionPath(unit, "bind"));
}

function applyResumeTransaction(unit, transaction) {
	secureJson(unit.paths.state, transaction.state);
	secureJson(unit.paths.head, transaction.head);
	if (transaction.binding) secureJson(unit.paths.binding, transaction.binding);
	for (const pending of transaction.pending_updates || []) secureJson(path.join(unit.paths.pending, pending.name), pending.value);
	durableUnlink(path.join(unit.paths.locks, "success.lock"));
	durableUnlink(transactionPath(unit, "resume"));
}

function applyReviewTransaction(unit, transaction) {
	const records = readJsonlStrict(unit.paths.reviews, "review_log_corrupt", { allowMissing: true });
	const expected = transaction.expected_review;
	if (records.length === expected.count && (records.length ? records.at(-1).record_hash : ZERO_HASH) === expected.chain_head) {
		appendJsonl(unit.paths.reviews, transaction.record);
	} else if (records.length !== expected.count + 1 || records.at(-1).record_hash !== transaction.record.record_hash) {
		throw Object.assign(new Error("review transaction conflicts with review log"), { code: "review_transaction_conflict" });
	}
	secureJson(unit.paths.reviewHead, transaction.review_head);
	secureJson(path.join(unit.paths.pending, transaction.invocation_name), transaction.invocation);
	if (transaction.private_bundle_name) {
		durableUnlink(path.join(unit.paths.pending, transaction.private_bundle_name));
	}
	durableUnlink(transactionPath(unit, "review"));
}

function applySessionTransaction(unit, transaction) {
	if (transaction.binding) secureJson(unit.paths.binding, transaction.binding);
	secureJson(unit.paths.head, transaction.head);
	durableUnlink(transactionPath(unit, "session"));
}

function recoverUnitTransactions(unit) {
	for (const [kind, apply] of [["state", applyStateTransaction], ["source", applySourceTransaction], ["bind", applyBindTransaction], ["resume", applyResumeTransaction], ["review", applyReviewTransaction], ["session", applySessionTransaction]]) {
		const file = transactionPath(unit, kind);
		if (!fs.existsSync(file)) continue;
		const transaction = requiredJson(file, `${kind}_transaction_corrupt`);
		if (transaction.kind !== kind || transaction.version !== VERSION) throw Object.assign(new Error(`${kind} transaction shape invalid`), { code: `${kind}_transaction_corrupt` });
		apply(unit, transaction);
	}
}

function assertUnitMutable(unit) {
	const terminal = readUnitState(unit).terminal;
	if (terminal) throw Object.assign(new Error(`unit is terminal: ${terminal.status}`), { code: "unit_terminal" });
}

function listUnits(cwd) {
	const dir = path.join(harnessRoot(cwd), "units");
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^[a-f0-9]{32}$/.test(e.name))
			.map((e) => e.name);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
}

function hasUnitStorageState(cwd) {
	const dir = path.join(harnessRoot(cwd), "units");
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() || entry.isFile());
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw Object.assign(new Error("request-contract unit storage cannot be read"), { code: "unit_storage_unreadable", cause: error });
	}
}

function findUnit(cwd, client, sessionId) {
	const matches = [];
	for (const id of listUnits(cwd)) {
		const p = unitPaths(cwd, id);
		const head = readJson(p.head);
		const bindings = (head && head.session_bindings) || (head ? [{ client: head.client, session_id: head.session_id }] : []);
		if (head && bindings.some((b) => b.client === client && b.session_id === sessionId) && head.lifecycle !== "compacted") matches.push({ id, paths: p, head });
	}
	if (matches.length > 1) return { error: "duplicate_runtime_binding", matches };
	return matches[0] || null;
}

function unresolvedUnits(cwd) {
	return listUnits(cwd)
		.map((id) => {
			const paths = unitPaths(cwd, id);
			const head = readJson(paths.head);
			const state = readJson(paths.state);
			const corrupt = !head || !state || !/^[a-f0-9]{64}$/.test(head.state_digest || "") || head.state_digest !== stateDigest(state);
			return { id, paths, head, state, corrupt };
		})
		.filter((unit) => {
			if (unit.corrupt) return true;
			if (!unit.head || unit.head.lifecycle === "compacted") return false;
			const terminal = unit.state.terminal;
			return !terminal || terminal.status !== "success";
		});
}

function successfulHandoffExists(cwd, unit, head, terminal) {
	const proof = terminal && terminal.completion_proof;
	if (!proof || !/^[a-f0-9]{64}$/.test(proof.workspace_digest || "")) return false;
	for (const id of listUnits(cwd)) {
		if (id === unit.id) continue;
		const paths = unitPaths(cwd, id);
		const successorHead = readJson(paths.head);
		const successorState = readJson(paths.state);
		if (!successorHead || !successorState || successorHead.created_at < terminal.at) continue;
		if (successorHead.state_digest !== stateDigest(successorState)) continue;
		if (successorHead.config_digest !== head.config_digest) continue;
		if (successorState.genesis_workspace_digest === proof.workspace_digest) return true;
	}
	return false;
}

function validateSuccessfulHandoffsBeforeGenesis(cwd) {
	for (const id of listUnits(cwd)) {
		const unit = { id, paths: unitPaths(cwd, id) };
		withUnitLock(unit, () => {
			const head = requiredJson(unit.paths.head, "unit_head_corrupt");
			const state = readUnitState(unit, head);
			if (!state.terminal || state.terminal.status !== "success") return;
			const verified = validateSuccessfulTerminalUnlocked(unit, cwd, { allowHandoff: true });
			if (!verified.ok) throw Object.assign(new Error(verified.errors.join(", ")), { code: "completion_proof_invalid", errors: verified.errors });
		});
	}
}

	return {
		transactionPath,
		applyStateTransaction,
		applySourceTransaction,
		applyScopeTransactionRecord,
		applyBindTransaction,
		applyResumeTransaction,
		applyReviewTransaction,
		applySessionTransaction,
		recoverUnitTransactions,
		assertUnitMutable,
		listUnits,
		hasUnitStorageState,
		findUnit,
		unresolvedUnits,
		successfulHandoffExists,
		validateSuccessfulHandoffsBeforeGenesis,
	};
};
