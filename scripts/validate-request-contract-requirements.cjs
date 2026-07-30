#!/usr/bin/env node
/**
 * Deterministically validate the tracked RCI requirement and review trace.
 *
 * The review check is not satisfied by a plausible-looking string in the requirement
 * file. Each stage must name receipts in `.agents/requirements/reviews/`, each receipt
 * must carry a Clean verdict from enough distinct reviewers, and each receipt must be
 * bound to the review-scope digest of the tree it actually judged. A verdict recorded
 * for one tree therefore cannot be spent on a different one.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scope = require("./request-contract-review-scope.cjs");
const transcript = require("./request-contract-review-transcript.cjs");

const { root, requirementsDir, receiptsDir } = scope;
const sourcesDir = path.join(requirementsDir, "sources");
const stages = ["planning", "development", "test", "integration"];
/** Legacy verified RCI-001..011 receipt quorum. Four evidence roles are tracked separately by review-pass/governed review. */
const stageMinimumReviewers = { planning: 2, development: 3, test: 2, integration: 3 };
const requiredCleanRounds = 2;
const expectedIds = Array.from({ length: 14 }, (_, index) => `RCI-${String(index + 1).padStart(3, "0")}`);
const expectedDirectives = Array.from({ length: 8 }, (_, index) => `USR-${String(index + 1).padStart(3, "0")}`);
const pendingIds = new Set(["RCI-012", "RCI-013", "RCI-014"]);
const sourceKinds = new Set(["human", "derived", "candidate"]);
const sourceOrigins = new Set(["native_user_message", "derived_artifact", "external_document", "candidate"]);
/**
 * Pre-manifest receipts are usable only as historical, release-blocking evidence. Binding
 * their exact tracked bytes prevents a new or modified receipt from deleting modern
 * evidence fields and silently downgrading itself into the legacy path.
 */
const legacyReceiptDigests = new Map([
	["2026-07-14-round-1", "sha256:993850f8e8f8adbea6d382906b28f9ff76aa8e49966842113071e89dc701d0dd"],
	["2026-07-14-round-2", "sha256:972b4b85c97e103856772a2d40a03a45b9bd62d933ddfdff8c38725fe5eed543"],
]);
const requiredUsr008Obligations = new Set([
	"existing-site-preservation",
	"professor-source-scenario-integration",
	"three-round-measurement",
	"full-scope-adversarial-review",
	"generic-harness-prevention",
]);
/** One process validates one immutable review snapshot; avoid hundreds of repeated Git walks. */
const currentReviewedFiles = scope.reviewedFiles();

function fail(message) {
	throw new Error(`request-contract requirement trace: ${message}`);
}

/** Split a document on its top-level (column-zero) keys so key order never matters. */
function topLevelBlocks(text, label) {
	const blocks = new Map();
	const lines = text.split(/\r?\n/);
	let current = null;
	for (const line of lines) {
		if (/^\s*(#.*)?$/.test(line)) {
			if (current) current.body.push(line);
			continue;
		}
		const header = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
		if (header) {
			if (blocks.has(header[1])) fail(`${label}: duplicate top-level key: ${header[1]}`);
			current = { inline: header[2].trim(), body: [] };
			blocks.set(header[1], current);
			continue;
		}
		if (!current) fail(`${label}: content before any top-level key`);
		current.body.push(line);
	}
	return blocks;
}

function unquote(value) {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^"(.*)"$/s) || trimmed.match(/^'(.*)'$/s);
	return quoted ? quoted[1] : trimmed;
}

function scalarOf(blocks, key, label) {
	const block = blocks.get(key);
	if (!block || block.inline === "") fail(`${label}: missing ${key}`);
	return unquote(block.inline);
}

function bodyOf(blocks, key, label) {
	const block = blocks.get(key);
	if (!block) fail(`${label}: missing ${key} block`);
	return block.body.join("\n");
}

function inlineListOf(blocks, key, label, { allowEmpty = false } = {}) {
	const inline = scalarOf(blocks, key, label).match(/^\[(.*)\]$/s);
	if (!inline) fail(`${label}: ${key} must be an inline list`);
	const values = inline[1].split(",").map((item) => unquote(item)).filter((item) => item !== "");
	if (!allowEmpty && values.length === 0) fail(`${label}: ${key} must not be empty`);
	if (new Set(values).size !== values.length) fail(`${label}: ${key} contains duplicates`);
	return values;
}

