export const SUBJECTS = new Set(["agent_workflow", "artifact_runtime", "artifact_content", "end_user_flow"]);
export const EFFECTS = new Set(["background", "precondition", "outcome", "constraint", "presentation", "verification", "audience"]);
export const RENDER_POLICIES = new Set(["deny", "derive", "quote", "require"]);
export const COVERAGE_STATUSES = new Set(["COVERED", "NOT_COVERED"]);
export const VERDICTS = ["CLEAN", "NOT_CLEAN"];
export const OUTSIDE_SCOPE_VALUE = "outside_declared_atoms";
export const FINDING_REQUIRED_KEYS = ["file_location", "impact", "minimal_fix"];
export const ATOM_KEYS = ["id", "source_id", "text", "directive_ids", "subject", "effect", "render_policy", "target_ids", "criterion_ids", "evidence_ids"];

// Obligations the reviewer must satisfy no matter which base prompt was used.
//
// The atom ledger is written by the author of the change. Reviewing only inside
// it answers "is this right within the stated scope" and can never answer "is
// the stated scope right", which is where large reviews actually fail. So the
// reviewer is told, in every invocation, that it may report outside the ledger
// and must say whether the ledger was sufficient.
export const FRAME_OBLIGATIONS = `--- REVIEWER OBLIGATIONS & OUTPUT CONTRACT ---
The atom ledger below was written by the author of the change. It is a claim
about what matters, not a boundary on what you may examine.

You must output exactly one JSON object and no other text (no markdown formatting, no code fences, no commentary).
The JSON object must strictly match the following schema:

{
  "verdict": "CLEAN" | "NOT_CLEAN",
  "coverage": [
    {
      "atom_id": "<exact atom id from dynamic ledger>",
      "status": "COVERED" | "NOT_COVERED"
    }
  ],
  "findings": [
    {
      "atom_id": "<exact atom id>" | null,
      "scope": "outside_declared_atoms",
      "file_location": "<path/to/file:line>",
      "impact": "<concrete failure impact>",
      "minimal_fix": "<smallest diff or change to resolve the issue>"
    }
  ],
  "frame_assessment": {
    "scope_is_sufficient": true | false,
    "missing_concerns": ["<unaddressed concern>", ...]
  },
  "runtime_observed": true | false
}

Rules:
1. Output exactly one valid JSON object. Do not wrap with prose, markdown code blocks, or greetings.
2. "coverage": Must contain an entry for every atom in the dynamic ledger. Exactly one row per atom_id.
   - "status": "COVERED" if verified and satisfied, or "NOT_COVERED" if unsatisfied or unverifiable.
   - Duplicate, missing, or unknown atom IDs are strictly rejected.
3. "findings": Array of issues found. Empty array [] if no issues.
   - "file_location": Non-empty string specifying file and optional line.
   - "impact": Non-empty string describing the concrete harm or failure.
   - "minimal_fix": Non-empty string describing the minimal change to resolve it.
   - "atom_id": Exact atom ID if the issue relates to a declared atom, or null if outside the author's ledger.
   - "scope": If "atom_id" is null, "scope" MUST be "outside_declared_atoms".
4. "frame_assessment": Judge whether the ledger itself is sufficient for the original request.
   - "scope_is_sufficient": boolean.
   - "missing_concerns": Array of non-empty strings. If "scope_is_sufficient" is false, this array must not be empty.
5. "runtime_observed": boolean. Set to true ONLY if you actually observed the running system. Reading files is not observing behaviour; if static review only, set to false.
6. "verdict":
   - "CLEAN" is ONLY valid when every atom is "COVERED", "findings" is empty ([]), and "scope_is_sufficient" is true.
   - "NOT_CLEAN" must be used if any atom is "NOT_COVERED", any finding exists, or "scope_is_sufficient" is false.`;

export const AGY_TOOL_POLICY = `--- TOOL USAGE POLICY ---
Shell commands and web browsing are denied in this environment. Do not call run_command. Do not use web search or browser tools (such as search_web, read_url_content, read_browser_page). Web access is forbidden. If you need to inspect files, read them using local file viewing tools only. You must output the final review JSON as your response.`;
