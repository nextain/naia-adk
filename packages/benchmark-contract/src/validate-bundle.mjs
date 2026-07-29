const TRACE_KINDS = ["directive","requirement","use_case","use_case_test","feature","feature_test","implementation","evidence"];
const EDGE_KINDS = ["directives_to_requirements","requirements_to_use_cases","use_cases_to_use_case_tests","use_case_tests_to_features","features_to_feature_tests","feature_tests_to_implementations","implementations_to_evidence"];
const EDGE_ENDPOINTS = Object.fromEntries(EDGE_KINDS.map((kind, index) => [kind, [TRACE_KINDS[index], TRACE_KINDS[index + 1]]]));
const FIXED_CONTROLS = ["prompt_digest","context_digest","tool_set_digest","tool_schema_digest","platform_digest","scheduler_digest","scorer_set_digest","ordering_digest"];
const REQUIRED_COSTS = ["cached_input_tokens","uncached_input_tokens","output_tokens","reasoning_tokens","retries","wall_time_ms","fallbacks","escalations","terminal_failure_consumption"];

const sameSet = (left, right) => left.length === right.length && left.every((item) => right.includes(item));
const timestamp = (value) => Date.parse(value);
const acceptanceUsable = (observation) => ["measured","provider_proven_zero"].includes(observation?.state);
const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
const relativePosixLocator = (value) => {
  const artifactPath = value.split("#", 1)[0];
  return !artifactPath.startsWith("/") && !/^[A-Za-z]:/.test(artifactPath) && !artifactPath.includes("\\") && artifactPath.split("/").every((segment) => segment && segment !== "." && segment !== "..");
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  return value;
}

export const digestCanonical = (value) => createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

function bootstrapBounds(values, seed, repetitions = 10000) {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const means = [];
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  const quantile = (probability) => means[Math.floor((means.length - 1) * probability)];
  return { estimate: values.reduce((sum, value) => sum + value, 0) / values.length, lower: quantile(0.025), upper: quantile(0.975) };
}

function mapUnique(items, label, errors) {
  const map = new Map();
  for (const item of items) {
    if (map.has(item.id)) errors.push(`${label}: duplicate id ${item.id}`);
    else map.set(item.id, item);
  }
  return map;
}

