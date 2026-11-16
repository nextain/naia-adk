"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// This list belongs to the gate code, never to the configuration being approved.
const GATE_CONFIG_FILES = Object.freeze([".claude/deploy/config.json"]);
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function snapshotGateConfig(root) {
	try {
		const hash = crypto.createHash("sha256").update("gate-config-files-v1\0");
		const files = {};
		for (const name of GATE_CONFIG_FILES) {
			const bytes = fs.readFileSync(path.join(root, name));
			const nameBytes = Buffer.from(name, "utf8");
			const lengths = Buffer.alloc(16);
			lengths.writeBigUInt64BE(BigInt(nameBytes.length), 0);
			lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
			hash.update(lengths).update(nameBytes).update(bytes);
			files[name] = bytes;
		}
		return { hash: hash.digest("hex"), files };
	} catch {
		return null;
	}
}

function approvalCode(configHash) {
	if (typeof configHash !== "string" || !/^[0-9a-f]{64}$/.test(configHash)) throw new Error("invalid gate config hash");
	const bytes = crypto.createHash("sha256").update("gate-config-v1\0").update(configHash).digest();
	let value = 0;
	let bits = 0;
	let encoded = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && encoded.length < 10) {
			bits -= 5;
			encoded += BASE32[(value >>> bits) & 31];
		}
		if (encoded.length === 10) break;
	}
	return `CFG-${encoded}`;
}

/** Returns the approved hash and its JSON snapshot. Any failure means strict defaults. */
async function approvedGateConfig({ root, approverId, refs, token, fetchImpl, discordConfirms } = {}) {
	const snapshot = snapshotGateConfig(root);
	if (!snapshot) return null;
	let parsed;
	try {
		parsed = JSON.parse(snapshot.files[GATE_CONFIG_FILES[0]].toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	} catch { return null; }
	try {
		// Lazy loading avoids a module cycle; use the same REST and author checks as plan approvals.
		const confirm = discordConfirms || require("./deploy-plan.js").discordConfirms;
		const result = await confirm({
			code: approvalCode(snapshot.hash), refs, approverId, expectedApproverId: approverId,
			token, fetchImpl, checkTimestamp: false,
		});
		if (!result?.ok || snapshotGateConfig(root)?.hash !== snapshot.hash) return null;
		return { hash: snapshot.hash, config: parsed };
	} catch { return null; }
}

module.exports = { GATE_CONFIG_FILES, snapshotGateConfig, approvalCode, approvedGateConfig };
