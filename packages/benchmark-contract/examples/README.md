# Example fixture

The executable positive bundle in
`../test/validate-benchmark-contract.mjs` is the canonical minimal example.
Keeping it executable prevents a copied JSON example from drifting away from the
schemas and semantic validator. Consumers should clone that fixture and replace
every digest, revision, route, task, and evidence reference with frozen values.
