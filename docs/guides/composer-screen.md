# Classifying an existing input box

`scripts/composer-screen.mjs --tool TOOL` reads a visible ANSI terminal capture
from stdin and returns only `{tool,state}`. States are `idle`, `busy`, `draft`
and `unknown`. It performs no input, transport, model call or session restart.
An instance may configure this command as its screen classifier before using
its existing transport. A classifier failure or unknown state must preserve the
original input for retry.

The classifier reuses the Codex receiver's screen parser and adds a Muse
adapter. Muse's empty input box can display a rotating suggestion instead of
an empty string. The 1.4.25 installed catalog contains 23 hints, including
`/goal pins a session objective with a progress bar`. Narrow panes clip hints.
A known hint or sufficiently long clipped prefix is treated as empty only when
its ANSI foreground matches the input border's neutral color, or its text is
rendered dim. There is no fixed color requirement. Human input rendered in the
normal text color remains a draft, even when its words equal a known hint.
Arbitrary slash commands are never treated as empty. ANSI extended background
and underline colors are consumed independently; their numeric color components
do not alter foreground or dim state.

Unstyled captures cannot prove a new Muse hint is empty. Unknown text rendered
with placeholder style returns `unknown`, so a future tool-version or catalog
change remains visible to instance diagnostics. Keep the original input pending
and verify the installed provider's renderer/catalog before adding that hint.
Do not weaken the classifier to accept every slash command.

The catalog was derived from the installed Muse 1.4.25 release's static hint
table and checked against an actual visible ANSI input box. The regression
suite covers complete and clipped hints, different neutral palettes, human and
multiline drafts, active spinners, unknown hints and the stdin CLI boundary.
Provider-native lifecycle or input-box metadata should replace screenshot
inference if an installed tool exposes a reliable read-only API.

An empty-box result proves only that the input box appears available. It does
not prove native message reception. The Codex receiver separately requires
native user-input acknowledgement; a legacy Muse consumer still has its existing
transport receipt semantics. This classifier does not add a Muse native ACK.

Instance integration preserves the formatter's complete text and original
source separately. For example, a host can keep the existing formatter and
transport while setting a per-role `screen_classifier.command` to this pinned
CLI, passing `--tool` from the actual foreground executable rather than the
preferred restart model. Host paths and tool versions belong to that instance's
configuration and diagnostic record, not the shared classifier.