function sha256(bytes) {
	return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Canonical event bytes bind ordering and provenance together with the exact excerpt.
 * Field order is intentionally fixed here instead of trusting object insertion order.
 */
function canonicalSourceEvent(event) {
	return Buffer.from(JSON.stringify({
		sequence: event.sequence,
		event_id: event.event_id,
		source_kind: event.source_kind,
		origin: event.origin,
		locator: event.locator,
		exact_text: event.exact_text,
		obligations: event.obligations,
	}), "utf8");
}

function sourceIndexEntries(indexText) {
	const blocks = topLevelBlocks(indexText, "requirements index");
	const body = bodyOf(blocks, "source_ledger", "requirements index");
	if (!/^\s{2}version:\s*1\s*$/m.test(body)) fail("requirements index: source_ledger version is not 1");
	const lines = body.split(/\r?\n/).filter((line) => /^\s{4}-\s*\{ id: USR-\d{3}, path:/.test(line));
	if (lines.length === 0) fail("requirements index: source_ledger has no records");
	return lines.map((line) => {
		const match = line.match(/^\s{4}- \{ id: (USR-\d{3}), path: "([^"]+)", sha256: "(sha256:[0-9a-f]{64})", source_kind: (human|derived|candidate), origin: ([a-z_]+), locator: "([^"]+)" \}\s*$/);
		if (!match) fail(`requirements index: malformed source_ledger record: ${line.trim()}`);
		return { id: match[1], path: match[2], sha256: match[3], source_kind: match[4], origin: match[5], locator: match[6] };
	});
}

function legacySourceGapIds(indexText) {
	const blocks = topLevelBlocks(indexText, "requirements index");
	const body = bodyOf(blocks, "source_ledger", "requirements index");
	const lines = body.split(/\r?\n/).filter((line) => /^\s{4}-\s*\{ id: USR-\d{3}, introduced_in:/.test(line));
	const ids = lines.map((line) => {
		const match = line.match(/^\s{4}- \{ id: (USR-\d{3}), introduced_in: "([0-9a-f]{40})", reason: "native source record was not preserved" \}\s*$/);
		if (!match) fail(`requirements index: malformed legacy source gap: ${line.trim()}`);
		return match[1];
	});
	if (new Set(ids).size !== ids.length) fail("requirements index: duplicate legacy source gap");
	return ids.sort();
}

function validateSourceLocator(locator, label) {
	if (typeof locator !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/[^\s#]+(?:#[^\s]+)?$/.test(locator)) fail(`${label}: locator is not an absolute source locator`);
	if (/^(?:self|file|inline):/i.test(locator) || locator.includes(".agents/requirements") || /^USR-\d{3}(?:$|#)/.test(locator)) {
		fail(`${label}: locator is a requirement self-reference, not native source provenance`);
	}
}

function validateSourceRecord(record, entry, label) {
	if (!record || record.schema_version !== 1) fail(`${label}: unsupported source record schema`);
	for (const key of ["id", "source_kind", "origin", "actor", "platform", "locator", "locator_access", "capture_kind", "coverage", "ordering", "digest_algorithm"]) {
		if (typeof record[key] !== "string" || record[key].trim() === "") fail(`${label}: missing ${key}`);
	}
	if (record.id !== entry.id) fail(`${label}: index/file id mismatch`);
	if (!sourceKinds.has(record.source_kind) || record.source_kind !== entry.source_kind) fail(`${label}: source_kind does not match the ledger index`);
	if (!sourceOrigins.has(record.origin) || record.origin !== entry.origin) fail(`${label}: origin does not match the ledger index`);
	if (record.source_kind === "human" && (record.origin !== "native_user_message" || record.actor !== "user")) {
		fail(`${label}: human evidence must originate from a native user message`);
	}
	if (record.id === "USR-008" && (record.source_kind !== "human" || record.origin !== "native_user_message" || record.actor !== "user")) {
		fail(`${label}: the incident directive must remain classified as a native human source`);
	}
	validateSourceLocator(record.locator, label);
	if (record.locator !== entry.locator) fail(`${label}: locator does not match the ledger index`);
	if (record.locator_access !== "restricted") fail(`${label}: private conversation locator access must be explicit`);
	if (record.capture_kind !== "public_safe_verbatim_excerpt") fail(`${label}: source capture is not a public-safe verbatim excerpt`);
	if (record.id === "USR-008" && record.coverage !== "selected_incident_directives_not_complete_history") fail(`${label}: incident excerpt is falsely represented as complete history`);
	if (record.ordering !== "relative_chronological_order_of_selected_messages") fail(`${label}: event ordering policy is missing`);
	if (record.digest_algorithm !== "sha256-canonical-event-v1") fail(`${label}: unsupported digest algorithm`);
	if (!Array.isArray(record.events) || record.events.length === 0) fail(`${label}: no source events`);

	const atomIds = new Set();
	const obligations = new Set();
	for (const [index, event] of record.events.entries()) {
		const eventLabel = `${label} event ${index + 1}`;
		const sequence = index + 1;
		if (event.sequence !== sequence) fail(`${eventLabel}: sequence is not contiguous chronological order`);
		const expectedEventId = `${record.id}-E${String(sequence).padStart(2, "0")}`;
		if (event.event_id !== expectedEventId || atomIds.has(event.event_id)) fail(`${eventLabel}: event_id is missing, duplicated, or out of order`);
		atomIds.add(event.event_id);
		if (event.source_kind !== record.source_kind || event.origin !== record.origin) fail(`${eventLabel}: source_kind/origin drift from its record`);
		const expectedLocator = `${record.locator}#selected-user-message-${String(sequence).padStart(2, "0")}`;
		validateSourceLocator(event.locator, eventLabel);
		if (event.locator !== expectedLocator) fail(`${eventLabel}: locator does not bind its chronological position`);
		if (typeof event.exact_text !== "string" || event.exact_text.trim() === "") fail(`${eventLabel}: exact_text is empty`);
		if (!Array.isArray(event.obligations) || event.obligations.length === 0 || event.obligations.some((item) => typeof item !== "string" || item.trim() === "")) {
			fail(`${eventLabel}: obligations are missing or malformed`);
		}
		if (new Set(event.obligations).size !== event.obligations.length) fail(`${eventLabel}: obligations contain duplicates`);
		for (const obligation of event.obligations) obligations.add(obligation);
		if (event.text_sha256 !== sha256(Buffer.from(event.exact_text, "utf8"))) fail(`${eventLabel}: exact_text digest mismatch`);
		if (event.event_sha256 !== sha256(canonicalSourceEvent(event))) fail(`${eventLabel}: canonical event digest mismatch`);
	}
	if (record.id === "USR-008") {
		for (const obligation of requiredUsr008Obligations) if (!obligations.has(obligation)) fail(`${label}: missing required incident obligation ${obligation}`);
	}
	return { ...entry, record, atomIds };
}

function loadSourceLedger(indexText, readSource = (relativePath) => scope.workingBytes(relativePath)) {
	const ledger = new Map();
	const paths = new Set();
	const sourceRoot = path.resolve(sourcesDir);
	for (const entry of sourceIndexEntries(indexText)) {
		if (ledger.has(entry.id)) fail(`${entry.id}: duplicate source_ledger id`);
		if (paths.has(entry.path)) fail(`${entry.id}: source_ledger path is reused`);
		paths.add(entry.path);
		const resolved = path.resolve(root, entry.path);
		if (!resolved.startsWith(`${sourceRoot}${path.sep}`) || path.extname(resolved) !== ".json") fail(`${entry.id}: source path escapes .agents/requirements/sources`);
		let bytes;
		try {
			bytes = readSource(entry.path);
		} catch {
			fail(`${entry.id}: source artifact is missing: ${entry.path}`);
		}
		if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
		if (sha256(bytes) !== entry.sha256) fail(`${entry.id}: source artifact digest mismatch`);
		let record;
		try {
			record = JSON.parse(bytes.toString("utf8"));
		} catch {
			fail(`${entry.id}: source artifact is not valid JSON`);
		}
		ledger.set(entry.id, validateSourceRecord(record, entry, entry.id));
	}
	return ledger;
}

function validateRequirementContract(blocks, label, sourceDirectives, sourceLedger) {
	const evidence = inlineListOf(blocks, "source_evidence", label);
	if (sourceDirectives.some((directive) => !evidence.includes(directive))) fail(`${label}: source_evidence does not cover source_directives`);
	for (const sourceId of new Set([...sourceDirectives, ...evidence])) {
		if (!sourceLedger.has(sourceId)) fail(`${label}: source reference ${sourceId} does not resolve to an immutable ledger record`);
	}
	const sourceAtoms = inlineListOf(blocks, "source_atoms", label);
	for (const atomId of sourceAtoms) {
		const owners = evidence.filter((sourceId) => sourceLedger.get(sourceId).atomIds.has(atomId));
		if (owners.length !== 1) fail(`${label}: source atom ${atomId} does not resolve exactly once through source_evidence`);
	}
	const sourceKind = scalarOf(blocks, "source_kind", label);
	if (!sourceKinds.has(sourceKind)) fail(`${label}: invalid source_kind`);
	if (scalarOf(blocks, "source", label) !== sourceKind) fail(`${label}: source and source_kind disagree`);
	if (sourceKind !== "derived") fail(`${label}: an RCI synthesized from ledger evidence must be classified as derived`);
	const derivedFrom = inlineListOf(blocks, "derived_from", label, { allowEmpty: true });
	const derivationKind = scalarOf(blocks, "derivation_kind", label);
	if (sourceKind === "derived") {
		if (derivedFrom.length === 0 || !["preserve", "clarify", "expand", "narrow", "replace"].includes(derivationKind)) fail(`${label}: derived source metadata is incomplete`);
	} else if (derivedFrom.length !== 0 || derivationKind !== "null") fail(`${label}: non-derived requirement carries derivation metadata`);
	for (const sourceId of derivedFrom) if (!sourceLedger.has(sourceId)) fail(`${label}: derived_from ${sourceId} does not resolve to an immutable ledger record`);
	const effect = scalarOf(blocks, "change_effect", label);
	if (!["add", "integrate", "extend", "modify", "migrate", "replace", "remove"].includes(effect)) fail(`${label}: invalid change_effect`);
	inlineListOf(blocks, "preserves", label);
	inlineListOf(blocks, "must_not_change", label);
	const approval = scalarOf(blocks, "destructive_approval", label);
	if (["migrate", "replace", "remove"].includes(effect) && approval === "null") fail(`${label}: destructive change_effect requires destructive_approval`);
	if (["narrow", "replace"].includes(derivationKind) && approval === "null") fail(`${label}: destructive source derivation requires destructive_approval`);
}

function validatePendingReviews(traceBody, label) {
	const line = traceBody.split(/\r?\n/).find((entry) => /^ {2}reviews:/.test(entry));
	if (!line) fail(`${label}: trace.reviews missing`);
	const inline = line.replace(/^ {2}reviews:\s*/, "").trim();
	for (const stage of stages) if (!new RegExp(`(?:^|[,{])\\s*${stage}:\\s*null(?:\\s*[,}])`).test(inline)) fail(`${label}: active ${stage} review must remain null until reviewed`);
}

/** Reviews must be a mapping of stage -> list of receipt ids. */
function parseReviews(traceBody, label) {
	const line = traceBody.split(/\r?\n/).find((entry) => /^ {2}reviews:/.test(entry));
	if (!line) fail(`${label}: trace.reviews missing`);
	const inline = line.replace(/^ {2}reviews:\s*/, "").trim();
	const mapping = inline.match(/^\{(.*)\}$/s);
	if (!mapping) fail(`${label}: trace.reviews must be an inline mapping`);
	const reviews = {};
	for (const stage of stages) {
		const entry = mapping[1].match(new RegExp(`(?:^|,)\\s*${stage}:\\s*\\[([^\\]]*)\\]`));
		if (!entry) fail(`${label}: ${stage} review evidence missing or not a receipt list`);
		const ids = entry[1]
			.split(",")
			.map((item) => unquote(item))
			.filter((item) => item !== "");
		if (ids.some((id) => !/^[A-Za-z0-9._-]+$/.test(id))) fail(`${label}: ${stage} names a malformed receipt id`);
		if (new Set(ids).size !== ids.length) fail(`${label}: ${stage} repeats a receipt id`);
		reviews[stage] = ids;
	}
	return reviews;
}

function parseTracePaths(traceBody, section, label) {
	const lines = traceBody.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^ {2}${section}:\\s*$`).test(line));
	if (start === -1) fail(`${label}: trace.${section} missing`);
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue;
		if (/^ {2}[^\s#]/.test(line)) break;
		if (!/^\s*-\s/.test(line)) continue;
		const pathMatch = line.match(/path:\s*("[^"]+"|'[^']+')/);
		const symbolMatch = line.match(/symbol:\s*("[^"]+"|'[^']+')/);
		if (!pathMatch) fail(`${label}: trace.${section} entry has no path`);
		if (!symbolMatch || unquote(symbolMatch[1]).trim() === "") fail(`${label}: trace.${section} entry has no symbol`);
		entries.push(unquote(pathMatch[1]));
	}
	if (entries.length === 0) fail(`${label}: trace.${section} has no entries`);
	return entries;
}

function loadReceipts(readReceipt) {
	const receipts = new Map();
	if (!fs.existsSync(receiptsDir)) fail("review receipt store is missing");
	for (const filename of fs.readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).sort()) {
		const id = filename.replace(/\.json$/, "");
		let receipt;
		try {
			const bytes = Buffer.from(readReceipt(filename));
			receipt = JSON.parse(bytes.toString("utf8"));
			Object.defineProperty(receipt, "__file_sha256", { value: sha256(bytes), enumerable: false });
		} catch {
			fail(`receipt ${id}: not valid JSON`);
		}
		if (receipt.review_id !== id) fail(`receipt ${id}: filename/review_id mismatch`);
		receipts.set(id, receipt);
	}
	return receipts;
}

/**
 * Re-derive everything the receipt claims about a reviewer straight from the preserved
 * bytes. Hashing the transcript alone proves only that *some* transcript exists: a real
 * FOUND_ISSUES transcript could sit next to a receipt asserting Clean, and both the hash
 * and the format check would pass. So the transcript is parsed again here, with the same
 * parser the issuer used, and the receipt must agree with what it says.
 */
function receiptManifestPaths(receipt, receiptId) {
	if (receipt.scope_manifest === undefined) return [];
	if (!Array.isArray(receipt.scope_manifest) || receipt.scope_manifest.length === 0) fail(`receipt ${receiptId}: scope_manifest must be a non-empty array when present`);
	const paths = [];
	for (const [index, entry] of receipt.scope_manifest.entries()) {
		const label = `receipt ${receiptId}: scope_manifest entry ${index + 1}`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${label} is not an object`);
		if (typeof entry.path !== "string" || entry.path.trim() === "" || path.isAbsolute(entry.path) || entry.path.includes("\\")) fail(`${label} has an invalid repository-relative path`);
		if (!["file", "symlink", "deletion"].includes(entry.type)) fail(`${label} has an invalid object type`);
		if (!Number.isInteger(entry.size) || entry.size < 0) fail(`${label} has an invalid size`);
		if (!/^sha256:[0-9a-f]{64}$/.test(entry.sha256 || "")) fail(`${label} has an invalid digest`);
		if (entry.type === "symlink") {
			if (typeof entry.target_path !== "string" || entry.target_path.trim() === "" || path.isAbsolute(entry.target_path) || entry.target_path.includes("\\")) fail(`${label} has an invalid internal target path`);
			if (!Number.isInteger(entry.target_size) || entry.target_size < 0) fail(`${label} has an invalid target size`);
			if (!/^sha256:[0-9a-f]{64}$/.test(entry.target_sha256 || "")) fail(`${label} has an invalid target digest`);
		} else if (entry.target_path !== undefined || entry.target_size !== undefined || entry.target_sha256 !== undefined) {
			fail(`${label} carries symlink target metadata for a non-symlink`);
		}
		paths.push(entry.path);
	}
	if (new Set(paths).size !== paths.length) fail(`receipt ${receiptId}: scope_manifest contains duplicate paths`);
	if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) fail(`receipt ${receiptId}: scope_manifest paths are not canonical sorted order`);
	return paths;
}

function deriveReviewerEvidence(reviewer, receiptId, receiptScopeDigest, receiptFiles, readLog) {
	const label = `receipt ${receiptId} reviewer ${reviewer.model}`;
	if (!/^sha256:[0-9a-f]{64}$/.test(reviewer.log_sha256 || "")) fail(`${label} has no verbatim log digest`);
	/** Containment is decided on the resolved path: a `logs/../../..` prefix passes a startsWith check. */
	const logsDir = path.join(receiptsDir, "logs");
	const resolved = typeof reviewer.log === "string" ? path.resolve(root, reviewer.log) : "";
	if (path.dirname(resolved) !== logsDir || path.basename(resolved) !== path.basename(reviewer.log || "")) {
		fail(`${label} does not preserve its transcript in the receipt store`);
	}

	let bytes;
	try {
		bytes = readLog(reviewer.log);
	} catch {
		fail(`${label} transcript is missing: ${reviewer.log}`);
	}
	const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== reviewer.log_sha256) fail(`${label} transcript does not hash to its recorded digest`);

	const derived = transcript.readTranscript(bytes);
	if (reviewer.scope_digest !== derived.scope_digest) fail(`${label} scope_digest differs from its transcript`);
	if (reviewer.files_read !== undefined && JSON.stringify(derived.files_read) !== JSON.stringify(reviewer.files_read)) {
		fail(`${label} Files Read attestation differs from its transcript`);
	}
	if (JSON.stringify(derived.covers) !== JSON.stringify(reviewer.covers)) fail(`${label} coverage differs from its transcript`);
	if (JSON.stringify(derived.stages) !== JSON.stringify(reviewer.stages)) fail(`${label} stage verdicts differ from its transcript`);
	if (JSON.stringify(derived.findings) !== JSON.stringify(reviewer.findings)) fail(`${label} finding counts differ from its transcript`);
	const readSet = new Set(derived.files_read);
	const missingFiles = receiptFiles.filter((relativePath) => !readSet.has(relativePath));
	if (missingFiles.length > 0) {
		fail(`${label} omitted ${missingFiles.length} reviewed file(s) from its Files Read attestation`);
	}
	/** The reviewer's own transcript names the tree it judged; a verdict cannot be moved onto another one. */
	if (derived.scope_digest !== receiptScopeDigest) {
		fail(`${label} judged ${derived.scope_digest ?? "an unstated tree"}, not the receipt's ${receiptScopeDigest}`);
	}
	return derived;
}

function verifyReviewerAgainstTranscript(reviewer, receiptId, stage, requirementId, scopeDigest, receiptFiles, readLog) {
	const derived = deriveReviewerEvidence(reviewer, receiptId, scopeDigest, receiptFiles, readLog);
	if (derived.stages[stage] !== reviewer.stages?.[stage]) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} claims a ${stage} verdict of ${JSON.stringify(reviewer.stages?.[stage])} but its transcript says ${JSON.stringify(derived.stages[stage])}`);
	}
	if (derived.stages[stage] !== "clean") {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not give a clean ${stage} verdict`);
	}
	if (derived.findings[stage] !== 0) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript reports ${derived.findings[stage]} ${stage} finding(s)`);
	}
	if (!derived.covers.includes(requirementId)) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not report covering it`);
	}
}

