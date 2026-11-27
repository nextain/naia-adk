import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { withFileLock } from "./file-lock.js"
import { isPublishPrivatePath, withPublishLock } from "./publish-lock.js"
import { openRegularFile } from "./publish-files.js"

export const DOC_ASSET_BODY_LIMIT = 20 * 1024 * 1024
export const DOC_ASSET_BUNDLE_LIMIT = 83_886_080

export class DocAssetError extends Error {
  constructor(public status: number, public category: string, message: string) {
    super(message)
  }
}

function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ".jpg"
  if (["GIF87a", "GIF89a"].some((header) => bytes.subarray(0, 6).equals(Buffer.from(header)))) return ".gif"
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"))) return ".webp"
  return null
}

export function validateDocAsset(bytes: Buffer, originalName: string): { stem: string; extension: string } {
  if (!bytes.length || !originalName) throw new DocAssetError(400, "missing_file", "그림 파일을 선택한 뒤 다시 올려 주세요.")
  if (bytes.length > DOC_ASSET_BODY_LIMIT) throw new DocAssetError(413, "too_large", "그림 한 장을 20메비바이트 이하로 줄여 주세요.")
  const extension = imageExtension(bytes)
  if (!extension) throw new DocAssetError(415, "unsupported_type", "피엔지·제이펙·지아이에프·웹피 그림 파일을 선택해 주세요.")
  if (/[\\/\x00]/.test(originalName)) throw new DocAssetError(400, "path_escape", "폴더 경로를 빼고 파일 이름만 보내 주세요.")
  const originalExtension = path.extname(originalName).toLowerCase()
  if (originalExtension !== extension && !(extension === ".jpg" && originalExtension === ".jpeg")) {
    throw new DocAssetError(415, "type_mismatch", "파일의 실제 그림 형식과 확장자가 다릅니다. 올바른 형식으로 다시 내보내 주세요.")
  }
  const stem = Array.from(originalName.slice(0, -originalExtension.length).normalize("NFC").toLowerCase()
    .replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}_-]/gu, "")).slice(0, 60).join("") || "image"
  return { stem, extension }
}

export function directoryFdPath(fd: number): string {
  const opened = fs.fstatSync(fd)
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(base, String(fd))
    try {
      const stat = fs.statSync(`${candidate}/.`)
      if (stat.isDirectory() && stat.dev === opened.dev && stat.ino === opened.ino) return candidate
    } catch {}
  }
  throw new DocAssetError(403, "forbidden", "열린 폴더를 안전하게 사용할 수 없습니다. 서버의 파일 접근 환경을 확인해 주세요.")
}

function namedFile(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target) } catch (error: any) {
    if (error.code !== "ENOENT") throw error
  }
}

function sameFile(first: fs.Stats | undefined, second: fs.Stats | undefined): boolean {
  return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino
}

function unlinkCreatedName(target: string, created: fs.Stats | undefined): void {
  if (created && sameFile(namedFile(target), created)) fs.unlinkSync(target)
}

// 같은 문서 폴더의 요청은 묶음 크기 검사와 배타 생성을 하나의 잠금 안에서 처리한다.
export async function saveDocAsset(
  docPath: string,
  bytes: Buffer,
  originalName: string,
  bundleLimit = DOC_ASSET_BUNDLE_LIMIT,
  checkDocument: () => void = () => {},
  beforeWrite?: () => Promise<void> | void,
): Promise<{ path: string; size: number; sha256: string }> {
  return withPublishLock(async () => {
    await beforeWrite?.()
    return saveDocAssetLocked(docPath, bytes, originalName, bundleLimit, checkDocument)
  })
}

