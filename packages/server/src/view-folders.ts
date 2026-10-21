import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { getProxySecretDir } from "./security.js"

export interface ViewFolderConfig {
  id: string
  label: string
  path: string
  tab?: "common" | "brand" | "developer"
}

export interface ViewFoldersFile {
  schemaVersion: 1
  folders: ViewFolderConfig[]
}

export type PathAttributes = number | { hidden?: boolean; system?: boolean }

export interface FolderCheckContext {
  homeDir?: string
  workspaceRoot?: string
  tmpDir?: string
  xdgRuntimeDir?: string
  secretDir?: string
  pathAttributes?: Record<string, PathAttributes> | ((filePath: string) => PathAttributes | undefined)
}

export interface ResolvedFolderContext {
  homeDir: string
  workspaceRoot: string
  tmpDir: string
  xdgRuntimeDir?: string
  secretDir: string
  realHome: string
  realWorkspaceRoot: string
  realTmpDir: string
  realXdgRuntimeDir?: string
  realSecretDir: string
  pathAttributes?: Record<string, PathAttributes> | ((filePath: string) => PathAttributes | undefined)
}

const ID_REGEX = /^[a-z0-9-]{1,40}$/
const VALID_TABS = new Set(["common", "brand", "developer"])
const FORBIDDEN_SEGMENTS = new Set(["data-private", ".git", "node_modules"])

/**
 * 두 경로 간 포함 관계 확인: child가 parent의 하위 폴더(자식)인지
 */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * child가 parent와 같거나 parent의 하위 폴더인지
 */
export function isInsideOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true
  return isInside(child, parent)
}

/**
 * 경로 조각(segment)에 금지된 폴더명(data-private, .git, node_modules)이 포함되어 있는지 (금지 3)
 */
export function containsForbiddenSegment(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/).filter((s) => s.length > 0)
  for (const seg of segments) {
    const norm = seg.toLowerCase().trim()
    if (FORBIDDEN_SEGMENTS.has(norm)) {
      return true
    }
  }
  return false
}

/**
 * Windows 기본 속성 읽기 (attrib.exe 실행, Windows가 아니면 비트 없음)
 */