function auditReceiptIntrinsic(receipt, id, readLog) {
	if (receipt.product !== "naia-adk-request-contract") fail(`receipt ${id}: wrong product`);
	if (typeof receipt.reviewed_at !== "string" || Number.isNaN(Date.parse(receipt.reviewed_at))) fail(`receipt ${id}: invalid reviewed_at`);
	if (!/^sha256:[0-9a-f]{64}$/.test(receipt.scope_digest || "")) fail(`receipt ${id}: invalid scope digest`);
	const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers : [];
	if (reviewers.length === 0) fail(`receipt ${id}: no reviewers`);
	const hasLegacyEvidenceGap = receipt.scope_manifest === undefined || reviewers.some((reviewer) => reviewer.files_read === undefined);
	const legacyDigest = legacyReceiptDigests.get(id);
	if (hasLegacyEvidenceGap && (!legacyDigest || legacyDigest !== receipt.__file_sha256)) fail(`receipt ${id}: incomplete modern evidence without an exact legacy byte binding`);
	const receiptFiles = receiptManifestPaths(receipt, id);
	if (receipt.scope_manifest !== undefined && scope.computeManifestDigest(receipt.scope_manifest) !== receipt.scope_digest) fail(`receipt ${id}: scope_manifest does not compute to its scope_digest`);

	const transcriptDigests = new Set();
	const identities = new Set();
	const facts = [];
	for (const reviewer of reviewers) {
		const identity = `${reviewer.tool}/${reviewer.model}`;
		if (identities.has(identity)) fail(`receipt ${id}: duplicate reviewer identity ${identity}`);
		identities.add(identity);
		if (transcriptDigests.has(reviewer.log_sha256)) fail(`receipt ${id}: one transcript is listed under two reviewers`);
		transcriptDigests.add(reviewer.log_sha256);
		facts.push(deriveReviewerEvidence(reviewer, id, receipt.scope_digest, receiptFiles, readLog));
	}

	const expectedStages = {};
	for (const stage of stages) {
		const verdicts = facts.map((fact) => fact.stages[stage]);
		const clean = verdicts.filter((verdict) => verdict === "clean").length;
		const dirty = verdicts.filter((verdict) => verdict === "dirty").length;
		const silent = verdicts.filter((verdict) => verdict === null).length;
		const findings = facts.reduce((total, fact) => total + (fact.findings[stage] || 0), 0);
		expectedStages[stage] = { verdict: dirty > 0 || clean === 0 ? "dirty" : "clean", findings, clean_reviewers: clean, dirty_reviewers: dirty, silent_reviewers: silent };
	}
	if (JSON.stringify(receipt.stages) !== JSON.stringify(expectedStages)) fail(`receipt ${id}: aggregate stage claims do not match reviewer transcripts`);
	const cleanFacts = facts.filter((fact) => stages.some((stage) => fact.stages[stage] === "clean"));
	const expectedCovers = [...new Set(cleanFacts.flatMap((fact) => fact.covers))].sort();
	if (JSON.stringify(receipt.covers) !== JSON.stringify(expectedCovers)) fail(`receipt ${id}: aggregate coverage does not match reviewer transcripts`);
}

