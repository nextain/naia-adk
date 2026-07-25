# PROTOCOL — Pure Local Integrity Stage Gate (P0)

- **Domain:** `io.nextain.naia-adk.stage-gate` (framed with version `v1`, see hash frame below).
- **Scope:** local, unauthenticated integrity metadata **only**. Receipts carry no
  authentication, no signatures, and no trust semantics beyond local tamper-evidence.
- **Evaluator:** returns a **candidate** only; it never finalizes. P1 atomically
  consumes the replay (all-or-nothing).

## Canonical JSON (NOT RFC 8785)

This protocol defines its own canonical JSON. It is **not** RFC 8785 (JCS) and must
not be implemented as such.

### Accepted values (exhaustive)

| Value          | Rule                                                                 |
|----------------|----------------------------------------------------------------------|
| `null`         | allowed                                                              |
| boolean        | allowed (`true` / `false`)                                           |
| number         | **safe integers only** (`Number.isSafeInteger`); `-0` normalizes to `0` |
| string         | valid Unicode **scalar values** only (no lone surrogates)            |
| array          | **dense** arrays of own data elements only (no holes)                |
| object         | **plain** objects (`Object.prototype` or `null` prototype) only      |

### Rejected (encoding MUST fail)

- Any other number: non-integers, unsafe integers, `NaN`, `±Infinity`.
- `toJSON` methods (never invoked — their presence is an error).
- Accessor (getter/setter) properties.
- Non-enumerable own properties.
- Symbol keys.
- Strings containing lone surrogates.
- Cycles (any self-reference at any depth).
- Any other type: `undefined`, functions, bigints, class instances, `Map`, `Set`,
  typed arrays, `Date`, etc.

### Serialization rules

- Object keys are sorted by **UTF-16 code units** (ascending).
- No whitespace, no trailing newline, no duplicate keys.
- Control characters (U+0000–U+001F) are written with explicit escapes
  (`\b \t \n \f \r`, otherwise `\u00XX`); `"` and `\` are escaped.
- All other Unicode is emitted **unescaped** as UTF-8. No BOM.

## SHA256 Hash Frame

Every digest is SHA256 over the byte sequence:

```
utf8(domain + NUL + "v1" + NUL + kind + NUL)
  + u64be(fieldCount)
  + for each field, in order:
      u64be(byteLength(utf8(name))) + utf8(name)
      + u64be(byteLength(value))    + value
```

i.e. a domain/version/kind preamble (NUL-separated, NUL-terminated), a big-endian
unsigned 64-bit field count, then each **named, length-prefixed** field.

## Receipt digest

The receipt digest is **exactly**:

```
frame("receipt", [
  ["receipt", utf8(canonicalJson({ stage, previousDigest, requestDigest, scopeDigest, manifest }))]
])
```

The serialized receipt object has **exactly these 5 own keys** and no others:
`stage`, `previousDigest`, `requestDigest`, `scopeDigest`, `manifest`.

## Module surface (`core.mjs`)

`core.mjs` imports **only** `node:crypto` and exports **exactly** these names
(non-exported helpers may exist):

`DOMAIN`, `VERSION`, `ARTIFACT_SPEC`, `RECEIPT_SPEC`, `VIOLATION`,
`canonicalJson`, `digestRequest`, `digestScope`, `digestArtifact`,
`digestReceipt`, `evaluateStageGate`.

The cumulative expected-artifact table (M0..M5 sets) is **private** to
`core.mjs` — it is not exported; consumers derive it from `RECEIPT_SPEC`.

Raw byte inputs (`requestBytes`, `scopeBytes`, `artifact.bytes`) MUST be genuine
`Uint8Array` instances — nothing else is accepted.

## Artifacts (exactly 7, in this order)

Each id is bound to one immutable `(kind, path)` tuple. Paths are POSIX-relative.

| ID  | kind                 | path                                          |
|-----|----------------------|-----------------------------------------------|
| D01 | `expert_design`      | `.agents/requirements/design.md`              |
| R01 | `adversarial_review` | `.agents/reviews/adversarial-review.md`       |
| I01 | `main_integration`   | `.agents/requirements/integration.md`         |
| A01 | `operator_approval`  | `.agents/requirements/operator-approval.md`   |
| P01 | `scenarios`          | `.agents/requirements/scenarios.yaml`         |
| P02 | `coverage`           | `.agents/requirements/coverage.yaml`          |
| P03 | `requirements`       | `.agents/requirements/requirements.yaml`      |

The observation artifact set must be **exactly the cumulative artifact set of
the observed clean prefix** (see M0..M5 below): no unknown ids, no duplicates,
no missing ids (`ARTIFACT_MISSING`), and no extra ids (`ARTIFACT_EXTRA`). An
artifact frames `id`, `kind`, `path`, `bytes` in that order.

Paths reject: empty, leading `/`, any `\`, any NUL, any `//`, trailing `/`, any
`.`/`..` segment, and any lone surrogate.

