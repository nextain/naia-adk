#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ID_REGEX = /^[a-z0-9-]{1,40}$/
const VALID_TABS = new Set(["common", "brand", "developer"])
const FORBIDDEN_SEGMENTS = new Set(["data-private", ".git", "node_modules"])

export function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export function isInsideOrEqual(child, parent) {
  if (child === parent) return true
  return isInside(child, parent)
}

export function containsForbiddenSegment(filePath) {
  const segments = filePath.split(/[/\\]/).filter((s) => s.length > 0)
  for (const seg of segments) {
    const norm = seg.toLowerCase().trim()
    if (FORBIDDEN_SEGMENTS.has(norm)) {
      return true
    }
  }
  return false
}

export function containsHiddenSegment(relPath) {
  const segments = relPath.split(/[/\\]/).filter((s) => s.length > 0)
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (trimmed.startsWith(".")) {
      return true
    }
    if (trimmed.toLowerCase() === "appdata") {
      return true
    }
  }
  return false
}

export function readWin32Attributes(filePath) {
  if (process.platform !== "win32") {
    return { hidden: false, system: false }
  }
  try {
    const out = execFileSync("attrib.exe", [filePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
    const flagSlice = out.slice(0, 11)
    return {
      hidden: flagSlice.includes("H"),
      system: flagSlice.includes("S"),
    }
  } catch {
    return { hidden: false, system: false }
  }
}

export function isHiddenOrSystem(absPath, context) {
  if (context?.pathAttributes) {
    const norm = path.resolve(absPath)
    let attr
    if (typeof context.pathAttributes === "function") {
      attr = context.pathAttributes(norm)
    } else {
      attr = context.pathAttributes[norm]
    }
    if (attr !== undefined) {
      if (typeof attr === "number") {
        return (attr & 0x06) !== 0 // 0x02 (HIDDEN) | 0x04 (SYSTEM)
      }
      return Boolean(attr.hidden || attr.system)
    }
  }

  if (process.platform === "win32") {
    const { hidden, system } = readWin32Attributes(absPath)
    return hidden || system
  }

  return false
}

export function containsHiddenSegmentWithAttributes(relPath, baseDir, context) {
  const segments = relPath.split(/[/\\]/).filter((s) => s.length > 0)
  let current = baseDir
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (trimmed.startsWith(".")) {
      return true
    }
    current = path.join(current, seg)
    if (isHiddenOrSystem(current, context)) {
      return true
    }
  }
  return false
}

export function getSecretDir(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR, tmpDir = os.tmpdir(), homeDir = os.homedir()) {
  if (xdgRuntimeDir) {
    return path.join(xdgRuntimeDir, "naia-adk")
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")
    return path.join(localAppData, "naia-adk", "run")
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username
  return path.join(tmpDir, `naia-adk-${uid}`)
}

export function resolveContext(workspaceRoot, customContext = {}) {
  const homeDir = customContext.homeDir ?? os.homedir()
  const wsRoot = customContext.workspaceRoot ?? workspaceRoot
  const tmpDir = customContext.tmpDir ?? os.tmpdir()
  const xdg =
    customContext.xdgRuntimeDir !== undefined
      ? customContext.xdgRuntimeDir
      : process.env.XDG_RUNTIME_DIR
  const secret = customContext.secretDir ?? getSecretDir(xdg, tmpDir, homeDir)

  let realHome = homeDir
  try {
    realHome = fs.realpathSync.native(homeDir)
  } catch {}

  let realWs = wsRoot
  try {
    realWs = fs.realpathSync.native(wsRoot)
  } catch {}

  let realTmp = tmpDir
  try {
    realTmp = fs.realpathSync.native(tmpDir)
  } catch {}

  let realXdg = xdg
  if (xdg) {
    try {
      realXdg = fs.realpathSync.native(xdg)
    } catch {}
  }

  let realSecret = secret
  try {
    realSecret = fs.realpathSync.native(secret)
  } catch {}

  return {
    homeDir,
    workspaceRoot: wsRoot,
    tmpDir,
    xdgRuntimeDir: xdg,
    secretDir: secret,
    realHome,
    realWorkspaceRoot: realWs,
    realTmpDir: realTmp,
    realXdgRuntimeDir: realXdg,
    realSecretDir: realSecret,
    pathAttributes: customContext.pathAttributes,
  }
}

export function expandHome(rawPath, homeDir) {
  if (rawPath === "~") return homeDir
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(homeDir, rawPath.slice(2))
  }
  return rawPath
}

export function validateFolder(folderPath, context) {
  const isHomeTilde = folderPath === "~" || folderPath.startsWith("~/") || folderPath.startsWith("~\\")
  const isAbs = path.isAbsolute(folderPath)
  if (!isHomeTilde && !isAbs) {
    return { ok: false, status: "forbidden", error: "경로는 절대경로이거나 ~/ 로 시작해야 합니다." }
  }

  const inputExpanded = expandHome(folderPath, context.homeDir)
  const inputNormalized = path.resolve(inputExpanded)

  // 1. 입력 경로 조각에 금지 3 검사
  if (containsForbiddenSegment(inputNormalized)) {
    return { ok: false, status: "forbidden", error: "입력 경로에 금지된 폴더명(data-private, .git, node_modules)이 포함되어 있습니다. (금지 3)" }
  }

  // 2. 입력 경로에 금지 1 (보호 폴더를 품음) 검사
  const protectedDirs = [
    context.homeDir,
    context.workspaceRoot,
    context.tmpDir,
    ...(context.xdgRuntimeDir ? [context.xdgRuntimeDir] : []),
    context.secretDir,
  ]

  for (const prot of protectedDirs) {
    if (isInsideOrEqual(prot, inputNormalized)) {
      return { ok: false, status: "forbidden", error: `보호 폴더(${prot})를 품거나 같습니다. (금지 1)` }
    }
  }

  // 3. 존재 확인
  if (!fs.existsSync(inputNormalized)) {
    return { ok: false, status: "missing", error: `폴더를 찾을 수 없습니다: ${inputNormalized}` }
  }

  let realPath
  try {
    realPath = fs.realpathSync.native(inputNormalized)
  } catch {
    return { ok: false, status: "missing", error: `실경로를 풀 수 없습니다: ${inputNormalized}` }
  }

  let stat
  try {
    stat = fs.statSync(realPath)
  } catch {
    return { ok: false, status: "missing", error: `폴더 정보를 읽을 수 없습니다: ${realPath}` }
  }

  if (!stat.isDirectory()) {
    return { ok: false, status: "forbidden", error: `디렉토리가 아닙니다: ${realPath}` }
  }

  // 4. 실경로에 대해 금지 1 검사
  const realProtectedDirs = [
    context.realHome,
    context.realWorkspaceRoot,
    context.realTmpDir,
    ...(context.realXdgRuntimeDir ? [context.realXdgRuntimeDir] : []),
    context.realSecretDir,
  ]

  for (const prot of realProtectedDirs) {
    if (isInsideOrEqual(prot, realPath)) {
      return { ok: false, status: "forbidden", error: `실경로가 보호 폴더(${prot})를 품거나 같습니다. (금지 1)` }
    }
  }

  // 5. 실경로에 대해 금지 3 검사
  if (containsForbiddenSegment(realPath)) {
    return { ok: false, status: "forbidden", error: "실경로에 금지된 폴더명(data-private, .git, node_modules)이 포함되어 있습니다. (금지 3)" }
  }

  // 6. 금지 2 검사 (표시 파일 없는 폴더는 홈 안 보통 폴더만)
  const naiaViewPath = path.join(realPath, ".naia-view")
  let hasNaiaView = false
  try {
    hasNaiaView = fs.existsSync(naiaViewPath) && fs.statSync(naiaViewPath).isFile()
  } catch {
    hasNaiaView = false
  }

  if (!hasNaiaView) {
    if (!isInside(realPath, context.realHome)) {
      return { ok: false, status: "forbidden", error: "표시 파일(.naia-view)이 없는 폴더는 홈 폴더 안이어야 합니다. (금지 2)" }
    }
    if (!isInside(inputNormalized, context.homeDir)) {
      return { ok: false, status: "forbidden", error: "표시 파일(.naia-view)이 없는 폴더는 입력 경로도 홈 폴더 안이어야 합니다. (금지 2)" }
    }

    const relFromRealHome = path.relative(context.realHome, realPath)
    if (containsHiddenSegmentWithAttributes(relFromRealHome, context.realHome, context)) {
      return { ok: false, status: "forbidden", error: `표시 파일(.naia-view) 없는 폴더의 경로에 숨김 조각이 있습니다: ${relFromRealHome} (금지 2)` }
    }

    const relFromInputHome = path.relative(context.homeDir, inputNormalized)
    if (containsHiddenSegmentWithAttributes(relFromInputHome, context.homeDir, context)) {
      return { ok: false, status: "forbidden", error: `표시 파일(.naia-view) 없는 폴더의 입력 경로에 숨김 조각이 있습니다: ${relFromInputHome} (금지 2)` }
    }
  }

  return { ok: true, status: "ok", realPath }
}

export function addViewFolder(
  workspaceRoot,
  { id, label, path: pathArg, tab = "common" },
  customContext = {},
) {
  if (!id || !ID_REGEX.test(id)) {
    throw new Error(`오류: 올바르지 않은 id 형식입니다: "${id}" (영문 소문자·숫자·-, 1~40자)`)
  }

  if (!label || label.trim().length === 0) {
    throw new Error("오류: --label 은 필수이며 비어 있을 수 없습니다.")
  }

  if (!pathArg || pathArg.trim().length === 0) {
    throw new Error("오류: --path 는 필수입니다.")
  }

  if (tab && !VALID_TABS.has(tab)) {
    throw new Error(`오류: 올바르지 않은 tab 값입니다: "${tab}" (common | brand | developer)`)
  }

  const finalTab = tab || "common"
  const context = resolveContext(workspaceRoot, customContext)
  const config = readConfigFile(workspaceRoot)

  if (config.folders.some((f) => f.id === id)) {
    throw new Error(`오류: 이미 등록된 id입니다: "${id}"`)
  }

  const validation = validateFolder(pathArg, context)
  if (!validation.ok) {
    throw new Error(`등록 거절: ${validation.error}`)
  }

  config.folders.push({
    id,
    label: label.trim(),
    path: pathArg,
    tab: finalTab,
  })

  writeConfigFile(workspaceRoot, config)
  return { id, label: label.trim(), path: pathArg, tab: finalTab, realPath: validation.realPath }
}

export function readConfigFile(workspaceRoot) {
  const filePath = path.join(workspaceRoot, ".agents", "work", "view-folders.json")
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, folders: [] }
  }

  const raw = fs.readFileSync(filePath, "utf-8")
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.folders)) {
    throw new Error("올바르지 않은 view-folders.json 파일 형식입니다.")
  }
  return parsed
}