function validateReceiptIntegrity(receipt, id, stage, requirementId, readLog) {
	const stageResult = receipt.stages?.[stage];
	if (!stageResult) fail(`${requirementId}: receipt ${id} carries no ${stage} verdict`);
	if (stageResult.verdict !== "clean") fail(`${requirementId}: receipt ${id} ${stage} verdict is not clean`);
	if (!Number.isInteger(stageResult.findings) || stageResult.findings !== 0) fail(`${requirementId}: receipt ${id} ${stage} is clean with a nonzero finding count`);
	if (!/^sha256:[0-9a-f]{64}$/.test(receipt.scope_digest || "")) fail(`${requirementId}: receipt ${id} has no valid scope digest`);
	const hasLegacyEvidenceGap = receipt.scope_manifest === undefined || (receipt.reviewers ?? []).some((reviewer) => reviewer.files_read === undefined);
	const legacyDigest = legacyReceiptDigests.get(id);
	if (hasLegacyEvidenceGap && (!legacyDigest || legacyDigest !== receipt.__file_sha256)) {
		fail(`${requirementId}: receipt ${id} omits modern manifest/Files Read evidence without an exact legacy byte binding`);
	}
	const receiptFiles = receiptManifestPaths(receipt, id);

	/**
	 * Quorum is counted per requirement, not per receipt: a reviewer only vouches for what
	 * it said it covered. One reviewer omitting RCI-007 should cost that requirement its
	 * vote, not void the receipt for the ten it did cover.
	 */
	const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers : [];
	/** Distinct reviewers means distinct reviews: the same transcript listed twice is one voice, not two. */
	const transcripts = new Set();
	for (const reviewer of reviewers) {
		if (transcripts.has(reviewer.log_sha256)) fail(`${requirementId}: receipt ${id} lists one transcript under two reviewers`);
		transcripts.add(reviewer.log_sha256);
	}
	const vouching = reviewers.filter((reviewer) => reviewer?.stages?.[stage] === "clean" && Array.isArray(reviewer.covers) && reviewer.covers.includes(requirementId));
	const identities = new Set(vouching.map((reviewer) => `${reviewer.tool}/${reviewer.model}`));
	if (identities.size < stageMinimumReviewers[stage]) {
		fail(`${requirementId}: receipt ${id} ${stage} has ${identities.size} clean reviewer(s) vouching for it; ${stageMinimumReviewers[stage]} distinct reviewers are required`);
	}
	for (const reviewer of vouching) verifyReviewerAgainstTranscript(reviewer, id, stage, requirementId, receipt.scope_digest, receiptFiles, readLog);
}

function validateReceiptEligibility(receipt, id, stage, requirementId, scopeDigest, scopeManifest) {
	if (receipt.scope_digest !== scopeDigest) fail(`${requirementId}: receipt ${id} judged a different tree (scope digest drift — the reviewed content changed after the review)`);
	if (JSON.stringify(receipt.scope_manifest) !== JSON.stringify(scopeManifest)) {
		fail(`${requirementId}: receipt ${id} does not bind the exact path, object type, size, and digest manifest supplied for review`);
	}
	const vouching = (receipt.reviewers ?? []).filter((reviewer) => reviewer?.stages?.[stage] === "clean" && Array.isArray(reviewer.covers) && reviewer.covers.includes(requirementId));
	for (const reviewer of vouching) {
		if (!Array.isArray(reviewer.files_read)) fail(`${requirementId}: receipt ${id} reviewer ${reviewer.model} has no explicit Files Read attestation for the current review schema`);
	}
}

const readLogFromDisk = (relativePath) => fs.readFileSync(path.join(root, relativePath));

