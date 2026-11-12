// "일정에 넣기": 메신저 글 내용으로 보는 사람 본인의 개인 일정 한 줄을 만든다.
// 쓰기는 대시보드 개인 일정 API(/schedule-personal) 하나만 부른다. 그 API 는 요청한 사람의 신원(게이트가 확인한
// 머리글)으로만 파일을 고르므로, 이 모듈은 사용자 이름을 보내지 않는다. 남의 일정에 쓸 길이 없다.
import { scheduleDetailHref } from "@naia-adk/core/src/schedule-link"
import { messagesHref, type Message } from "./messenger"

export const PERSONAL_SCHEDULE_PATH = "/schedule-personal"
// core personal-schedule 의 MAX_TITLE_LENGTH·MAX_MEMO_LENGTH 와 같다. 그 모듈은 node:fs 를 써서 브라우저 묶음에 넣지 못한다.
export const MAX_TITLE_LENGTH = 200
export const MAX_MEMO_LENGTH = 2000

export interface ScheduleDraft {
  title: string
  date: string
  /** "HH:mm" 이면 시각 일정, null 이면 종일. */
  time: string | null
  memo: string
}

export interface ScheduleWriteBody {
  title: string
  start: string
  end: string
  allDay: boolean
  memo: string
}

const pad = (n: number) => String(n).padStart(2, "0")

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

function plainLine(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** 글 본문에서 날짜(YYYY-MM-DD, M월 D일)와 시각(HH:mm, 오전/오후 N시 M분, N시)을 찾는다. 없으면 오늘 종일. */
export function draftScheduleFromMessage(message: Pick<Message, "id" | "channel_id" | "body">, today: string): ScheduleDraft {
  const body = message.body ?? ""
  const outsideCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
  const firstLine = outsideCode.split(/\r?\n/).map(plainLine).find(Boolean) ?? "메신저 글"
  const title = Array.from(firstLine).slice(0, MAX_TITLE_LENGTH).join("")

  const year = Number(today.slice(0, 4))
  let date: string | null = null
  const iso = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(outsideCode)
  if (iso) date = validDate(+iso[1], +iso[2], +iso[3])
  if (!date) {
    const ko = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(outsideCode)
    if (ko) date = validDate(year, +ko[1], +ko[2])
  }

  let time: string | null = null
  const hm = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(outsideCode)
  if (hm) time = `${pad(+hm[1])}:${hm[2]}`
  if (!time) {
    const ko = /(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/.exec(outsideCode)
    if (ko) {
      let hour = +ko[2]
      const minute = ko[3] !== undefined ? +ko[3] : /반$/.test(ko[0]) ? 30 : 0
      if (ko[1] === "오후" && hour < 12) hour += 12
      if (ko[1] === "오전" && hour === 12) hour = 0
      if (hour <= 23 && minute <= 59) time = `${pad(hour)}:${pad(minute)}`
    }
  }

  const link = messagesHref(message.channel_id, message.id)
  const memo = Array.from(`메신저 글: ${link}\n\n${body}`).slice(0, MAX_MEMO_LENGTH).join("")
  return { title, date: date ?? today, time, memo }
}

/** 초안을 개인 일정 API 몸통으로. 시각 일정은 한 시간짜리(같은 날 23:59 를 넘지 않음). */
export function scheduleWriteBody(draft: ScheduleDraft): ScheduleWriteBody {
  const title = draft.title.trim()
  if (!title) throw new Error("제목을 적어 주세요.")
  if (!validDate(+draft.date.slice(0, 4), +draft.date.slice(5, 7), +draft.date.slice(8, 10)) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    throw new Error("날짜는 YYYY-MM-DD 입니다.")
  }
  if (draft.time === null) return { title, start: draft.date, end: draft.date, allDay: true, memo: draft.memo }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("시각은 HH:mm 입니다.")
  const [h, m] = draft.time.split(":").map(Number)
  const endMinutes = Math.min(h * 60 + m + 60, 23 * 60 + 59)
  return {
    title,
    start: `${draft.date} ${draft.time}`,
    end: `${draft.date} ${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}`,
    allDay: false,
    memo: draft.memo,
  }
}

export class ScheduleAddError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

const ERROR_TEXT: Record<string, string> = {
  "personal-schedule-identity-required": "로그인한 본인 일정에만 넣을 수 있습니다. 이 대시보드에는 개인 일정 신원이 없습니다.",
  "origin-not-allowed": "이 주소에서는 개인 일정을 고칠 수 없습니다(원점 확인 실패).",
  "personal-schedule-has-warnings": "개인 일정 파일에 경고가 있어 화면에서 고칠 수 없습니다. 일정 화면에서 확인하세요.",
  "personal-schedule-busy": "다른 저장이 진행 중입니다. 잠시 뒤 다시 하세요.",
  "personal-schedule-conflict": "일정이 그사이 바뀌었습니다. 다시 하세요.",
}

async function errorOf(res: Response): Promise<ScheduleAddError> {
  let code = `http-${res.status}`
  try {
    const data = (await res.json()) as { error?: unknown }
    if (typeof data.error === "string") code = data.error
  } catch {}
  return new ScheduleAddError(code, ERROR_TEXT[code] ?? (code.startsWith("http-") ? `개인 일정 API 오류 (${res.status})` : code))
}

interface PersonalDoc {
  revision?: string
  items?: { id: string; title: string; start: string }[]
}

/**
 * 읽고-쓰기 계약대로 GET 으로 개정 값을 받은 뒤 If-Match 로 POST 한다. 개정이 어긋나면(409 conflict) 한 번만 다시 한다.
 * 돌려주는 값: 새 일정 id 와 일정 화면 상세 링크.
 */
export async function addToPersonalSchedule(
  body: ScheduleWriteBody,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string | null; href: string }> {
  for (let attempt = 0; ; attempt++) {
    const current = await fetchFn(PERSONAL_SCHEDULE_PATH, { cache: "no-store", headers: { accept: "application/json" } })
    if (!current.ok) throw await errorOf(current)
    const doc = (await current.json()) as PersonalDoc
    if (typeof doc.revision !== "string") throw new ScheduleAddError("no-revision", "개인 일정 개정 값을 받지 못했습니다.")
    const before = new Set((doc.items ?? []).map((i) => i.id))
    const res = await fetchFn(PERSONAL_SCHEDULE_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "if-match": doc.revision, accept: "application/json" },
      body: JSON.stringify(body),
    })
    if (res.status === 409 && attempt === 0) {
      const error = await errorOf(res)
      if (error.code === "personal-schedule-conflict") continue
      throw error
    }
    if (!res.ok) throw await errorOf(res)
    const after = (await res.json()) as PersonalDoc
    const added = (after.items ?? []).find((i) => !before.has(i.id) && i.title === body.title && i.start === body.start)
    const id = added?.id ?? null
    const date = body.start.slice(0, 10)
    return { id, href: id ? scheduleDetailHref({ layer: "personal", id, date }) : "/schedule" }
  }
}
