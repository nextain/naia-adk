"use strict";
module.exports = function createRequestContractModule(api) {
const {
	crypto, fs, path, VERSION, DIR_MODE, FILE_MODE, ID_PATTERN,
} = api;
function transactionPath(...args) { return api.transactionPath(...args); }
function applyStateTransaction(...args) { return api.applyStateTransaction(...args); }
function recoverUnitTransactions(...args) { return api.recoverUnitTransactions(...args); }

function closedObject(value, allowed, errors, code) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${code}_shape_invalid`);
		return false;
	}
	for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${code}_extra_field`);
	return true;
}

function validId(value) {
	return typeof value === "string" && ID_PATTERN.test(value);
}

function sha256(value) {
	return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function publicKeyFingerprint(value) {
	try {
		const der = crypto.createPublicKey(value).export({ type: "spki", format: "der" });
		return sha256(der);
	} catch {
		return sha256(String(value || "").trim());
	}
}

function opaqueId(prefix = "") {
	return prefix + crypto.randomBytes(16).toString("hex");
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
		return out;
	}
	return value;
}

function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

function ensureDir(dir) {
	const missing = [];
	let cursor = dir;
	while (!fs.existsSync(cursor)) {
		missing.push(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	try {
		fs.chmodSync(dir, DIR_MODE);
	} catch {
		/* best effort on platforms without POSIX modes */
	}
	for (const created of missing.reverse()) {
		fsyncDirectory(created);
		const parent = path.dirname(created);
		if (parent !== created) fsyncDirectory(parent);
	}
}

function fsyncDirectory(dir) {
	let fd;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		if (process.platform === "win32" && ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error.code)) return;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function durableRename(from, to) {
	fs.renameSync(from, to);
	const fromDir = path.dirname(from);
	const toDir = path.dirname(to);
	fsyncDirectory(toDir);
	if (fromDir !== toDir) fsyncDirectory(fromDir);
}

function durableUnlink(file) {
	try {
		fs.unlinkSync(file);
		fsyncDirectory(path.dirname(file));
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function durableRemoveTree(directory) {
	try {
		fs.rmSync(directory, { recursive: true, force: false });
		fsyncDirectory(path.dirname(directory));
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function secureWrite(file, data, opts = {}) {
	ensureDir(path.dirname(file));
	const payload = Buffer.isBuffer(data) ? data : String(data);
	if (opts.exclusive) {
		const fd = fs.openSync(file, "wx", FILE_MODE);
		try {
			fs.writeFileSync(fd, payload);
			fs.fsyncSync(fd);
		} catch (error) {
			try { fs.closeSync(fd); } finally { durableUnlink(file); }
			throw error;
		} finally {
			try { fs.closeSync(fd); } catch (error) { if (error.code !== "EBADF") throw error; }
		}
		fsyncDirectory(path.dirname(file));
		return;
	}
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${opaqueId()}.tmp`);
	try {
		const fd = fs.openSync(tmp, "wx", FILE_MODE);
		try {
			fs.writeFileSync(fd, payload);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.chmodSync(tmp, FILE_MODE);
		} catch {
			/* best effort */
		}
		durableRename(tmp, file);
	} catch (error) {
		durableUnlink(tmp);
		throw error;
	}
}

function secureJson(file, value, opts = {}) {
	secureWrite(file, JSON.stringify(value, null, 2) + "\n", opts);
}

function appendJsonl(file, value) {
	ensureDir(path.dirname(file));
	const created = !fs.existsSync(file);
	const fd = fs.openSync(file, "a", FILE_MODE);
	try {
		fs.writeSync(fd, JSON.stringify(value) + "\n");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.chmodSync(file, FILE_MODE);
	} catch {
		/* best effort */
	}
	if (created) fsyncDirectory(path.dirname(file));
}

function readJson(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function requiredJson(file, code = "runtime_state_corrupt") {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
		return value;
	} catch (error) {
		throw Object.assign(new Error(`${file}: ${error.message}`), { code });
	}
}

function optionalJson(file, fallback, code = "runtime_state_corrupt") {
	if (!fs.existsSync(file)) return fallback;
	return requiredJson(file, code);
}

function stateDigest(state) {
	return sha256(canonicalJson(state));
}

function readUnitState(unit, head = null) {
	const state = requiredJson(unit.paths.state, "unit_state_corrupt");
	const pinnedHead = head || requiredJson(unit.paths.head, "unit_head_corrupt");
	if (!state.baseline || !/^[a-f0-9]{64}$/.test(state.baseline_digest || "") || state.baseline_digest !== sha256(canonicalJson(state.baseline))) {
		throw Object.assign(new Error("lifecycle baseline manifest does not match its digest"), { code: "unit_baseline_digest_mismatch" });
	}
	if (!/^[a-f0-9]{64}$/.test(pinnedHead.state_digest || "") || pinnedHead.state_digest !== stateDigest(state)) {
		throw Object.assign(new Error("lifecycle state differs from the digest pinned in the unit head"), { code: "unit_state_digest_mismatch" });
	}
	return state;
}

function writeUnitState(unit, state, head = null, opts = {}) {
	if (fs.existsSync(transactionPath(unit, "state"))) recoverUnitTransactions(unit);
	const nextHead = head || requiredJson(unit.paths.head, "unit_head_corrupt");
	nextHead.state_digest = stateDigest(state);
	const transaction = { version: VERSION, kind: "state", state: JSON.parse(JSON.stringify(state)), head: JSON.parse(JSON.stringify(nextHead)) };
	secureJson(transactionPath(unit, "state"), transaction);
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applyStateTransaction(unit, transaction, opts);
	return transaction.head;
}

function readJsonl(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function readJsonlStrict(file, code = "runtime_jsonl_corrupt", opts = {}) {
	try {
		const raw = fs.readFileSync(file, "utf8");
		if (raw && !raw.endsWith("\n")) throw new Error("truncated final record");
		return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch (error) {
		if (opts.allowMissing && error.code === "ENOENT") return [];
		throw Object.assign(new Error(`${file}: ${error.message}`), { code });
	}
}

function normalizeRel(p) {
	const value = String(p || "");
	return (process.platform === "win32" ? value.replace(/\\/g, "/") : value)
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
}

function boundedInteger(raw, key, fallback, minimum, maximum, errors) {
	if (raw === undefined) return fallback;
	if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
		errors.push(`${key}_invalid`);
		return fallback;
	}
	return raw;
}

	return {
		closedObject,
		validId,
		sha256,
		publicKeyFingerprint,
		opaqueId,
		canonicalize,
		canonicalJson,
		ensureDir,
		fsyncDirectory,
		durableRename,
		durableUnlink,
		durableRemoveTree,
		secureWrite,
		secureJson,
		appendJsonl,
		readJson,
		requiredJson,
		optionalJson,
		stateDigest,
		readUnitState,
		writeUnitState,
		readJsonl,
		readJsonlStrict,
		normalizeRel,
		boundedInteger,
	};
};