function validateData(files, indexText, receipts, scopeDigest, exists = (relativePath) => fs.existsSync(path.join(root, relativePath)), readLog = readLogFromDisk, sourceLedger = new Map(), scopeManifest = scope.reviewManifest()) {
	const ids = [...files.keys()].sort();
	const legacyGaps = new Set(legacySourceGapIds(indexText));
	if (ids.join(",") !== expectedIds.join(",")) fail(`expected ${expectedIds.join(",")}; got ${ids.join(",")}`);
	if (!sourceLedger.has("USR-008")) fail("USR-008 does not resolve to an immutable source ledger record");
	for (const [receiptId, receipt] of receipts) auditReceiptIntrinsic(receipt, receiptId, readLog);

	/**
	 * A Dirty verdict against the very tree being certified is disqualifying, whether or not any
	 * requirement bothered to name that receipt. Passing by citing only the Clean rounds and
	 * quietly leaving a Dirty one in the store beside them is exactly the shape of the failure
	 * this gate exists to prevent.
	 */
	for (const [receiptId, receipt] of receipts) {
		if (receipt.scope_digest !== scopeDigest) continue;
		for (const stage of stages) {
			if (receipt.stages?.[stage]?.verdict === "dirty") {
				fail(`receipt ${receiptId} records a dirty ${stage} verdict against this exact tree; fix what it found and re-review`);
			}
		}
	}

	const directiveUnion = new Set();
	const eligibilityChecks = [];
	for (const id of expectedIds) {
		const blocks = topLevelBlocks(files.get(id), id);
		if (scalarOf(blocks, "id", id) !== id) fail(`${id}: filename/id mismatch`);
		if (scalarOf(blocks, "product", id) !== "naia-adk-request-contract") fail(`${id}: wrong product`);
		const expectedStatus = pendingIds.has(id) ? "active" : "verified";
		if (scalarOf(blocks, "status", id) !== expectedStatus) fail(`${id}: status is not ${expectedStatus}`);
		const expectedSourceKind = pendingIds.has(id) ? "derived" : "human";
		if (scalarOf(blocks, "source", id) !== expectedSourceKind) fail(`${id}: source is not ${expectedSourceKind}`);
		const expectedProvenance = pendingIds.has(id) ? "ledger_resolved" : "legacy_unresolved";
		if (scalarOf(blocks, "source_provenance", id) !== expectedProvenance) fail(`${id}: source_provenance is not ${expectedProvenance}`);

		const directiveInline = scalarOf(blocks, "source_directives", id).match(/^\[(.*)\]$/s);
		if (!directiveInline) fail(`${id}: source_directives missing or malformed`);
		const directives = directiveInline[1].split(",").map((item) => unquote(item)).filter((item) => item !== "");
		if (directives.length === 0 || directives.some((item) => !expectedDirectives.includes(item))) fail(`${id}: invalid source_directives`);
		for (const directive of directives) directiveUnion.add(directive);
		if (pendingIds.has(id)) validateRequirementContract(blocks, id, directives, sourceLedger);
		else for (const directive of directives) if (!legacyGaps.has(directive) && !sourceLedger.has(directive)) fail(`${id}: legacy directive ${directive} is neither ledger-resolved nor explicitly unresolved`);

		const acceptance = bodyOf(blocks, "acceptance_criteria", id);
		if ((acceptance.match(/^\s{2}-\s+.+$/gm) || []).length < 2) fail(`${id}: fewer than two acceptance criteria`);

		const trace = bodyOf(blocks, "trace", id);
		for (const section of ["code", "tests"]) {
			for (const relativePath of parseTracePaths(trace, section, id)) {
				if (!exists(relativePath)) fail(`${id}: trace path does not exist: ${relativePath}`);
			}
		}

		if (pendingIds.has(id)) {
			validatePendingReviews(trace, id);
		} else {
		const reviews = parseReviews(trace, id);
		for (const stage of stages) {
			const receiptIds = reviews[stage];
			if (receiptIds.length < requiredCleanRounds) {
				fail(`${id}: ${stage} names ${receiptIds.length} Clean round(s); review-pass requires ${requiredCleanRounds} consecutive`);
			}
			/**
			 * Two receipts are two rounds only if two reviews actually happened. Nothing else
			 * separates them: both must carry the same scope digest by construction, so a single
			 * round could otherwise be issued twice under different ids and satisfy the streak —
			 * which is the exact violation this gate exists to catch. Round identity is therefore
			 * the set of transcripts it was derived from: no transcript may be spent twice.
			 */
			const spent = new Map();
			for (const receiptId of receiptIds) {
				const receipt = receipts.get(receiptId);
				if (!receipt) fail(`${id}: ${stage} names receipt ${receiptId}, which does not exist in the receipt store`);
				validateReceiptIntegrity(receipt, receiptId, stage, id, readLog);
				eligibilityChecks.push({ receipt, receiptId, stage, requirementId: id });
				for (const reviewer of receipt.reviewers ?? []) {
					const previous = spent.get(reviewer.log_sha256);
					if (previous !== undefined && previous !== receiptId) {
						fail(`${id}: ${stage} counts ${previous} and ${receiptId} as separate Clean rounds, but they rest on the same reviewer transcript (${reviewer.model}) — one round cannot be spent twice`);
					}
					spent.set(reviewer.log_sha256, receiptId);
				}
			}
		}
		}

		const title = scalarOf(blocks, "title", id);
		const escapedId = id.replace("-", "\\-");
		const indexMatches = [...indexText.matchAll(new RegExp(`^\\s+- \\{ id: ${escapedId}, title: "([^"]+)", status: ([^ }]+) \\}\\s*$`, "gm"))];
		if (indexMatches.length !== 1) fail(`${id}: expected exactly one index entry`);
		if (indexMatches[0][1] !== title || indexMatches[0][2] !== expectedStatus) fail(`${id}: index title/status drift`);
	}

	if ([...directiveUnion].sort().join(",") !== expectedDirectives.join(",")) fail("USR-001 through USR-008 are not all traced");
	if (!/product:\s*naia-adk-request-contract[\s\S]*?req_count:\s*14\b/.test(indexText)) fail("request-contract index count is not 14");

	/**
	 * Release eligibility is intentionally the final pass. A known stale receipt must never
	 * short-circuit structural, index, source, trace, transcript, or receipt-integrity checks
	 * for a later requirement and thereby hide repository damage behind an expected blocker.
	 */
	for (const check of eligibilityChecks) {
		validateReceiptEligibility(check.receipt, check.receiptId, check.stage, check.requirementId, scopeDigest, scopeManifest);
	}
}

function loadRequirementFiles() {
	const files = new Map();
	const tracked = new Set(scope.requirementFilenames());
	const working = fs.readdirSync(requirementsDir).filter((name) => /^RCI-\d{3}-.+\.yaml$/.test(name));
	for (const filename of [...new Set([...tracked, ...working])].sort()) {
		const relativePath = path.posix.join(".agents", "requirements", filename);
		const text = scope.workingBytes(relativePath).toString("utf8");
		const declared = scalarOf(topLevelBlocks(text, filename), "id", filename);
		const status = scalarOf(topLevelBlocks(text, filename), "status", filename);
		if (status === "verified" && !tracked.has(filename)) fail(`${filename}: verified requirement is not Git-tracked`);
		const fromName = filename.slice(0, "RCI-000".length);
		if (declared !== fromName) fail(`${filename}: declares id ${declared}`);
		if (files.has(declared)) fail(`${declared}: declared by more than one file`);
		files.set(declared, text);
	}
	return files;
}

function expectFailure(label, run) {
	try {
		run();
	} catch {
		return;
	}
	fail(`negative self-test passed unexpectedly: ${label}`);
}

function expectFailureMatching(label, pattern, run) {
	try {
		run();
	} catch (error) {
		if (pattern.test(String(error && error.message || ""))) return;
		fail(`negative self-test failed for the wrong reason: ${label}: ${error && error.message}`);
	}
	fail(`negative self-test passed unexpectedly: ${label}`);
}

/**
 * The negative self-tests run against a synthetic fixture, not against the repository's
 * own requirement files and receipts.
 *
 * That is deliberate. Tests built on the live data can only run once the live data already
 * passes: before the first receipt exists the suite dies at "receipt store is missing", and
 * a mutation regex written for one file format goes inert against another. Either way the
 * assertions never execute and the gate quietly guards nothing. A fixture the test owns
 * outright always runs, and it exercises the rejection paths on a tree that is valid by
 * construction — so a regression that starts accepting forged receipts fails here loudly,
 * whatever state the real store happens to be in.
 */
