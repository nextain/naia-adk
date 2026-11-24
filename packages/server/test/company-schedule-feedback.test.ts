import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import {
  getScheduleCommentsDir,
  getScheduleCommentFilePath,
  getScheduleOverridesFilePath,
  generateScheduleCommentId,
  inferTargetRole,
  isValidScheduleItemId,
  isValidScheduleCommentId,
  listScheduleComments,
  readScheduleComment,
  readScheduleOverrides,
  validateScheduleCommentBody,
  type ScheduleComment,
} from "../src/company-schedule-feedback.js"
import { readCompanySchedules } from "../src/company-schedule.js"

const SCHEDULE_MD = `| 날짜 | 일정 | 담당 | 상태 |
|---|---|---|---|
| 11/18(수) 10:00~12:00 | 댓글 대상 일정 | 알파 | 확정 |
| 11/19(목) 14:00 | 오버레이 대상 일정 | 민호 | 예정 |
`

function makeAdkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sched-fb-"))
  fs.mkdirSync(path.join(root, "docs", "common", "alpha"), { recursive: true })
  fs.writeFileSync(path.join(root, "docs", "common", "alpha", "schedule.md"), SCHEDULE_MD, "utf-8")
  return root
}

const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
const TRUSTED_HEADERS = {
  host: "localhost:3141",
  "x-naia-proxy-secret": TEST_SECRET,
  "x-naia-peer": "127.0.0.1",
  "x-naia-local": "127.0.0.1",
  "x-naia-origin-ok": "1",
}
const UNTRUSTED_HEADERS = { host: "localhost:3141" }

async function makeApp(root: string) {
  const app = await createServer({ root, port: 3141, host: "127.0.0.1" })
  ;(app as any).proxySecret = TEST_SECRET
  return app
}