## Receipts (at most 5, ordered, cumulative, fixed manifests)

| # | stage                 | manifest                                  | previousDigest |
|---|-----------------------|-------------------------------------------|----------------|
| 1 | `expert_design`       | `D01`                                     | `null`         |
| 2 | `adversarial_review`  | `D01,R01`                                 | receipt 1      |
| 3 | `main_integration`    | `D01,R01,I01`                             | receipt 2      |
| 4 | `operator_approval`   | `D01,R01,I01,A01`                         | receipt 3      |
| 5 | `planning_contract`   | `D01,R01,I01,A01,P01,P02,P03` (all seven) | receipt 4      |

Each receipt chains to the prior via `previousDigest`; the first links to `null`.
The full receipt carries exactly `stage`, `previousDigest`, `requestDigest`,
`scopeDigest`, `manifest`, `digest`.

## Valid clean prefixes (M0..M5)

Valid evaluation prefixes M0 through M5 are allowed. For each prefix, the
observed artifacts and receipts must exactly match its cumulative manifest —
exactly `n` receipts (the first `n` rows of the receipt table, in order, fully
valid) and exactly the cumulative artifact set below — nothing missing, nothing
extra. Only M5 has all seven artifacts, all five receipts, and a non-null
terminal candidate:

| Prefix | Receipt count | Exact cumulative artifact set              | Artifact count | terminalCandidate |
|--------|---------------|--------------------------------------------|----------------|-------------------|
| M0     | 0             | `{}` (empty)                               | 0              | `null`            |
| M1     | 1             | `{D01}`                                    | 1              | `null`            |
| M2     | 2             | `{D01,R01}`                                | 2              | `null`            |
| M3     | 3             | `{D01,R01,I01}`                            | 3              | `null`            |
| M4     | 4             | `{D01,R01,I01,A01}`                        | 4              | `null`            |
| M5     | 5             | `{D01,R01,I01,A01,P01,P02,P03}` (all seven)| 7              | non-null          |

- **Only M5** binds **all seven artifacts** with the full **five-receipt**
  chain, and **only M5** yields a non-null `terminalCandidate`.
- M0..M4 are valid intermediate states: clean, but never a candidate.
- Any artifact id absent from the prefix's exact set is flagged
  `ARTIFACT_EXTRA`; any id in the set but absent from the observation is
  flagged `ARTIFACT_MISSING`. Either violation makes the observation unclean
  (no terminal candidate).

## State & Observation

- **State** has exactly `{ requestBytes, scopeBytes }`.
- **Observation** has exactly `{ artifacts, receipts }`.

## Evaluator (`evaluateStageGate(state, observation, replaySet)`)

- `replaySet` MUST be a native `Set`; it is snapshot-copied and **never mutated**.
- Returns exactly `{ violations, prefix, terminalCandidate }`. It makes **no
  authorization claim** (there is no `allow` field).
- A clean result has `prefix` = `n` for exactly one of M0..M5.
- `terminalCandidate` is non-null **only** for M5 — the full, clean
  five-receipt chain binding all seven artifacts — and is
  `{ requestDigest, scopeDigest, finalReceiptDigest }` — a candidate for
  P1 to consume atomically, never a decision.

## Trust model & P1

- Receipts are **local, unauthenticated metadata only** — tamper-evidence, not
  authentication or authorization.
- The evaluator returns a **candidate only**; it never commits.
- **P1** consumes the replay **atomically**: the full 7-artifact / 5-receipt chain
  is accepted whole or rejected whole. Partial consumption is forbidden.
