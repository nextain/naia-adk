import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const allowedTemporary = path.resolve(os.tmpdir())
const sourceModules = new URL("../src/", import.meta.url).href

// 동기 open이 멈추는 회귀도 시험 실행기를 멈추지 않도록 별도 프로세스에서 실행한다.
function watchedWorker(script: string): Promise<any[]> {
  const relative = path.relative(allowedTemporary, fs.realpathSync(os.tmpdir()))
  expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, sourceModules], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
    let stderr = "", point = "별도 프로세스 준비"
    const results: any[] = []
    let timer: ReturnType<typeof setTimeout>
    const arm = (milliseconds: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${point}: 응답 시간 초과`)) }, milliseconds)
    }
    arm(10_000)
    child.stderr!.on("data", chunk => { stderr += chunk })
    child.on("message", (message: any) => {
      if (message.start) { point = message.start; arm(5000) }
      if (message.result) { results.push(message.result); point = "다음 시나리오 준비"; arm(10_000) }
    })
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("exit", code => {
      clearTimeout(timer)
      if (code === 0) resolve(results)
      else reject(new Error(`${point}: 별도 프로세스 실패 (${code}): ${stderr}`))
    })
  })
}

const workerImports = `
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import assert from 'node:assert/strict';
  import { spawnSync } from 'node:child_process';
  const modules = process.argv[1];
  const { openRegularFile, readRegularFile } = await import(new URL('publish-files.ts', modules));
  function fifo(file) {
    const result = spawnSync('mkfifo', [file], { timeout: 1000 });
    assert.equal(result.status, 0, String(result.stderr));
  }
`

describe("게시 파일의 비차단 읽기", () => {
  it("FIFO·장치·소켓은 열기 전에 거절하고, 열기·읽기 중 교체도 거절하며 설명자를 닫는다", async () => {
    const results = await watchedWorker(workerImports + `
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-file-types-'));
      const pipe = path.join(directory, 'pipe');
      const socket = path.join(directory, 'socket');
      const linkedPipe = path.join(directory, 'linked-pipe');
      fifo(pipe);
      fs.symlinkSync(pipe, linkedPipe);
      // 연결 대기 없이도 실제 소켓 inode를 만들어 일반 파일 판정을 검사한다.
      const madeSocket = spawnSync('python3', ['-c', 'import os,stat,sys; os.mknod(sys.argv[1],stat.S_IFSOCK|0o600)', socket], { timeout: 1000 });
      assert.equal(madeSocket.status, 0, String(madeSocket.stderr));
      assert.equal(fs.lstatSync(socket).isSocket(), true);
      const open = fs.openSync;
      for (const [name, target, code] of [['FIFO', pipe, 'EISDIR'], ['FIFO 링크', linkedPipe, 'ELOOP'], ['소켓', socket, 'EISDIR'], ['장치', '/dev/null', 'EISDIR']]) {
        process.send({ start: name });
        let opened = false;
        fs.openSync = (...args) => { if (args[0] === target) opened = true; return open(...args) };
        try { assert.throws(() => readRegularFile(target), { code }); assert.equal(opened, false) } finally { fs.openSync = open }
        process.send({ result: { name, rejectedBeforeOpen: !opened } });
      }
      for (const replacement of ['FIFO', 'FIFO 링크', '다른 일반 파일']) {
        const target = path.join(directory, 'race-' + replacement);
        fs.writeFileSync(target, 'original');
        let openedFd;
        let swapped = false;
        process.send({ start: '열기 직전 ' + replacement });
        fs.openSync = (...args) => {
          if (!swapped && args[0] === target) {
            swapped = true;
            fs.renameSync(target, target + '.original');
            if (replacement === 'FIFO') fifo(target);
            else if (replacement === 'FIFO 링크') fs.symlinkSync(pipe, target);
            else fs.writeFileSync(target, 'different');
            openedFd = open(...args);
            return openedFd;
          }
          return open(...args);
        };
        try { assert.throws(() => openRegularFile(target), { code: replacement === 'FIFO' ? 'EISDIR' : replacement === 'FIFO 링크' ? 'ELOOP' : 'ESTALE' }) }
        finally { fs.openSync = open }
        if (openedFd !== undefined) assert.throws(() => fs.fstatSync(openedFd), { code: 'EBADF' });
        process.send({ result: { name: replacement, rejectedRace: true, descriptorClosed: true } });
      }
      const target = path.join(directory, 'read-race');
      fs.writeFileSync(target, 'original');
      const read = fs.readSync;
      let readFd;
      process.send({ start: '읽은 직후 FIFO 교체' });
      fs.readSync = (...args) => {
        const count = read(...args);
        if (readFd === undefined) { readFd = args[0]; fs.renameSync(target, target + '.original'); fifo(target) }
        return count;
      };
      try { assert.throws(() => readRegularFile(target), { code: 'ESTALE' }) } finally { fs.readSync = read }
      assert.throws(() => fs.fstatSync(readFd), { code: 'EBADF' });
      process.send({ result: { name: '읽기 중 FIFO', rejectedRace: true, descriptorClosed: true } });
      const { resolveSecureFile } = await import(new URL('routes/portal.ts', modules));
      const source = { id: 'adk', title: '시험', baseDir: directory, allowedPrefixes: null, readOnly: false };
      const plain = path.join(directory, 'plain.md');
      fs.writeFileSync(plain, 'plain');
      fs.symlinkSync(plain, path.join(directory, 'plain-link.md'));
      process.send({ start: '일반 문서 링크와 게시 문서 링크 구분' });
      assert.equal('error' in resolveSecureFile(source, 'plain-link.md'), false);
      assert.deepEqual(resolveSecureFile(source, 'plain-link.md', { rejectLinks: true }), { error: 'not_found', reason: 'not_file' });
      process.send({ result: { name: '일반 문서 링크 정책', linksPreserved: true } });
      for (const replacement of ['FIFO 링크', '다른 일반 파일']) {
        const target = path.join(directory, 'strict-race-' + replacement + '.md');
        fs.writeFileSync(target, 'original');
        let swapped = false;
        process.send({ start: '게시 경로 검사 직후 ' + replacement });
        fs.openSync = (...args) => {
          if (!swapped && args[0] === target) {
            swapped = true;
            fs.renameSync(target, target + '.original');
            if (replacement === 'FIFO 링크') fs.symlinkSync(pipe, target);
            else fs.writeFileSync(target, 'different');
          }
          return open(...args);
        };
        try { assert.deepEqual(resolveSecureFile(source, path.basename(target), { rejectLinks: true }), { error: 'not_found', reason: 'not_file' }) }
        finally { fs.openSync = open }
        assert.equal(swapped, true);
        process.send({ result: { name: replacement, strictRaceClassified: true } });
      }
      process.disconnect();
    `)
    expect(results).toHaveLength(11)
    expect(results.slice(0, 4).every(result => result.rejectedBeforeOpen)).toBe(true)
    expect(results.slice(4, 8).every(result => result.rejectedRace && result.descriptorClosed)).toBe(true)
    expect(results[8].linksPreserved).toBe(true)
    expect(results.slice(9).every(result => result.strictRaceClassified)).toBe(true)
  })

  it("원고·그림의 FIFO와 FIFO 링크를 최초 422·대기판 409·승인 뒤 변경 상태로 처리하고 매 요청 뒤 잠금을 푼다", async () => {
    const results = await watchedWorker(workerImports + `
      const crypto = await import('node:crypto');
      const { createServer } = await import(new URL('server.ts', modules));
      const { hashBytes } = await import(new URL('publish-bundle.ts', modules));
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
      const actor = 'test-gate:owner';
      const secret = 'special-file-test-proxy-secret';
      const headers = { host: 'localhost:3175', 'x-naia-proxy-secret': secret, 'x-naia-peer': '127.0.0.1', 'x-naia-local': '1', 'x-naia-origin-ok': '1', 'x-naia-actor-id': actor, 'x-naia-actor-verified': '1' };
      let activeDirectory;
      for (const stage of ['최초', '대기판', '승인 뒤']) for (const kind of ['원고', '그림']) for (const linked of [false, true]) {
        const scenario = [stage, kind, linked ? 'FIFO 링크' : 'FIFO'].join(' ');
        process.send({ start: scenario + ' 준비' });
        activeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-special-'));
        const root = path.join(activeDirectory, 'workspace');
        const state = path.join(activeDirectory, 'state');
        fs.mkdirSync(path.join(root, 'docs/article/assets'), { recursive: true });
        fs.mkdirSync(path.join(state, 'descriptors'), { recursive: true, mode: 0o700 });
        const document = path.join(root, 'docs/article/draft.md');
        const image = path.join(root, 'docs/article/assets/hero.png');
        const content = Buffer.from('## 본문\\n\\n![그림](assets/hero.png)\\n\\n---\\n\\n## 근거표\\n비공개\\n');
        fs.writeFileSync(document, content);
        fs.writeFileSync(image, png);
        const descriptor = { source: 'adk', path: 'article/draft.md', slug: 'test-post', body_selector: { start_heading: '## 본문', end_heading: '## 근거표', separator: '---' }, frontmatter: { kind: 'post', slug: 'test-post', title: '특수파일 시험', summary: '시험 요약', date: '2030-11-04T20:00+09:00', targets: ['site-a'], languages: { 'site-a': ['ko'] }, hero: 'assets/hero.png' }, asset_roots: ['assets'], asset_path_map: {}, media_map: { ko: { ready: true, hero: 'assets/hero.png', body_images: ['assets/hero.png'] } } };
        fs.writeFileSync(path.join(state, 'descriptors/test-post.json'), JSON.stringify(descriptor));
        const keys = crypto.generateKeyPairSync('ed25519');
        const signingFile = path.join(activeDirectory, 'signing.pem');
        fs.writeFileSync(signingFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
        Object.assign(process.env, { PUBLISH_STATE_DIR: state, XDG_RUNTIME_DIR: path.join(activeDirectory, 'runtime'), PUBLISH_GATEWAY_SCOPE: 'test-gate', PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: '1', PUBLISH_APPROVER_IDS: actor, PUBLISH_SIGNING_KEY_FILE: signingFile, PUBLISH_SIGNING_KEY_ID: 'test-key', PUBLISH_PUBLIC_KEYS: JSON.stringify({ 'test-key': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) });
        const app = await createServer({ root, port: 3175, host: '127.0.0.1' });
        app.proxySecret = secret;
        const base = '/api/portal/publish/test-post/';
        const inject = (suffix, payload, key) => app.inject({ method: payload ? 'POST' : 'GET', url: base + suffix, headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
        let review, view, receipt;
        if (stage !== '최초') {
          const response = await inject('request-review', { saved_revision: hashBytes(content) }, 'prepare');
          assert.equal(response.statusCode, 201, response.body);
          review = response.json();
          const preview = await inject('preview?' + new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id }));
          assert.equal(preview.statusCode, 200, preview.body);
          view = preview.json();
          if (stage === '승인 뒤') {
            const approved = await inject('approve', { review_id: review.review_id, revision_id: review.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash }, 'prepare-approval');
            assert.equal(approved.statusCode, 201, approved.body);
            receipt = approved.json().receipt;
          }
        }
        const target = kind === '원고' ? document : image;
        const original = path.join(activeDirectory, 'original');
        fs.renameSync(target, original);
        if (linked) { const pipe = path.join(root, 'docs/article/pipe'); fifo(pipe); fs.symlinkSync(pipe, target) }
        else fifo(target);
        const actions = [['status', undefined, undefined, stage === '승인 뒤' ? 200 : 422]];
        if (stage === '최초') actions.push(['request-review', { saved_revision: hashBytes(content) }, 'bad-review', 422]);
        else {
          actions.push(['preview?' + new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id }), undefined, undefined, 409]);
          actions.push(['approve', { review_id: review.review_id, revision_id: review.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash }, 'changed-approval', 409]);
        }
        const checks = [];
        for (const [action, payload, key, expected] of actions) {
          process.send({ start: scenario + ' ' + action });
          const started = performance.now();
          const response = await inject(action, payload, key);
          const elapsed = performance.now() - started;
          assert.equal(response.statusCode, expected, response.body);
          assert(elapsed < 5000);
          if (expected === 409) assert.equal(response.json().code, 'PREVIEW_CHANGED');
          if (stage === '승인 뒤' && action === 'status') {
            assert.equal(response.json().state, 'changed_after_approval');
            assert.equal(response.json().changed_after_approval, true);
            assert.deepEqual(response.json().receipt, receipt);
          }
          const lock = spawnSync('flock', ['--exclusive', '--nonblock', path.join(state, 'locks/bundle.lock'), 'true'], { timeout: 1000 });
          assert.equal(lock.status, 0, '게시 잠금이 남았습니다');
          checks.push({ action, status: response.statusCode, elapsed, lockReleased: true });
        }
        // 원래 이름으로 복구하면 같은 서버가 즉시 정상 자료를 다시 읽는다.
        fs.renameSync(target, path.join(activeDirectory, 'rejected'));
        fs.renameSync(original, target);
        process.send({ start: scenario + ' 회복' });
        const recovered = await inject('status');
        assert.equal(recovered.statusCode, 200, recovered.body);
        assert.equal(recovered.json().state, stage === '승인 뒤' ? 'approved_waiting_export' : stage === '대기판' ? 'pending_review' : 'draft');
        await app.close();
        process.send({ result: { scenario, checks, recovered: true } });
      }
      process.disconnect();
    `)
    expect(results).toHaveLength(12)
    for (const result of results) {
      expect(result.checks.length, result.scenario).toBeGreaterThanOrEqual(2)
      expect(result.checks.every((check: any) => check.elapsed < 5000 && check.lockReleased), result.scenario).toBe(true)
      expect(result.recovered, result.scenario).toBe(true)
    }
  }, 60_000)
})
