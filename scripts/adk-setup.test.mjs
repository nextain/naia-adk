import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { runSetup, extractRepoName, parseArgs } from "./adk-setup.mjs"

describe("adk-setup (scripts/adk-setup.mjs)", () => {
  let tempBase
  let bareCompanyPath
  let bareHubPath

  before(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "adk-setup-test-"))

    // 1. remote-hub.git (bare 저장소) 생성
    bareHubPath = path.join(tempBase, "remote-hub.git")
    execFileSync("git", ["init", "--bare", bareHubPath], { stdio: "ignore" })
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bareHubPath })

    const hubInitDir = path.join(tempBase, "hub-init")
    fs.mkdirSync(hubInitDir, { recursive: true })
    execFileSync("git", ["init", "-b", "main"], { cwd: hubInitDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: hubInitDir })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: hubInitDir })
    fs.mkdirSync(path.join(hubInitDir, "docs"), { recursive: true })
    fs.writeFileSync(path.join(hubInitDir, "docs", "readme.md"), "# Hub Repo Readme")
    execFileSync("git", ["add", "."], { cwd: hubInitDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init hub"], { cwd: hubInitDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", `file://${bareHubPath}`], { cwd: hubInitDir })
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: hubInitDir, stdio: "ignore" })

    // 2. remote-company.git (bare 저장소) 생성
    bareCompanyPath = path.join(tempBase, "remote-company.git")
    execFileSync("git", ["init", "--bare", bareCompanyPath], { stdio: "ignore" })
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bareCompanyPath })

    const companyInitDir = path.join(tempBase, "company-init")
    fs.mkdirSync(companyInitDir, { recursive: true })
    execFileSync("git", ["init", "-b", "main"], { cwd: companyInitDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: companyInitDir })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: companyInitDir })

    const companyConfig = {
      schemaVersion: 1,
      title: "테스트 회사 문서",
      docs: { include: ["docs"] },
      repos: [
        {
          id: "hub",
          path: "projects/hub",
          remote: `file://${bareHubPath}`,
          docs: { title: "허브", include: ["docs"] },
        },
      ],
    }
    fs.writeFileSync(
      path.join(companyInitDir, "adk-company.json"),
      JSON.stringify(companyConfig, null, 2),
    )
    execFileSync("git", ["add", "."], { cwd: companyInitDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init company"], { cwd: companyInitDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", `file://${bareCompanyPath}`], { cwd: companyInitDir })
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: companyInitDir, stdio: "ignore" })
  })

  after(() => {
    try {
      fs.rmSync(tempBase, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it("회사 주소에서 나온 폴더 이름이 안전하지 않으면 받지 않는다", () => {
    const fakeAdk = fs.mkdtempSync(path.join(os.tmpdir(), "adk-unsafe-name-"))
    try {
      for (const company of ["https://example.invalid/org/..", "https://example.invalid/org/bad name.git", "--upload-pack=touch-x"]) {
        const summary = runSetup({ company, dryRun: true }, fakeAdk)
        assert.equal(summary.received.length, 0, company)
        assert.ok(summary.errors.length > 0, company)
      }
    } finally {
      fs.rmSync(fakeAdk, { recursive: true, force: true })
    }
  })

  it("extractRepoName: git URL에서 저장소 이름을 올바르게 추출", () => {
    assert.equal(extractRepoName("https://github.com/example/company-docs.git"), "company-docs")
    assert.equal(extractRepoName("https://github.com/example/company-docs"), "company-docs")
    assert.equal(extractRepoName("git@github.com:example/co.git"), "co")
    assert.equal(extractRepoName("file:///path/to/my-repo.git"), "my-repo")
  })

  it("parseArgs: CLI 인자를 올바르게 파싱", () => {
    const args1 = parseArgs(["--company", "https://example.com/repo.git", "--pull"])
    assert.equal(args1.company, "https://example.com/repo.git")
    assert.equal(args1.pull, true)
    assert.equal(args1.dryRun, false)

    const args2 = parseArgs(["--company=git@github.com:test.git", "--dry-run"])
    assert.equal(args2.company, "git@github.com:test.git")
    assert.equal(args2.dryRun, true)
  })

  it("--company clone 및 adk-company.json repos clone", () => {
    const fakeAdk = path.join(tempBase, "adk-test-1")
    fs.mkdirSync(fakeAdk, { recursive: true })

    const summary = runSetup({ company: `file://${bareCompanyPath}` }, fakeAdk)

    // 회사 문서 저장소 clone 확인
    const companyJson = path.join(fakeAdk, "data-company", "remote-company", "adk-company.json")
    assert.ok(fs.existsSync(companyJson), "data-company/remote-company/adk-company.json이 존재해야 합니다.")

    // repos의 projects/hub clone 확인
    const hubReadme = path.join(fakeAdk, "projects", "hub", "docs", "readme.md")
    assert.ok(fs.existsSync(hubReadme), "projects/hub/docs/readme.md가 clone되어야 합니다.")

    assert.ok(summary.received.length >= 2, "회사 저장소와 repo가 수신되어야 합니다.")
    assert.equal(summary.errors.length, 0, "오류가 없어야 합니다.")
  })

  it("이미 있는 경로는 절대 지우거나 덮지 않고 건너뜀", () => {
    const fakeAdk = path.join(tempBase, "adk-test-2")
    fs.mkdirSync(fakeAdk, { recursive: true })

    // 첫 실행
    runSetup({ company: `file://${bareCompanyPath}` }, fakeAdk)

    // 기존 hub 파일에 사용자 변경 추가
    const hubReadme = path.join(fakeAdk, "projects", "hub", "docs", "readme.md")
    fs.writeFileSync(hubReadme, "# 로컬에서 변경된 내용")

    // 두 번째 실행
    const summary2 = runSetup({ company: `file://${bareCompanyPath}` }, fakeAdk)

    // 건너뛰었는지 확인
    assert.ok(summary2.skipped.some((s) => s.target.includes("remote-company")), "회사 저장소는 건너뛰어야 합니다.")
    assert.ok(summary2.skipped.some((s) => s.target.includes("projects/hub")), "hub 저장소는 건너뛰어야 합니다.")

    // 로컬 파일 내용이 보존되었는지 확인 (덮어쓰지 않음)
    assert.equal(fs.readFileSync(hubReadme, "utf-8"), "# 로컬에서 변경된 내용")
  })

  it("--dry-run은 아무 파일도 만들지 않음", () => {
    const fakeAdk = path.join(tempBase, "adk-test-dry")
    fs.mkdirSync(fakeAdk, { recursive: true })

    const summary = runSetup({ company: `file://${bareCompanyPath}`, dryRun: true }, fakeAdk)

    assert.ok(!fs.existsSync(path.join(fakeAdk, "data-company")), "data-company 폴더가 생성되지 않아야 합니다.")
    assert.ok(!fs.existsSync(path.join(fakeAdk, "projects")), "projects 폴더가 생성되지 않아야 합니다.")
    assert.ok(summary.received.every((r) => r.startsWith("[dry-run]")), "모든 수신 항목이 [dry-run]으로 표시되어야 합니다.")
  })

  it("잘못된 목록 파일 형식 거부 (절대경로, .. 등)", () => {
    const fakeAdk = path.join(tempBase, "adk-test-bad")
    const badCompanyDir = path.join(fakeAdk, "data-company", "bad-co")
    fs.mkdirSync(badCompanyDir, { recursive: true })

    // 절대경로가 포함된 잘못된 adk-company.json
    const badConfig = {
      schemaVersion: 1,
      title: "잘못된 설정",
      repos: [
        {
          id: "escape",
          path: "/tmp/outside-danger",
          remote: "https://example.com/escape.git",
        },
      ],
    }
    fs.writeFileSync(path.join(badCompanyDir, "adk-company.json"), JSON.stringify(badConfig, null, 2))

    const summary = runSetup({}, fakeAdk)
    assert.ok(summary.errors.length > 0, "형식 오류가 기록되어야 합니다.")
    assert.ok(summary.errors[0].includes("must be under projects/ or data-company/"))
    assert.ok(!fs.existsSync(path.join(fakeAdk, "projects", "escape")), "잘못된 저장소는 clone되지 않아야 합니다.")
  })

  it("--pull은 작업 트리가 깨끗할 때만 실행하고, 더러운 트리는 건너뜀", () => {
    const fakeAdk = path.join(tempBase, "adk-test-pull")
    fs.mkdirSync(fakeAdk, { recursive: true })

    // 초기 setup
    runSetup({ company: `file://${bareCompanyPath}` }, fakeAdk)

    // hub 저장소에 로컬 변경(더러운 작업 트리) 만들기
    const hubDir = path.join(fakeAdk, "projects", "hub")
    fs.writeFileSync(path.join(hubDir, "dirty.txt"), "더러운 파일")

    // --pull 실행
    const summary = runSetup({ pull: true }, fakeAdk)

    // hub는 더러우므로 건너뛰어야 함
    assert.ok(
      summary.skipped.some((s) => s.target.includes("projects/hub") && s.reason.includes("고치던 파일")),
      "더러운 hub 트리는 pull을 건너뛰어야 합니다.",
    )
  })
  it("--pull 요약에 같은 저장소가 두 번 나오지 않음(받음과 건너뜀에 동시에 나오지 않음)", () => {
    const fakeAdk = path.join(tempBase, "adk-test-pull-once")
    fs.mkdirSync(fakeAdk, { recursive: true })
    runSetup({ company: `file://${bareCompanyPath}` }, fakeAdk)

    // 회사 주소를 다시 주면서 --pull 해도 같은 결과여야 한다.
    for (const options of [{ pull: true }, { company: `file://${bareCompanyPath}`, pull: true }]) {
      const summary = runSetup(options, fakeAdk)
      assert.equal(summary.errors.length, 0, JSON.stringify(summary.errors))
      const names = [
        ...summary.received.map((r) => r.replace(/^최신으로 받음: /, "")),
        ...summary.skipped.map((s) => s.target),
      ]
      assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], `두 번 나온 항목: ${names.join(", ")}`)
      assert.ok(summary.received.includes("최신으로 받음: projects/hub"), summary.received.join(", "))
      assert.ok(summary.received.includes("최신으로 받음: data-company/remote-company"), summary.received.join(", "))
      assert.ok(!summary.skipped.some((s) => s.target === "projects/hub"), "깨끗한 hub는 건너뜀에 나오면 안 됩니다.")
    }
  })
})
