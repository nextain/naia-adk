import crypto from "node:crypto"

export class PublishError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string) {
    super(message)
    this.name = "PublishError"
  }
}
function invalid(field: string, message: string): never {
  throw new PublishError(422, "invalid_bundle", message, field)
}
export function hashBytes(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}
export function canonicalBytes(value: unknown, field = "serialization"): Buffer {
  const seen = new Set<object>()
  function encode(input: unknown, at: string): string {
    if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
    if (typeof input === "number" && Number.isSafeInteger(input) && !Object.is(input, -0)) return String(input)
    if (typeof input !== "object" || input === null || seen.has(input)) invalid(at, "고정 직렬화에는 문자열·불리언·안전한 정수·배열·객체·null만 사용할 수 있습니다.")
    seen.add(input)
    let output: string
    if (Array.isArray(input)) {
      if (Object.keys(input).length !== input.length) invalid(at, "빈 배열 칸과 추가 속성은 사용할 수 없습니다.")
      output = `[${input.map((entry, i) => encode(entry, `${at}.${i}`)).join(",")}]`
    } else {
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalid(at, "일반 객체만 직렬화할 수 있습니다.")
      if (Object.getOwnPropertySymbols(input).length) invalid(at, "심벌 속성은 사용할 수 없습니다.")
      output = `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${encode((input as Record<string, unknown>)[key], `${at}.${key}`)}`).join(",")}}`
    }
    seen.delete(input)
    return output
  }
  return Buffer.from(encode(value, field), "utf8")
}
