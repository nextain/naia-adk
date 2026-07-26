'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_KEYS = [
  'token',
  'key',
  'secret',
  'password',
  'apikey',
  'baseurl',
  'credentialref'
];

const ORCHESTRATOR_STAGE_ORDER = Object.freeze([
  'design',
  'review_terra',
  'review_hy3',
  'orchestration',
  'external_approval_evidence',
  'plan',
  'implementation',
  'testing',
  'final_review_terra',
  'final_review_hy3',
  'integration'
]);

const MAX_RERUNS = 3;

const REVIEW_INDEPENDENCE_POLICY = Object.freeze({
  implementationTesting: Object.freeze({
    differentRole: true,
    differentSessionId: true,
    differentExecutionId: true
  }),
  hy3HighReviewOfHy3Medium: Object.freeze({
    allowed: true,
    differentSessionId: true,
    differentExecutionId: true
  }),
  peerReviewers: Object.freeze({
    differentSessionId: true,
    differentExecutionId: true
  })
});

function isSecretKey(name) {
  return SECRET_KEYS.includes(String(name).toLowerCase());
}

function stripSecretKeys(node, rejected) {
  // Kept as a compatibility export.  Configuration is never sanitized in
  // place: a secret-bearing input is rejected by the boundary instead.
  return collectSecretKeys(node, rejected || []);
}

function collectSecretKeys(node, found) {
  found = found || [];
  if (Array.isArray(node)) {
    for (const k of Object.keys(node)) {
      if (isSecretKey(k)) {
        found.push(k);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, k);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        collectSecretKeys(descriptor.value, found);
      }
    }
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (isSecretKey(k)) {
        found.push(k);
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(node, k);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          collectSecretKeys(descriptor.value, found);
        }
      }
    }
  }
  return found;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      out.push(canonicalize(descriptor && descriptor.value));
    }
    return out;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) out[k] = canonicalize(value[k]);
    return out;
  }
  if (typeof value === 'function' || typeof value === 'undefined') {
    return null;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value), null, 2);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function loadJSON(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function resolveConfig(filename) {
  const candidates = [
    path.join(__dirname, '..', 'naia-settings', filename),
    path.join(process.cwd(), 'naia-settings', filename),
    path.join(process.cwd(), filename)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function parseArgs(argv) {
  const out = { issue: undefined, scope: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') {
      out.issue = argv[i + 1];
      i++;
    } else if (a.startsWith('--issue=')) {
      out.issue = a.slice('--issue='.length);
    } else if (a === '--scope') {
      out.scope = argv[i + 1] || '';
      i++;
    } else if (a.startsWith('--scope=')) {
      out.scope = a.slice('--scope='.length);
    }
  }
  return out;
}

function normalizeIssueScope(issue, scopeStr) {
  const issueId = String(issue == null ? '' : issue).trim();
  const scope = String(scopeStr == null ? '' : scopeStr)
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; })
    .map(function (s) { return s.replace(/\\/g, '/'); })
    .sort();
  return { issue: issueId, scope: scope };
}

