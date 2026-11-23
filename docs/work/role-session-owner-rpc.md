# Owner-account RPC for the existing role turn

Status: bounded phase-2 contract, before implementation. Integration base is
main `8ac90c6c5489a598e198323e518c412984112ec7`, which contains active mentions
and legacy-612 compatibility. The reviewed registration component is
`a272dca19b0bd11dbed57dff2d53808f1acbee1b`.

## Architecture fit

- Original request: restore automatic role delivery in common Naia ADK, including
  explicit human mentions during an existing working turn, with the same thread
  and normal-start model configuration.
- Parent structure: the existing Gateway proof, dispatcher canonical attempt,
  registered frontend/native-owner lease, active-turn client and native ACK.
- Acceptance rationale: add an optional account transport to that client. Keep
  authority, scheduling, attempts and acknowledgement with their existing owners;
  do not add a second scheduler, approval system or model lifecycle service.

## Fixed account boundary

`active_mentions.app_server.command` is an explicitly configured absolute argv
for a trusted immutable owner helper. It may invoke an existing authorized
account adapter such as sudo. No command, username, endpoint or configuration
path comes from a wake body. The helper's fixed argv names its private role
configuration and role; it opens no other role's endpoint.

The central consumer retains the credentialed Gateway/source grant, exact
source and formatted digests, canonical attempt, submission journal and native
same-turn UserMessage ACK. The owner helper receives bounded JSON stdin for
`inspect` or `steer`, with expected thread/cwd/native path, frontend and owner
identity, lease generation/launch ID, expected turn and an optional literal text
plus digest. Text is never shell syntax or an argv fragment. Replies contain
only bounded identity/turn/digest/result fields, with no text, token or raw error.

The helper loads its own fixed private configuration, verifies its effective
UID, resolves the current registration locally and compares both identities and
generation with the central expectation. The configured Unix endpoint must be
the lease's endpoint. It then reuses the existing client to initialize, read
that loaded thread and inspect its latest turn. `inspect` cannot send input.
`steer` uses only the exact expected turn and literal payload. Neither path
starts a server, resumes/loads a saved thread, edits a composer or changes a model.

There is no implicit reuse of native-read or registration-read prefixes as RPC
permission. Directory/socket modes stay unchanged. The registration resolver
compares native ownership; the pane guard selects the explicitly registered
frontend only within its actual foreground ancestry, independent of sibling
process order. Other providers retain their installed delivery path.

## Result and uncertainty

The protocol is `role-owner-rpc/v1`. It echoes the operation and configured role,
thread and binding identifiers. Successful steer returns its exact turn and
payload digest. This is transport evidence only; accepted delivery still needs
the central new-offset native user-item ACK for the same thread/turn/digest.

A structured helper result may prove `not_submitted` only when the fixed helper
knows it never sent the steer. A failed process before launch also proves no
input. Timeout, malformed/missing reply or transport failure after launch during
steer remain uncertain unless an explicit pre-steer report proves otherwise.
No generic nonzero exit becomes negative proof. The same canonical attempt is
never steered or pasted again; verification reconciles native evidence only.

Requests/replies are size-limited and helper execution is time-limited. Integration
must test these limits against the host command timeout; slow or unknown results
preserve the original and distinguish deferral from acceptance. Metadata logs
contain no payload or capability token. Existing opaque historical attempts are
not reclassified by this source change.

## Acceptance on one fixed integrated source

1. Preserve active grants, origin/source-file formatter binding, existing idle
   native ACK, all legacy-612 positive and negative compatibility scenarios, and
   registration component cases on the same main-based tree.
2. A registered frontend wins over an unrelated native foreground sibling only
   when it is in the verified foreground ancestry; another provider or global
   same-UID process never grants input. Mutating this selection must fail a case.
3. Two account policies use the same helper. Wrong UID, stale generation,
   frontend/owner mismatch, wrong endpoint/thread/turn, changed payload and an
   unregistered frontend reject before input. No permission mode is widened.
4. Local fixed argv is literal; shell-looking text remains one JSON text value.
   Owner inspect sends no input. Steer uses the existing active-turn client once.
5. A helper RPC success without the exact native item stays pending. Unknown
   transport followed by repeated verification performs zero extra inputs; a
   late same-turn ACK accepts it once. Other-turn/item/digest evidence rejects.
6. Run component, active-mention, legacy compatibility and integration acceptance
   plus required full CI, with resource-gated heavy work and fixed-snapshot
   independent review. Keep source and model-free fixtures distinct from live
   production acceptance.
7. The already installed host formatter successor remains byte-pinned. Confirm
   normal file rendering/registered formatter parity and old/new consumer CLI
   compatibility without touching role state; preserve its backup and rollback.
8. Actual role restart occurs only in the coordinator's normal lifecycle window,
   after current work/children/drafts finish. Preserve the explicit resume thread
   and registered model preference. Observe one real working-turn mention and
   stalled-card continuation with native ACK on the final fixed source before
   reporting operational completion.
