#!/usr/bin/env node
/** Launch a reviewer in the native platform sandbox and ingest two-party attestations. */

const path = require("path");
const core = require("../.agents/hooks/core/request-contract.js");
const runner = require("../.agents/hooks/core/request-contract-review-runner.js");

function args(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index++) if (argv[index].startsWith("--")) out[argv[index].slice(2)] = argv[++index];
	return out;
}

function locate(cwd, id) {
	if (!id || !/^[a-f0-9]{32}$/.test(id) || !core.listUnits(cwd).includes(id)) throw Object.assign(new Error("valid --unit is required"), { code: "unit_id_invalid" });
	return { id, paths: core.unitPaths(cwd, id) };
}

function main() {
	const input = args(process.argv.slice(2));
	const cwd = path.resolve(input.cwd || process.cwd());
	const unit = locate(cwd, input.unit);
	if (!input["writer-session"] || !input.reviewer || !input["reviewer-attestor"] || !input["runner-attestor"]) throw Object.assign(new Error("--writer-session, --reviewer, --reviewer-attestor, and --runner-attestor are required"), { code: "review_runner_argument_missing" });
	const config = core.loadConfig(cwd);
	const issued = core.issueReviewInvocation(unit, cwd, input["writer-session"]);
	const bundlePath = path.resolve(cwd, issued.manifest.bundle_locator);
	const contextId = `review-${issued.manifest.nonce}`;
	const isolated = runner.runSandbox({
		bundlePath,
		expectedBundleDigest: issued.manifest.bundle_digest,
		reviewerPath: path.resolve(input.reviewer),
		allowedReviewerDigests: config.review_runner.allowed_reviewer_digests,
		allowedSandboxDigests: config.review_runner.allowed_sandbox_digests,
		env: { REQUEST_CONTRACT_CHALLENGE: issued.manifest.nonce, REQUEST_CONTRACT_CONTEXT_ID: contextId, REQUEST_CONTRACT_REVIEW_STAGE: issued.manifest.review_stage, REQUEST_CONTRACT_REVIEW_ROLE: issued.manifest.required_role || "general", REQUEST_CONTRACT_DELIVERY_STATE: issued.manifest.expected_delivery_state },
	});
	const review = {
		...isolated.output,
		review_stage: issued.manifest.review_stage,
		planning_digest: issued.manifest.planning_digest,
		planning_seal_digest: issued.manifest.planning_seal_digest,
		run_id: issued.manifest.review_run_id,
		reviewed_at: isolated.evidence.executed_at,
		bundle_digest: issued.manifest.bundle_digest,
		full_bundle_digest: issued.manifest.full_bundle_digest,
		evidence_view_digest: issued.manifest.evidence_view_digest,
		source_head: issued.manifest.source_head,
		contract_digest: issued.manifest.contract_digest,
		workspace_digest: issued.manifest.workspace_digest,
		config_digest: issued.manifest.config_digest,
		scope_epoch: issued.manifest.scope_epoch,
		work_revision: issued.manifest.work_revision,
		binding_epoch: issued.manifest.binding_epoch,
	};
	const reviewerAttestorPath = path.resolve(input["reviewer-attestor"]);
	const runnerAttestorPath = path.resolve(input["runner-attestor"]);
	const reviewerAttestorDigest = runner.pinnedExecutableDigest(reviewerAttestorPath, config.reviewer.allowed_attestor_digests);
	const runnerAttestorDigest = runner.pinnedExecutableDigest(runnerAttestorPath, config.review_runner.allowed_attestor_digests);
	review.executor = { credential_id: config.reviewer.credential_id, context_id: contextId, process_id: isolated.evidence.launcher_process_id, process_identity: isolated.evidence.reviewer_process_identity, started_at: isolated.evidence.started_at, attestor_executable_digest: reviewerAttestorDigest, signature: "" };
	review.sandbox = { no_network: true, repository_blind: true, home_blind: true };
	const reviewerSignature = runner.externalSign(reviewerAttestorPath, core.canonicalJson(core.reviewSignaturePayload(review)), config.reviewer.allowed_attestor_digests);
	review.executor.signature = reviewerSignature.signature;
	review.isolation = {
		credential_id: config.review_runner.credential_id,
		execution_id: `execution-${core.opaqueId()}`,
		challenge: issued.manifest.nonce,
		bundle_digest: issued.manifest.bundle_digest,
		reviewer_context_id: review.executor.context_id,
		reviewer_process_id: review.executor.process_id,
		reviewer_process_identity: review.executor.process_identity,
		...isolated.evidence,
		attestor_executable_digest: runnerAttestorDigest,
		review_payload_digest: core.sha256(core.canonicalJson(core.reviewSignaturePayload(review))),
		signature: "",
	};
	const isolationSignature = runner.externalSign(runnerAttestorPath, core.canonicalJson(core.isolationSignaturePayload(review.isolation)), config.review_runner.allowed_attestor_digests);
	review.isolation.signature = isolationSignature.signature;
	const record = core.appendReview(unit, review, {
		expectedBundleDigest: issued.manifest.bundle_digest,
		reviewerPublicKey: core.loadReviewerKey(cwd, config),
		reviewerCredentialId: config.reviewer.credential_id,
		reviewRunnerPublicKey: core.loadReviewRunnerKey(cwd, config),
		reviewRunnerCredentialId: config.review_runner.credential_id,
		runnerEvidence: isolated.evidence,
		cwd,
	});
	process.stdout.write(JSON.stringify({ verdict: record.verdict, run_id: record.run_id }) + "\n");
}

try { main(); } catch (error) {
	process.stderr.write(JSON.stringify({ error: error.code || "review_runner_failed" }) + "\n");
	process.exit(1);
}