function findItemId(root: string, titlePart: string): string {
  const res = readCompanySchedules({ adkRoot: root, from: "2026-11-01", to: "2026-11-30", env: {} })
  const item = res.items.find((it) => it.title.includes(titlePart))
  if (!item) throw new Error(`schedule item not found: ${titlePart}`)
  return item.id
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const prev = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k])
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("FT-schedule-comments: 회사 일정 댓글 저장소", () => {
  describe("단위: 경로·ID·추론", () => {
    it("미설정 시 adkRoot 폴백, 설정 시 외부 상태 디렉터리를 사용한다", () => {
      expect(getScheduleCommentsDir("/adk", {})).toBe(
        path.join("/adk", ".agents", "work", "schedule-comments"),
      )
      expect(getScheduleOverridesFilePath("/adk", {})).toBe(
        path.join("/adk", ".agents", "work", "schedule-overrides.json"),
      )
      expect(getScheduleCommentsDir("/adk", { NAIA_SCHEDULE_COMMENTS_DIR: "/state/comments" })).toBe(
        "/state/comments",
      )
      expect(getScheduleOverridesFilePath("/adk", { NAIA_SCHEDULE_OVERRIDES_FILE: "/state/ov.json" })).toBe(
        "/state/ov.json",
      )
    })

    it("상대 경로 env 값은 adkRoot 기준으로 푼다", () => {
      expect(getScheduleCommentsDir("/adk", { NAIA_SCHEDULE_COMMENTS_DIR: "state/c" })).toBe(
        path.join("/adk", "state/c"),
      )
    })

    it("댓글 본문은 1~2000자만 허용한다", () => {
      expect(validateScheduleCommentBody("ok").valid).toBe(true)
      expect(validateScheduleCommentBody("").valid).toBe(false)
      expect(validateScheduleCommentBody("x".repeat(2001)).valid).toBe(false)
      expect(validateScheduleCommentBody(123).valid).toBe(false)
    })

    it("일정 id는 허용 문자만, 댓글 id는 날짜 형식을 따른다", () => {
      expect(isValidScheduleItemId("company:md:abc123def456")).toBe(true)
      expect(isValidScheduleItemId("company:reg:retro-daily:2026-11-21")).toBe(true)
      expect(isValidScheduleItemId("../escape")).toBe(false)
      expect(isValidScheduleItemId("a/b")).toBe(false)
      expect(isValidScheduleItemId("")).toBe(false)
      const cid = generateScheduleCommentId(new Date("2026-11-24T10:00:00Z"))
      expect(isValidScheduleCommentId(cid)).toBe(true)
      expect(isValidScheduleCommentId("../x")).toBe(false)
    })

    it("targetRole은 role 우선, 없으면 sourceDocPath의 common/<role>에서 추론한다", () => {
      expect(inferTargetRole({ role: "alpha", sourceDocPath: "common/beta/f.md" })).toBe("alpha")
      expect(inferTargetRole({ sourceDocPath: "common/alpha/schedule.md" })).toBe("alpha")
      expect(inferTargetRole({ sourceDocPath: "common/minho-staff/plan.md" })).toBe("minho-staff")
      expect(inferTargetRole({ sourceDocPath: "docs/other.md" })).toBe(null)
      expect(inferTargetRole({})).toBe(null)
    })
  })

  describe("통합: 댓글 CRUD + 외부 쓰기 경로", () => {
    let root: string
    let app: Awaited<ReturnType<typeof createServer>>
    let commentsDir: string
    let scheduleId: string

    beforeAll(async () => {
      root = makeAdkRoot()
      commentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sched-comments-"))
      process.env.NAIA_SCHEDULE_COMMENTS_DIR = commentsDir
      delete process.env.NAIA_SCHEDULE_OVERRIDES_FILE
      app = await makeApp(root)
      scheduleId = findItemId(root, "댓글 대상 일정")
    })

    afterAll(async () => {
      delete process.env.NAIA_SCHEDULE_COMMENTS_DIR
      await app.close()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(commentsDir, { recursive: true, force: true })
    })

    it("POST 댓글 생성 201 + GET 목록 + 외부 디렉터리에 저장된다", async () => {
      const post = await app.inject({
        method: "POST",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
        payload: JSON.stringify({
          body: "대표 피드백: 날짜를 확인해 주세요",
          scheduleTitle: "댓글 대상 일정",
          sourceDocPath: "common/alpha/schedule.md",
        }),
      })
      expect(post.statusCode).toBe(201)
      const created = JSON.parse(post.payload).comment as ScheduleComment
      expect(created.schemaVersion).toBe(1)
      expect(created.scheduleId).toBe(scheduleId)
      expect(created.action).toBe("comment")
      expect(created.targetRole).toBe("alpha")
      expect(isValidScheduleCommentId(created.id)).toBe(true)

      // adkRoot가 아닌 외부 상태 디렉터리에 기록됨
      expect(fs.existsSync(getScheduleCommentFilePath(root, created.id))).toBe(true)
      expect(
        fs.readdirSync(path.join(root, ".agents", "work", "schedule-comments")).length,
      ).toBe(0)

      const list = await app.inject({
        method: "GET",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        headers: TRUSTED_HEADERS,
      })
      expect(list.statusCode).toBe(200)
      const comments = JSON.parse(list.payload).comments as ScheduleComment[]
      expect(comments).toHaveLength(1)
      expect(comments[0].targetRole).toBe("alpha")
    })

    it("믿지 않는 요청은 403, 빈 본문은 400이다", async () => {
      const forbidden = await app.inject({
        method: "GET",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        headers: UNTRUSTED_HEADERS,
      })
      expect(forbidden.statusCode).toBe(403)

      const bad = await app.inject({
        method: "POST",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
        payload: JSON.stringify({ body: "" }),
      })
      expect(bad.statusCode).toBe(400)
    })

    it("허용 문자 밖의 일정 id는 400으로 차단한다", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/schedule/company/bad%20id%24/comments",
        headers: TRUSTED_HEADERS,
      })
      expect(res.statusCode).toBe(400)
    })

    it("심볼릭 링크 댓글 파일은 목록·단건에서 건너뛴다", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sched-evil-"))
      try {
        const evilId = generateScheduleCommentId(new Date("2026-11-24T11:00:00Z"))
        const evilTarget = path.join(outside, "evil.json")
        fs.writeFileSync(
          evilTarget,
          JSON.stringify({
            schemaVersion: 1,
            id: evilId,
            scheduleId,
            scheduleTitle: "x",
            targetRole: null,
            sourceDocPath: null,
            author: "portal",
            action: "comment",
            body: "evil",
            createdAt: new Date().toISOString(),
          }),
        )
        fs.symlinkSync(evilTarget, path.join(commentsDir, `${evilId}.json`))
        const listed = listScheduleComments(root, scheduleId, process.env)
        expect(listed.some((c) => c.id === evilId)).toBe(false)
        expect(readScheduleComment(root, evilId, process.env)).toBe(null)
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
        for (const f of fs.readdirSync(commentsDir)) {
          try {
            if (fs.lstatSync(path.join(commentsDir, f)).isSymbolicLink()) {
              fs.unlinkSync(path.join(commentsDir, f))
            }
          } catch {}
        }
      }
    })

    it("DELETE 댓글 삭제 후 목록에서 사라진다", async () => {
      const post = await app.inject({
        method: "POST",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
        payload: JSON.stringify({ body: "지울 댓글" }),
      })
      expect(post.statusCode).toBe(201)
      const created = JSON.parse(post.payload).comment as ScheduleComment

      const del = await app.inject({
        method: "DELETE",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments/${created.id}`,
        headers: TRUSTED_HEADERS,
      })
      expect(del.statusCode).toBe(200)

      const again = await app.inject({
        method: "DELETE",
        url: `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments/${created.id}`,
        headers: TRUSTED_HEADERS,
      })
      expect(again.statusCode).toBe(404)
    })
  })

  describe("통합: 직접 수정·삭제 오버레이", () => {
    let root: string
    let app: Awaited<ReturnType<typeof createServer>>
    let stateDir: string
    let targetId: string

    beforeAll(async () => {
      root = makeAdkRoot()
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sched-state-"))
      process.env.NAIA_SCHEDULE_COMMENTS_DIR = path.join(stateDir, "comments")
      process.env.NAIA_SCHEDULE_OVERRIDES_FILE = path.join(stateDir, "overrides.json")
      app = await makeApp(root)
      targetId = findItemId(root, "오버레이 대상 일정")
    })

    afterAll(async () => {
      delete process.env.NAIA_SCHEDULE_COMMENTS_DIR
      delete process.env.NAIA_SCHEDULE_OVERRIDES_FILE
      await app.close()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(stateDir, { recursive: true, force: true })
    })

    it("PATCH 수정이 readCompanySchedules에 즉시 반영되고 원본 md는 그대로다", async () => {
      const before = fs.readFileSync(
        path.join(root, "docs", "common", "alpha", "schedule.md"),
        "utf-8",
      )
      const res = await app.inject({
        method: "PATCH",
        url: `/api/portal/schedule/company/${encodeURIComponent(targetId)}`,
        headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
        payload: JSON.stringify({ title: "고친 일정 제목", status: "확정" }),
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).ok).toBe(true)

      withEnv({}, () => {
        const listed = readCompanySchedules({
          adkRoot: root,
          from: "2026-11-01",
          to: "2026-11-30",
          env: process.env,
        })
        const item = listed.items.find((it) => it.id === targetId)
        expect(item?.title).toBe("고친 일정 제목")
        expect(item?.status).toBe("확정")
        expect(item?.startDate).toBe("2026-11-19")
      })

      // action=edit 피드백 레코드 기록
      const comments = listScheduleComments(root, targetId, process.env)
      expect(comments.some((c) => c.action === "edit")).toBe(true)

      // 원본 읽기 전용 문서는 건드리지 않음
      expect(
        fs.readFileSync(path.join(root, "docs", "common", "alpha", "schedule.md"), "utf-8"),
      ).toBe(before)
      expect(fs.existsSync(path.join(root, ".agents", "work", "schedule-overrides.json"))).toBe(false)

      // 잘못된 날짜는 400
      const bad = await app.inject({
        method: "PATCH",
        url: `/api/portal/schedule/company/${encodeURIComponent(targetId)}`,
        headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
        payload: JSON.stringify({ startDate: "2026-02-30" }),
      })
      expect(bad.statusCode).toBe(400)
    })

    it("읽기 전용 adkRoot에서도 외부 상태 경로로 수정·삭제가 된다", async () => {
      fs.chmodSync(root, 0o555)
      try {
        const patch = await app.inject({
          method: "PATCH",
          url: `/api/portal/schedule/company/${encodeURIComponent(targetId)}`,
          headers: { ...TRUSTED_HEADERS, "content-type": "application/json" },
          payload: JSON.stringify({ title: "읽기전용에서 고침" }),
        })
        expect(patch.statusCode).toBe(200)
        withEnv({}, () => {
          const listed = readCompanySchedules({
            adkRoot: root,
            from: "2026-11-01",
            to: "2026-11-30",
            env: process.env,
          })
          expect(listed.items.find((it) => it.id === targetId)?.title).toBe("읽기전용에서 고침")
        })
      } finally {
        fs.chmodSync(root, 0o755)
      }
    })

    it("DELETE 삭제가 목록에서 제외하고 action=delete 레코드를 남긴다", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/portal/schedule/company/${encodeURIComponent(targetId)}`,
        headers: TRUSTED_HEADERS,
      })
      expect(res.statusCode).toBe(200)

      withEnv({}, () => {
        const listed = readCompanySchedules({
          adkRoot: root,
          from: "2026-11-01",
          to: "2026-11-30",
          env: process.env,
        })
        expect(listed.items.some((it) => it.id === targetId)).toBe(false)
        const data = readScheduleOverrides(root, process.env)
        expect(data.overrides[targetId]?.deleted).toBe(true)
      })

      const comments = listScheduleComments(root, targetId, process.env)
      expect(comments.some((c) => c.action === "delete")).toBe(true)
    })

    it("심볼릭 링크 오버레이 파일은 무시하고 원본 항목을 그대로 둔다", () => {
      const linkRoot = makeAdkRoot()
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sched-ov-evil-"))
      try {
        const evilTarget = path.join(outside, "evil-overrides.json")
        fs.writeFileSync(evilTarget, JSON.stringify({ schemaVersion: 1, overrides: {} }))
        const linkPath = path.join(outside, "link.json")
        fs.symlinkSync(evilTarget, linkPath)
        const listed = readCompanySchedules({
          adkRoot: linkRoot,
          from: "2026-11-01",
          to: "2026-11-30",
          env: { NAIA_SCHEDULE_OVERRIDES_FILE: linkPath },
        })
        expect(listed.items.length).toBeGreaterThan(0)
        const data = readScheduleOverrides(linkRoot, {
          NAIA_SCHEDULE_OVERRIDES_FILE: linkPath,
        })
        expect(data.overrides).toEqual({})
      } finally {
        fs.rmSync(linkRoot, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})
