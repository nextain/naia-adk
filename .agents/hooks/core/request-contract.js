/**
 * Request-contract integrity core.
 *
 * Tool-neutral policy for preserving the complete user request before an
 * agent can claim success. Host adapters translate envelopes only; they do
 * not own policy. Runtime instances are private and ignored under
 * .agents/harness/{units,quarantine,receipts-v2}.
 *
 * Threat model: prevents sincere scope drift and stale/self-inconsistent
 * completion. It does not resist an actor that rewrites every local record.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const preservationPolicy = require("./preservation-contract.js");

const VERSION = 1;
const DIR_MODE = 0o700;
const WINDOWS_CURRENT_PROCESS_IDENTITY = { value: null };
const FILE_MODE = 0o600;
const ZERO_HASH = "0".repeat(64);
const TERMINAL = new Set(["done", "superseded", "deferred", "abandoned"]);
const TRACE_KEYS = ["requirements", "use_cases", "use_case_tests", "features", "feature_tests", "implementations", "evidence"];
const TRACE_EDGES = [{ from: "directives", to: "requirements", kind: "directives_to_requirements" }].concat(
	TRACE_KEYS.slice(0, -1).map((from, index) => ({ from, to: TRACE_KEYS[index + 1], kind: `${from}_to_${TRACE_KEYS[index + 1]}` })),
);
const SCOPE_STATES = new Set(["pending", "active", "done", "superseded", "deferred", "abandoned"]);
const CLASSIFICATIONS = new Set(["directive", "context", "reference", "example", "conversation", "approval", "question", "internal", "authority"]);
const SOURCE_SUBJECTS = new Set(["agent_workflow", "artifact_runtime", "artifact_content", "end_user_flow"]);
const SOURCE_EFFECTS = new Set(["background", "precondition", "outcome", "constraint", "presentation", "verification", "audience"]);
const RENDER_POLICIES = new Set(["deny", "derive", "quote", "require"]);
const OUTPUT_KINDS = new Set(["code_symbol", "code_hunk", "ui_string", "document_heading", "document_paragraph", "developer_comment"]);
const OUTPUT_AUDIENCES = new Set(["developer", "reviewer", "internal", "end_user", "partner", "public"]);
const OUTPUT_EXPOSURES = new Set(["internal", "repository", "product_ui", "external"]);
const AUTH_OPS = new Set(["authorize_contract", "amend_scope_add", "amend_scope_replace", "supersede", "defer", "abandon", "resume"]);
const REVIEW_FINDING_CODES = new Set(["FINDING-SEMANTIC-SCOPE-OMISSION", "FINDING-SOURCE-MAPPING", "FINDING-TRACE-GAP", "FINDING-AUTHORITY-MISMATCH", "FINDING-EVIDENCE-GAP", "FINDING-CONTEXT-OUTPUT-SEPARATION", "FINDING-AUDIENCE-SURFACE-FIT", "FINDING-UNJUSTIFIED-PRODUCT-SURFACE", "FINDING-OTHER"]);
const TERMINAL_AUTHORITY_OP = { superseded: "supersede", deferred: "defer", abandoned: "abandon" };
const HELD_LOCKS = new Set();
const ID_PATTERN = /^[A-Z][A-Z0-9_-]{2,127}$/;
const REQUIRED_CLIENT_EVENTS = ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"];
const CONTROL_INPUT_NAMES = Object.freeze({ contract: "contract-input.json", authority: "authority-presentation-input.json", resume: "resume-receipt-input.json" });
const PRESERVATION_REVIEW_STAGES = Object.freeze(["planning", "integration"]);
const PRESERVATION_REVIEW_ROLES = Object.freeze(["source_fidelity", "baseline_preservation", "implementation_test", "authority_release"]);

const api = {
	crypto,
	fs,
	path,
	cp,
	preservationPolicy,
	VERSION,
	DIR_MODE,
	WINDOWS_CURRENT_PROCESS_IDENTITY,
	FILE_MODE,
	ZERO_HASH,
	TERMINAL,
	TRACE_KEYS,
	TRACE_EDGES,
	SCOPE_STATES,
	CLASSIFICATIONS,
	SOURCE_SUBJECTS,
	SOURCE_EFFECTS,
	RENDER_POLICIES,
	OUTPUT_KINDS,
	OUTPUT_AUDIENCES,
	OUTPUT_EXPOSURES,
	AUTH_OPS,
	REVIEW_FINDING_CODES,
	TERMINAL_AUTHORITY_OP,
	HELD_LOCKS,
	ID_PATTERN,
	REQUIRED_CLIENT_EVENTS,
	CONTROL_INPUT_NAMES,
	PRESERVATION_REVIEW_STAGES,
	PRESERVATION_REVIEW_ROLES,
};

Object.assign(api, require("./request-contract-foundation.js")(api));
Object.assign(api, require("./request-contract-lifecycle.js")(api));
Object.assign(api, require("./request-contract-transactions.js")(api));
Object.assign(api, require("./request-contract-workspace.js")(api));
Object.assign(api, require("./request-contract-quarantine.js")(api));
Object.assign(api, require("./request-contract-validation.js")(api));
Object.assign(api, require("./request-contract-semantics.js")(api));
Object.assign(api, require("./request-contract-binding.js")(api));
Object.assign(api, require("./request-contract-review.js")(api));
Object.assign(api, require("./request-contract-review-records.js")(api));
Object.assign(api, require("./request-contract-completion.js")(api));
Object.assign(api, require("./request-contract-completion-state.js")(api));
Object.assign(api, require("./request-contract-events.js")(api));
Object.assign(api, require("./request-contract-event-handler.js")(api));

const {
	sha256, opaqueId, canonicalize, canonicalJson, secureWrite, secureJson, durableUnlink, stateDigest,
	processIdentity, readUnitState, writeUnitState, appendJsonl, readJson, readJsonl, loadConfig, loadAuthorityKey,
	loadReviewerKey, loadReviewRunnerKey, governed, hasStickyGovernanceState, harnessRoot, unitPaths, controlInputPath, withDirectoryLock,
	withUnitLock, listUnits, findUnit, unresolvedUnits, addSessionBinding, referenceManifest, workspaceManifest, diffManifests,
	listUnconsumedQuarantine, appendQuarantine, createGenesis, adoptQuarantine, verifySourceChain, appendSource, contractDigest, scopeProjection,
	directiveDisposedScopeIds, validateAuthorityReceipt, authorityPresentation, issueAuthorityChallenge, validateContract, bindContract, appendScopeVersion, verifyScopeHistory,
	contractCoverageProjection, contractCoverageIds, buildReviewBundle, reviewSignaturePayload, isolationSignaturePayload, issueReviewInvocation, observeOccurrence, captureWorkspaceOccurrences,
	verifyReviewChain, appendReview, evaluateReviews, releaseCommandFromEvent, evaluateCompletion, resumeIncomplete, compactExpiredUnits, governedControlEvent,
	isShellTool, mutationFromEvent, clientRegistrySupports, assertSupportedClient, handleEvent, canonicalParityProjection,
} = api;
module.exports = {
	VERSION,
	DIR_MODE,
	FILE_MODE,
	TRACE_KEYS,
	TRACE_EDGES,
	sha256,
	opaqueId,
	canonicalize,
	canonicalJson,
	secureWrite,
	secureJson,
	durableUnlink,
	stateDigest,
	processIdentity,
	readUnitState,
	writeUnitState,
	appendJsonl,
	readJson,
	readJsonl,
	loadConfig,
	loadAuthorityKey,
	loadReviewerKey,
	loadReviewRunnerKey,
	governed,
	hasStickyGovernanceState,
	harnessRoot,
	unitPaths,
	controlInputPath,
	withDirectoryLock,
	withUnitLock,
	listUnits,
	findUnit,
	unresolvedUnits,
	addSessionBinding,
	referenceManifest,
	workspaceManifest,
	diffManifests,
	listUnconsumedQuarantine,
	appendQuarantine,
	createGenesis,
	adoptQuarantine,
	verifySourceChain,
	appendSource,
	contractDigest,
	scopeProjection,
	directiveDisposedScopeIds,
	validateAuthorityReceipt,
	authorityPresentation,
	issueAuthorityChallenge,
	validateContract,
	validatePreservationDeclaration: preservationPolicy.validateDeclaration,
	validateWorkspacePreservation: preservationPolicy.validateWorkspace,
	preservationSurfaceDiffDigest: preservationPolicy.surfaceDiffDigest,
	preservationSurfaceContentDigest: preservationPolicy.surfaceContentDigest,
	preservationSurfaceInventoryDigest: preservationPolicy.surfaceInventoryDigest,
	preservationVendorTreeDigest: preservationPolicy.vendorTreeDigest,
	signedProbePayload: preservationPolicy.signedProbePayload,
	signedVendorPayload: preservationPolicy.signedVendorPayload,
	signedInventoryPayload: preservationPolicy.signedInventoryPayload,
	bindContract,
	appendScopeVersion,
	verifyScopeHistory,
	contractCoverageProjection,
	contractCoverageIds,
	buildReviewBundle,
	reviewSignaturePayload,
	isolationSignaturePayload,
	issueReviewInvocation,
	observeOccurrence,
	captureWorkspaceOccurrences,
	verifyReviewChain,
	appendReview,
	evaluateReviews,
	releaseCommandFromEvent,
	evaluateCompletion,
	resumeIncomplete,
	compactExpiredUnits,
	governedControlEvent,
	isShellTool,
	mutationFromEvent,
	releaseCommandFromEvent,
	clientRegistrySupports,
	assertSupportedClient,
	handleEvent,
	canonicalParityProjection,
};
