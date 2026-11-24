[English](dev-docs-writing.en.md) | [한국어](dev-docs-writing.md)

Question this document answers: how do we accurately record the structure,
contracts, and implementation evidence of public Naia ADK development
documents?
Status: current baseline
Baseline: public repository `4d9d09cbb311de811f0c4eaeed6bc5fab426cc89`

# Development documentation criteria

This criteria applies when writing and reviewing the architecture, contracts,
procedures, and references of public Naia ADK. Development documents help
people and AI describe behavior against the same code and contracts. Each
topic's current baseline is maintained in one canonical document in the
repository.

Folder layout, tables of contents, file names, record keeping, moves, and
link management follow the repository's existing conventions. Outward-facing
sentences and tone follow the [external writing criteria](external-writing.md).

## Roles of documents

Find the existing canonical document first and update it. Each document kind
answers distinct questions in distinct prose.

| Document kind | Question it answers | Prose |
|---|---|---|
| Architecture | What are the system's purpose, boundaries, components, and connections? | Background and structure in prose with figures as needed. |
| Contract · interface | What input, output, state, and failure promises exist between components? | Link the schema and explain fields, states, and transitions in tables. |
| Procedure | In what order do we work, and how is success confirmed? | Numbered steps with observable completion conditions. |
| Reference | Which commands, configs, files, and states must be found? | Link values confirmed in the repository; verified results for generatable values. |
| Decision record | Which choice was made, and what was the result? | Link the record at the repository's designated place and keep the current contract canonical. |
| Work record | What was investigated, measured, or reviewed at a point in time? | State the time and observed results; distinguish them from the current baseline. |

The current canonical document describes present behavior. Work records
preserve the confirmation results of a point in time. When implementation
baselines change, update the canonical document and keep the scope confirmed
at the time in the records.

## Page frontmatter and baseline

Human-read development documents carry these three lines above the title:

```text
Question this document answers: <the question the reader checks>
Status: <current baseline, or a dated record status>
Baseline: public repository `<full commit SHA>`
```

Record the full commit SHA of the reviewed public baseline. Versions and
short SHAs may appear alongside in readable prose. Reproducible evidence is
pinned to the full SHA. Current behavior is explained with evidence from the
confirmed baseline.

When the scope of application must be distinguished, state in the body whether
it is the common baseline or a specific deployment environment. Access
permissions and disclosure levels are recorded separately under the
repository's relevant criteria.

## Describing contracts

Contract documents explain the boundaries and promises the reader checks.
Record the following when it applies to the contract:

1. State the purpose and participants — who makes and who consumes the
   contract.
2. Tie data-field formats, required/optional status, defaults, and
   constraints to the canonical schema. Use tables for supplementary
   comparisons the reader needs.
3. For contracts with state, explain allowed transitions, rejection
   conditions, and observed results.
4. Link implementation-touching tests by repository-relative path and symbol,
   and record the reproduction command.
5. Documents needing their own change history follow the repository's
   existing conventions.

Tables and body prose explain what schema fields mean and when they are
used; field definitions are confirmed by linking the schema. Check results
record the command, run time, exit status, or observed outcome. Distinguish
executed check results from non-executed items.

## Evidence grounding and code links

Volatile implementation evidence is recorded with the repository-relative
file path plus symbol, function, and schema keys — for example,
`scripts/lib/adk-manifest-validator.mjs`'s `validateAdkManifest`. Line numbers
are a finding aid while reviewing; the canonical evidence is pinned to file
paths and symbols.

Numbers, versions, ports, defaults, paths, and allowed states are confirmed
against the baseline's code, schemas, and configs. When code and observed
execution disagree, explain each side's evidence and the difference. Books,
meetings, messages, and work records give background; current implementation
is backed by the baseline's code and schemas plus the needed run
observations.

Automatic checks verify formats, links, file/schema existence, and
machine-comparable values. Whether a claim's meaning is backed by code, and
whether it fits a public document, is confirmed in content review. Report
results within the check's scope.

## Reading and structure

State the question the reader resolves in the title and first paragraph.
Explain the conclusion and needed scope first, then the reasons and details.
Information where row/column correspondence matters — fields, states,
responsibilities, comparisons — goes in tables. Background and exceptions go
in prose.

Procedures are written as a numbered order. Call flows are drawn as readable
figures, with the body prose explaining what arrows and boundaries mean.
Common terminology follows the [terminology baseline](../../.agents/context/terminology.yaml);
project-specific terms link to that project's terminology canonical.

## Public evidence and review

A public document's roles, paths, contracts, and examples use evidence
confirmable from the public repository. Examples use the repository's public
examples or reproducible values unrelated to real instances.

When describing new canonical or contract behavior, compare the code and
schema evidence and pass an independent review scoped to the change. Changes
spanning permissions, data, security, or multiple modules follow the
repository's review procedure. After the change, check document links and
automatic check results. When a lag candidate appears in checks, re-compare
the related code and claims and update the document.

## Casebooks and development documents

Casebooks explain the background behind a standard and how it was applied.
Development documents are the canonical source for current structure,
contracts, and procedures. Code quotes in the book should be read as
examples from the point in time stated in the book. When the book points
readers to current behavior, it links to the corresponding development
document.
