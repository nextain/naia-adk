#!/usr/bin/bash
set -euo pipefail

jq -c \
  --arg nonce "$REQUEST_CONTRACT_CHALLENGE" \
  --arg stage "${REQUEST_CONTRACT_REVIEW_STAGE:-integration}" \
  --arg role "${REQUEST_CONTRACT_REVIEW_ROLE:-general}" \
  '
  {
    verdict: "CLEAN",
    review_stage: $stage,
    role: $role,
    delivery_state: (env.REQUEST_CONTRACT_DELIVERY_STATE // "RELEASE_ELIGIBLE"),
    preservation_vetoes: [],
    invocation_nonce: $nonce,
    covered_source_ids: .review_coverage.sourceIds,
    covered_source_mappings: .review_coverage.sourceMappings,
    covered_directive_ids: .review_coverage.directiveIds,
    covered_target_ids: .review_coverage.targetIds,
    covered_criterion_ids: .review_coverage.criterionIds,
    covered_authority_ids: .review_coverage.authorityIds,
    covered_authority_mappings: .review_coverage.authorityMappings,
    covered_tombstone_ids: .review_coverage.tombstoneIds,
    covered_tombstone_mappings: .review_coverage.tombstoneMappings,
    covered_scope_version_ids: .review_coverage.scopeVersionIds,
    covered_scope_version_mappings: .review_coverage.scopeVersionMappings,
    covered_artifact_ids: .review_coverage.artifactIds,
    covered_edge_ids: .review_coverage.edgeIds,
    covered_change_ids: .review_coverage.occurrenceIds,
    covered_change_mappings: .review_coverage.changeMappings,
    covered_preservation_surface_mappings: (.review_coverage.preservationSurfaceMappings // []),
    finding_codes: []
  }
  ' "$REQUEST_CONTRACT_BUNDLE"