function validateRoleBindings(devModels, orchestrator) {
  const errors = [];
  const devModelsShapeError = validateConfigurationShape(devModels, 'developmentModels');
  const orchestratorShapeError = validateConfigurationShape(orchestrator, 'orchestrator');
  if (devModelsShapeError) errors.push(devModelsShapeError);
  if (orchestratorShapeError) errors.push(orchestratorShapeError);
  if (errors.length > 0) return { ok: false, errors: errors };

  const roles = (devModels && devModels.roles) || {};
  const expected = {
    expert: { runner: 'codex', model: /sol/i, tier: 'high' },
    main: { runner: 'opencode', model: /hy3/i, tier: 'high' },
    sub: { runner: 'opencode', model: /hy3/i, tier: 'medium' },
    testing: { runner: 'opencode', model: /hy3/i, tier: 'medium' },
    adversarial_review: { runner: 'codex', model: /terra/i, tier: 'high' },
    adversarial_review_hy3: { runner: 'opencode', model: /hy3/i, tier: 'high' },
    approval_boundary: { runner: 'external', model: /approval-boundary/i, tier: 'external' },
    integration: { runner: 'codex', model: /codex/i, tier: 'high' }
  };
  for (const rk of Object.keys(expected)) {
    const e = expected[rk];
    const r = roles[rk];
    if (!r) {
      errors.push('missing role ' + rk);
      continue;
    }
    if (r.runner !== e.runner) {
      errors.push('role ' + rk + ' runner expected ' + e.runner + ' got ' + String(r.runner));
    }
    if (!e.model.test(String(r.model || ''))) {
      errors.push('role ' + rk + ' model expected match ' + e.model + ' got ' + String(r.model));
    }
    if (r.reasoningEffort !== e.tier) {
      errors.push('role ' + rk + ' tier expected ' + e.tier + ' got ' + String(r.reasoningEffort));
    }
    if (typeof r.modelFamily !== 'string' || r.modelFamily.trim() === '') {
      errors.push('role ' + rk + ' modelFamily must be a non-empty string');
    }
  }
  const rb = (orchestrator && orchestrator.roleBindings) || {};
  const expectedStages = {
    design: 'expert',
    orchestration: 'main',
    implementation: 'sub',
    testing: 'testing',
    reviewTerra: 'adversarial_review',
    reviewHy3: 'adversarial_review_hy3',
    externalApproval: 'approval_boundary',
    integration: 'integration'
  };
  if (!exactKeys(rb, Object.keys(expectedStages)) || !hasOnlyDataProperties(rb)) {
    errors.push('roleBindings must contain exactly the eight fixed role bindings');
  }
  for (const stage of Object.keys(expectedStages)) {
    const want = expectedStages[stage];
    if (rb[stage] !== want) {
      errors.push('roleBinding ' + stage + ' expected ' + want + ' got ' + String(rb[stage]));
    }
  }
  const shellMain = (orchestrator && orchestrator.shellMain) || {};
  const shellKeys = Object.keys(shellMain).sort();
  const expectedShellKeys = ['description', 'executeCodingStages', 'mode'];
  if (!isPlainObject(shellMain) || shellKeys.length !== expectedShellKeys.length || expectedShellKeys.some(function (k, i) { return shellKeys[i] !== k; }) ||
      shellMain.mode !== 'delegate-and-report-only' || shellMain.executeCodingStages !== false || !isNonEmptyString(shellMain.description)) {
    errors.push('shellMain must be exactly delegate-and-report-only with executeCodingStages=false and a description');
  }

  if (!Array.isArray(orchestrator.stages) || !hasOnlyDataProperties(orchestrator.stages) ||
      canonicalJSON(orchestrator.stages) !== canonicalJSON(ORCHESTRATOR_STAGE_ORDER)) {
    errors.push('stages must be exactly the fixed ordered 11-stage pipeline');
  }

  const reviewPolicy = orchestrator.reviewPolicy;
  if (!exactKeys(reviewPolicy, ['requiredReviews', 'mustAllBeClean', 'description', 'independence']) ||
      !hasOnlyDataProperties(reviewPolicy) ||
      !Array.isArray(reviewPolicy.requiredReviews) ||
      canonicalJSON(reviewPolicy.requiredReviews) !== canonicalJSON(['review_terra', 'review_hy3']) ||
      reviewPolicy.mustAllBeClean !== true ||
      !isNonEmptyString(reviewPolicy.description) ||
      canonicalJSON(reviewPolicy.independence) !== canonicalJSON(REVIEW_INDEPENDENCE_POLICY)) {
    errors.push('reviewPolicy must exactly require clean review_terra/review_hy3 passes with the approved session/execution independence policy');
  }

  const approvalPolicy = orchestrator.approvalPolicy;
  if (!exactKeys(approvalPolicy, ['externallyVerifiedOnly', 'identityProofRequired', 'description']) ||
      !hasOnlyDataProperties(approvalPolicy) ||
      approvalPolicy.externallyVerifiedOnly !== true ||
      approvalPolicy.identityProofRequired !== false ||
      !isNonEmptyString(approvalPolicy.description)) {
    errors.push('approvalPolicy must be exactly externallyVerifiedOnly=true, identityProofRequired=false, and a description');
  }

  const gateAuthority = orchestrator.gateAuthority;
  if (!exactKeys(gateAuthority, ['eligibility', 'orchestratorMayScheduleOnlyFromGateReceipt', 'shellMayPresentApprovalUiOnly', 'realRunnerIncluded']) ||
      !hasOnlyDataProperties(gateAuthority) ||
      gateAuthority.eligibility !== 'naia-adk-deterministic-gate' ||
      gateAuthority.orchestratorMayScheduleOnlyFromGateReceipt !== true ||
      gateAuthority.shellMayPresentApprovalUiOnly !== true ||
      gateAuthority.realRunnerIncluded !== false) {
    errors.push('gateAuthority must be exactly deterministic eligibility with scheduling-only orchestration and no runner');
  }

  const family = function (role) { return String((roles[role] || {}).modelFamily || '').trim(); };
  const mustDiffer = function (left, right, label) {
    if (family(left) && family(left) === family(right)) {
      errors.push(label + ' must use a different modelFamily (' + family(left) + ')');
    }
  };
  // The two adversarial reviewers must be different families.  A HY3-high
  // reviewer may review HY3-medium work, but the state gate requires a fresh
  // sessionId and executionId and binds the configured reasoning tier.
  mustDiffer('adversarial_review', 'adversarial_review_hy3', 'adversarial reviewers');
  return { ok: errors.length === 0, errors: errors };
}

function buildRoleSnapshot(devModels, orchestrator) {
  const roles = (devModels && devModels.roles) || {};
  const snap = {};
  for (const rk of ['expert', 'main', 'sub', 'testing', 'adversarial_review', 'adversarial_review_hy3', 'approval_boundary', 'integration']) {
    const r = roles[rk] || {};
    snap[rk] = {
      role: rk,
      runner: r.runner,
      model: r.model,
      modelFamily: r.modelFamily,
      tier: r.reasoningEffort
    };
  }
  return { snapshot: snap, rejected: [] };
}

function buildSteps(snapshot) {
  const stageRole = {
    design: 'expert',
    review_terra: 'adversarial_review',
    review_hy3: 'adversarial_review_hy3',
    orchestration: 'main',
    external_approval_evidence: 'approval_boundary',
    plan: 'main',
    implementation: 'sub',
    testing: 'testing',
    final_review_terra: 'adversarial_review',
    final_review_hy3: 'adversarial_review_hy3',
    integration: 'integration'
  };
  const defs = [
    { id: 's1', name: 'design', dependsOn: [] },
    { id: 's2', name: 'review_terra', dependsOn: ['s1'] },
    { id: 's3', name: 'review_hy3', dependsOn: ['s1'] },
    { id: 's4', name: 'orchestration', dependsOn: ['s2', 's3'] },
    { id: 's5', name: 'external_approval_evidence', dependsOn: ['s4'] },
    { id: 's6', name: 'plan', dependsOn: ['s5'] },
    { id: 's7', name: 'implementation', dependsOn: ['s6'] },
    { id: 's8', name: 'testing', dependsOn: ['s7'] },
    { id: 's9', name: 'final_review_terra', dependsOn: ['s8'] },
    { id: 's10', name: 'final_review_hy3', dependsOn: ['s8'] },
    { id: 's11', name: 'integration', dependsOn: ['s9', 's10'] }
  ];
  const steps = defs.map(function (d) {
    const s = { id: d.id, name: d.name, dependsOn: d.dependsOn };
    const roleKey = stageRole[d.name];
    if (roleKey) {
      s.role = roleKey;
      s.roleRef = snapshot[roleKey];
    }
    if (d.name === 'external_approval_evidence') {
      s.evidenceStatus = 'pending';
      s.externallyVerifiedOnly = true;
    }
    return s;
  });
  return steps;
}

