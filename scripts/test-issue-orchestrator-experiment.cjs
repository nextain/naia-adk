'use strict';

// This suite is deliberately maintained by a session other than the
// implementation session.  It exercises the receipt/attestation boundary as
// a consumer would, without importing implementation-private helpers.

const assert = require('assert');
const mod = require('./issue-orchestrator-experiment.cjs');

const STAGES = [
  'design', 'review_terra', 'review_hy3', 'orchestration',
  'external_approval_evidence', 'plan', 'implementation', 'testing',
  'final_review_terra', 'final_review_hy3', 'integration'
];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function hash(value) { return mod.sha256(String(value)); }

function freshPlan() {
  const devModels = mod.loadJSON(mod.resolveConfig('development-models.json'));
  const orchestrator = mod.loadJSON(mod.resolveConfig('issue-orchestrator-experiment.json'));
  const built = mod.buildPlan({
    devModels,
    orchestrator,
    issue: 'HARNESS-TEST-1',
    scope: 'scripts/issue-orchestrator-experiment.cjs'
  });
  assert.strictEqual(built.validation.ok, true, built.validation.errors.join('; '));
  return built.plan;
}

function freshConfigs() {
  return {
    devModels: mod.loadJSON(mod.resolveConfig('development-models.json')),
    orchestrator: mod.loadJSON(mod.resolveConfig('issue-orchestrator-experiment.json'))
  };
}

// Configuration validation is an input boundary.  These cases intentionally
// exercise both public entry points so a future buildPlan shortcut cannot
// silently bypass validateRoleBindings.
function assertConfigRejected(label, mutate) {
  const configs = freshConfigs();
  mutate(configs.orchestrator, configs.devModels);

  const direct = mod.validateRoleBindings(configs.devModels, configs.orchestrator);
  assert.strictEqual(direct.ok, false, label + ': validateRoleBindings accepted relaxed configuration');

  const built = mod.buildPlan({
    devModels: configs.devModels,
    orchestrator: configs.orchestrator,
    issue: 'HARNESS-CONFIG-REJECTION',
    scope: 'scripts/issue-orchestrator-experiment.cjs'
  });
  assert.strictEqual(built.validation.ok, false, label + ': buildPlan accepted relaxed configuration');
  assert.ok(built.validation.errors.length > 0, label + ': rejection must include a validation error');
}

function identityDigest(run) {
  return mod.sha256(mod.canonicalJSON({
    issueId: run.issueId,
    normalizedScopeHash: run.normalizedScopeHash,
    configSnapshotHash: run.configSnapshotHash,
    roleSnapshotHash: run.roleSnapshotHash,
    runGeneration: run.runGeneration
  }));
}

function digest(receipt, previous) {
  return mod.sha256(mod.canonicalJSON({
    stage: receipt.stage,
    clean: receipt.clean,
    payload: receipt.payload,
    executionId: receipt.executionId,
    attestation: receipt.attestation,
    prevDigest: previous
  }) + '|' + previous);
}

function payload(stage) {
  return stage === 'external_approval_evidence'
    ? { approvalEvidenceDigest: hash('approval-evidence') }
    : { artifact: stage };
}

function makeAttestation(role, stage, suffix) {
  return Object.assign({}, role, { sessionId: stage + '-session-' + (suffix || '1') });
}

// Bind every candidate up-front.  Completed receipts form only an ordered
// prefix, while stageBindings remains a commitment to the exact candidate for
// every remaining stage.
function preparedRun(prefixLength, mutate) {
  const plan = freshPlan();
  const contract = plan.executionContract;
  const run = {
    issueId: 'HARNESS-TEST-1',
    normalizedScopeHash: hash('normalized-scope'),
    configSnapshot: contract.configSnapshot,
    configSnapshotHash: contract.configSnapshotHash,
    roleSnapshot: contract.roleSnapshot,
    roleSnapshotHash: contract.roleSnapshotHash,
    runGeneration: 1,
    stageBindings: {},
    receipts: []
  };
  const all = STAGES.map(function (stage) {
    return {
      stage,
      clean: true,
      payload: payload(stage),
      executionId: stage + '-execution-1',
      attestation: makeAttestation(contract.roleSnapshot[stage], stage)
    };
  });
  if (mutate) mutate({ run, all });

  let previous = identityDigest(run);
  for (const item of all) {
    item.digest = digest(item, previous);
    run.stageBindings[item.stage] = item.digest;
    previous = item.digest;
  }
  run.receipts = all.slice(0, prefixLength).map(function (item) {
    return {
      stage: item.stage,
      clean: item.clean,
      payload: item.payload,
      executionId: item.executionId,
      attestation: item.attestation,
      digest: item.digest
    };
  });
  return { run, all };
}