export function validateBundleSemantics(bundle) {
  const errors = [];
  const tasks = mapUnique(bundle.tasks, "tasks", errors);
  const runs = mapUnique(bundle.runs, "runs", errors);
  const assets = mapUnique(bundle.assets, "assets", errors);
  const routes = mapUnique(bundle.routing_policy.routes, "routes", errors);
  const referenceRoute = routes.get(bundle.routing_policy.reference_route_id);
  if (!referenceRoute) errors.push("routing: unknown reference route");
  if (bundle.routing_policy.digest !== digestCanonical(without(bundle.routing_policy, "digest"))) errors.push("routing: policy digest mismatch");
  if (new Set(bundle.routing_policy.routes.map((route) => route.order)).size !== bundle.routing_policy.routes.length) errors.push("routing: duplicate route order");
  if (!bundle.routing_policy.task_classes.every((kind) => bundle.routing_policy.routes.some((route) => route.task_class === kind))) errors.push("routing: task class without route");

  for (const task of bundle.tasks) {
    const asset = assets.get(task.asset_id);
    if (!asset) errors.push(`${task.id}: unknown asset ${task.asset_id}`);
    else {
      if (asset.lifecycle_digest !== digestCanonical(asset.lifecycle_events)) errors.push(`${task.id}: asset lifecycle digest mismatch`);
      asset.lifecycle_events.forEach((event, index) => {
        if (event.sequence !== index + 1 || (index && timestamp(event.at) < timestamp(asset.lifecycle_events[index - 1].at))) errors.push(`${task.id}: asset lifecycle ledger invalid`);
      });
      if (asset.lifecycle_events.at(-1)?.status !== asset.holdout_status) errors.push(`${task.id}: asset lifecycle status mismatch`);
      if (asset.fixture_digest !== task.fixture_digest) errors.push(`${task.id}: fixture digest differs from asset`);
      if (task.holdout_class === "holdout" && !["sealed_unconsumed","consumed"].includes(asset.holdout_status)) errors.push(`${task.id}: asset is not a holdout`);
      if (task.holdout_class === "holdout" && asset.holdout_status === "consumed") errors.push(`${task.id}: consumed holdout cannot be unseen evidence`);
      if (asset.oracle_first_access_at && timestamp(asset.oracle_first_access_at) < timestamp(asset.producer_snapshot_bound_at)) errors.push(`${task.id}: oracle accessed before producer snapshot binding`);
      if (task.scorer.kind === "calibrated_model_judge") {
        if (!asset.judge_calibration || task.scorer.calibration_digest !== asset.scorer_digest) errors.push(`${task.id}: judge calibration is not bound to scorer`);
        if (asset.judge_calibration?.judge_execution_id === bundle.review_freeze.producer.execution_id) errors.push(`${task.id}: producer cannot be judge`);
        if (asset.judge_calibration) {
          const calibration = asset.judge_calibration;
          if (calibration.strata_digest !== digestCanonical(calibration.strata)) errors.push(`${task.id}: judge stratum digest mismatch`);
          const dimensions = ["expected_class","language","task_difficulty","sensitivity_class"];
          if (dimensions.some((dimension) => !calibration.strata.some((stratum) => stratum.dimension === dimension))) errors.push(`${task.id}: judge calibration dimension missing`);
          if (calibration.strata.some((stratum) => !stratum.passed || stratum.agreement < stratum.agreement_floor || stratum.disagreement_count > stratum.sample_count || (stratum.dimension === "expected_class" && stratum.sample_count < calibration.cases_per_expected_class_min))) errors.push(`${task.id}: judge calibration stratum failed`);
        }
      }
    }
  }

  for (const run of bundle.runs) {
    if (run.contract_digest !== bundle.review_freeze.contract_digest) errors.push(`${run.id}: contract digest mismatch`);
    const route = routes.get(run.route_id);
    if (!route) errors.push(`${run.id}: undeclared route ${run.route_id}`);
    else if (route.exact_model_id !== run.model.exact_id || route.provider !== run.model.provider || route.configuration_digest !== run.model.configuration_digest) errors.push(`${run.id}: model does not match route`);
    const expected = new Map();
    for (const taskId of run.scheduled_task_ids) {
      const task = tasks.get(taskId);
      if (!task) errors.push(`${run.id}: unknown scheduled task ${taskId}`);
      else {
        expected.set(taskId, task.scheduled_runs);
        if (route && route.task_class !== task.task_class) errors.push(`${run.id}: route task class mismatch for ${taskId}`);
        const calibration = assets.get(task.asset_id)?.judge_calibration;
        if (calibration && timestamp(calibration.calibrated_at) > timestamp(run.started_at)) errors.push(`${run.id}: judge calibration occurred after run start`);
      }
    }
    const scheduledTasks = run.scheduled_task_ids.map((id) => tasks.get(id)).filter(Boolean);
    if (run.task_set_digest !== digestCanonical(scheduledTasks)) errors.push(`${run.id}: task-set digest mismatch`);
    if (run.price_snapshot.digest !== digestCanonical(without(run.price_snapshot, "digest")) || timestamp(run.price_snapshot.captured_at) > timestamp(run.started_at)) errors.push(`${run.id}: price snapshot is mutable or late`);
    const resultKeys = new Set();
    const indices = new Map();
    for (const result of run.task_results) {
      if (!expected.has(result.task_id)) errors.push(`${run.id}: unscheduled result ${result.task_id}`);
      const key = `${result.task_id}#${result.run_index}`;
      if (resultKeys.has(key)) errors.push(`${run.id}: duplicate result ${key}`);
      resultKeys.add(key);
      if (!indices.has(result.task_id)) indices.set(result.task_id, []);
      indices.get(result.task_id).push(result.run_index);
      if (result.outcome_class !== "task_result" && result.status !== "invalid") errors.push(`${run.id}: non-task failure classified as valid result`);
    }
    for (const [taskId, count] of expected) {
      const actual = (indices.get(taskId) ?? []).sort((a, b) => a - b);
      if (actual.length !== count || actual.some((value, index) => value !== index + 1)) errors.push(`${run.id}: incomplete accounting for ${taskId}`);
    }
    if (new Set(run.metrics.map((metric) => metric.id)).size !== run.metrics.length) errors.push(`${run.id}: duplicate metric id`);
    const metricMap = new Map(run.metrics.map((metric) => [metric.id, metric]));
    for (const taskId of run.scheduled_task_ids) for (const definition of tasks.get(taskId)?.required_metrics ?? []) {
      const metric = metricMap.get(definition.id);
      if (!metric) errors.push(`${run.id}: missing required metric ${definition.id}`);
      else if (metric.suite_id !== tasks.get(taskId).suite || ["calculation_kind","formula_revision","unit","numerator_definition","denominator_definition","required_for_acceptance"].some((key) => metric[key] !== definition[key])) errors.push(`${run.id}: required metric definition mismatch ${definition.id}`);
    }
    for (const metric of run.metrics) {
      const suiteTaskIds = run.scheduled_task_ids.filter((id) => tasks.get(id)?.suite === metric.suite_id);
      const sourceResults = run.task_results.filter((result) => suiteTaskIds.includes(result.task_id)).map(({task_id,run_index,status,outcome_class,evidence_digest}) => ({task_id,run_index,status,outcome_class,evidence_digest}));
      if (!sourceResults.length || metric.input_digest !== digestCanonical(sourceResults)) errors.push(`${run.id}: metric input binding mismatch ${metric.id}`);
      if (metric.calculation_kind === "task_pass_rate" && (metric.denominator !== sourceResults.length || metric.numerator !== sourceResults.filter((result) => result.status === "valid_pass").length)) errors.push(`${run.id}: task pass metric value mismatch ${metric.id}`);
      if (metric.calculation_kind === "task_valid_rate" && (metric.denominator !== sourceResults.length || metric.numerator !== sourceResults.filter((result) => result.status !== "invalid").length)) errors.push(`${run.id}: task valid metric value mismatch ${metric.id}`);
    }
    const gates = mapUnique(run.hard_gate_observations, `${run.id} gates`, errors);
    for (const taskId of run.scheduled_task_ids) {
      const task = tasks.get(taskId);
      for (const gateId of task?.hard_gate_ids ?? []) {
        const gate = gates.get(gateId);
        if (!gate || !gate.task_ids.includes(taskId)) errors.push(`${run.id}: missing mapped hard gate ${gateId} for ${taskId}`);
        else if (!gate.owning_layers.includes(task.layer)) errors.push(`${run.id}: hard gate ${gateId} does not own ${task.layer}`);
      }
    }
    if (run.evidence_snapshot_digest !== digestCanonical({ task_results:run.task_results, metrics:run.metrics, hard_gate_observations:run.hard_gate_observations })) errors.push(`${run.id}: evidence snapshot digest mismatch`);
  }

  const { trace, reuse_decision: reuse, dual_context: dual, canonical_structure: structure } = bundle.governance;
  const nodes = mapUnique(trace.nodes, "trace nodes", errors);
  const edges = mapUnique(trace.edges, "trace edges", errors);
  const activeScopes = new Set();
  for (const node of nodes.values()) if (node.status === "active") {
    const key = `${node.kind}:${node.semantic_scope}`;
    if (activeScopes.has(key)) errors.push(`trace: duplicate active semantic scope ${key}`);
    activeScopes.add(key);
    if (!relativePosixLocator(node.locator)) errors.push(`trace: locator escapes repository ${node.id}`);
  }
  if (trace.snapshot_digest !== digestCanonical({ schema_digest: trace.schema_digest, nodes: trace.nodes, edges: trace.edges })) errors.push("trace: snapshot digest mismatch");
  for (const kind of TRACE_KINDS) if (![...nodes.values()].some((node) => node.kind === kind && node.status === "active")) errors.push(`trace: missing active ${kind}`);
  for (const kind of EDGE_KINDS) if (![...edges.values()].some((edge) => edge.kind === kind && edge.status === "active")) errors.push(`trace: missing active ${kind}`);
  for (const edge of edges.values()) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to) { errors.push(`trace: unresolved edge ${edge.id}`); continue; }
    if (!relativePosixLocator(edge.evidence_locator)) errors.push(`trace: evidence locator escapes repository ${edge.id}`);
    const expectedKinds = EDGE_ENDPOINTS[edge.kind];
    if (edge.status === "active" && (from.status !== "active" || to.status !== "active")) errors.push(`trace: active edge targets inactive node ${edge.id}`);
    if (from.kind !== expectedKinds[0] || to.kind !== expectedKinds[1]) errors.push(`trace: invalid endpoints for ${edge.id}`);
    if (edge.from_revision !== from.revision || edge.from_digest !== from.content_digest || edge.to_revision !== to.revision || edge.to_digest !== to.content_digest) errors.push(`trace: stale binding for ${edge.id}`);
    if (!from.outgoing_edge_ids.includes(edge.id) || !to.incoming_edge_ids.includes(edge.id)) errors.push(`trace: asymmetric edge ${edge.id}`);
  }
  for (const node of nodes.values()) {
    for (const edgeId of node.incoming_edge_ids) if (edges.get(edgeId)?.to !== node.id) errors.push(`trace: invalid incoming reference ${node.id}/${edgeId}`);
    for (const edgeId of node.outgoing_edge_ids) if (edges.get(edgeId)?.from !== node.id) errors.push(`trace: invalid outgoing reference ${node.id}/${edgeId}`);
    if (node.status === "active" && node.kind !== "directive" && node.incoming_edge_ids.length === 0) errors.push(`trace: orphan active ${node.id}`);
    if (node.status === "active" && node.kind !== "evidence" && node.outgoing_edge_ids.length === 0) errors.push(`trace: dead-end active ${node.id}`);
  }
  const activeEdges = [...edges.values()].filter((edge) => edge.status === "active");
  const walk = (seeds, direction) => {
    const visited = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of activeEdges.filter((item) => item[direction === "forward" ? "from" : "to"] === current)) {
        const next = edge[direction === "forward" ? "to" : "from"];
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    return visited;
  };
  const activeNodes = [...nodes.values()].filter((node) => node.status === "active");
  const fromDirective = walk(activeNodes.filter((node) => node.kind === "directive").map((node) => node.id), "forward");
  const toEvidence = walk(activeNodes.filter((node) => node.kind === "evidence").map((node) => node.id), "backward");
  for (const node of activeNodes) if (!fromDirective.has(node.id) || !toEvidence.has(node.id)) errors.push(`trace: active node is not end-to-end reachable ${node.id}`);
  if (activeNodes.length) {
    const connected = new Set([activeNodes[0].id]), queue = [activeNodes[0].id];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of activeEdges.filter((item) => item.from === current || item.to === current)) {
        const next = edge.from === current ? edge.to : edge.from;
        if (!connected.has(next)) { connected.add(next); queue.push(next); }
      }
    }
    if (connected.size !== activeNodes.length) errors.push("trace: active graph has disconnected components");
  }
  if (trace.validator_result !== "PASS") errors.push("trace validator did not pass");

  if (reuse.reservation.status !== "acquired" || reuse.reservation.conflict_result !== "clear") errors.push("reuse reservation is not exclusively acquired");
  if (reuse.receipt_digest !== digestCanonical(without(reuse, "receipt_digest"))) errors.push("reuse receipt digest mismatch");
  if (reuse.reservation.scope_digest !== reuse.semantic_scope_digest) errors.push("reuse reservation scope mismatch");
  if (timestamp(reuse.query_completed_at) > timestamp(reuse.reservation.acquired_at) || timestamp(reuse.reservation.acquired_at) > timestamp(reuse.decided_at) || timestamp(reuse.decided_at) > timestamp(reuse.first_implementation_at) || timestamp(reuse.reservation.expires_at) <= timestamp(reuse.first_implementation_at) || timestamp(reuse.reservation.expires_at) <= timestamp(reuse.reservation.acquired_at)) errors.push("reuse decision or reservation is not valid before implementation");
  reuse.reservation_events.forEach((event, index) => {
    if (event.sequence !== index + 1 || event.scope_digest !== reuse.semantic_scope_digest || (index && timestamp(event.at) < timestamp(reuse.reservation_events[index - 1].at))) errors.push("reuse reservation event ledger is invalid");
    if (event.kind === "conflict") errors.push("reuse reservation has a conflict event");
  });
  if (reuse.reservation_events[0]?.kind !== "acquired" || timestamp(reuse.reservation_events[0]?.at) !== timestamp(reuse.reservation.acquired_at)) errors.push("reuse reservation acquisition event mismatch");
  if (reuse.reservation_events.some((event, index) => index > 0 && !["renewed"].includes(event.kind)) || !["acquired","renewed"].includes(reuse.reservation_events.at(-1)?.kind) || timestamp(reuse.reservation_events.at(-1)?.at) > timestamp(reuse.first_implementation_at)) errors.push("reuse reservation lifecycle is not active at implementation");

  let routeIndex = 0, retries = 0, fallbacks = 0;
  dual.route_attempts.forEach((attempt, index) => {
    if (attempt.sequence !== index + 1) errors.push("dual-context attempt sequence is invalid");
    if (index === 0 && (attempt.attempt_kind !== "primary" || attempt.route_id !== dual.ordered_route_ids[0])) errors.push("dual-context primary route is invalid");
    if (attempt.attempt_kind === "retry") { retries += 1; if (attempt.route_id !== dual.ordered_route_ids[routeIndex]) errors.push("dual-context retry changed route"); }
    if (attempt.attempt_kind === "fallback") { fallbacks += 1; routeIndex += 1; if (!attempt.fallback_trigger || attempt.route_id !== dual.ordered_route_ids[routeIndex]) errors.push("dual-context fallback transition is invalid"); }
  });
  if (retries > dual.retry_limit || fallbacks > dual.fallback_limit || routeIndex >= dual.ordered_route_ids.length) errors.push("dual-context retry or fallback budget exceeded");
  if (dual.route_attempts.length > 1 + dual.retry_limit + dual.fallback_limit) errors.push("dual-context attempt budget exceeded");
  const translationPassed = dual.structural_result === "PASS" && dual.semantic_result === "PASS" && dual.route_attempts.some((attempt) => attempt.status === "pass");
  const terminalTranslationPassed = translationPassed && dual.route_attempts.at(-1)?.status === "pass" && dual.route_attempts.findIndex((attempt) => attempt.status === "pass") === dual.route_attempts.length - 1;
  if (dual.accepted !== (terminalTranslationPassed && !dual.stale)) errors.push("dual-context acceptance is inconsistent");
  if (!dual.accepted && (!dual.stale || !dual.previous_mirror_preserved || dual.result_mirror_digest !== dual.previous_mirror_digest)) errors.push("dual-context failure did not preserve the previous mirror");
  if (structure.platform === "windows" && (structure.uses_wsl || structure.uses_bash || structure.requires_symlink || !/^node(?:\.exe)?\b|^powershell(?:\.exe)?\b|^pwsh(?:\.exe)?\b/i.test(structure.native_command))) errors.push("Windows evidence is not native Node or PowerShell");
  if (structure.structural_result !== "PASS") errors.push("canonical structure did not pass");

  const review = bundle.review_freeze;
  review.attempts.forEach((attempt, index) => {
    if (index && attempt.sequence !== review.attempts[index - 1].sequence + 1) errors.push("review attempt sequence is not consecutive");
    if (attempt.contract_digest !== review.contract_digest || attempt.prompt_digest !== review.prompt_digest || attempt.reviewer.reviewed_snapshot_digest !== review.contract_digest) errors.push(`review attempt ${attempt.sequence} target mismatch`);
    if (timestamp(attempt.started_at) > timestamp(attempt.completed_at)) errors.push(`review attempt ${attempt.sequence} timestamps invalid`);
    if (attempt.reviewer.execution_id === review.producer.execution_id || attempt.reviewer.agent_principal === review.producer.agent_principal) errors.push(`review attempt ${attempt.sequence} is producer self-review`);
    if (attempt.receipt_digest !== digestCanonical(without(attempt, "receipt_digest"))) errors.push(`review attempt ${attempt.sequence} receipt digest mismatch`);
  });
  if (review.producer.input_contract_digest !== review.contract_digest || review.producer.produced_snapshot_digest !== review.contract_digest || review.producer.prompt_digest !== review.prompt_digest) errors.push("producer provenance target mismatch");
  const expectedLedgerDigest = digestCanonical({ contract_digest: review.contract_digest, prompt_digest: review.prompt_digest, attempts: review.attempts });
  if (review.attempt_ledger_digest !== expectedLedgerDigest) errors.push("review attempt ledger digest mismatch");
  const finalPair = review.attempts.slice(-2);
  if (finalPair.length !== 2 || finalPair.some((item) => item.status !== "CLEAN" || item.verdict !== "CLEAN" || item.blocking_count || item.material_count)) errors.push("final review attempts are not consecutive CLEAN");
  if (new Set(finalPair.map((item) => item.reviewer.execution_id)).size !== 2 || new Set(finalPair.map((item) => item.reviewer.agent_principal)).size !== 2) errors.push("final review principals are not independent");
  if (review.freeze.contract_digest !== review.contract_digest || review.freeze.ledger_digest !== review.attempt_ledger_digest || review.freeze.final_sequence !== review.attempts.at(-1)?.sequence) errors.push("freeze target, ledger, or sequence mismatch");
  if (review.freeze.ordered_clean_receipt_digests.join() !== finalPair.map((item) => item.receipt_digest).join()) errors.push("freeze receipt order mismatch");
  if (review.freeze.manifest_digest !== digestCanonical(without(review.freeze, "manifest_digest"))) errors.push("freeze manifest digest mismatch");

  for (const comparison of bundle.comparisons) {
    const reference = runs.get(comparison.reference_run_id), candidate = runs.get(comparison.candidate_run_id);
    if (!reference || !candidate || reference === candidate) { errors.push(`${comparison.id}: unresolved run pair`); continue; }
    if (comparison.routing_policy_id !== bundle.routing_policy.id || comparison.statistical_plan_id !== bundle.routing_policy.statistical_plan.id) errors.push(`${comparison.id}: policy or statistical plan mismatch`);
    if (!sameSet(reference.scheduled_task_ids, candidate.scheduled_task_ids) || !sameSet(comparison.paired_task_ids, reference.scheduled_task_ids)) errors.push(`${comparison.id}: paired task set mismatch`);
    if (!sameSet(comparison.paired_observations.map((item) => item.task_id), comparison.paired_task_ids) || comparison.calculation.input_digest !== digestCanonical(comparison.paired_observations)) errors.push(`${comparison.id}: paired observation binding mismatch`);
    if (comparison.calculation.evidence_input_digest !== digestCanonical([{ run_id:reference.id, evidence_snapshot_digest:reference.evidence_snapshot_digest },{ run_id:candidate.id, evidence_snapshot_digest:candidate.evidence_snapshot_digest }])) errors.push(`${comparison.id}: run evidence input digest mismatch`);
    if (comparison.paired_task_ids.some((id) => tasks.get(id)?.layer !== comparison.layer)) errors.push(`${comparison.id}: cross-layer aggregation`);
    if (comparison.paired_task_ids.some((id) => assets.get(tasks.get(id)?.asset_id)?.holdout_status === "consumed")) errors.push(`${comparison.id}: consumed holdout used for acceptance evidence`);
    for (const key of FIXED_CONTROLS) if (!comparison.fixed_control_keys.includes(key) || reference.controls[key] !== candidate.controls[key]) errors.push(`${comparison.id}: fixed control mismatch ${key}`);
    if (!comparison.fixed_control_keys.includes("task_set_digest") || reference.task_set_digest !== candidate.task_set_digest) errors.push(`${comparison.id}: task-set mismatch`);
    if (!comparison.fixed_control_keys.includes("price_snapshot_digest") || reference.price_snapshot.digest !== candidate.price_snapshot.digest) errors.push(`${comparison.id}: price snapshot mismatch`);
    if (reference.route_id !== bundle.routing_policy.reference_route_id || reference.cost_scope !== candidate.cost_scope || comparison.claim_scope !== candidate.cost_scope) errors.push(`${comparison.id}: route or cost scope mismatch`);
    const sameModel = reference.model.exact_id === candidate.model.exact_id && reference.model.provider === candidate.model.provider && reference.model.configuration_digest === candidate.model.configuration_digest;
    if (reference.adapter_revision !== candidate.adapter_revision) errors.push(`${comparison.id}: provider adapter revision changed`);
    if (comparison.layer === "A_model_capability") {
      if (comparison.changed_variable !== "model_configuration" || sameModel || reference.model.provider !== candidate.model.provider || reference.product_revision !== candidate.product_revision || reference.agent_runtime_revision !== candidate.agent_runtime_revision || reference.governance_harness_revision !== candidate.governance_harness_revision || reference.tool_adapter_revision !== candidate.tool_adapter_revision) errors.push(`${comparison.id}: model-layer causal controls invalid`);
    } else if (comparison.layer === "B_agent_runtime") {
      if (comparison.changed_variable !== "agent_runtime_revision" || !sameModel || reference.agent_runtime_revision === candidate.agent_runtime_revision || reference.product_revision !== reference.agent_runtime_revision || candidate.product_revision !== candidate.agent_runtime_revision || reference.governance_harness_revision !== candidate.governance_harness_revision || reference.tool_adapter_revision !== candidate.tool_adapter_revision) errors.push(`${comparison.id}: runtime-layer causal controls invalid`);
    } else {
      const governanceChanged = reference.governance_harness_revision !== candidate.governance_harness_revision;
      const toolAdapterChanged = reference.tool_adapter_revision !== candidate.tool_adapter_revision;
      const productBound = governanceChanged ? reference.product_revision === reference.governance_harness_revision && candidate.product_revision === candidate.governance_harness_revision : reference.product_revision === reference.tool_adapter_revision && candidate.product_revision === candidate.tool_adapter_revision;
      if (!sameModel || reference.agent_runtime_revision !== candidate.agent_runtime_revision || comparison.changed_variable === "governance_harness_revision" !== governanceChanged || comparison.changed_variable === "tool_adapter_revision" !== toolAdapterChanged || governanceChanged === toolAdapterChanged || !productBound) errors.push(`${comparison.id}: governance-layer causal controls invalid`);
    }
    const expectedGateIds = [...new Set(comparison.paired_task_ids.flatMap((id) => tasks.get(id)?.hard_gate_ids ?? []))];
    if (!sameSet(comparison.owning_gate_ids, expectedGateIds)) errors.push(`${comparison.id}: owning hard-gate set is incomplete`);
    const qualityDeltas = [], costDeltas = [];
    if (comparison.quality.delta_definition !== "candidate-reference" || comparison.cost.delta_definition !== "(candidate-reference)/reference") errors.push(`${comparison.id}: delta definition mismatch`);
    for (const observation of comparison.paired_observations) {
      const referenceResults = reference.task_results.filter((item) => item.task_id === observation.task_id);
      const candidateResults = candidate.task_results.filter((item) => item.task_id === observation.task_id);
      const referenceQuality = referenceResults.filter((item) => item.status === "valid_pass").length / referenceResults.length;
      const candidateQuality = candidateResults.filter((item) => item.status === "valid_pass").length / candidateResults.length;
      const referenceCost = referenceResults.reduce((sum, item) => sum + (item.cost[comparison.cost.metric_id]?.value ?? NaN), 0);
      const candidateCost = candidateResults.reduce((sum, item) => sum + (item.cost[comparison.cost.metric_id]?.value ?? NaN), 0);
      if (![referenceQuality,candidateQuality,referenceCost,candidateCost].every(Number.isFinite) || !close(observation.reference_quality,referenceQuality) || !close(observation.candidate_quality,candidateQuality) || !close(observation.reference_cost,referenceCost) || !close(observation.candidate_cost,candidateCost)) errors.push(`${comparison.id}: paired observation differs from run evidence`);
      qualityDeltas.push(candidateQuality - referenceQuality);
      costDeltas.push(referenceCost === 0 ? NaN : (candidateCost - referenceCost) / referenceCost);
    }
    if (costDeltas.some((value) => !Number.isFinite(value))) errors.push(`${comparison.id}: relative cost delta has zero reference`);
    else {
      const calculatedQuality = bootstrapBounds(qualityDeltas, comparison.calculation.bootstrap_seed);
      const calculatedCost = bootstrapBounds(costDeltas, comparison.calculation.bootstrap_seed);
      for (const [recorded, calculated, label] of [[comparison.quality,calculatedQuality,"quality"],[comparison.cost,calculatedCost,"cost"]]) {
        if (!close(recorded.estimate,calculated.estimate) || !close(recorded.lower_bound,calculated.lower) || !close(recorded.upper_bound,calculated.upper) || !close(recorded.ci_width,calculated.upper-calculated.lower)) errors.push(`${comparison.id}: fabricated ${label} confidence bounds`);
      }
    }
    if (comparison.claim_status === "accepted") {
      const plan = bundle.routing_policy.statistical_plan;
      if (comparison.paired_task_ids.length < plan.paired_task_min || comparison.quality.lower_bound < -plan.quality_noninferiority_margin || comparison.cost.upper_bound > -plan.minimum_cost_improvement || comparison.quality.ci_width > plan.max_ci_width || comparison.cost.ci_width > plan.max_ci_width) errors.push(`${comparison.id}: statistical acceptance failed`);
      for (const taskId of comparison.paired_task_ids) {
        const task = tasks.get(taskId);
        const requiredRepetitions = task.execution_kind === "stochastic" ? plan.stochastic_repetitions : plan.deterministic_repetitions;
        if (task.scheduled_runs < requiredRepetitions) errors.push(`${comparison.id}: insufficient repetitions for ${taskId}`);
      }
      for (const run of [reference, candidate]) {
        if (run.task_results.some((result) => result.status === "invalid" || REQUIRED_COSTS.some((key) => !acceptanceUsable(result.cost[key])))) errors.push(`${comparison.id}: invalid or incomplete terminal consumption`);
        if (comparison.cost.metric_id === "monetary" && run.task_results.some((result) => !acceptanceUsable(result.cost.monetary))) errors.push(`${comparison.id}: monetary cost is unavailable`);
        if (comparison.cost.metric_id === "quota_units" && run.task_results.some((result) => !acceptanceUsable(result.cost.quota_units))) errors.push(`${comparison.id}: quota cost is unavailable`);
        if (run.task_results.some((result) => !acceptanceUsable(result.cost[comparison.cost.metric_id]))) errors.push(`${comparison.id}: selected cost dimension is unavailable`);
        if (run.metrics.some((metric) => metric.required_for_acceptance && !acceptanceUsable(metric))) errors.push(`${comparison.id}: required metric unavailable`);
        const gates = new Map(run.hard_gate_observations.map((gate) => [gate.id, gate]));
        if (comparison.owning_gate_ids.some((id) => gates.get(id)?.status !== "GREEN")) errors.push(`${comparison.id}: owning hard gate is not GREEN`);
      }
    }
  }

  const baseline = bundle.baseline;
  if (baseline.manifest_digest !== digestCanonical(without(baseline, "manifest_digest"))) errors.push("baseline manifest digest mismatch");
  if (baseline.contract_digest !== review.contract_digest || baseline.routing_policy_digest !== bundle.routing_policy.digest) errors.push("baseline contract or routing-policy digest mismatch");
  if (baseline.reference_route_id !== bundle.routing_policy.reference_route_id || !routes.has(baseline.candidate_route_id)) errors.push("baseline route mismatch");
  const baselineIds = new Set();
  for (const slot of baseline.tasks) {
    if (baselineIds.has(slot.task_id)) errors.push(`baseline: duplicate task ${slot.task_id}`);
    baselineIds.add(slot.task_id);
    const task = tasks.get(slot.task_id);
    if (!task || task.fixture_digest !== slot.fixture_digest || task.scorer.revision !== slot.scorer_revision || task.scorer.digest !== slot.scorer_digest) errors.push(`baseline: unresolved task slot ${slot.task_id}`);
    if (slot.reference_route_id !== baseline.reference_route_id || slot.candidate_route_id !== baseline.candidate_route_id || slot.repetitions !== baseline.repetitions) errors.push(`baseline: route or repetition mismatch ${slot.task_id}`);
    if (slot.control_digest !== digestCanonical(baseline.controls)) errors.push(`baseline: control digest mismatch ${slot.task_id}`);
    if (task && !sameSet(slot.hard_gate_observation_ids, task.hard_gate_ids)) errors.push(`baseline: hard-gate mapping mismatch ${slot.task_id}`);
  }
  if (baseline.scheduled_denominator !== baseline.tasks.length * baseline.repetitions) errors.push("baseline denominator mismatch");
  const mappedGateIds = [...new Set(baseline.tasks.flatMap((slot) => slot.hard_gate_observation_ids))];
  if (mappedGateIds.some((id) => !baseline.declared_hard_gate_ids.includes(id)) || baseline.unobserved_hard_gate_ids.some((id) => !baseline.declared_hard_gate_ids.includes(id) || mappedGateIds.includes(id))) errors.push("baseline observed and unavailable hard-gate sets are inconsistent");
  const requiredForbiddenClaims = ["global_model_superiority","proven_cost_optimization","complete_product_quality","global_green_for_unobserved_gate","sota_status"];
  if (!sameSet(baseline.claims_forbidden, requiredForbiddenClaims)) errors.push("baseline forbidden claims are incomplete");
  if (baseline.platform.os === "windows" && (baseline.platform.uses_wsl || baseline.platform.uses_bash || baseline.platform.requires_symlink || !/^node(?:\.exe)?\b|^powershell(?:\.exe)?\b|^pwsh(?:\.exe)?\b/i.test(baseline.platform.native_command))) errors.push("baseline Windows runner is not native");
  return { ok: errors.length === 0, errors };
}
import { createHash } from "node:crypto";