function buildDefectPolicy() {
  return {
    rerun: {
      trigger: 'defect detected in a step',
      action: 'rerun the failing step with its bound role',
      maxReruns: MAX_RERUNS,
      roleLocked: true,
      rerunRole: 'same bound role; role bindings are immutable for the run'
    },
    invalidation: {
      trigger: 'step output hash changes OR any dependency hash changes',
      propagation: 'downstream dependent steps are invalidated and forced to rerun',
      externalApproval: 'if s5 external_approval_evidence changes, steps s6..s11 are invalidated',
      reviewCleanRequired: 's2 and s3 must both report clean; a non-clean review invalidates s4..s11',
      finalReviewCleanRequired: 's9, s10 and s11 must all report clean; otherwise the plan is not releasable'
    },
    determinism: 'no clock/random; reruns use the same canonical inputs and produce identical plans'
  };
}

function validateConfigurationShape(value, label) {
  if (!isPlainObject(value) || !hasOnlyDataProperties(value) || !isJsonSafe(value)) {
    return label + ' must be JSON-safe plain data with data properties only';
  }
  return null;
}

function buildV2ExecutionContract(roleCatalog, orchestrator) {
  const roleSnapshot = {};
  for (const stage of V2_STAGE_ORDER) {
    const role = V2_STAGE_ROLES[stage];
    const source = roleCatalog[role] || {};
    roleSnapshot[stage] = {
      role: role,
      runner: source.runner,
      model: source.model,
      modelFamily: source.modelFamily,
      reasoningEffort: source.tier
    };
  }
  const configSnapshot = {
    defectRoutes: {
      design: orchestrator.defectRoutes && orchestrator.defectRoutes.design,
      instruction: orchestrator.defectRoutes && orchestrator.defectRoutes.instruction,
      implementation: orchestrator.defectRoutes && orchestrator.defectRoutes.implementation
    },
    rerunPolicy: {
      maxReruns: MAX_RERUNS
    }
  };
  return {
    configSnapshot: configSnapshot,
    configSnapshotHash: sha256(canonicalJSON(configSnapshot)),
    roleSnapshot: roleSnapshot,
    roleSnapshotHash: sha256(canonicalJSON(roleSnapshot))
  };
}

function buildPlan(opts) {
  const devModels = opts.devModels;
  const orchestrator = opts.orchestrator;
  const issue = opts.issue;
  const scope = opts.scope == null ? '' : opts.scope;

  // Configuration is an input boundary: reject secrets without modifying the
  // caller-owned object.  Mutating it here used to make a poisoned config look
  // clean to the later snapshot/hash calculation.
  const shapeErrors = [
    validateConfigurationShape(devModels, 'developmentModels'),
    validateConfigurationShape(orchestrator, 'orchestrator')
  ].filter(Boolean);
  const secretKeysRejected = Array.from(new Set(
    collectSecretKeys(devModels, []).concat(collectSecretKeys(orchestrator, []))
  )).sort();

  const validation = shapeErrors.length === 0
    ? validateRoleBindings(devModels, orchestrator)
    : { ok: false, errors: shapeErrors.slice() };
  if (secretKeysRejected.length > 0) {
    validation.errors.push('secret-bearing configuration is rejected: ' + secretKeysRejected.join(', '));
    validation.ok = false;
  }
  const built = shapeErrors.length === 0 ? buildRoleSnapshot(devModels, orchestrator) : { snapshot: {}, rejected: [] };
  const snapshot = built.snapshot;

  const norm = normalizeIssueScope(issue, scope);
  const configClean = shapeErrors.length === 0 ? { developmentModels: devModels, orchestrator: orchestrator } : {};

  const configHash = sha256(canonicalJSON(configClean));
  const issueScopeHash = sha256(canonicalJSON(norm));
  const executionContract = shapeErrors.length === 0 ? buildV2ExecutionContract(snapshot, orchestrator) : null;
  const roleSnapshotHash = executionContract ? executionContract.roleSnapshotHash : sha256(canonicalJSON({}));

  const steps = buildSteps(snapshot);

  const reviewPolicySrc = shapeErrors.length === 0 ? ((orchestrator && orchestrator.reviewPolicy) || {}) : {};
  const approvalPolicySrc = shapeErrors.length === 0 ? ((orchestrator && orchestrator.approvalPolicy) || {}) : {};

  const plan = {
    schema: 'issue-orchestrator-experiment/v1',
    issue: norm.issue,
    scope: norm.scope,
    configHash: configHash,
    issueScopeHash: issueScopeHash,
    roleSnapshotHash: roleSnapshotHash,
    roleSnapshot: executionContract ? executionContract.roleSnapshot : {},
    roleCatalogSnapshot: snapshot,
    executionContract: executionContract,
    steps: steps,
    reviewPolicy: canonicalize(reviewPolicySrc),
    approvalPolicy: canonicalize(approvalPolicySrc),
    defectPolicy: buildDefectPolicy(),
    validation: validation,
    secretKeysRejected: secretKeysRejected,
    configSources: {
      developmentModels: 'development-models.json',
      orchestrator: 'issue-orchestrator-experiment.json'
    }
  };

  return { plan: plan, validation: validation, normalized: norm, secretKeysRejected: secretKeysRejected };
}