export function readWin32Attributes(filePath: string): { hidden: boolean; system: boolean } {
  if (process.platform !== "win32") {
    return { hidden: false, system: false }
  }
  try {
    const { execFileSync } = require("node:child_process")
    const out: string = execFileSync("attrib.exe", [filePath], {
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

/**
 * 단일 경로의 숨김·시스템 속성 비트 확인 (주입값 우선, 미주입 시 win32만 실제 확인)
 */
export function isHiddenOrSystem(
  absPath: string,
  context?: ResolvedFolderContext | FolderCheckContext,
): boolean {
  if (context?.pathAttributes) {
    const norm = path.resolve(absPath)
    let attr: PathAttributes | undefined
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

/**
 * 상대 경로에 숨김 조각이 있는지 (금지 2)
 * 이름이 '.'으로 시작하거나 Windows AppData 등
 */
export function containsHiddenSegment(relPath: string): boolean {
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

/**
 * 홈부터 모든 조각의 숨김 이름 및 숨김·시스템 속성을 검사 (금지 2)
 */
export function containsHiddenSegmentWithAttributes(
  relPath: string,
  baseDir: string,
  context?: ResolvedFolderContext | FolderCheckContext,
): boolean {
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

/**
 * 환경 컨텍스트 해석 (테스트에서 주입 가능하도록)
 * 제품 코드에서는 인자가 없을 경우 os.homedir(), os.tmpdir(), getProxySecretDir()로 고정
 */
export function resolveFolderContext(
  workspaceRoot: string,
  customContext?: FolderCheckContext,
): ResolvedFolderContext {
  const homeDir = customContext?.homeDir ?? os.homedir()
  const wsRoot = customContext?.workspaceRoot ?? workspaceRoot
  const tmpDir = customContext?.tmpDir ?? os.tmpdir()
  const xdg =
    customContext?.xdgRuntimeDir !== undefined
      ? customContext.xdgRuntimeDir
      : process.env.XDG_RUNTIME_DIR
  const secret = customContext?.secretDir ?? getProxySecretDir()

  let realHome = homeDir
  try {
    realHome = fs.realpathSync.native(homeDir)
  } catch {
    // ignore
  }

  let realWs = wsRoot
  try {
    realWs = fs.realpathSync.native(wsRoot)
  } catch {
    // ignore
  }

  let realTmp = tmpDir
  try {
    realTmp = fs.realpathSync.native(tmpDir)
  } catch {
    // ignore
  }

  let realXdg = xdg
  if (xdg) {
    try {
      realXdg = fs.realpathSync.native(xdg)
    } catch {
      // ignore
    }
  }

  let realSecret = secret
  try {
    realSecret = fs.realpathSync.native(secret)
  } catch {
    // ignore
  }

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
    pathAttributes: customContext?.pathAttributes,
  }
}

/**
 * ~/ 경로 풀기
 */
export function expandHomePath(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(homeDir, rawPath.slice(2))
  }
  return rawPath
}

export type EvaluateResult =
  | { status: "ok"; realPath: string }
  | { status: "missing" }
  | { status: "forbidden"; reason: string }

/**
 * 단일 폴더 경로에 대해 금지 1~3 검사 및 실경로 확인
 */
export function evaluateViewFolder(
  folder: ViewFolderConfig,
  context: ResolvedFolderContext,
): EvaluateResult {
  const rawPath = folder.path
  if (!rawPath || typeof rawPath !== "string") {
    return { status: "forbidden", reason: "Invalid path" }
  }

  const isHomeTilde = rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
  const isAbs = path.isAbsolute(rawPath)
  if (!isHomeTilde && !isAbs) {
    return { status: "forbidden", reason: "Path must be absolute or start with ~/" }
  }

  const inputExpanded = expandHomePath(rawPath, context.homeDir)
  const inputNormalized = path.resolve(inputExpanded)

  // 1. 입력 경로 조각에 금지 3 (data-private, .git, node_modules) 검사
  if (containsForbiddenSegment(inputNormalized)) {
    return { status: "forbidden", reason: "Forbidden segment in input path (rule 3)" }
  }

  // 2. 입력 경로에 대해 금지 1 (보호 폴더를 품음) 검사
  const protectedDirs = [
    context.homeDir,
    context.workspaceRoot,
    context.tmpDir,
    ...(context.xdgRuntimeDir ? [context.xdgRuntimeDir] : []),
    context.secretDir,
  ]

  for (const prot of protectedDirs) {
    if (isInsideOrEqual(prot, inputNormalized)) {
      return { status: "forbidden", reason: `Input path contains protected dir: ${prot} (rule 1)` }
    }
  }

  // 3. 실경로 확인 (존재 여부 및 realpath)
  if (!fs.existsSync(inputNormalized)) {
    return { status: "missing" }
  }

  let realPath: string
  try {
    realPath = fs.realpathSync.native(inputNormalized)
  } catch {
    return { status: "missing" }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch {
    return { status: "missing" }
  }

  if (!stat.isDirectory()) {
    return { status: "forbidden", reason: "Not a directory" }
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
      return { status: "forbidden", reason: `Real path contains protected dir: ${prot} (rule 1)` }
    }
  }

  // 5. 실경로에 대해 금지 3 검사
  if (containsForbiddenSegment(realPath)) {
    return { status: "forbidden", reason: "Forbidden segment in real path (rule 3)" }
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
    // 표시 파일이 없으면 실경로가 홈 안이어야 함
    if (!isInside(realPath, context.realHome)) {
      return {
        status: "forbidden",
        reason: "Without .naia-view, path must be inside home (rule 2)",
      }
    }

    // 입력 경로도 홈 안이어야 함
    if (!isInside(inputNormalized, context.homeDir)) {
      return {
        status: "forbidden",
        reason: "Without .naia-view, input path must be inside home (rule 2)",
      }
    }

    // 홈부터의 상대 경로에 숨김 조각이 없어야 함 (Windows 숨김·시스템 비트 포함)
    const relFromRealHome = path.relative(context.realHome, realPath)
    if (containsHiddenSegmentWithAttributes(relFromRealHome, context.realHome, context)) {
      return {
        status: "forbidden",
        reason: "Without .naia-view, path cannot contain hidden segments under home (rule 2)",
      }
    }

    const relFromInputHome = path.relative(context.homeDir, inputNormalized)
    if (containsHiddenSegmentWithAttributes(relFromInputHome, context.homeDir, context)) {
      return {
        status: "forbidden",
        reason: "Without .naia-view, input path cannot contain hidden segments under home (rule 2)",
      }
    }
  }

  return { status: "ok", realPath }
}

/**
 * <workspaceRoot>/.agents/work/view-folders.json 읽기
 */
export function readViewFoldersFile(workspaceRoot: string): {
  folders: ViewFolderConfig[]
  errors: string[]
} {
  const filePath = path.join(workspaceRoot, ".agents", "work", "view-folders.json")
  if (!fs.existsSync(filePath)) {
    return { folders: [], errors: [] }
  }

  let rawContent: string
  try {
    rawContent = fs.readFileSync(filePath, "utf-8")
  } catch (err: any) {
    return { folders: [], errors: [`Failed to read view-folders.json: ${err.message}`] }
  }

  let parsed: any
  try {
    parsed = JSON.parse(rawContent)
  } catch (err: any) {
    return { folders: [], errors: [`Corrupted view-folders.json (JSON syntax error): ${err.message}`] }
  }

  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.folders)) {
    return { folders: [], errors: ["Invalid view-folders.json schema (schemaVersion !== 1 or folders not array)"] }
  }

  const validFolders: ViewFolderConfig[] = []
  const seenIds = new Set<string>()
  const errors: string[] = []

  for (let idx = 0; idx < parsed.folders.length; idx++) {
    const item = parsed.folders[idx]
    if (!item || typeof item !== "object") {
      errors.push(`Item ${idx}: not an object`)
      continue
    }

    const { id, label, path: fPath, tab } = item

    if (!id || typeof id !== "string" || !ID_REGEX.test(id)) {
      errors.push(`Item ${idx}: invalid id '${id}' (must match ${ID_REGEX})`)
      continue
    }

    if (seenIds.has(id)) {
      errors.push(`Item ${idx}: duplicate id '${id}'`)
      continue
    }

    if (!label || typeof label !== "string" || label.trim().length === 0) {
      errors.push(`Item ${idx} (${id}): invalid label`)
      continue
    }

    if (!fPath || typeof fPath !== "string") {
      errors.push(`Item ${idx} (${id}): missing path`)
      continue
    }

    const isHomeTilde = fPath === "~" || fPath.startsWith("~/") || fPath.startsWith("~\\")
    const isAbs = path.isAbsolute(fPath)
    if (!isHomeTilde && !isAbs) {
      errors.push(`Item ${idx} (${id}): path must be absolute or start with ~/`)
      continue
    }

    let finalTab: "common" | "brand" | "developer" = "common"
    if (tab !== undefined && tab !== null) {
      if (typeof tab !== "string" || !VALID_TABS.has(tab)) {
        errors.push(`Item ${idx} (${id}): invalid tab '${tab}'`)
        continue
      }
      finalTab = tab as "common" | "brand" | "developer"
    }

    seenIds.add(id)
    validFolders.push({
      id,
      label,
      path: fPath,
      tab: finalTab,
    })
  }

  return { folders: validFolders, errors }
}

/**
 * view-folders.json 원자적 저장 (tmp 파일 + rename)
 */
export function writeViewFoldersFile(
  workspaceRoot: string,
  folders: ViewFolderConfig[],
): void {
  const dir = path.join(workspaceRoot, ".agents", "work")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const targetPath = path.join(dir, "view-folders.json")
  const tmpPath = path.join(dir, `view-folders.json.tmp.${process.pid}.${Date.now()}`)

  const data: ViewFoldersFile = {
    schemaVersion: 1,
    folders,
  }

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
    fs.renameSync(tmpPath, targetPath)
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // ignore
      }
    }
    throw err
  }
}