export function writeConfigFile(workspaceRoot, data) {
  const dir = path.join(workspaceRoot, ".agents", "work")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const targetPath = path.join(dir, "view-folders.json")
  const tmpPath = path.join(dir, `view-folders.json.tmp.${process.pid}.${Date.now()}`)

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
    fs.renameSync(tmpPath, targetPath)
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {}
    }
    throw err
  }
}

function parseCliArgs(args) {
  let rootArg = null
  let idArg = null
  let labelArg = null
  let pathArg = null
  let tabArg = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--root" && i + 1 < args.length) {
      rootArg = args[++i]
    } else if (arg === "--id" && i + 1 < args.length) {
      idArg = args[++i]
    } else if (arg === "--label" && i + 1 < args.length) {
      labelArg = args[++i]
    } else if (arg === "--path" && i + 1 < args.length) {
      pathArg = args[++i]
    } else if (arg === "--tab" && i + 1 < args.length) {
      tabArg = args[++i]
    }
  }

  return { rootArg, idArg, labelArg, pathArg, tabArg }
}

export function getDefaultRoot() {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "..")
}

export function runCli(argv = process.argv.slice(2)) {
  const command = argv[0]
  if (!command || !["list", "add", "remove"].includes(command)) {
    console.error("사용법: view-folders.mjs list | add --id <id> --label <label> --path <path> [--tab <common|brand|developer>] | remove --id <id> [--root <작업공간 루트>]")
    process.exit(1)
  }

  const { rootArg, idArg, labelArg, pathArg, tabArg } = parseCliArgs(argv.slice(1))
  const workspaceRoot = rootArg ? path.resolve(rootArg) : getDefaultRoot()
  const context = resolveContext(workspaceRoot)

  if (command === "list") {
    let config
    try {
      config = readConfigFile(workspaceRoot)
    } catch (err) {
      console.error(`설정 파일 읽기 오류: ${err.message}`)
      process.exit(1)
    }

    if (config.folders.length === 0) {
      console.log("[view-folders] 등록된 데이터 폴더 없음")
      return
    }

    console.log(`[view-folders] 등록된 데이터 폴더 (${config.folders.length}개):`)
    for (const f of config.folders) {
      console.log(`- ${f.id}: "${f.label}" (${f.path}) [${f.tab || "common"}]`)
    }
    return
  }

  if (command === "add") {
    if (!idArg || !ID_REGEX.test(idArg)) {
      console.error(`오류: 올바르지 않은 id 형식입니다: "${idArg}" (영문 소문자·숫자·-, 1~40자)`)
      process.exit(1)
    }

    if (!labelArg || labelArg.trim().length === 0) {
      console.error("오류: --label 은 필수이며 비어 있을 수 없습니다.")
      process.exit(1)
    }

    if (!pathArg || pathArg.trim().length === 0) {
      console.error("오류: --path 는 필수입니다.")
      process.exit(1)
    }

    let tab = "common"
    if (tabArg) {
      if (!VALID_TABS.has(tabArg)) {
        console.error(`오류: 올바르지 않은 tab 값입니다: "${tabArg}" (common | brand | developer)`)
        process.exit(1)
      }
      tab = tabArg
    }

    let config
    try {
      config = readConfigFile(workspaceRoot)
    } catch (err) {
      console.error(`설정 파일 읽기 오류: ${err.message}`)
      process.exit(1)
    }

    if (config.folders.some((f) => f.id === idArg)) {
      console.error(`오류: 이미 등록된 id입니다: "${idArg}"`)
      process.exit(1)
    }

    const validation = validateFolder(pathArg, context)
    if (!validation.ok) {
      console.error(`등록 거절: ${validation.error}`)
      process.exit(1)
    }

    // 등록 전 첫 단계 항목 출력
    let entries = []
    try {
      entries = fs.readdirSync(validation.realPath)
    } catch (err) {
      console.error(`폴더 항목 읽기 실패: ${err.message}`)
      process.exit(1)
    }

    console.log(`[view-folders] "${idArg}" 첫 단계 항목 (${entries.length}개):`)
    for (const entry of entries) {
      console.log(`- ${entry}`)
    }

    // 추가 및 원자적 저장
    config.folders.push({
      id: idArg,
      label: labelArg.trim(),
      path: pathArg,
      tab,
    })

    try {
      writeConfigFile(workspaceRoot, config)
    } catch (err) {
      console.error(`저장 오류: ${err.message}`)
      process.exit(1)
    }

    console.log(`[view-folders] 추가 완료: ${idArg} -> ${pathArg}`)
    return
  }

  if (command === "remove") {
    if (!idArg) {
      console.error("오류: --id 는 필수입니다.")
      process.exit(1)
    }

    let config
    try {
      config = readConfigFile(workspaceRoot)
    } catch (err) {
      console.error(`설정 파일 읽기 오류: ${err.message}`)
      process.exit(1)
    }

    const idx = config.folders.findIndex((f) => f.id === idArg)
    if (idx === -1) {
      console.error(`오류: 해당 id를 찾을 수 없습니다: "${idArg}"`)
      process.exit(1)
    }

    config.folders.splice(idx, 1)

    try {
      writeConfigFile(workspaceRoot, config)
    } catch (err) {
      console.error(`저장 오류: ${err.message}`)
      process.exit(1)
    }

    console.log(`[view-folders] 삭제 완료: ${idArg}`)
    return
  }
}

// 직접 실행 시
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli()
}