const V2_STAGE_ORDER = ORCHESTRATOR_STAGE_ORDER;

const V2_EARLY_REVIEWS = Object.freeze(['review_terra', 'review_hy3']);
const V2_FINAL_REVIEWS = Object.freeze(['final_review_terra', 'final_review_hy3']);
const V2_STAGE_ROLES = Object.freeze({
  design: 'expert',
  review_terra: 'adversarial_review',
  review_hy3: 'adversarial_review_hy3',
  orchestration: 'main',
  external_approval_evidence: 'approval_boundary',
  plan: 'main',
  implementation: 'sub',
  testing: 'testing',
  final_review_terra: 'adversarial_review',
  final_review_hy3: 'adversarial_review_hy3',
  integration: 'integration'
});

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isSha256Hex(v) {
  return typeof v === 'string' && SHA256_HEX_RE.test(v);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isJsonSafe(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) {
      if (keys.indexOf(String(i)) === -1) return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !isJsonSafe(descriptor.value)) return false;
    }
    return true;
  }
  if (isPlainObject(v)) {
    return Object.keys(v).every(function (k) { return isJsonSafe(v[k]); });
  }
  return false;
}

function exactKeys(value, wanted) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = wanted.slice().sort();
  return actual.length === expected.length && expected.every(function (k, i) { return actual[i] === k; });
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function v2IdentitySeed(run) {
  return sha256(canonicalJSON({
    issueId: run.issueId,
    normalizedScopeHash: run.normalizedScopeHash,
    configSnapshotHash: run.configSnapshotHash,
    roleSnapshotHash: run.roleSnapshotHash,
    runGeneration: run.runGeneration
  }));
}

function v2ReceiptDigest(receipt, prevDigest) {
  const core = canonicalJSON({
    stage: receipt.stage,
    clean: receipt.clean,
    payload: receipt.payload,
    executionId: receipt.executionId,
    attestation: receipt.attestation,
    prevDigest: prevDigest
  });
  return sha256(core + '|' + prevDigest);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasOnlyDataProperties(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    const child = descriptor.value;
    if ((isPlainObject(child) || Array.isArray(child)) && !hasOnlyDataProperties(child)) return false;
  }
  return true;
}

function v2ProjectStaticRole(value, label) {
  if (!exactKeys(value, ['role', 'runner', 'model', 'modelFamily', 'reasoningEffort']) || !hasOnlyDataProperties(value)) {
    return { ok: false, error: label + ' must have exactly role/runner/model/modelFamily/reasoningEffort' };
  }
  for (const k of ['role', 'runner', 'model', 'modelFamily', 'reasoningEffort']) {
    if (!isNonEmptyString(value[k])) return { ok: false, error: label + '.' + k + ' must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      role: value.role,
      runner: value.runner,
      model: value.model,
      modelFamily: value.modelFamily,
      reasoningEffort: value.reasoningEffort
    }
  };
}

function v2ProjectAttestation(value, label) {
  if (!exactKeys(value, ['role', 'runner', 'model', 'modelFamily', 'reasoningEffort', 'sessionId']) || !hasOnlyDataProperties(value)) {
    return { ok: false, error: label + ' must have exactly role/runner/model/modelFamily/reasoningEffort/sessionId' };
  }
  const staticRole = v2ProjectStaticRole({
    role: value.role,
    runner: value.runner,
    model: value.model,
    modelFamily: value.modelFamily,
    reasoningEffort: value.reasoningEffort
  }, label);
  if (!staticRole.ok) return staticRole;
  if (!isNonEmptyString(value.sessionId)) return { ok: false, error: label + '.sessionId must be a non-empty string' };
  return { ok: true, value: Object.assign({}, staticRole.value, { sessionId: value.sessionId }) };
}

function v2ProjectRoleSnapshot(value) {
  if (!exactKeys(value, V2_STAGE_ORDER) || !hasOnlyDataProperties(value)) {
    return { ok: false, error: 'roleSnapshot must contain exactly all 11 stage attestations' };
  }
  const out = {};
  for (const stage of V2_STAGE_ORDER) {
    const projected = v2ProjectStaticRole(value[stage], 'roleSnapshot.' + stage);
    if (!projected.ok) return projected;
    if (projected.value.role !== V2_STAGE_ROLES[stage]) {
      return { ok: false, error: 'roleSnapshot.' + stage + '.role must be ' + V2_STAGE_ROLES[stage] };
    }
    out[stage] = projected.value;
  }
  return { ok: true, value: out };
}

function v2ProjectConfigSnapshot(value) {
  if (!exactKeys(value, ['defectRoutes', 'rerunPolicy']) || !hasOnlyDataProperties(value) ||
      !exactKeys(value.defectRoutes, ['design', 'instruction', 'implementation']) ||
      !exactKeys(value.rerunPolicy, ['maxReruns'])) {
    return { ok: false, error: 'configSnapshot must contain exact defectRoutes and rerunPolicy' };
  }
  const expected = { design: 'design', instruction: 'orchestration', implementation: 'implementation' };
  for (const k of Object.keys(expected)) {
    if (value.defectRoutes[k] !== expected[k]) {
      return { ok: false, error: 'configSnapshot.defectRoutes.' + k + ' must be ' + expected[k] };
    }
  }
  if (value.rerunPolicy.maxReruns !== MAX_RERUNS) {
    return { ok: false, error: 'configSnapshot.rerunPolicy.maxReruns must be ' + MAX_RERUNS };
  }
  return {
    ok: true,
    value: {
      defectRoutes: Object.assign({}, expected),
      rerunPolicy: { maxReruns: MAX_RERUNS }
    }
  };
}

