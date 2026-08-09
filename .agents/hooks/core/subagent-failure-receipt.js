const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RECEIPT_VERSION = "subagent-failure-receipt-v1";
const KEY_MODE = 0o600;
const DIR_MODE = 0o700;

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonical(value) {
	return JSON.stringify(stableValue(value));
}

function stateDirectory(env = process.env) {
	return path.resolve(env.ADK_CODEX_FAILURE_RECEIPT_DIR || path.join(os.homedir(), ".local", "state", "naia-adk", "codex-harness"));
}

function ensureState(env = process.env) {
	const dir = stateDirectory(env);
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	fs.chmodSync(dir, DIR_MODE);
	const keyPath = path.join(dir, "failure-receipt.key");
	if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: KEY_MODE, flag: "wx" });
	fs.chmodSync(keyPath, KEY_MODE);
	return { dir, keyPath, journalPath: path.join(dir, "failure-receipts.jsonl") };
}

function signaturePayload(receipt) {
	const unsigned = { ...receipt };
	delete unsigned.signature;
	return canonical(unsigned);
}

function sign(receipt, key) {
	return crypto.createHmac("sha256", key).update(signaturePayload(receipt)).digest("hex");
}

function issueFailureReceipt(fields, opts = {}) {
	const env = opts.env || process.env;
	const state = ensureState(env);
	const observedAt = fields.observed_at || new Date(opts.now || Date.now()).toISOString();
	const receipt = {
		schema_version: RECEIPT_VERSION,
		receipt_id: `FAIL-${crypto.randomBytes(16).toString("hex")}`,
		session_id: fields.session_id,
		contract_digest: fields.contract_digest,
		task_digest: fields.task_digest,
		failure_kind: fields.failure_kind,
		error_code: fields.error_code,
		observed_at: observedAt,
	};
	const key = fs.readFileSync(state.keyPath);
	receipt.signature = sign(receipt, key);
	fs.appendFileSync(state.journalPath, `${canonical(receipt)}\n`, { mode: KEY_MODE });
	fs.chmodSync(state.journalPath, KEY_MODE);
	return receipt;
}

function loadReceipts(env = process.env) {
	const state = ensureState(env);
	const key = fs.readFileSync(state.keyPath);
	if (!fs.existsSync(state.journalPath)) return { key, receipts: new Map() };
	const receipts = new Map();
	for (const line of fs.readFileSync(state.journalPath, "utf8").split("\n").filter(Boolean)) {
		let receipt;
		try { receipt = JSON.parse(line); } catch { continue; }
		if (typeof receipt?.receipt_id === "string") receipts.set(receipt.receipt_id, receipt);
	}
	return { key, receipts };
}

function verifyFailureReceipts(receiptIds, expected, opts = {}) {
	if (!Array.isArray(receiptIds) || receiptIds.length === 0 || new Set(receiptIds).size !== receiptIds.length) {
		return "invalid_orchestrator_failure_receipts";
	}
	const { key, receipts } = loadReceipts(opts.env || process.env);
	const activation = Date.parse(expected.activated_at);
	for (const id of receiptIds) {
		if (!/^FAIL-[a-f0-9]{32}$/.test(id)) return "invalid_orchestrator_failure_receipt_id";
		const receipt = receipts.get(id);
		if (!receipt || receipt.schema_version !== RECEIPT_VERSION) return "orchestrator_failure_receipt_missing";
		const supplied = Buffer.from(String(receipt.signature || ""), "hex");
		const calculated = Buffer.from(sign(receipt, key), "hex");
		if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) return "orchestrator_failure_receipt_signature_invalid";
		if (receipt.session_id !== expected.session_id || receipt.contract_digest !== expected.contract_digest ||
			receipt.task_digest !== expected.task_digest || receipt.failure_kind !== expected.failure_kind) {
			return "orchestrator_failure_receipt_binding_mismatch";
		}
		const observed = Date.parse(receipt.observed_at);
		if (!Number.isFinite(observed) || observed > activation || activation - observed > 15 * 60 * 1000) {
			return "orchestrator_failure_receipt_stale";
		}
	}
	return null;
}

module.exports = { RECEIPT_VERSION, issueFailureReceipt, verifyFailureReceipts };