async function saveDocAssetLocked(
  docPath: string,
  bytes: Buffer,
  originalName: string,
  bundleLimit = DOC_ASSET_BUNDLE_LIMIT,
  checkDocument: () => void = () => {},
): Promise<{ path: string; size: number; sha256: string }> {
  const { stem, extension } = validateDocAsset(bytes, originalName)
  const parent = path.dirname(docPath)
  const assets = path.join(parent, "assets")
  const escape = () => new DocAssetError(403, "path_escape", "문서와 그림 폴더의 연결을 확인하고 문서 폴더 안의 실제 폴더를 사용해 주세요.")
  if (isPublishPrivatePath(docPath) || isPublishPrivatePath(assets)) throw escape()
  const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)
  const parentFd = fs.openSync(parent, directoryFlags)
  try {
    const parentStat = fs.fstatSync(parentFd)
    const parentFdPath = directoryFdPath(parentFd)
    function checkParent() {
      try {
        if (isPublishPrivatePath(docPath) || isPublishPrivatePath(parent)) throw escape()
        const stat = fs.lstatSync(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parentStat.dev || stat.ino !== parentStat.ino || fs.realpathSync.native(parent) !== parent) throw escape()
      } catch { throw escape() }
      checkDocument()
    }
    checkParent()
    return await withFileLock(path.join(parentFdPath, ".doc-assets"), () => {
      checkParent()
      const pinnedAssets = path.join(parentFdPath, "assets")
      try { fs.mkdirSync(pinnedAssets) } catch (error: any) { if (error.code !== "EEXIST") throw error }
      let assetsFd: number
      try { assetsFd = fs.openSync(pinnedAssets, directoryFlags) } catch { throw escape() }
      try {
        const assetsStat = fs.fstatSync(assetsFd)
        const assetsFdPath = directoryFdPath(assetsFd)
        function checkAssets() {
          checkParent()
          try {
            if (isPublishPrivatePath(assets)) throw escape()
            const stat = fs.lstatSync(assets)
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== assetsStat.dev || stat.ino !== assetsStat.ino || fs.realpathSync.native(assets) !== assets) throw escape()
          } catch { throw escape() }
        }
        checkAssets()
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex")
        const result = (name: string) => ({ path: `assets/${name}`, size: bytes.length, sha256 })
        for (let suffix = 1; ; suffix++) {
          checkAssets()
          const name = `${stem}${suffix === 1 ? "" : `-${suffix}`}${extension}`
          if (isPublishPrivatePath(path.join(assets, name))) throw escape()
          const destination = path.join(assetsFdPath, name)
          let existing: fs.Stats | undefined
          try { existing = fs.lstatSync(destination) } catch (error: any) { if (error.code !== "ENOENT") throw error }
          if (existing) {
            if (existing.isSymbolicLink()) throw escape()
            if (existing.isFile() && existing.nlink === 1 && existing.size === bytes.length) {
              let fd: number
              let opened: fs.Stats
              try { ({ fd, stat: opened } = openRegularFile(destination, existing)) } catch (error) {
                if (["ESTALE", "EISDIR", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) continue
                throw error
              }
              try {
                if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== existing.dev || opened.ino !== existing.ino || opened.size !== bytes.length) continue
                // 검사 뒤 파일이 커져도 올린 그림 길이를 넘겨 읽거나 메모리를 늘리지 않는다.
                const existingBytes = Buffer.alloc(bytes.length)
                let offset = 0
                while (offset < existingBytes.length) {
                  const count = fs.readSync(fd, existingBytes, offset, existingBytes.length - offset, offset)
                  if (!count) break
                  offset += count
                }
                const finished = fs.fstatSync(fd)
                if (offset === bytes.length && finished.nlink === 1 && finished.size === bytes.length && existingBytes.equals(bytes)) {
                  checkAssets()
                  // 열린 뒤 이름 자리가 바뀌었으면 읽은 파일의 경로로 반환하지 않는다.
                  let named: fs.Stats
                  try { named = fs.lstatSync(destination) } catch (error: any) {
                    if (error.code === "ENOENT") continue
                    throw error
                  }
                  if (!named.isFile() || named.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino) continue
                  return result(name)
                }
              } finally { fs.closeSync(fd) }
            }
            continue
          }
          let total = 0
          for (const entry of fs.readdirSync(assetsFdPath)) {
            if (isPublishPrivatePath(path.join(assets, entry))) continue
            const stat = fs.lstatSync(path.join(assetsFdPath, entry))
            if (stat.isFile()) total += stat.size
          }
          if (total + bytes.length > bundleLimit) throw new DocAssetError(413, "bundle_limit", "이 문서의 그림 묶음은 80메비바이트까지입니다. 불필요한 그림을 정리하거나 크기를 줄여 주세요.")
          const temporary = path.join(assetsFdPath, `.upload-${crypto.randomUUID()}.tmp`)
          const changed = () => new DocAssetError(403, "path_escape", "그림 파일 이름의 연결이 바뀌었습니다. 그림 폴더의 파일과 링크를 확인한 뒤 다시 올려 주세요.")
          let fd: number | undefined
          let temporaryCreated: fs.Stats | undefined
          let destinationCreated: fs.Stats | undefined
          let accepted = false
          try {
            fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644)
            temporaryCreated = fs.fstatSync(fd)
            fs.writeFileSync(fd, bytes)
            checkAssets()
            const beforeLink = namedFile(temporary)
            if (!beforeLink?.isFile() || !sameFile(beforeLink, temporaryCreated)) throw changed()
            // 생성·연결·정리는 검사한 폴더의 열린 파일 설명자를 기준으로 수행한다.
            try { fs.linkSync(temporary, destination) } catch (error: any) {
              if (error.code === "EEXIST") { suffix--; continue }
              throw error
            }
            destinationCreated = temporaryCreated
            const linkedSource = namedFile(temporary)
            const linkedDestination = namedFile(destination)
            // 연결 도중 임시 이름이 교체됐어도 이번에 만든 연결은 그 inode로만 정리한다.
            if (sameFile(linkedDestination, linkedSource)) destinationCreated = linkedDestination
            checkAssets()
            const opened = fs.fstatSync(fd)
            const temporaryNamed = namedFile(temporary)
            const destinationNamed = namedFile(destination)
            if (!opened.isFile() || opened.size !== bytes.length
              || !temporaryNamed?.isFile() || !sameFile(temporaryNamed, opened)
              || !destinationNamed?.isFile() || !sameFile(destinationNamed, opened)) throw changed()
            accepted = true
            return result(name)
          } finally {
            try {
              if (!accepted) unlinkCreatedName(destination, destinationCreated)
            } finally {
              try { unlinkCreatedName(temporary, temporaryCreated) } finally {
                if (fd !== undefined) fs.closeSync(fd)
              }
            }
          }
        }
      } finally { fs.closeSync(assetsFd) }
    })
  } finally { fs.closeSync(parentFd) }
}