function v2LoadTrustedRoleSnapshot() {
  let devModels;
  let orchestrator;
  try {
    devModels = loadJSON(resolveConfig('development-models.json'));
    orchestrator = loadJSON(resolveConfig('issue-orchestrator-experiment.json'));
  } catch (error) {
    return { ok: false, error: 'trusted role configuration could not be loaded' };
  }

  const secretKeys = Array.from(new Set(
    collectSecretKeys(devModels, []).concat(collectSecretKeys(orchestrator, []))
  )).sort();
  if (secretKeys.length > 0) {
    return { ok: false, error: 'trusted role configuration contains rejected secret-bearing fields' };
  }

  const validation = validateRoleBindings(devModels, orchestrator);
  if (!validation.ok) {
    return { ok: false, error: 'trusted role configuration is invalid: ' + validation.errors.join('; ') };
  }

  const roleCatalog = buildRoleSnapshot(devModels, orchestrator).snapshot;
  const executionContract = buildV2ExecutionContract(roleCatalog, orchestrator);
  const projection = v2ProjectRoleSnapshot(executionContract.roleSnapshot);
  if (!projection.ok) {
    return { ok: false, error: 'trusted role configuration projection failed: ' + projection.error };
  }
  return {
    ok: true,
    roleSnapshot: deepFreeze(projection.value),
    roleSnapshotHash: executionContract.roleSnapshotHash
  };
}

function v2ProjectRun(run, trustedRoleSnapshot) {
  if (!isPlainObject(run) || !hasOnlyDataProperties(run)) {
    return { ok: false, error: 'run must be a plain object' };
  }
  const allowed = [
    'issueId',
    'normalizedScopeHash',
    'configSnapshot',
    'configSnapshotHash',
    'roleSnapshot',
    'roleSnapshotHash',
    'runGeneration',
    'stageBindings',
    'receipts'
  ];
  for (const k of Object.keys(run)) {
    if (allowed.indexOf(k) === -1) {
      return { ok: false, error: 'unexpected run field ' + k };
    }
  }
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(run, k)) {
      return { ok: false, error: 'missing run field ' + k };
    }
  }
  if (typeof run.issueId !== 'string' || run.issueId.trim() === '') {
    return { ok: false, error: 'issueId must be a non-empty string' };
  }
  for (const hk of ['normalizedScopeHash', 'configSnapshotHash', 'roleSnapshotHash']) {
    if (!isSha256Hex(run[hk])) {
      return { ok: false, error: hk + ' must be a sha256 hex digest' };
    }
  }
  if (!Number.isInteger(run.runGeneration) || run.runGeneration < 1) {
    return { ok: false, error: 'runGeneration is stale: expected an integer from 1 through ' + (MAX_RERUNS + 1) };
  }
  if (run.runGeneration > MAX_RERUNS + 1) {
    return { ok: false, error: 'runGeneration exceeds maxReruns=' + MAX_RERUNS };
  }
  const configProjection = v2ProjectConfigSnapshot(run.configSnapshot);
  if (!configProjection.ok) return configProjection;
  if (sha256(canonicalJSON(configProjection.value)) !== run.configSnapshotHash) {
    return { ok: false, error: 'configSnapshotHash does not match configSnapshot' };
  }
  const roleProjection = v2ProjectRoleSnapshot(run.roleSnapshot);
  if (!roleProjection.ok) return roleProjection;
  if (sha256(canonicalJSON(roleProjection.value)) !== run.roleSnapshotHash) {
    return { ok: false, error: 'roleSnapshotHash does not match roleSnapshot' };
  }
  if (!trustedRoleSnapshot ||
      canonicalJSON(roleProjection.value) !== canonicalJSON(trustedRoleSnapshot.roleSnapshot) ||
      run.roleSnapshotHash !== trustedRoleSnapshot.roleSnapshotHash) {
    return { ok: false, error: 'roleSnapshot does not match the trusted current role configuration' };
  }
  if (!isPlainObject(run.stageBindings)) {
    return { ok: false, error: 'stageBindings must be a plain object' };
  }
  const bindingKeys = Object.keys(run.stageBindings);
  for (const bk of bindingKeys) {
    if (V2_STAGE_ORDER.indexOf(bk) === -1) {
      return { ok: false, error: 'unexpected stageBindings key ' + bk };
    }
  }
  const stageBindings = {};
  for (const stage of V2_STAGE_ORDER) {
    const b = run.stageBindings[stage];
    if (!isSha256Hex(b)) {
      return { ok: false, error: 'stageBindings.' + stage + ' must be a sha256 hex digest' };
    }
    stageBindings[stage] = b;
  }
  if (!Array.isArray(run.receipts)) {
    return { ok: false, error: 'receipts must be an array' };
  }
  if (run.receipts.length > V2_STAGE_ORDER.length) {
    return { ok: false, error: 'receipts exceed the fixed 11 stage order' };
  }
  const receipts = [];
  for (let i = 0; i < run.receipts.length; i++) {
    const r = run.receipts[i];
    if (!isPlainObject(r) || !hasOnlyDataProperties(r)) {
      return { ok: false, error: 'receipt ' + i + ' must be a plain object' };
    }
    const rKeys = Object.keys(r).sort();
    const wanted = ['attestation', 'clean', 'digest', 'executionId', 'payload', 'stage'];
    if (rKeys.length !== wanted.length || wanted.some(function (k, j) { return rKeys[j] !== k; })) {
      return { ok: false, error: 'receipt ' + i + ' must have exactly stage/clean/payload/executionId/attestation/digest' };
    }
    if (r.stage !== V2_STAGE_ORDER[i]) {
      return { ok: false, error: 'receipt ' + i + ' breaks the ordered stage prefix (expected ' + V2_STAGE_ORDER[i] + ')' };
    }
    if (typeof r.clean !== 'boolean') {
      return { ok: false, error: 'receipt ' + i + ' clean must be a boolean' };
    }
    if (!isNonEmptyString(r.executionId)) {
      return { ok: false, error: 'receipt ' + i + ' executionId must be a non-empty string' };
    }
    const attestation = v2ProjectAttestation(r.attestation, 'receipt ' + i + '.attestation');
    if (!attestation.ok) return attestation;
    const attestedRole = Object.assign({}, attestation.value);
    delete attestedRole.sessionId;
    if (canonicalJSON(attestedRole) !== canonicalJSON(trustedRoleSnapshot.roleSnapshot[r.stage])) {
      return { ok: false, error: 'receipt ' + i + ' attestation does not match trusted role configuration for ' + r.stage };
    }
    if (!isSha256Hex(r.digest)) {
      return { ok: false, error: 'receipt ' + i + ' digest must be a sha256 hex digest' };
    }
    if (!isJsonSafe(r.payload) || ((isPlainObject(r.payload) || Array.isArray(r.payload)) && !hasOnlyDataProperties(r.payload))) {
      return { ok: false, error: 'receipt ' + i + ' payload must be JSON-safe plain data' };
    }
    receipts.push({
      stage: r.stage,
      clean: r.clean,
      payload: canonicalize(r.payload),
      executionId: r.executionId,
      attestation: attestation.value,
      digest: r.digest
    });
  }
  const projection = deepFreeze({
    issueId: run.issueId,
    normalizedScopeHash: run.normalizedScopeHash,
    configSnapshot: configProjection.value,
    configSnapshotHash: run.configSnapshotHash,
    roleSnapshot: trustedRoleSnapshot.roleSnapshot,
    roleSnapshotHash: trustedRoleSnapshot.roleSnapshotHash,
    runGeneration: run.runGeneration,
    stageBindings: stageBindings,
    receipts: receipts
  });
  return { ok: true, run: projection };
}

