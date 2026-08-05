#!/usr/bin/env node
const crypto = require("crypto");

module.exports = function createRequirementTraceFixtureBuilder({
	scope, transcript, currentReviewedFiles, expectedIds, expectedDirectives, pendingIds,
	requiredUsr008Obligations, sha256, canonicalSourceEvent, loadSourceLedger,
}) {
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
		"    req_count: 16",
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
	return buildFixture;
};
