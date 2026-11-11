import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { expect, it } from "vitest"

it("별도 프로세스가 rename 직후 복구한 영수증은 작성자의 부모 fsync EIO와 다음 재시도 뒤에도 유지된다", async () => {
  const allowed = os.tmpdir()
  const temporary = fs.realpathSync(os.tmpdir())
  const relative = path.relative(allowed, temporary)
  expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
  const directory = fs.mkdtempSync(path.join(temporary, "publish-commit-race-"))
  const root = path.join(directory, "workspace")
  const state = path.join(directory, "state")
  const release = path.join(directory, "release-parent-sync")
  fs.mkdirSync(path.join(root, "docs/article/assets"), { recursive: true })
  fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, "docs/article/draft.md"), "## 본문\n\n게시 승인 경쟁 시험\n![그림](assets/hero.png)\n\n---\n\n## 근거표\n시험 자료\n")
  fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"))
  fs.writeFileSync(path.join(state, "descriptors/test-post.json"), JSON.stringify({
    source: "adk", path: "article/draft.md", slug: "test-post",
    body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" },
    frontmatter: { kind: "post", slug: "test-post", title: "동시 승인 시험", summary: "시험용 요약", date: "2030-11-04T20:00+09:00", targets: ["site-a", "site-b"], languages: { "site-a": ["ko", "en"], "site-b": ["ko", "en"] }, hero: "assets/hero.png", secondary_category: "ai" },
    asset_roots: ["assets"], asset_path_map: {}, media_map: { ko: { ready: true, hero: "assets/hero.png", body_images: ["assets/hero.png"] }, en: { ready: false } },
  }))
  const keys = crypto.generateKeyPairSync("ed25519")
  const keyFile = path.join(directory, "signing.pem")
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const secret = "commit-race-test-proxy-secret"
  const actor = "test-gate:owner"
  const headers = { host: "localhost:3175", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1", "x-naia-actor-id": actor, "x-naia-actor-verified": "1" }
  const program = `
    import fs from 'node:fs';
    import path from 'node:path';
    const exists = fs.existsSync;
    const [root, release, mode, serializedInput] = process.argv.slice(1);
    const approvalParent = path.join(process.env.PUBLISH_STATE_DIR, 'approvals/test-post');
    let input, renamed = false;
    if (mode === 'writer') {
      const rename = fs.renameSync, sync = fs.fsyncSync;
      fs.renameSync = (source, destination) => {
        rename(source, destination);
        if (path.dirname(String(destination)) !== approvalParent || !path.basename(String(destination)).startsWith('rev_')) return;
        renamed = true;
        process.send({ event: 'renamed', input, pid: process.pid });
        const deadline = Date.now() + 12000;
        while (!exists(release)) {
          if (Date.now() >= deadline) throw new Error('parent sync release timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      };
      fs.fsyncSync = (fd) => {
        if (renamed && fs.readlinkSync('/proc/self/fd/' + fd) === approvalParent) {
          renamed = false;
          process.send({ event: 'sync-failed', directory: approvalParent });
          throw Object.assign(new Error('approval parent sync I/O failure'), { code: 'EIO' });
        }
        sync(fd);
      };
    }
    (await import('node:module')).syncBuiltinESMExports();
    const { createServer } = await import(${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)});
    const { hashBytes } = await import(${JSON.stringify(new URL("../src/publish-bundle.ts", import.meta.url).href)});
    const app = await createServer({ root, port: 3175, host: '127.0.0.1' });
    app.proxySecret = ${JSON.stringify(secret)};
    const headers = ${JSON.stringify(headers)};
    const post = (action, payload, key) => app.inject({ method: 'POST', url: '/api/portal/publish/test-post/' + action, headers: { ...headers, 'idempotency-key': key }, payload });
    if (mode === 'writer') {
      const response = await post('request-review', { saved_revision: hashBytes(fs.readFileSync(path.join(root, 'docs/article/draft.md'))) }, 'review-key');
      if (response.statusCode !== 201) throw new Error('review failed: ' + response.body);
      const review = response.json();
      const preview = await app.inject({ url: '/api/portal/publish/test-post/preview?' + new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id }), headers });
      if (preview.statusCode !== 200) throw new Error('preview failed: ' + preview.body);
      const view = preview.json();
      input = { review_id: review.review_id, revision_id: view.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash };
      const approval = await post('approve', input, 'approval-key');
      process.send({ event: 'failed', status: approval.statusCode, body: approval.json() });
    } else {
      input = JSON.parse(serializedInput);
      const recovered = await post('approve', input, 'approval-key');
      process.send({ event: 'recovered', status: recovered.statusCode, body: recovered.json(), pid: process.pid });
      await new Promise((resolve) => process.once('message', resolve));
      const retried = await post('approve', input, 'approval-key');
      const operation = await app.inject({ url: '/api/portal/publish/operations/' + retried.json().operation_id, headers });
      process.send({ event: 'retried', status: retried.statusCode, body: retried.json(), operationStatus: operation.statusCode, operation: operation.json() });
      await new Promise((resolve) => process.once('message', resolve));
      const sync = fs.fsyncSync;
      let failedRecoveryParent;
      fs.fsyncSync = (fd) => {
        if (fs.readlinkSync('/proc/self/fd/' + fd) === approvalParent) {
          failedRecoveryParent = approvalParent;
          throw Object.assign(new Error('recovery parent sync I/O failure'), { code: 'EIO' });
        }
        sync(fd);
      };
      const failedRecovery = await post('approve', input, 'approval-key');
      fs.fsyncSync = sync;
      process.send({ event: 'recovery-failed', status: failedRecovery.statusCode, body: failedRecovery.json(), directory: failedRecoveryParent });
      const recoveredAgain = await post('approve', input, 'approval-key');
      process.send({ event: 'recovered-again', status: recoveredAgain.statusCode, body: recoveredAgain.json() });
    }
    await app.close();
    process.disconnect();
  `
  const workers: ReturnType<typeof worker>[] = []
  function worker(mode: "writer" | "reader", input?: unknown) {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, root, release, mode, JSON.stringify(input) ?? ""], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, PUBLISH_STATE_DIR: state, XDG_RUNTIME_DIR: path.join(directory, `runtime-${mode}`), PUBLISH_GATEWAY_SCOPE: "test-gate", PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "1", PUBLISH_APPROVER_IDS: actor, PUBLISH_SIGNING_KEY_FILE: keyFile, PUBLISH_SIGNING_KEY_ID: "test-key", PUBLISH_PUBLIC_KEYS: JSON.stringify({ "test-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString() }) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    let stderr = "", failure: Error | undefined, closed = false
    const messages: any[] = []
    child.stderr!.on("data", (chunk) => { stderr += chunk })
    child.on("message", (message) => { messages.push(message) })
    child.once("error", (error) => { failure = error })
    const completed = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve() }))
    const waitFor = async (event: string) => {
      const deadline = Date.now() + 10000
      while (!messages.some((message) => message.event === event)) {
        if (failure) throw failure
        if (closed || Date.now() >= deadline) throw new Error(`${mode} worker ${event} failed (${child.exitCode}): ${stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return messages.find((message) => message.event === event)
    }
    const result = { child, messages, completed, waitFor }
    workers.push(result)
    return result
  }
  try {
    const writer = worker("writer")
    const renamed = await writer.waitFor("renamed")
    const approvalDirectory = path.join(state, "approvals/test-post", renamed.input.revision_id)
    const commitBytes = fs.readFileSync(path.join(approvalDirectory, "commit.json"))
    const commit = JSON.parse(commitBytes.toString())
    const resultCommit = path.join(state, "operations", commit.operation.operation_id, "result/commit.json")
    expect(fs.existsSync(resultCommit)).toBe(false)
    const reader = worker("reader", renamed.input)
    const recovered = await reader.waitFor("recovered")
    expect(recovered.pid).not.toBe(renamed.pid)
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200)
    expect(recovered.body.receipt).toEqual(commit.result.receipt)
    expect(writer.child.exitCode).toBeNull()
    expect(writer.messages.some((message) => message.event === "sync-failed" || message.event === "failed")).toBe(false)
    fs.writeFileSync(release, "release")
    const failed = await writer.waitFor("failed")
    expect(await writer.waitFor("sync-failed")).toMatchObject({ directory: path.dirname(approvalDirectory) })
    expect(failed).toMatchObject({ status: 503, body: { code: "PUBLISH_UNAVAILABLE", retryable: true, operation_id: commit.operation.operation_id } })
    await writer.completed
    expect(writer.child.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(approvalDirectory, "commit.json"))).toEqual(commitBytes)
    expect(fs.existsSync(resultCommit)).toBe(false)
    reader.child.send({ retry: true })
    const retried = await reader.waitFor("retried")
    expect(retried).toMatchObject({ status: 200, body: { receipt: recovered.body.receipt }, operationStatus: 200, operation: { state: "committed", result: { receipt: recovered.body.receipt } } })
    expect(retried.body.receipt).toEqual(recovered.body.receipt)
    expect(retried.operation.result.receipt).toEqual(recovered.body.receipt)
    expect(fs.readdirSync(path.dirname(approvalDirectory))).toEqual([renamed.input.revision_id])
    expect(fs.readFileSync(path.join(approvalDirectory, "commit.json"))).toEqual(commitBytes)
    reader.child.send({ failRecoverySync: true })
    const failedRecovery = await reader.waitFor("recovery-failed")
    expect(failedRecovery).toMatchObject({ status: 503, body: { code: "PUBLISH_UNAVAILABLE", retryable: true }, directory: path.dirname(approvalDirectory) })
    const recoveredAgain = await reader.waitFor("recovered-again")
    expect(recoveredAgain.status).toBe(200)
    expect(recoveredAgain.body.receipt).toEqual(recovered.body.receipt)
    expect(fs.readFileSync(path.join(approvalDirectory, "commit.json"))).toEqual(commitBytes)
    expect(fs.existsSync(resultCommit)).toBe(false)
    await reader.completed
    expect(reader.child.exitCode).toBe(0)
  } finally {
    fs.writeFileSync(release, "release")
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await Promise.all(workers.map(({ completed }) => completed))
  }
}, 20000)