function v2ProjectObservation(observation) {
  if (!isPlainObject(observation) || !hasOnlyDataProperties(observation)) {
    return { ok: false, error: 'observation must be a plain object' };
  }
  const oKeys = Object.keys(observation).sort();
  const wanted = ['attestation', 'clean', 'executionId', 'payload', 'stage'];
  if (oKeys.length !== wanted.length || wanted.some(function (k, j) { return oKeys[j] !== k; })) {
    return { ok: false, error: 'observation must have exactly stage/clean/payload/executionId/attestation' };
  }
  if (typeof observation.stage !== 'string' || V2_STAGE_ORDER.indexOf(observation.stage) === -1) {
    return { ok: false, error: 'observation stage must be one of the fixed 11 stages' };
  }
  if (typeof observation.clean !== 'boolean') {
    return { ok: false, error: 'observation clean must be a boolean' };
  }
  if (!isNonEmptyString(observation.executionId)) {
    return { ok: false, error: 'observation executionId must be a non-empty string' };
  }
  const attestation = v2ProjectAttestation(observation.attestation, 'observation.attestation');
  if (!attestation.ok) return attestation;
  if (!isJsonSafe(observation.payload) || ((isPlainObject(observation.payload) || Array.isArray(observation.payload)) && !hasOnlyDataProperties(observation.payload))) {
    return { ok: false, error: 'observation payload must be JSON-safe plain data' };
  }
  return {
    ok: true,
    observation: deepFreeze({
      stage: observation.stage,
      clean: observation.clean,
      payload: canonicalize(observation.payload),
      executionId: observation.executionId,
      attestation: attestation.value
    })
  };
}

function v2RestartDescriptor(run, defectKind) {
  if (run.runGeneration >= run.configSnapshot.rerunPolicy.maxReruns + 1) return null;
  const rerunStage = run.configSnapshot.defectRoutes[defectKind];
  const from = V2_STAGE_ORDER.indexOf(rerunStage);
  return {
    nextGeneration: run.runGeneration + 1,
    defectKind: defectKind,
    rerunStage: rerunStage,
    invalidatedStages: V2_STAGE_ORDER.slice(from),
    reissueRequired: true
  };
}

function v2DefectKind(payload) {
  if (!exactKeys(payload, ['defectKind'])) return null;
  return ['design', 'instruction', 'implementation'].includes(payload.defectKind) ? payload.defectKind : null;
}

function v2IndependenceError(stage, item, completed) {
  for (const prior of Object.keys(completed)) {
    if (completed[prior].executionId === item.executionId) {
      return stage + ' must use a different executionId from ' + prior;
    }
    if (completed[prior].attestation.sessionId === item.attestation.sessionId) {
      return stage + ' must use a different sessionId from ' + prior;
    }
  }
  return null;
}

function v2ApprovalRecord(run, identityDigest, receipt, orchestrationDigest) {
  return {
    issueId: run.issueId,
    normalizedScopeHash: run.normalizedScopeHash,
    configSnapshotHash: run.configSnapshotHash,
    roleSnapshotHash: run.roleSnapshotHash,
    runGeneration: run.runGeneration,
    runIdentityDigest: identityDigest,
    orchestrationReceiptDigest: orchestrationDigest,
    approvalAction: 'continue_to_plan',
    approvalEvidenceDigest: receipt.payload.approvalEvidenceDigest,
    approvalExecutionId: receipt.executionId,
    approvalSessionId: receipt.attestation.sessionId,
    approvalAttestationDigest: sha256(canonicalJSON(receipt.attestation)),
    approvalReceiptDigest: receipt.digest,
    approvalStageTargetDigest: run.stageBindings.external_approval_evidence
  };
}

