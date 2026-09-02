"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const contractCore = require("../hooks/core/session-contract.js");

function readJson(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function switchSubject(fromContractId, toContractId, safeId) {
	const from = safeId(fromContractId, "from_contract_id");
	const to = safeId(toContractId, "to_contract_id");
	return `switch-${crypto.createHash("sha256").update(`${from}\0${to}`).digest("hex")}`;
}

function registryPointer(contract, digest) {
	return {
		contract_id: contract.id,
		contract_path: `.agents/session-contracts/${path.basename(contract.__filePath)}`,
		contract_digest: digest,
	};
}

function transactionDigest(transaction) {
	const unsigned = { ...transaction };
	delete unsigned.transaction_digest;
	return crypto.createHash("sha256").update(JSON.stringify(contractCore.stableValue(unsigned))).digest("hex");
}

function sealTransaction(transaction) {
	return { ...transaction, transaction_digest: transactionDigest(transaction) };
}

function assertTransactionIntegrity(transaction) {
	if (!transaction?.transaction_digest || transaction.transaction_digest !== transactionDigest(transaction)) throw new Error("recovery_transaction_digest_mismatch");
}

function sameValue(left, right) {
	return JSON.stringify(contractCore.stableValue(left ?? null)) === JSON.stringify(contractCore.stableValue(right ?? null));
}

function registryTransition(transaction) {
	const registry = readJson(transaction.registry_path);
	if (!registry?.bindings || !transaction.registry_preconditions || !transaction.registry_postconditions) throw new Error("contract_state_inconsistent");
	let alreadyApplied = true;
	for (const [sessionId, expected] of Object.entries(transaction.registry_preconditions)) {
		const actual = registry.bindings[sessionId] ?? null;
		const post = transaction.registry_postconditions[sessionId] ?? null;
		if (!sameValue(actual, expected) && !sameValue(actual, post)) throw new Error(`registry_changed_since_recovery_prepared:${sessionId}`);
		if (!sameValue(actual, post)) alreadyApplied = false;
	}
	const next = JSON.parse(JSON.stringify(registry));
	for (const [sessionId, pointer] of Object.entries(transaction.registry_postconditions)) {
		if (pointer === null) delete next.bindings[sessionId];
		else next.bindings[sessionId] = pointer;
	}
	return { alreadyApplied, next };
}

function filesMatch(pairs) {
	return pairs.every(([filePath, expected]) => sameValue(readJson(filePath), expected));
}

function withDigest(contract, sessionIds) {
	const next = { ...contract };
	delete next.__filePath;
	next.session_bindings = sessionIds.map((sessionId) => ({ session_id: sessionId, contract_digest: "" }));
	const digest = contractCore.contractDigest(next);
	next.contract_digest = digest;
	for (const binding of next.session_bindings) binding.contract_digest = digest;
	return { contract: next, digest };
}

function acquireLocks(acquireLock, root, contractIds) {
	const releases = [];
	try {
		for (const contractId of [...new Set(contractIds)].sort()) releases.push(acquireLock(root, contractId));
	} catch (error) {
		for (const release of releases.reverse()) release();
		throw error;
	}
	return () => { for (const release of releases.reverse()) release(); };
}

module.exports = { acquireLocks, assertTransactionIntegrity, filesMatch, registryPointer, registryTransition, sealTransaction, switchSubject, withDigest };