function observation(prepared, stage, patch) {
  const item = prepared.all.find(function (candidate) { return candidate.stage === stage; });
  assert.ok(item, 'stage exists: ' + stage);
  return Object.assign({
    stage: item.stage,
    clean: item.clean,
    payload: item.payload,
    executionId: item.executionId,
    attestation: item.attestation
  }, patch || {});
}

function exactApprovalBoundary() {
  return {
    verify: function (record) {
      return { verified: true, bindings: record };
    }
  };
}

test('plan is deterministic and retains the agreed role tiers', function () {
  const a = freshPlan();
  const b = freshPlan();
  assert.strictEqual(mod.canonicalJSON(a.executionContract), mod.canonicalJSON(b.executionContract));
  assert.strictEqual(a.executionContract.roleSnapshot.implementation.reasoningEffort, 'medium');
  assert.strictEqual(a.executionContract.roleSnapshot.testing.reasoningEffort, 'medium');
  assert.strictEqual(a.executionContract.roleSnapshot.review_hy3.reasoningEffort, 'high');
});

test('approval policy is exact and fails closed on omission, expansion, or relaxation', function () {
  const cases = [
    ['missing approvalPolicy', function (o) { delete o.approvalPolicy; }],
    ['approvalPolicy extra field', function (o) { o.approvalPolicy.unreviewedShortcut = true; }],
    ['approvalPolicy externallyVerifiedOnly false', function (o) { o.approvalPolicy.externallyVerifiedOnly = false; }],
    ['approvalPolicy identityProofRequired true', function (o) { o.approvalPolicy.identityProofRequired = true; }]
  ];
  for (const item of cases) assertConfigRejected(item[0], item[1]);
});

test('review policy is exact: both specified reviewers and clean consensus are mandatory', function () {
  const cases = [
    ['missing reviewPolicy', function (o) { delete o.reviewPolicy; }],
    ['reviewPolicy extra field', function (o) { o.reviewPolicy.allowOneCleanReviewer = true; }],
    ['reviewPolicy reordered reviewers', function (o) { o.reviewPolicy.requiredReviews.reverse(); }],
    ['reviewPolicy mustAllBeClean false', function (o) { o.reviewPolicy.mustAllBeClean = false; }]
  ];
  for (const item of cases) assertConfigRejected(item[0], item[1]);
});

test('stage order and gate authority are exact and cannot be weakened', function () {
  const cases = [
    ['stages missing integration', function (o) { o.stages.pop(); }],
    ['stages reordered', function (o) { const first = o.stages[0]; o.stages[0] = o.stages[1]; o.stages[1] = first; }],
    ['missing gateAuthority', function (o) { delete o.gateAuthority; }],
    ['gate authority permits scheduling without a gate receipt', function (o) { o.gateAuthority.orchestratorMayScheduleOnlyFromGateReceipt = false; }],
    ['gate authority permits a real runner', function (o) { o.gateAuthority.realRunnerIncluded = true; }]
  ];
  for (const item of cases) assertConfigRejected(item[0], item[1]);
});

test('gate eligibility is deterministic and binds the exact candidate', function () {
  const prepared = preparedRun(0);
  const first = mod.evaluateRun(prepared.run, observation(prepared, 'design'));
  const second = mod.evaluateRun(prepared.run, observation(prepared, 'design'));
  assert.strictEqual(first.allow, true, first.reason);
  assert.strictEqual(mod.canonicalJSON(first), mod.canonicalJSON(second));
  assert.strictEqual(first.gateEligibilityReceipt.evidence.stage, 'design');
  assert.strictEqual(first.gateEligibilityReceipt.evidence.candidateDigest, prepared.run.stageBindings.design);

  const tampered = mod.evaluateRun(prepared.run, observation(prepared, 'design', { payload: { artifact: 'tampered' } }));
  assert.strictEqual(tampered.allow, false);
  assert.match(tampered.reason, /does not bind/);
});

