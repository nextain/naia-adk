# Native harness CI runtime

The test job uses `ubuntu-24.04` deliberately. Re-running commit `c1695e3`
changed the hosted image from Ubuntu 24.04 (run 41233838929, attempt 1) to
Ubuntu 26.04 (attempt 2). The latter failed isolated request-contract reviewer
launches, also seen in runs 41748330647 and 41806902871. The native test code
was unchanged. The previous image installed bubblewrap 0.9.0; the new image
had 0.11.1 and AppArmor 5.0.2.

This is a supported-runtime mitigation. It does not establish which Ubuntu
26.04 kernel/AppArmor rule rejects the launch: the existing runner deliberately
withholds reviewer stderr, and those hosted logs contain only the closed error
code. A locally extracted 0.11.1 binary fails with `loopback: Failed RTM_NEWADDR:
Operation not permitted` outside the installed executable's AppArmor profile,
but succeeds when inheriting that profile. Therefore the version number alone
is not a sufficient diagnosis. Ubuntu 26.04 also ships a named `bwrap` profile
in `bwrap-userns-restrict`; the CI's differently named profile should not be
assumed to replace it. Investigate that interaction before changing images.

The sandbox install step now runs a synthetic namespace, `/proc`, and `/dev`
probe directly, so its stderr can be retained safely before private review
inputs exist. Full request-contract isolation, executable pinning, anonymous
snapshots, network separation, and private stderr handling remain tested.
Never replace a failing isolation test with a skip or host execution fallback.

A separate local fixture issue occurs with a group-writable shell umask:
files created as 0664 differ from Git's 0644 baseline even when their bytes
match. That invents workspace changes and can invalidate planning reviews.
Each synchronous request-contract case now uses umask 0022 and restores its
caller's value in `finally`. Production workspace mode comparisons remain
unchanged. Fixture signing keys are generated per run and validity windows
use `Date.now()`; no static certificate expiration was found.

Validation: run `pnpm test:harness-native` and
`node --test scripts/response-watch.test.mjs scripts/session-health.test.mjs`.
A hosted run after publication is required to confirm the CI image mitigation.