function v2VerifyApproval(boundary, record) {
  if (!isPlainObject(boundary) || typeof boundary.verify !== 'function') return false;
  let verdict;
  try {
    verdict = boundary.verify(deepFreeze(canonicalize(record)));
  } catch (e) {
    return false;
  }
  if (!exactKeys(verdict, ['verified', 'bindings']) || !hasOnlyDataProperties(verdict) || !isJsonSafe(verdict) || verdict.verified !== true ||
      !isPlainObject(verdict.bindings) || !hasOnlyDataProperties(verdict.bindings)) return false;
  return canonicalJSON(verdict.bindings) === canonicalJSON(record);
}

function evaluateRun(run, observation, approvalBoundary) {
  const result = {
    allow: false,
    nextStage: null,
    reason: '',
    restartGeneration: false,
    restart: null,
    completionCandidate: null,
    gateEligibilityReceipt: null,
    detail: {}
  };

  const trustedRoleSnapshot = v2LoadTrustedRoleSnapshot();
  if (!trustedRoleSnapshot.ok) {
    result.reason = 'invalid trusted configuration: ' + trustedRoleSnapshot.error;
    return deepFreeze(result);
  }

  const projected = v2ProjectRun(run, trustedRoleSnapshot);
  if (!projected.ok) {
    result.reason = 'invalid run: ' + projected.error;
    return deepFreeze(result);
  }
  const R = projected.run;
  const bindings = R.stageBindings;
  const identityDigest = v2IdentitySeed(R);

  let prev = identityDigest;
  const completed = {};
  const lineage = {};
  for (let i = 0; i < R.receipts.length; i++) {
    const r = R.receipts[i];
    const digest = v2ReceiptDigest(r, prev);
    if (digest !== r.digest) {
      result.reason = 'receipt chain broken at index ' + i;
      result.restartGeneration = true;
      result.detail.brokenIndex = i;
      return deepFreeze(result);
    }
    if (bindings[r.stage] !== digest) {
      result.reason = 'stage ' + r.stage + ' digest does not bind stageBindings target';
      result.restartGeneration = true;
      result.detail.stage = r.stage;
      return deepFreeze(result);
    }
    const independenceError = v2IndependenceError(r.stage, r, completed);
    if (independenceError) {
      result.reason = 'historical receipt independence violation: ' + independenceError;
      result.restartGeneration = true;
      result.detail.stage = r.stage;
      return deepFreeze(result);
    }
    if (r.clean !== true) {
      const defectKind = v2DefectKind(r.payload);
      if (!defectKind) {
        result.reason = 'historical non-clean receipt requires exact defectKind';
        return deepFreeze(result);
      }
      const restart = v2RestartDescriptor(R, defectKind);
      if (!restart) {
        result.reason = 'stage ' + r.stage + ' receipt is not clean; maxReruns=' + MAX_RERUNS + ' exhausted';
        result.detail.stage = r.stage;
        result.detail.maxReruns = MAX_RERUNS;
        return deepFreeze(result);
      }
      result.reason = 'stage ' + r.stage + ' receipt is not clean; generation restart required';
      result.restartGeneration = true;
      result.restart = restart;
      result.detail.stage = r.stage;
      return deepFreeze(result);
    }
    if (r.stage === 'external_approval_evidence') {
      if (!exactKeys(r.payload, ['approvalEvidenceDigest']) || !isSha256Hex(r.payload.approvalEvidenceDigest)) {
        result.reason = 'historical external approval payload is invalid';
        return deepFreeze(result);
      }
      const approvalRecord = v2ApprovalRecord(R, identityDigest, r, completed.orchestration && completed.orchestration.digest);
      if (!v2VerifyApproval(approvalBoundary, approvalRecord)) {
        result.reason = 'historical external approval failed re-verification (fail-closed)';
        return deepFreeze(result);
      }
    }
    completed[r.stage] = {
      clean: r.clean,
      digest: digest,
      payload: r.payload,
      executionId: r.executionId,
      attestation: r.attestation
    };
    lineage[r.stage] = {
      executionId: r.executionId,
      attestation: r.attestation,
      digest: digest
    };
    prev = digest;
  }
  result.detail.lineage = lineage;

  if (R.receipts.length === V2_STAGE_ORDER.length) {
    result.reason = 'all 11 stages complete';
    result.nextStage = null;
    return deepFreeze(result);
  }

  const pendingStage = V2_STAGE_ORDER[R.receipts.length];

  const obsProjected = v2ProjectObservation(observation);
  if (!obsProjected.ok) {
    result.reason = 'invalid observation: ' + obsProjected.error;
    result.nextStage = pendingStage;
    return deepFreeze(result);
  }
  const O = obsProjected.observation;

  if (O.stage !== pendingStage) {
    result.reason = 'observation must report pending stage ' + pendingStage;
    result.nextStage = pendingStage;
    return deepFreeze(result);
  }

  const observedRole = Object.assign({}, O.attestation);
  delete observedRole.sessionId;
  if (canonicalJSON(observedRole) !== canonicalJSON(R.roleSnapshot[pendingStage])) {
    result.reason = 'observation attestation does not match immutable roleSnapshot for ' + pendingStage;
    result.nextStage = pendingStage;
    return deepFreeze(result);
  }

  if (O.clean !== true) {
    const defectKind = v2DefectKind(O.payload);
    if (!defectKind) {
      result.reason = 'non-clean observation requires exact defectKind';
      result.nextStage = pendingStage;
      return deepFreeze(result);
    }
    const restart = v2RestartDescriptor(R, defectKind);
    if (!restart) {
      result.reason = 'observation for stage ' + pendingStage + ' is not clean; maxReruns=' + MAX_RERUNS + ' exhausted';
      result.nextStage = pendingStage;
      result.detail.maxReruns = MAX_RERUNS;
      return deepFreeze(result);
    }
    result.reason = 'observation for stage ' + pendingStage + ' is not clean; generation restart required';
    result.restartGeneration = true;
    result.restart = restart;
    result.nextStage = result.restart.rerunStage;
    return deepFreeze(result);
  }

  const candidate = {
    stage: O.stage,
    clean: O.clean,
    payload: O.payload,
    executionId: O.executionId,
    attestation: O.attestation
  };
  const candidateDigest = v2ReceiptDigest(candidate, prev);
  if (bindings[pendingStage] !== candidateDigest) {
    result.reason = 'candidate ' + pendingStage + ' digest does not bind stageBindings target';
    result.nextStage = pendingStage;
    return deepFreeze(result);
  }

  const independenceError = v2IndependenceError(pendingStage, candidate, completed);
  if (independenceError) {
    result.reason = independenceError;
    result.nextStage = pendingStage;
    return deepFreeze(result);
  }

  if (pendingStage === 'orchestration') {
    if (!V2_EARLY_REVIEWS.every(function (s) { return completed[s] && completed[s].clean === true; })) {
      result.reason = 'orchestration blocked: early reviews not both clean';
      result.nextStage = pendingStage;
      return deepFreeze(result);
    }
  }

  if (pendingStage === 'external_approval_evidence') {
    if (!exactKeys(O.payload, ['approvalEvidenceDigest']) || !isSha256Hex(O.payload.approvalEvidenceDigest)) {
      result.reason = 'external_approval_evidence payload must be exactly {approvalEvidenceDigest: sha256}';
      result.nextStage = pendingStage;
      return deepFreeze(result);
    }
    const approvalCandidate = Object.assign({}, candidate, { digest: candidateDigest });
    const record = v2ApprovalRecord(R, identityDigest, approvalCandidate, completed.orchestration && completed.orchestration.digest);
    if (!v2VerifyApproval(approvalBoundary, record)) {
      result.reason = 'external_approval_evidence blocked: verifier verdict/bindings did not exactly match the complete approval record (fail-closed)';
      result.nextStage = pendingStage;
      return deepFreeze(result);
    }
  }

  if (pendingStage === 'integration') {
    if (!V2_FINAL_REVIEWS.every(function (s) { return completed[s] && completed[s].clean === true; })) {
      result.reason = 'integration blocked: final reviews not both clean';
      result.nextStage = pendingStage;
      return deepFreeze(result);
    }
    result.completionCandidate = {
      stage: 'integration',
      privilege: 'integration-eligibility-only',
      digest: candidateDigest,
      runGeneration: R.runGeneration,
      runIdentityDigest: identityDigest
    };
  }

  const idx = V2_STAGE_ORDER.indexOf(pendingStage);
  result.allow = true;
  result.nextStage = V2_STAGE_ORDER[idx + 1] || null;
  result.reason = 'gate passed for ' + pendingStage;
  result.detail.pendingStage = pendingStage;
  result.detail.candidateDigest = candidateDigest;
  result.detail.candidateProducer = { executionId: O.executionId, attestation: O.attestation };
  const eligibilityEvidence = {
    schema: 'naia-adk/deterministic-gate-eligibility/v1',
    authority: 'naia-adk-deterministic-gate',
    decision: 'eligible',
    issueId: R.issueId,
    runGeneration: R.runGeneration,
    runIdentityDigest: identityDigest,
    stage: pendingStage,
    candidateDigest: candidateDigest,
    nextStage: result.nextStage
  };
  result.gateEligibilityReceipt = {
    evidence: eligibilityEvidence,
    digest: sha256(canonicalJSON(eligibilityEvidence))
  };
  return deepFreeze(result);
}

