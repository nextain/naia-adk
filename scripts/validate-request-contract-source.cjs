#!/usr/bin/env node
const crypto = require("crypto");
const path = require("path");

module.exports = function createRequirementSourceValidators({
	scope, root, sourcesDir, stages, fail, sourceKinds, sourceOrigins, requiredUsr008Obligations,
}) {
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
		entries.push({ path: unquote(pathMatch[1]), symbol: unquote(symbolMatch[1]) });
	}
	if (entries.length === 0) fail(`${label}: trace.${section} has no entries`);
	return entries;
}
	return { topLevelBlocks, unquote, scalarOf, bodyOf, inlineListOf, sha256, canonicalSourceEvent, sourceIndexEntries, legacySourceGapIds, validateSourceLocator, validateSourceRecord, loadSourceLedger, validateRequirementContract, validatePendingReviews, parseReviews, parseTracePaths };
};
