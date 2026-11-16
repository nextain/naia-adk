"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function validNames(names) {
	return Array.isArray(names) && names.length > 0 && new Set(names).size === names.length && names.every((name) =>
		typeof name === "string" && name.length > 0 && !path.isAbsolute(name) &&
		!name.split(/[\\/]/).some((part) => part === ".." || part === "." || part === ""));
}

function hashFiles(names, files) {
	const hash = crypto.createHash("sha256").update("gate-config-files-v1\0");
	for (const name of names) {
		const bytes = files[name];
		const nameBytes = Buffer.from(name, "utf8");
		const lengths = Buffer.alloc(16);
		lengths.writeBigUInt64BE(BigInt(nameBytes.length), 0);
		lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
		hash.update(lengths).update(nameBytes).update(bytes);
	}
	return hash.digest("hex");
}

function snapshotGateConfig(root, names) {
	try {
		if (!root || !validNames(names)) return null;
		const files = Object.create(null);
		for (const name of names) files[name] = fs.readFileSync(path.join(root, name));
		return { hash: hashFiles(names, files), files };
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

// State files are untrusted. Their name and bytes are verified against the approval
// each time they are read; neither their timestamp nor their order is authoritative.
function snapshotDirectory(env = process.env) {
	const { statePath } = require("./deploy-human-approval.js");
	return path.join(path.dirname(statePath(env)), "gate-config-snapshots");
}

function parseSnapshot(snapshot, names) {
	try {
		const config = JSON.parse(snapshot.files[names[0]].toString("utf8"));
		return config && typeof config === "object" && !Array.isArray(config) ? config : null;
	} catch { return null; }
}

function usableRefs(refs, hash) {
	const code = approvalCode(hash);
	const seen = new Set();
	return (Array.isArray(refs) ? refs : []).filter((ref) => {
		if (!ref || ref.code !== code || !/^\d{17,20}$/.test(String(ref.channelId || "")) || !/^\d{17,20}$/.test(String(ref.messageId || ""))) return false;
		const key = `${ref.channelId}/${ref.messageId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).map(({ code: c, channelId, messageId }) => ({ code: c, channelId: String(channelId), messageId: String(messageId) }));
}

function saveSnapshot(snapshot, names, env, refs) {
	try {
		const dir = snapshotDirectory(env);
		fs.mkdirSync(dir, { recursive: true });
		// References are only discovery hints. A cached reference is rechecked on Discord.
		let previousRefs = [];
		try { previousRefs = JSON.parse(fs.readFileSync(path.join(dir, `${snapshot.hash}.json`), "utf8")).refs || []; } catch {}
		const data = { files: names.map((name) => snapshot.files[name].toString("base64")), refs: usableRefs([...usableRefs(previousRefs, snapshot.hash), ...usableRefs(refs, snapshot.hash)], snapshot.hash) };
		const tmp = path.join(dir, `.${snapshot.hash}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
		fs.renameSync(tmp, path.join(dir, `${snapshot.hash}.json`));
	} catch { /* Approval remains usable even if the state directory is unavailable. */ }
}

function readCachedSnapshots(names, env) {
	const dir = snapshotDirectory(env);
	let entries;
	try { entries = fs.readdirSync(dir); } catch { return []; }
	const snapshots = [];
	for (const entry of entries) {
		if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
			const encoded = Array.isArray(data) ? data : data?.files;
			if (!Array.isArray(encoded) || encoded.length !== names.length || encoded.some((s) => typeof s !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))) continue;
			const files = Object.create(null);
			for (let i = 0; i < names.length; i++) files[names[i]] = Buffer.from(encoded[i], "base64");
			const hash = hashFiles(names, files);
			if (`${hash}.json` !== entry) continue;
			snapshots.push({ hash, files, refs: usableRefs(data?.refs, hash) });
		} catch { /* Ignore corrupt or unreadable copies. */ }
	}
	return snapshots;
}

function newerApproval(a, b) {
	if (!b || a.at !== b.at) return !b || a.at > b.at;
	// Discord snowflakes are decimal integers; string order is not numeric order.
	try { return BigInt(a.id) > BigInt(b.id); } catch { return false; }
}

/** Current bytes take priority if approved; otherwise choose the latest verified cached approval. */
async function approvedGateConfig({ root, files: names, approverId, refs, token, fetchImpl, discordConfirms, env = process.env, signal } = {}) {
	if (!validNames(names)) return null;
	const current = snapshotGateConfig(root, names);
	const confirm = discordConfirms || require("./deploy-plan.js").discordConfirms;
	async function confirmation(snapshot, needsTime) {
		const code = approvalCode(snapshot.hash);
		let latest = null;
		for (const ref of usableRefs([...(Array.isArray(refs) ? refs : []), ...(snapshot.refs || [])], snapshot.hash)) {
			if (signal?.aborted) return null;
			if (!ref || ref.code !== code) continue;
			try {
				const result = await confirm({ code, refs: [ref], approverId, expectedApproverId: approverId, token, fetchImpl, checkTimestamp: false, signal });
				if (!result?.ok) continue;
				const at = Date.parse(result.at || "");
				if (!needsTime) return { at };
				if (!Number.isFinite(at)) continue;
				const candidate = { at, id: String(ref.messageId || "") };
				if (newerApproval(candidate, latest)) latest = candidate;
			} catch { /* A failed confirmation is not an approval. */ }
		}
		return latest;
	}
	if (current) {
		const config = parseSnapshot(current, names);
		if (config && await confirmation(current, false)) {
			if (!signal?.aborted && snapshotGateConfig(root, names)?.hash === current.hash) {
				saveSnapshot(current, names, env, refs);
				return { ...current, config, source: "current" };
			}
		}
	}
	let latest = null;
	for (const snapshot of readCachedSnapshots(names, env)) {
		if (signal?.aborted) return null;
		const config = parseSnapshot(snapshot, names);
		if (!config) continue;
		const approved = await confirmation(snapshot, true);
		if (!approved) continue;
		if (newerApproval(approved, latest?.approved)) latest = { snapshot, config, approved };
	}
	return !signal?.aborted && latest ? { hash: latest.snapshot.hash, files: latest.snapshot.files, config: latest.config, source: "cache" } : null;
}

module.exports = { snapshotGateConfig, approvalCode, approvedGateConfig, snapshotDirectory };