function run(argv) {
  const args = parseArgs(argv);
  if (args.issue == null || String(args.issue).trim() === '') {
    process.stderr.write('missing --issue <id>\n');
    process.exit(2);
  }
  const devModels = loadJSON(resolveConfig('development-models.json'));
  const orchestrator = loadJSON(resolveConfig('issue-orchestrator-experiment.json'));
  const secretKeysFound = Array.from(new Set(
    collectSecretKeys(devModels, []).concat(collectSecretKeys(orchestrator, []))
  )).sort();
  if (secretKeysFound.length > 0) {
    process.stderr.write('config rejected: secret keys present: ' + secretKeysFound.join(', ') + '\n');
    process.exit(2);
  }
  const validation = validateRoleBindings(devModels, orchestrator);
  if (!validation.ok) {
    process.stderr.write('config rejected: ' + validation.errors.join('; ') + '\n');
    process.exit(1);
  }
  const result = buildPlan({
    devModels: devModels,
    orchestrator: orchestrator,
    issue: args.issue,
    scope: args.scope
  });
  const out = canonicalJSON(result.plan);
  process.stdout.write(out + '\n');
  if (!result.validation.ok) {
    process.exit(1);
  }
}

module.exports = {
  SECRET_KEYS: SECRET_KEYS,
  isSecretKey: isSecretKey,
  stripSecretKeys: stripSecretKeys,
  canonicalize: canonicalize,
  canonicalJSON: canonicalJSON,
  sha256: sha256,
  loadJSON: loadJSON,
  resolveConfig: resolveConfig,
  parseArgs: parseArgs,
  normalizeIssueScope: normalizeIssueScope,
  validateRoleBindings: validateRoleBindings,
  buildRoleSnapshot: buildRoleSnapshot,
  buildSteps: buildSteps,
  buildDefectPolicy: buildDefectPolicy,
  buildPlan: buildPlan,
  evaluateRun: evaluateRun,
  run: run
};

if (require.main === module) {
  run(process.argv.slice(2));
}
