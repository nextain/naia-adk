# Clipped Codex empty-composer hint

Original request: recognize a clearly styled clipped known Codex hint while preserving human drafts. Parent structure: the shared pure composer classifier and existing receiver screenState API. Acceptance fit: consolidate those existing classifiers, reuse the established SGR parser and retain the receiver import path by re-export. No model, state, transport, timeout, schema or runtime configuration is added.

The Codex0.170 renderer draws its default empty hint with dim styling on one line, clipped to the text area. Disabled input can also have a placeholder, so style alone is insufficient. The default literal is `Ask Codex to do anything`; the shortest accepted clipped prefix is the complete `Ask Codex` token (nine ASCII characters including its space). An empty input retains the existing idle behavior. Existing complete and wrapped known-hint compatibility is preserved.

Primary sources: [renderer](https://raw.githubusercontent.com/openai/codex/rust-v0.170.0/codex-rs/tui/src/bottom_pane/chat_composer.rs), [default literal](https://raw.githubusercontent.com/openai/codex/rust-v0.170.0/codex-rs/tui/src/chatwidget.rs).

Implementation boundary:
- `scripts/lib/composer-screen.mjs` owns the unchanged ordinary classification and the existing style parser. Its Codex branch adds only exact single-row clipped-prefix recognition with all payload glyphs dim. Muse and other-tool fallback stay separate.
- `scripts/lib/role-session-input.mjs` imports/re-exports screenState; input attempts, guards and ACK handling remain unchanged.
- `scripts/lib/composer-screen.test.mjs` covers styled prefixes9..22, a sanitized12-column frame, plain/partial/reset styling, nonempty shorter prefixes, altered text, extra rows, disabled hints, pasted content, color components and CLI output.
- `scripts/lib/role-session-input.test.mjs` proves native-active precedence, human draft preservation, terminal canonical rejection and a fresh validated attempt accepting one native ACK.

Acceptance: new positive regressions fail against the base; related tests and current preflight/doc/OSS gates pass; independent narrow review and required CI run on a fixed source. Runtime pointer changes and real UI/session operations are separate operator work, not part of this patch.