test('all historical receipts revalidate immutable role attestations', function () {
  const prepared = preparedRun(1, function (state) {
    // Rebind after tampering so this specifically proves attestation
    // revalidation rather than only a stale digest check.
    state.all[0].attestation.model = 'forged-model';
  });
  const result = mod.evaluateRun(prepared.run, observation(prepared, 'review_terra'));
  assert.strictEqual(result.allow, false);
  assert.match(result.reason, /historical|invalid run/i);
  assert.match(result.reason, /attestation.*trusted role configuration|roleSnapshot/i);
});

test('a self-consistent forged role snapshot cannot replace the trusted current configuration', function () {
  const prepared = preparedRun(0, function (state) {
    // An attacker can recompute the run-local hashes, receipt digests, and
    // bindings.  The evaluator must still derive the expected static roles
    // from the current trusted configuration rather than trusting this input.
    state.run.roleSnapshot.design.model = 'forged-model';
    state.run.roleSnapshotHash = mod.sha256(mod.canonicalJSON(state.run.roleSnapshot));
    state.all[0].attestation.model = 'forged-model';
  });
  const result = mod.evaluateRun(prepared.run, observation(prepared, 'design'));
  assert.strictEqual(result.allow, false);
  assert.match(result.reason, /roleSnapshot does not match the trusted current role configuration/i);
});

test('historical external approval is reverified and requires an exact verdict', function () {
  const prepared = preparedRun(5);
  const absent = mod.evaluateRun(prepared.run, observation(prepared, 'plan'));
  assert.strictEqual(absent.allow, false);
  assert.match(absent.reason, /historical external approval.*re-verification/i);

  const malformed = mod.evaluateRun(prepared.run, observation(prepared, 'plan'), {
    verify: function (record) { return { verified: true, bindings: record, extra: true }; }
  });
  assert.strictEqual(malformed.allow, false);
  assert.match(malformed.reason, /historical external approval.*re-verification/i);

  const valid = mod.evaluateRun(prepared.run, observation(prepared, 'plan'), exactApprovalBoundary());
  assert.strictEqual(valid.allow, true, valid.reason);
  assert.strictEqual(valid.nextStage, 'implementation');
});

test('current external approval is fail-closed and exact-binding verified', function () {
  const prepared = preparedRun(4);
  const absent = mod.evaluateRun(prepared.run, observation(prepared, 'external_approval_evidence'));
  assert.strictEqual(absent.allow, false);
  assert.match(absent.reason, /fail-closed|verifier/i);

  const valid = mod.evaluateRun(prepared.run, observation(prepared, 'external_approval_evidence'), exactApprovalBoundary());
  assert.strictEqual(valid.allow, true, valid.reason);
  assert.strictEqual(valid.nextStage, 'plan');
});

test('non-clean observations produce immutable defect restart descriptors', function () {
  const prepared = preparedRun(0);
  const result = mod.evaluateRun(prepared.run, observation(prepared, 'design', {
    clean: false,
    payload: { defectKind: 'design' }
  }));
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.restartGeneration, true);
  assert.deepStrictEqual(result.restart, {
    nextGeneration: 2,
    defectKind: 'design',
    rerunStage: 'design',
    invalidatedStages: STAGES.slice(),
    reissueRequired: true
  });
  assert.ok(Object.isFrozen(result.restart));
});

