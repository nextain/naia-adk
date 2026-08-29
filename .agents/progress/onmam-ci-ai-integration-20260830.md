# Onmam CI AI integration context sync — 2026-08-30

The canonical implementation is maintained in the standalone new Onmam CI
worktree. Current contracts include provider-neutral draft generation,
OpenCode headless and Azure AI Foundry adapters, durable revision persistence,
restart-safe idempotency replay, and an explicit 500-revision mutation guard.

Azure review uses the registered model `azure-foundry/deepseek-v4-pro`.
Use OpenCode file attachments (`-f`) for bounded adversarial reviews; broad
tool-driven prompts may time out even though a minimal Azure model probe is
healthy. Full local typecheck, 292 tests, and production build are passing.

The remaining gate is two consecutive independent Azure DeepSeek V4 Pro
`CLEAN` review receipts.
