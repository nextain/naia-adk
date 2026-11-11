import fs from "node:fs"

export const REGULAR_FILE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)

function invalidFile(code: string): never {
  throw Object.assign(new Error("실제 일반 파일을 안전하게 읽지 못했습니다"), { code })
}

function assertRegularFile(stat: fs.Stats): void {
  if (stat.isSymbolicLink()) invalidFile("ELOOP")
  if (!stat.isFile()) invalidFile("EISDIR")
  if (stat.nlink !== 1) invalidFile("EMLINK")
}

export function sameRegularFile(first: fs.Stats, second: fs.Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
}

export function regularFileStat(target: string): fs.Stats {
  const stat = fs.lstatSync(target)
  assertRegularFile(stat)
  return stat
}

// 종류 검사 뒤 FIFO로 교체되어도 open이 기다리지 않으며, 연 파일의 종류를 다시 검사한다.
export function openRegularFile(target: string, expected?: fs.Stats): { fd: number; stat: fs.Stats } {
  const named = regularFileStat(target)
  if (expected && !sameRegularFile(expected, named)) invalidFile("ESTALE")
  const fd = fs.openSync(target, REGULAR_FILE_READ_FLAGS)
  try {
    const stat = fs.fstatSync(fd)
    assertRegularFile(stat)
    if (!sameRegularFile(named, stat)) invalidFile("ESTALE")
    return { fd, stat }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

export function readRegularFile(target: string, maxBytes = Infinity, expected?: fs.Stats): Buffer {
  const { fd, stat } = openRegularFile(target, expected)
  try {
    if (stat.size > maxBytes) invalidFile("EFBIG")
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) break
      offset += count
    }
    if (offset !== bytes.length || !sameRegularFile(stat, fs.fstatSync(fd)) || !sameRegularFile(stat, regularFileStat(target))) invalidFile("ESTALE")
    return bytes
  } finally { fs.closeSync(fd) }
}
