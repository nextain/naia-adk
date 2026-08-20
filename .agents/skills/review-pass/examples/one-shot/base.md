Review only the supplied repository and atom ledger. Be adversarial and concise.
Return one JSON object with `verdict` (`CLEAN` or `NOT_CLEAN`), `coverage`, and
`findings`. `coverage` must contain every ledger atom exactly once as
`{"atom_id":"...","status":"COVERED|NOT_COVERED"}`. Each finding must use
`{"atom_id":"...","file_location":"...","impact":"...","minimal_fix":"..."}`.
`CLEAN` requires every atom
to be `COVERED` and `findings` to be empty. Output JSON only. Do not modify files.
