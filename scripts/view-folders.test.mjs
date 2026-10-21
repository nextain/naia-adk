import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  addViewFolder,
  validateFolder,
  resolveContext,
  getSecretDir,
  readConfigFile,
  writeConfigFile,
} from "./view-folders.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.resolve(__dirname, "view-folders.mjs")

describe("view-folders.mjs 도구 시험 (W1c-2 규격)", () => {
  let testRoot
  let fakeHome
  let fakeWs
  let fakeTmp
  let fakeXdg
  let fakeSecretDir
  let customContext

  before(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "view-folders-test-"))
    fakeHome = path.join(testRoot, "home")
    fakeWs = path.join(testRoot, "ws")
    fakeTmp = path.join(testRoot, "tmp")
    fakeXdg = path.join(testRoot, "xdg")
    fakeSecretDir = path.join(fakeXdg, "naia-adk")

    fs.mkdirSync(fakeHome, { recursive: true })
    fs.mkdirSync(fakeWs, { recursive: true })
    fs.mkdirSync(fakeTmp, { recursive: true })
    fs.mkdirSync(fakeXdg, { recursive: true })
    fs.mkdirSync(fakeSecretDir, { recursive: true })

    customContext = {
      homeDir: fakeHome,
      workspaceRoot: fakeWs,
      tmpDir: fakeTmp,
      xdgRuntimeDir: fakeXdg,
      secretDir: fakeSecretDir,
    }
  })

  after(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true })
    } catch {}
  })

  function runScript(args, extraEnv = {}) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: fakeXdg,
        ...extraEnv,
      },
    })
  }

  describe("1. 명령행 자체 시험 (--root 임시 폴더로 list · add · remove 동작)", () => {
    it("list · add · remove 기본 흐름 확인", () => {
      // 1) 초기 list: 등록된 데이터 폴더 없음
      const resInit = runScript(["list", "--root", fakeWs])
      assert.equal(resInit.status, 0)
      assert.ok(resInit.stdout.includes("등록된 데이터 폴더 없음"))

      // 2) 실제 등록 가능한 경로 준비 (.naia-view가 있는 임시 폴더)
      const allowedDir = path.join(testRoot, "cli-demo-folder")
      fs.mkdirSync(allowedDir, { recursive: true })
      fs.writeFileSync(path.join(allowedDir, ".naia-view"), "")
      fs.writeFileSync(path.join(allowedDir, "file1.txt"), "hello")

      // 3) add 실행
      const resAdd = runScript([
        "add",
        "--id", "cli-demo",
        "--label", "CLI 데모",
        "--path", allowedDir,
        "--tab", "brand",
        "--root", fakeWs,
      ])
      assert.equal(resAdd.status, 0)
      assert.ok(resAdd.stdout.includes("첫 단계 항목"))
      assert.ok(resAdd.stdout.includes("file1.txt"))
      assert.ok(resAdd.stdout.includes("추가 완료: cli-demo"))

      // 4) list로 확인
      const resList = runScript(["list", "--root", fakeWs])
      assert.equal(resList.status, 0)
      assert.ok(resList.stdout.includes('cli-demo: "CLI 데모"'))
      assert.ok(resList.stdout.includes("[brand]"))

      // 5) remove 실행
      const resRemove = runScript(["remove", "--id", "cli-demo", "--root", fakeWs])
      assert.equal(resRemove.status, 0)
      assert.ok(resRemove.stdout.includes("삭제 완료: cli-demo"))

      // 6) remove 후 list 확인
      const resListAfter = runScript(["list", "--root", fakeWs])
      assert.equal(resListAfter.status, 0)
      assert.ok(resListAfter.stdout.includes("등록된 데이터 폴더 없음"))
    })
  })

  describe("2. 인자 주입 함수 시험 (addViewFolder / validateFolder)", () => {
    it("정상 추가: config에 저장되고 첫 단계 실경로 반환", () => {
      const dataDir = path.join(fakeHome, "valid-data")
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(path.join(dataDir, "item1.txt"), "sample")

      const result = addViewFolder(
        fakeWs,
        { id: "my-valid", label: "정상 폴더", path: "~/valid-data", tab: "brand" },
        customContext,
      )
      assert.equal(result.id, "my-valid")
      assert.equal(result.tab, "brand")

      const config = readConfigFile(fakeWs)
      const found = config.folders.find((f) => f.id === "my-valid")
      assert.ok(found)
      assert.equal(found.label, "정상 폴더")
    })

    it("중복 id 추가 거절", () => {
      assert.throws(() => {
        addViewFolder(
          fakeWs,
          { id: "my-valid", label: "중복 시도", path: "~/valid-data" },
          customContext,
        )
      }, /이미 등록된 id입니다/)
    })

    it("없는 폴더 추가 거절 (파일에 쓰지 않음)", () => {
      const configBefore = readConfigFile(fakeWs)
      assert.throws(() => {
        addViewFolder(
          fakeWs,
          { id: "ghost", label: "없는 폴더", path: "~/non-existent-dir" },
          customContext,
        )
      }, /등록 거절/)

      const configAfter = readConfigFile(fakeWs)
      assert.equal(configAfter.folders.length, configBefore.folders.length)
      assert.ok(!configAfter.folders.some((f) => f.id === "ghost"))
    })

    it("실재하지만 파일인 경로 거절 (파일에 쓰지 않음)", () => {
      const filePath = path.join(fakeHome, "a-regular-file.txt")
      fs.writeFileSync(filePath, "not a directory")

      const val = validateFolder(filePath, resolveContext(fakeWs, customContext))
      assert.equal(val.ok, false)
      assert.equal(val.status, "forbidden")
      assert.ok(val.error.includes("디렉토리가 아닙니다"))

      assert.throws(() => {
        addViewFolder(
          fakeWs,
          { id: "file-item", label: "파일 경로", path: filePath },
          customContext,
        )
      }, /디렉토리가 아닙니다/)
    })

    it("금지 경로 1 (홈 자신 및 루트) 거절", () => {
      const ctx = resolveContext(fakeWs, customContext)
      const rHome = validateFolder("~", ctx)
      assert.equal(rHome.ok, false)
      assert.equal(rHome.status, "forbidden")

      const rRoot = validateFolder("/", ctx)
      assert.equal(rRoot.ok, false)
      assert.equal(rRoot.status, "forbidden")
    })

    it("금지 경로 2: 표시 파일 없는 숨김 폴더 거절, 표시 파일 있으면 허용", () => {
      const ctx = resolveContext(fakeWs, customContext)
      const hiddenDir = path.join(fakeHome, ".local", "share", "app")
      fs.mkdirSync(hiddenDir, { recursive: true })

      // .naia-view 없음 -> 거절
      const rNoView = validateFolder("~/.local/share/app", ctx)
      assert.equal(rNoView.ok, false)
      assert.equal(rNoView.status, "forbidden")

      // .naia-view 있음 -> 허용
      fs.writeFileSync(path.join(hiddenDir, ".naia-view"), "")
      const rWithView = validateFolder("~/.local/share/app", ctx)
      assert.equal(rWithView.ok, true)
      assert.equal(rWithView.status, "ok")
    })

    it("금지 경로 3: data-private 세그먼트 거절 (.naia-view 있어도 거절)", () => {
      const ctx = resolveContext(fakeWs, customContext)
      const privDir = path.join(fakeHome, "data-private", "secret")
      fs.mkdirSync(privDir, { recursive: true })
      fs.writeFileSync(path.join(privDir, ".naia-view"), "")

      const rPriv = validateFolder("~/data-private/secret", ctx)
      assert.equal(rPriv.ok, false)
      assert.equal(rPriv.status, "forbidden")
    })

    it("Windows 숨김·시스템 속성 사례: 잎/조상 속성 및 .naia-view 유무에 따른 판정", () => {
      const leafHiddenDir = path.join(fakeHome, "docs", "leaf-hidden")
      const leafSystemDir = path.join(fakeHome, "docs", "leaf-system")
      const ancestorDir = path.join(fakeHome, "ancestor-hidden")
      const childDir = path.join(ancestorDir, "child")
      const normalNoAttrDir = path.join(fakeHome, "docs", "normal-no-attr")
      const attrWithViewDir = path.join(fakeHome, "docs", "attr-with-view")

      fs.mkdirSync(leafHiddenDir, { recursive: true })
      fs.mkdirSync(leafSystemDir, { recursive: true })
      fs.mkdirSync(childDir, { recursive: true })
      fs.mkdirSync(normalNoAttrDir, { recursive: true })
      fs.mkdirSync(attrWithViewDir, { recursive: true })
      fs.writeFileSync(path.join(attrWithViewDir, ".naia-view"), "")

      const attrCtx = resolveContext(fakeWs, {
        ...customContext,
        pathAttributes: {
          [path.resolve(leafHiddenDir)]: { hidden: true },
          [path.resolve(leafSystemDir)]: { system: true },
          [path.resolve(ancestorDir)]: { hidden: true },
          [path.resolve(attrWithViewDir)]: { hidden: true, system: true },
        },
      })

      // 잎만 숨김 -> 거절
      const rLeafHidden = validateFolder(leafHiddenDir, attrCtx)
      assert.equal(rLeafHidden.ok, false)
      assert.equal(rLeafHidden.status, "forbidden")

      // 잎만 시스템 -> 거절
      const rLeafSystem = validateFolder(leafSystemDir, attrCtx)
      assert.equal(rLeafSystem.ok, false)
      assert.equal(rLeafSystem.status, "forbidden")

      // 조상만 숨김 -> 거절
      const rAncestorHidden = validateFolder(childDir, attrCtx)
      assert.equal(rAncestorHidden.ok, false)
      assert.equal(rAncestorHidden.status, "forbidden")

      // 비트 없음 -> 허용
      const rNormal = validateFolder(normalNoAttrDir, attrCtx)
      assert.equal(rNormal.ok, true)
      assert.equal(rNormal.status, "ok")

      // 비트 있음 + 표시 파일 -> 허용
      const rWithView = validateFolder(attrWithViewDir, attrCtx)
      assert.equal(rWithView.ok, true)
      assert.equal(rWithView.status, "ok")
    })
  })

  describe("3. 환경 변수 무영향 시험 (결함 1)", () => {
    it("NAIA_TEST_HOME=/ 등 환경 변수를 바꿔도 인자 없는 문맥 함수는 os.homedir() 고정 및 /etc 거절", () => {
      const origEnv = { ...process.env }
      try {
        process.env.NAIA_TEST_HOME = "/"
        process.env.NAIA_TEST_TMP = "/"
        process.env.NAIA_TEST_SECRET_DIR = "/"

        const noArgCtx = resolveContext(fakeWs)
        assert.equal(noArgCtx.homeDir, os.homedir())
        assert.equal(noArgCtx.tmpDir, os.tmpdir())
        assert.equal(noArgCtx.secretDir, getSecretDir())
        assert.equal(noArgCtx.xdgRuntimeDir, process.env.XDG_RUNTIME_DIR)

        // 이 상태에서 /etc 등록은 거절됨
        const rEtc = validateFolder("/etc", noArgCtx)
        assert.equal(rEtc.ok, false)
        assert.equal(rEtc.status, "forbidden")
      } finally {
        process.env = origEnv
      }
    })
  })

  describe("4. 원자적 쓰기 순서 및 rename 실패 시 원본 보존 시험 (결함 5-(나))", () => {
    it("writeConfigFile: 임시 파일에 쓴 뒤에만 rename을 호출하고, rename 실패 시 원본 바이트 보존", () => {
      const initialData = {
        schemaVersion: 1,
        folders: [{ id: "orig", label: "Original", path: "~/orig" }],
      }
      writeConfigFile(fakeWs, initialData)

      const targetPath = path.join(fakeWs, ".agents", "work", "view-folders.json")
      const origBytes = fs.readFileSync(targetPath)

      let writeCalledBeforeRename = false
      let renameTargetCorrect = false

      const origWriteFileSync = fs.writeFileSync
      const origRenameSync = fs.renameSync

      try {
        fs.writeFileSync = function (file, data, options) {
          if (typeof file === "string" && file.includes(".tmp.")) {
            writeCalledBeforeRename = true
          }
          return origWriteFileSync.call(fs, file, data, options)
        }

        fs.renameSync = function (oldPath, newPath) {
          assert.ok(writeCalledBeforeRename, "rename must be called AFTER writing to temp file")
          if (newPath === targetPath) {
            renameTargetCorrect = true
          }
          // 임시 파일에 이미 쓰인 상태에서 rename 시점에 의도적으로 에러 발생시킴
          throw new Error("Simulated rename error")
        }

        assert.throws(() => {
          writeConfigFile(fakeWs, {
            schemaVersion: 1,
            folders: [{ id: "new", label: "New", path: "~/new" }],
          })
        }, /Simulated rename error/)

        assert.ok(writeCalledBeforeRename, "Temporary file was written first")
        assert.ok(renameTargetCorrect, "Rename target path was correct")

        // 원래 파일의 바이트가 온전히 그대로 유지되는지 확인
        const afterBytes = fs.readFileSync(targetPath)
        assert.deepEqual(afterBytes, origBytes)
      } finally {
        fs.writeFileSync = origWriteFileSync
        fs.renameSync = origRenameSync
      }
    })
  })
})
