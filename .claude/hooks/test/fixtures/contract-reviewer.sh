#!/usr/bin/bash
set -euo pipefail

jq -c \
  --arg nonce "$REQUEST_CONTRACT_CHALLENGE" \
  '
  {
    verdict: "CLEAN",
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
    finding_codes: []
  }
  ' "$REQUEST_CONTRACT_BUNDLE"