function buildFixture() {
	const scopeManifest = currentReviewedFiles.map((relativePath) => ({ path: relativePath, type: "file", size: 1, sha256: `sha256:${"2".repeat(64)}` }));
	const scopeDigest = scope.computeManifestDigest(scopeManifest);
	const logs = new Map();
	const stageNames = ["planning", "development", "test", "integration"];
	const reviewedFiles = currentReviewedFiles;

	/** Each round produces its own transcripts — two rounds that share bytes are one round, and the validator says so. */
	const transcriptFor = (receiptId, model, covered) =>
		Buffer.from(
			[
				`Review of ${receiptId} by ${model}.`,
				"",
				"### Scope Digest",
				"",
				scopeDigest,
				"",
				"### Files Read",
				...reviewedFiles.map((relativePath) => `- \`${relativePath}\``),
				"",
				"### RCI Coverage",
				...expectedIds.map((id) => `- ${id}: ${covered.includes(id) ? "COVERED" : "NOT COVERED"}`),
				"",
				...stageNames.flatMap((stage) => {
					const heading = stage[0].toUpperCase() + stage.slice(1);
					return [`### ${heading} Findings`, "", "NONE", "", `### ${heading} Verdict`, "", "CLEAN", ""];
				}),
			].join("\n"),
		);

	const reviewerOf = (receiptId, tool, model) => {
		const logPath = `.agents/requirements/reviews/logs/${receiptId}__${tool}__${model}.log`;
		const bytes = transcriptFor(receiptId, model, expectedIds);
		logs.set(logPath, bytes);
		const derived = transcript.readTranscript(bytes);
		return {
			tool,
			model,
			log: logPath,
			log_sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
			scope_digest: derived.scope_digest,
			files_read: derived.files_read,
			covers: derived.covers,
			stages: derived.stages,
			findings: derived.findings,
		};
	};

	const receiptOf = (receiptId) => ({
		review_id: receiptId,
		product: "naia-adk-request-contract",
		reviewed_at: "2026-07-14T00:00:00+09:00",
		scope_digest: scopeDigest,
		scope_manifest: scopeManifest,
		covers: [...expectedIds],
		stages: Object.fromEntries(stageNames.map((stage) => [stage, { verdict: "clean", findings: 0, clean_reviewers: 3, dirty_reviewers: 0, silent_reviewers: 0 }])),
		reviewers: [reviewerOf(receiptId, "opencode", "alpha"), reviewerOf(receiptId, "opencode", "beta"), reviewerOf(receiptId, "opencode", "gamma")],
	});

	const receipts = new Map([
		["round-1", receiptOf("round-1")],
		["round-2", receiptOf("round-2")],
	]);

	/** A replay of round-1's transcripts under a second id: same bytes, different receipt. */
	const replayed = JSON.parse(JSON.stringify(receipts.get("round-2")));
	replayed.review_id = "round-2";
	replayed.reviewers = receipts.get("round-1").reviewers.map((reviewer) => ({ ...reviewer }));

	const reviewsLine = `  reviews: { ${stageNames.map((stage) => `${stage}: ["round-1", "round-2"]`).join(", ")} }`;
	const files = new Map();
	for (const [index, id] of expectedIds.entries()) {
		const pending = pendingIds.has(id);
		const directives = pending ? ["USR-008"] : index === 0 ? expectedDirectives : [expectedDirectives[index % expectedDirectives.length]];
		files.set(
			id,
			[
				`id: ${id}`,
				`title: "Fixture ${id}"`,
				"product: naia-adk-request-contract",
				`status: ${pending ? "active" : "verified"}`,
				`source: ${pending ? "derived" : "human"}`,
				`source_provenance: ${pending ? "ledger_resolved" : "legacy_unresolved"}`,
				`source_directives: [${directives.join(", ")}]`,
				...(pending ? [
					"source_evidence: [USR-008]",
					"source_atoms: [USR-008-E01]",
					"source_kind: derived",
					"derived_from: [USR-008]",
					"derivation_kind: expand",
					"change_effect: extend",
					"preserves: [fixture-surface]",
					"must_not_change: [fixture-boundary]",
					"destructive_approval: null",
				] : []),
				"acceptance_criteria:",
				'  - "First criterion."',
				'  - "Second criterion."',
				"trace:",
				"  code:",
				'    - { path: "scripts/validate-request-contract-requirements.cjs", symbol: "validateData", coverage: full }',
				"  tests:",
				'    - { path: "scripts/request-contract-review-transcript.cjs", symbol: "selfTest", coverage: full }',
				pending ? "  reviews: { planning: null, development: null, test: null, integration: null }" : reviewsLine,
				"decisions: []",
				"",
			].join("\n"),
		);
	}

	const sourcePath = ".agents/requirements/sources/USR-008-fixture.json";
	const sourceRecord = {
		schema_version: 1,
		id: "USR-008",
		source_kind: "human",
		origin: "native_user_message",
		actor: "user",
		platform: "fixture-chat",
		locator: "conversation://private/request-contract-fixture",
		locator_access: "restricted",
		capture_kind: "public_safe_verbatim_excerpt",
		coverage: "selected_incident_directives_not_complete_history",
		ordering: "relative_chronological_order_of_selected_messages",
		digest_algorithm: "sha256-canonical-event-v1",
		capture_note: "Synthetic validator fixture.",
		events: [{
			sequence: 1,
			event_id: "USR-008-E01",
			source_kind: "human",
			origin: "native_user_message",
			locator: "conversation://private/request-contract-fixture#selected-user-message-01",
			exact_text: "Fixture native user directive.",
			obligations: [...requiredUsr008Obligations],
			text_sha256: "",
			event_sha256: "",
		}],
	};
	sourceRecord.events[0].text_sha256 = sha256(Buffer.from(sourceRecord.events[0].exact_text, "utf8"));
	sourceRecord.events[0].event_sha256 = sha256(canonicalSourceEvent(sourceRecord.events[0]));
	const sourceBytes = Buffer.from(`${JSON.stringify(sourceRecord, null, 2)}\n`, "utf8");
	const indexText = [
		"source_ledger:",
		"  version: 1",
		"  records:",
		`    - { id: USR-008, path: "${sourcePath}", sha256: "${sha256(sourceBytes)}", source_kind: human, origin: native_user_message, locator: "${sourceRecord.locator}" }`,
		"  legacy_unresolved:",
		...expectedDirectives.slice(0, 7).map((id) => `    - { id: ${id}, introduced_in: "${"a".repeat(40)}", reason: "native source record was not preserved" }`),
		"products:",
		"  - product: naia-adk-request-contract",
		"    req_count: 14",
		"    requirements:",
		...expectedIds.map((id) => `      - { id: ${id}, title: "Fixture ${id}", status: ${pendingIds.has(id) ? "active" : "verified"} }`),
		"",
	].join("\n");
	const sourceLedger = loadSourceLedger(indexText, (relativePath) => {
		if (relativePath !== sourcePath) throw new Error("fixture: source path missing");
		return sourceBytes;
	});

	/** The fixture owns its filesystem too: only the paths it traces exist, so a mutated path really is missing. */
	const present = new Set(["scripts/validate-request-contract-requirements.cjs", "scripts/request-contract-review-transcript.cjs"]);
	const exists = (relativePath) => present.has(relativePath);
	const readLog = (relativePath) => {
		if (!logs.has(relativePath)) throw new Error(`fixture: no such transcript: ${relativePath}`);
		return logs.get(relativePath);
	};

	/** A transcript that covers everything except RCI-007 — proves the NOT COVERED branch is live. */
	const partialFor = (receiptId, model) => transcriptFor(receiptId, model, expectedIds.filter((id) => id !== "RCI-007"));

	return { files, indexText, receipts, scopeDigest, scopeManifest, exists, readLog, logs, replayed, partialFor, sourcePath, sourceRecord, sourceBytes, sourceLedger };
}