test('stale, over-limit, and fourth-defect generations fail closed', function () {
  const stale = preparedRun(0, function (state) { state.run.runGeneration = 0; });
  const staleResult = mod.evaluateRun(stale.run, observation(stale, 'design'));
  assert.strictEqual(staleResult.allow, false);
  assert.match(staleResult.reason, /runGeneration is stale/i);

  const overLimit = preparedRun(0, function (state) { state.run.runGeneration = 5; });
  const overLimitResult = mod.evaluateRun(overLimit.run, observation(overLimit, 'design'));
  assert.strictEqual(overLimitResult.allow, false);
  assert.match(overLimitResult.reason, /exceeds maxReruns=3/i);

  // Generation 4 represents the fourth defect attempt after the configured
  // three reruns.  It is a valid historical generation but cannot mint a
  // fifth one, even when the next observation is otherwise well-attested.
  const exhausted = preparedRun(0, function (state) { state.run.runGeneration = 4; });
  const exhaustedResult = mod.evaluateRun(exhausted.run, observation(exhausted, 'design', {
    clean: false,
    payload: { defectKind: 'design' }
  }));
  assert.strictEqual(exhaustedResult.allow, false);
  assert.strictEqual(exhaustedResult.restartGeneration, false);
  assert.strictEqual(exhaustedResult.restart, null);
  assert.match(exhaustedResult.reason, /maxReruns=3 exhausted/i);
});

test('implementation, testing, and orchestration require distinct sessions and executions', function () {
  const selfTest = preparedRun(7, function (state) {
    state.all[7].executionId = state.all[6].executionId;
    state.all[7].attestation.sessionId = state.all[6].attestation.sessionId;
  });
  const testing = mod.evaluateRun(selfTest.run, observation(selfTest, 'testing'), exactApprovalBoundary());
  assert.strictEqual(testing.allow, false);
  assert.match(testing.reason, /executionId|sessionId/i);

  const reusedOrchestration = preparedRun(3, function (state) {
    state.all[3].executionId = state.all[0].executionId;
    state.all[3].attestation.sessionId = state.all[0].attestation.sessionId;
  });
  const orchestration = mod.evaluateRun(reusedOrchestration.run, observation(reusedOrchestration, 'orchestration'));
  assert.strictEqual(orchestration.allow, false);
  assert.match(orchestration.reason, /executionId|sessionId/i);
});

test('HY3 high review of HY3 medium work is allowed only with a distinct session and execution', function () {
  const allowed = preparedRun(9);
  const cleanReview = mod.evaluateRun(allowed.run, observation(allowed, 'final_review_hy3'), exactApprovalBoundary());
  assert.strictEqual(cleanReview.allow, true, cleanReview.reason);
  assert.strictEqual(cleanReview.nextStage, 'integration');
  assert.strictEqual(
    allowed.run.roleSnapshot.final_review_hy3.modelFamily,
    allowed.run.roleSnapshot.implementation.modelFamily,
    'this explicitly exercises the HY3 high / HY3 medium same-family case'
  );

  const sameSession = preparedRun(9, function (state) {
    state.all[9].executionId = state.all[6].executionId;
    state.all[9].attestation.sessionId = state.all[6].attestation.sessionId;
  });
  const rejected = mod.evaluateRun(sameSession.run, observation(sameSession, 'final_review_hy3'), exactApprovalBoundary());
  assert.strictEqual(rejected.allow, false);
  assert.match(rejected.reason, /executionId|sessionId/i);
});

test('only a clean, independently attested integration yields a completion candidate', function () {
  const prepared = preparedRun(10);
  const result = mod.evaluateRun(prepared.run, observation(prepared, 'integration'), exactApprovalBoundary());
  assert.strictEqual(result.allow, true, result.reason);
  assert.deepStrictEqual(result.completionCandidate, {
    stage: 'integration',
    privilege: 'integration-eligibility-only',
    digest: prepared.run.stageBindings.integration,
    runGeneration: 1,
    runIdentityDigest: identityDigest(prepared.run)
  });
});

let failures = 0;
for (const entry of tests) {
  try {
    entry.fn();
    process.stdout.write('PASS ' + entry.name + '\n');
  } catch (error) {
    failures += 1;
    process.stdout.write('FAIL ' + entry.name + '\n  ' + error.message + '\n');
  }
}
process.stdout.write(failures === 0
  ? 'All ' + tests.length + ' tests passed\n'
  : failures + ' of ' + tests.length + ' tests failed\n');
process.exit(failures === 0 ? 0 : 1);
