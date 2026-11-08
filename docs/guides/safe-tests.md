# Safe local tests

`npm test` runs the existing workspace package suites and standalone workspace tests, then the hook inventory. Both stages initialize `scripts/test-signal-safety.cjs`; either stage failing produces a nonzero exit status. `npm run test:workspace` and `npm run test:hooks` select those stages independently.

Every hook test entrypoint loads the same guard. Vitest package configurations use the threads pool and a setup module that loads the guard inside each worker. Node test commands use `--experimental-test-isolation=none`; an unprotected coordinator is refused before it starts internal workers. Guarded child Node test invocations receive that option automatically. Application arguments to other programs and `fork()` remain unchanged.

The guard blocks process signals, child process signals, signal shell commands, and copies of the forbidden real-process supervisor test. Native subprocess timeout and kill-signal options are removed before spawning; timeout behavior should be tested by injecting a fake subprocess boundary. Capture buffers are unlimited so output overflow cannot terminate a child. The supervisor wrapper test is excluded from the hook inventory and refuses direct startup.

The guard removes only its own exact preload after loading, so approval tools retain their rejection of arbitrary preload injection. Every spawned Node descendant receives the guard again. Use temporary roots for fixtures and preserve the inventory JSON summary when comparing failure names.