function runSelfTests() {
	const base = buildFixture();
	const check = (files = base.files, indexText = base.indexText, receipts = base.receipts, scopeDigest = base.scopeDigest, readLog = base.readLog, sourceLedger = base.sourceLedger, scopeManifest = base.scopeManifest) =>
		validateData(files, indexText, receipts, scopeDigest, base.exists, readLog, sourceLedger, scopeManifest);

	/** The fixture must pass as-is, or every rejection below would "pass" for the wrong reason. */
	check();

	const mutateAll = (replace) => new Map([...base.files].map(([id, text]) => [id, replace(text, id)]));
	const mutateOne = (id, replace) => {
		const before = base.files.get(id);
		const after = replace(before);
		if (after === before) fail(`negative self-test is inert: its mutation did not change ${id}`);
		return new Map([...base.files].map(([key, text]) => [key, key === id ? after : text]));
	};

	expectFailure("active requirement without source evidence", () => {
		check(mutateOne("RCI-012", (text) => text.replace(/^source_evidence:.*\r?\n/m, "")));
	});
	expectFailure("requirement source self-reference instead of a ledger record", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source_evidence: [USR-008]", "source_evidence: [RCI-012]")));
	});
	expectFailure("requirement source atom is an arbitrary string", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source_atoms: [USR-008-E01]", "source_atoms: [looks-like-evidence]")));
	});
	expectFailure("derived requirement launders itself as a human source", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source: derived", "source: human").replace("source_kind: derived", "source_kind: human")));
	});
	expectFailure("destructive active requirement without approval", () => {
		check(mutateOne("RCI-012", (text) => text.replace("change_effect: extend", "change_effect: replace")));
	});
	expectFailure("legacy provenance gap is silently omitted", () => {
		check(base.files, base.indexText.replace(/^\s{4}- \{ id: USR-001, introduced_in:.*\r?\n/m, ""));
	});

	const sourceIndexWith = (bytes, { sourceKind = "human", origin = "native_user_message", locator = base.sourceRecord.locator } = {}) =>
		base.indexText
			.replace(sha256(base.sourceBytes), sha256(bytes))
			.replace("source_kind: human, origin: native_user_message", `source_kind: ${sourceKind}, origin: ${origin}`)
			.replace(`locator: "${base.sourceRecord.locator}"`, `locator: "${locator}"`);
	const sourceBytesFrom = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
	const readOnlySource = (bytes) => (relativePath) => {
		if (relativePath !== base.sourcePath) throw new Error("fixture source missing");
		return bytes;
	};
	const cloneSource = () => JSON.parse(JSON.stringify(base.sourceRecord));

	expectFailure("source artifact bytes do not match the index digest", () => {
		const bytes = Buffer.concat([base.sourceBytes, Buffer.from(" ")]);
		loadSourceLedger(base.indexText, readOnlySource(bytes));
	});
	expectFailure("source locator self-references the requirement ledger", () => {
		const record = cloneSource();
		record.locator = "self://USR-008";
		record.events[0].locator = `${record.locator}#selected-user-message-01`;
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { locator: record.locator }), readOnlySource(bytes));
	});
	expectFailure("source_kind laundering changes a native directive to candidate", () => {
		const record = cloneSource();
		record.source_kind = "candidate";
		record.origin = "candidate";
		record.events[0].source_kind = "candidate";
		record.events[0].origin = "candidate";
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { sourceKind: "candidate", origin: "candidate" }), readOnlySource(bytes));
	});
	expectFailure("source origin laundering changes a native directive to derived", () => {
		const record = cloneSource();
		record.source_kind = "derived";
		record.origin = "derived_artifact";
		record.events[0].source_kind = "derived";
		record.events[0].origin = "derived_artifact";
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { sourceKind: "derived", origin: "derived_artifact" }), readOnlySource(bytes));
	});
	expectFailure("selected incident excerpts are laundered as complete history", () => {
		const record = cloneSource();
		record.coverage = "complete_history";
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	expectFailure("source excerpt changes without its text digest", () => {
		const record = cloneSource();
		record.events[0].exact_text += " tampered";
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	expectFailure("source event sequence is rewritten", () => {
		const record = cloneSource();
		record.events[0].sequence = 2;
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	const cloneReceipts = () => new Map([...base.receipts].map(([id, receipt]) => [id, JSON.parse(JSON.stringify(receipt))]));
	{
		const crlfReceipts = cloneReceipts();
		const reviewer = crlfReceipts.get("round-1").reviewers[0];
		const crlf = Buffer.from(base.logs.get(reviewer.log).toString("utf8").replace(/\n/g, "\r\n"), "utf8");
		reviewer.log_sha256 = sha256(crlf);
		check(base.files, base.indexText, crlfReceipts, base.scopeDigest, (relativePath) => relativePath === reviewer.log ? crlf : base.readLog(relativePath));
	}
	expectFailure("review transcript omits a required Files Read path", () => {
		const tampered = cloneReceipts();
		const reviewer = tampered.get("round-1").reviewers[0];
		const logs = new Map(base.logs);
		const original = logs.get(reviewer.log).toString("utf8");
		const omitted = currentReviewedFiles[0];
		const changed = Buffer.from(original.replace(`- \`${omitted}\`\n`, ""), "utf8");
		logs.set(reviewer.log, changed);
		const derived = transcript.readTranscript(changed);
		reviewer.log_sha256 = sha256(changed);
		reviewer.files_read = derived.files_read;
		const readLog = (relativePath) => {
			if (!logs.has(relativePath)) throw new Error("missing fixture transcript");
			return logs.get(relativePath);
		};
		check(base.files, base.indexText, tampered, base.scopeDigest, readLog);
	});
	const anyReceiptId = "round-1";

	for (const id of expectedIds) {
		const from = pendingIds.has(id) ? "status: active" : "status: verified";
		const to = pendingIds.has(id) ? "status: verified" : "status: active";
		expectFailure(`status drift in ${id}`, () => check(mutateOne(id, (text) => text.replace(from, to))));
		expectFailure(`index entry removed for ${id}`, () => check(base.files, base.indexText.replace(new RegExp(`^\\s+- \\{ id: ${id},.*\\n`, "m"), "")));
	}
	for (const id of expectedIds.filter((value) => !pendingIds.has(value))) {
		expectFailure(`nulled review in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, "planning: null"))));
		expectFailure(`review named by a bare string rather than receipts in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, 'planning: "2026-07-14-looks-clean"'))));
		expectFailure(`single Clean round in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[("[^"]+")[^\]]*\]/, "planning: [$1]"))));
		expectFailure(`forged receipt id in ${id}`, () => check(mutateOne(id, (text) => text.replace(/development: \[[^\]]*\]/, 'development: ["forged-clean", "forged-clean-2"]'))));
	}

	expectFailure("missing trace path", () => check(mutateAll((text) => text.replace("scripts/validate-request-contract-requirements.cjs", "missing/gone.cjs"))));
	expectFailure("empty trace symbol", () => check(mutateAll((text) => text.replace(/symbol: "[^"]*"/g, 'symbol: ""'))));
	expectFailure("duplicate top-level key", () => check(mutateAll((text) => `${text}\nstatus: active\n`)));
	expectFailure("requirement file dropped", () => check(new Map([...base.files].filter(([id]) => id !== "RCI-011"))));
	expectFailure("a directive is left untraced", () => check(mutateAll((text) => text.replace(/source_directives: \[[^\]]*\]/, "source_directives: [USR-001]"))));
	expectFailure("scope digest drift", () => check(base.files, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`));
	expectFailureMatching("stale receipt must not hide later acceptance damage", /RCI-002: fewer than two acceptance criteria/, () => {
		const damaged = mutateOne("RCI-002", (text) => text.replace(/^\s{2}- "Second criterion\."\r?\n/m, ""));
		check(damaged, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`);
	});
	expectFailureMatching("stale receipt must not hide later trace damage", /RCI-014: trace\.tests missing/, () => {
		const damaged = mutateOne("RCI-014", (text) => text.replace(/\n  tests:\n(?:    - .*\n)+/, "\n"));
		check(damaged, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`);
	});
	expectFailure("review receipt omits the exact supplied-file manifest", () => {
		const tampered = cloneReceipts();
		delete tampered.get("round-1").scope_manifest;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("a stale modern receipt cannot hide manifest tampering", /scope_manifest does not compute to its scope_digest/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").scope_manifest[0].size += 1;
		check(base.files, base.indexText, tampered, `sha256:${"0".repeat(64)}`);
	});
	expectFailureMatching("an unbound receipt cannot downgrade itself to the legacy evidence schema", /exact legacy byte binding/, () => {
		const tampered = cloneReceipts();
		delete tampered.get("round-1").scope_manifest;
		delete tampered.get("round-1").reviewers[0].files_read;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("reviewer scope claim differs from its transcript", /scope_digest differs from its transcript/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").reviewers[0].scope_digest = `sha256:${"9".repeat(64)}`;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("top-level coverage padding is rejected", /aggregate coverage does not match reviewer transcripts/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").covers.push("RCI-999");
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("aggregate reviewer counts are re-derived", /aggregate stage claims do not match reviewer transcripts/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").stages.development.clean_reviewers += 1;
		check(base.files, base.indexText, tampered);
	});
	expectFailure("receipt store emptied", () => check(base.files, base.indexText, new Map()));

	expectFailure("receipt verdict flipped to dirty", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).stages.development.verdict = "dirty";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("receipt clean with a nonzero finding count", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).stages.development.findings = 3;
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer quorum dropped", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers = tampered.get(anyReceiptId).reviewers.slice(0, 1);
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewers collapse to one identity", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		receipt.reviewers = receipt.reviewers.map((reviewer) => ({ ...reviewer, model: "same" }));
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer loses its verbatim log digest", () => {
		const tampered = cloneReceipts();
		delete tampered.get(anyReceiptId).reviewers[0].log_sha256;
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer stops vouching for the requirement", () => {
		const tampered = cloneReceipts();
		for (const reviewer of tampered.get(anyReceiptId).reviewers) reviewer.covers = [];
		check(base.files, base.indexText, tampered);
	});
	expectFailure("hand-written log digest with no matching transcript", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log_sha256 = `sha256:${"a".repeat(64)}`;
		check(base.files, base.indexText, tampered);
	});
	/**
	 * The attack hashing alone cannot see: keep a real, correctly-hashed transcript that says
	 * FOUND_ISSUES and write a receipt over it claiming Clean. Only re-parsing the bytes catches it.
	 */
	expectFailure("clean receipt over a transcript that found issues", () => {
		const tampered = cloneReceipts();
		const reviewer = tampered.get(anyReceiptId).reviewers[0];
		/**
		 * Same tree, same coverage, all four stages present — the ONLY difference from a genuine
		 * transcript is development's verdict. Anything less and the run would trip an earlier
		 * check (a missing planning section, say) and this test would pass without ever reaching
		 * the verdict comparison it is named for.
		 */
		const forged = Buffer.from(
			[
				"### Scope Digest",
				"",
				base.scopeDigest,
				"",
				"### RCI Coverage",
				...expectedIds.map((id) => `- ${id}: COVERED`),
				"",
				"### Planning Findings",
				"",
				"NONE",
				"",
				"### Planning Verdict",
				"",
				"CLEAN",
				"",
				"### Development Findings",
				"",
				"- `scripts/x.cjs:1 [CRITICAL] RCI-001 — a defect the reviewer really found`",
				"",
				"### Development Verdict",
				"",
				"FOUND_ISSUES",
				"",
				"### Test Findings",
				"",
				"NONE",
				"",
				"### Test Verdict",
				"",
				"CLEAN",
				"",
				"### Integration Findings",
				"",
				"NONE",
				"",
				"### Integration Verdict",
				"",
				"CLEAN",
			].join("\n"),
		);
		reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(forged).digest("hex")}`;
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => (relativePath === reviewer.log ? forged : base.readLog(relativePath)));
	});
	expectFailure("transcript removed from the store", () => {
		const tampered = cloneReceipts();
		const missing = tampered.get(anyReceiptId).reviewers[0].log;
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => {
			if (relativePath === missing) throw new Error("gone");
			return base.readLog(relativePath);
		});
	});
	expectFailure("transcript points outside the receipt store", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = "tmp/whatever.log";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("transcript escapes the store by path traversal", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = ".agents/requirements/reviews/logs/../../../../etc/hostname";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("transcript hides in a subdirectory of the store", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = ".agents/requirements/reviews/logs/nested/forged.log";
		check(base.files, base.indexText, tampered);
	});
	/**
	 * The violation this whole gate exists to catch: one review round, issued twice under two
	 * ids, passing as the two consecutive Clean rounds review-pass requires. Both receipts are
	 * individually valid — same scope digest, real transcripts, honest verdicts — and only the
	 * shared transcripts give it away.
	 */
	expectFailure("one round issued twice as two", () => {
		const tampered = cloneReceipts();
		tampered.set("round-2", base.replayed);
		check(base.files, base.indexText, tampered);
	});
	/** A verdict earned on the tree before the writer's last edit cannot be spent on the tree after it. */
	expectFailure("a verdict moved onto a tree its reviewer never saw", () => {
		const moved = `sha256:${"2".repeat(64)}`;
		const tampered = cloneReceipts();
		for (const receipt of tampered.values()) receipt.scope_digest = moved;
		check(base.files, base.indexText, tampered, moved);
	});
	expectFailure("one transcript listed under two reviewers", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		receipt.reviewers[1] = { ...receipt.reviewers[0], tool: "opencode", model: "beta" };
		check(base.files, base.indexText, tampered);
	});
	/**
	 * A reviewer that marked one requirement NOT COVERED must cost that requirement its vote —
	 * dropping the round below quorum for it — while the other ten stay covered. Without this,
	 * the transcript-vs-receipt coverage cross-check could be deleted and nothing would notice.
	 */
	expectFailure("a reviewer that did not cover RCI-007 cannot vouch for it", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		/** Each reviewer keeps its own distinct transcript — otherwise the duplicate-transcript check fires first and this test never reaches the quorum it is named for. */
		const partials = new Map();
		for (const reviewer of receipt.reviewers) {
			const bytes = base.partialFor(anyReceiptId, reviewer.model);
			partials.set(reviewer.log, bytes);
			reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
			reviewer.covers = expectedIds.filter((id) => id !== "RCI-007");
		}
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => partials.get(relativePath) ?? base.readLog(relativePath));
	});

	/**
	 * The receipt claims its reviewers covered RCI-007; their transcripts say otherwise. The
	 * quorum filter above cannot catch this — it reads the receipt's own claim — so only the
	 * cross-check against the preserved bytes stands between a padded `covers` list and a pass.
	 */
	expectFailure("a receipt that pads its coverage beyond what the transcripts say", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		const partials = new Map();
		for (const reviewer of receipt.reviewers) {
			const bytes = base.partialFor(anyReceiptId, reviewer.model);
			partials.set(reviewer.log, bytes);
			reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
			/** The lie: the receipt still vouches for all eleven. */
			reviewer.covers = [...expectedIds];
		}
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => partials.get(relativePath) ?? base.readLog(relativePath));
	});

	/** A Dirty verdict standing against this very tree disqualifies it, even if no requirement cites that receipt. */
	expectFailure("a dirty receipt left standing against the same tree", () => {
		const tampered = cloneReceipts();
		const dirty = JSON.parse(JSON.stringify(tampered.get("round-1")));
		dirty.review_id = "round-0";
		dirty.stages.development = { verdict: "dirty", findings: 2, clean_reviewers: 0, dirty_reviewers: 3, silent_reviewers: 0 };
		tampered.set("round-0", dirty);
		check(base.files, base.indexText, tampered);
	});
}

/** Self-tests first: they must hold whatever state the real store is in. */
if (!transcript.selfTest()) fail("the shared transcript parser failed its own self-test");
if (!scope.selfTest()) fail("the review-scope digest failed its own self-test");
runSelfTests();
if (process.env.RCI_SELF_TEST_ONLY === "1") {
	process.stdout.write("request-contract requirement trace self-tests: PASS\n");
	process.exit(0);
}

const files = loadRequirementFiles();
const indexText = fs.readFileSync(path.join(requirementsDir, "_index.yaml"), "utf8");
const sourceLedger = loadSourceLedger(indexText);
const unresolvedLegacySources = legacySourceGapIds(indexText);
const readReceipt = (filename) => fs.readFileSync(path.join(receiptsDir, filename), "utf8");
const receipts = loadReceipts(readReceipt);
const scopeDigest = scope.computeScopeDigest();
let releaseBlocker = null;
try {
	validateData(files, indexText, receipts, scopeDigest, undefined, undefined, sourceLedger, scope.reviewManifest());
} catch (error) {
	const match = String(error && error.message || "").match(/^request-contract requirement trace: (RCI-\d{3}): receipt ([A-Za-z0-9._-]+) judged a different tree \(scope digest drift/);
	if (!match) throw error;
	releaseBlocker = { code: "review_scope_stale", requirement_id: match[1], receipt_id: match[2] };
}
if (!releaseBlocker && unresolvedLegacySources.length > 0) releaseBlocker = { code: "legacy_source_provenance_unresolved", source_ids: unresolvedLegacySources };

if (process.env.RCI_RELEASE_STATUS_JSON === "1") {
	process.stdout.write(`${JSON.stringify({ status: releaseBlocker ? "blocked" : "eligible", blocker: releaseBlocker })}\n`);
	process.exit(releaseBlocker ? 3 : 0);
}
if (releaseBlocker?.code === "review_scope_stale") fail(`${releaseBlocker.requirement_id}: receipt ${releaseBlocker.receipt_id} judged a different tree (scope digest drift — the reviewed content changed after the review)`);
if (releaseBlocker?.code === "legacy_source_provenance_unresolved") fail(`legacy native source provenance remains unresolved: ${releaseBlocker.source_ids.join(", ")}; do not issue new verified receipts from AI-authored reconstructions`);

process.stdout.write("request-contract requirement trace: PASS\n");
