import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import {
  clampDateRange,
  parseCompanyScheduleMarkdown,
  parseRegularScheduleYaml,
  readCompanySchedules,
} from "../src/company-schedule.js"

const SAMPLE_SCHEDULE_MD = `# 알파 일정 챙김

갱신: 2026-11-17 02:45 KST (2026-11-16 17:45Z), 알파

## 0. 금주 핵심 일정 (11/15 ~ 11/20)

| 날짜·시각 (KST) | 일 | 준비 상태 | 담당 |
|---|---|---|---|
| **11/15(일)~11/17(화)** | **Azure 9월 청구서 환불 입금 확인** | 회신 대기 | 확인·팔로업 알파, 확인 루크 |
| **11/17(화) \`10:00~12:00\`** | **재도전성공패키지 최종 점검(현장실사, 하남 3층 11호)** | 점검표 완비 | 루크·알파 |
| **11/18(수)까지** | **웹GPU 시연 열쇠 사이트 번들 분리** | 진행 중 | 민호, 챙김 알파 |

## 1. 앞으로 일정 (11/15 일 ~, 날짜순)

| 날짜·시각 (KST) | 일 | 담당 | 근거 | 원문 확인 | 상태 |
|---|---|---|---|---|---|
| 매일 08:30 | 콘텐츠 지표 + 데일리 트렌드 | 나이아 | 정기 일정 | 원문 확인 | 진행 중 |
| 확인 대기 (11/10 이월) | 통장 사본 재전송분 확인 | 알파 | 11/6 요청 | 원문 확인 | 대기 |
| ~~11/26(목) 10:00~12:00~~ (취소) | **경기AI혁신클러스터 스타트업 815 IR Demo Day** | 루크 | 공고 | 원문 확인 | 선정 안 됨 — 취소 |
| 2026-11-20 17:00 | **웹GPU 투자자 공개 시연 종료 점검** | 알파·민호 | 메일 안내 | 원문 확인 | 대기 |
| **12/3(목) 09:00~12:00** (대표님 DM) | **교육청 양평 AX 강의 3시간 「업무자동화」** | 루크·지나 | DM | 원문 확인 | 오전 확정 |
| **12/3(목) 13:00 ~ 12/4(금) 12:00** | **재도전성공패키지 졸업식·네트워킹** | 루크·알파 | 안내문 | 원문 확인 | 정상 참석 |
| **12/30(수)~1/2(토)** | **연말연시 서버 점검** | 민호 | 운영 | 원문 확인 | 예정 |
`

const SAMPLE_REGULAR_YAML = `version: 1
timezone: Asia/Seoul

roles:
  minho:
    label: 민호
    area: 개발·운영
  alpha:
    label: 알파
    area: 사업·연구
  naia:
    label: 나이아
    area: 마케팅

items:
  - { id: retro-daily-alpha, role: alpha, title: "매일 회고", repeat: { every: day }, time: "22:00", state: 있음 }
  - { id: dev-dev-deploy, role: minho, title: "개발 서버 정기 배포", repeat: { every: week, days: [tue, thu] }, time: "15:00", state: 새로 }
  - { id: dev-monthly-cleanup, role: minho, title: "월말 정리", repeat: { every: month, day: last }, state: 새로 }
  - { id: retro-monthly-minho, role: minho, title: "월간 회고", repeat: { every: month, nth: 1, weekday: mon }, time: "19:30", state: 있음 }
  - { id: dev-cost-close, role: minho, title: "비용 결산", repeat: { every: month, week: 1 }, state: 새로 }
  - { id: naia-link-policy, role: naia, title: "링크 정책 재검토", repeat: { once: 2026-11-21 }, state: 있음 }
  - { id: timed-no-repeat, role: minho, title: "아침 스탠드업", times: [09:30, 18:00], state: 있음 }
  - { id: hold-item, role: naia, title: "보류 항목", repeat: { every: day }, state: 보류 }
  - { id: human-item, role: alpha, title: "사람 직접 확인", repeat: { every: day }, state: 사람 }
  - { id: timer-only-partial, role: minho, title: "타이머만 있는 부분 항목", timer: watch.timer, state: 부분 }
`

describe("FT-05: 회사·정기 일정 파서 및 /api/portal/schedule/company", () => {
  it("schedule.md: 단일일·기간·시각 범위·연도 넘김·취소선(~~11/26~~) 제외 및 안정 해시 생성", () => {
    const items = parseCompanyScheduleMarkdown(SAMPLE_SCHEDULE_MD, {
      sourceDocPath: "common/alpha/schedule.md",
      from: "2026-11-01",
      to: "2027-01-10",
    })

    // 취소선 ~~11/26~~ 행은 기본 제외되어야 함
    expect(items.some((it) => it.startDate === "2026-11-26" || it.title.includes("815 IR"))).toBe(false)
    // 날짜 토큰으로 시작하지 않는 "매일 08:30", "확인 대기 (11/10 이월)"는 포함되지 않음
    expect(items.some((it) => it.title.includes("데일리 트렌드"))).toBe(false)
    expect(items.some((it) => it.title.includes("통장 사본"))).toBe(false)

    // 기간 일정
    const rangeItem = items.find((it) => it.title.includes("Azure 9월 청구서"))
    expect(rangeItem).toMatchObject({
      startDate: "2026-11-15",
      endDate: "2026-11-17",
      kind: "company",
      sourceDocPath: "common/alpha/schedule.md",
    })
    expect(rangeItem?.id).toMatch(/^company:md:[0-9a-f]{12}$/)

    // 단일일 + 백틱 시각 범위
    const onsite = items.find((it) => it.title.includes("재도전성공패키지 최종 점검"))
    expect(onsite).toMatchObject({
      startDate: "2026-11-17",
      endDate: "2026-11-17",
      startTime: "10:00",
      endTime: "12:00",
      role: "루크·알파",
    })

    // ~까지 단일일
    const webgpuKey = items.find((it) => it.title.includes("웹GPU 시연 열쇠"))
    expect(webgpuKey).toMatchObject({
      startDate: "2026-11-18",
      endDate: "2026-11-18",
    })

    // 명시 연도 + 단일 시각
    const isoTimed = items.find((it) => it.title.includes("공개 시연 종료"))
    expect(isoTimed).toMatchObject({
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      startTime: "17:00",
    })

    // 한국식 날짜 + 시각 범위 + 뒤쪽 괄호 메모 무시
    const lecture = items.find((it) => it.title.includes("양평 AX 강의"))
    expect(lecture).toMatchObject({
      startDate: "2026-12-03",
      endDate: "2026-12-03",
      startTime: "09:00",
      endTime: "12:00",
    })

    // 여러 날 + 시작/끝 시각
    const graduation = items.find((it) => it.title.includes("졸업식"))
    expect(graduation).toMatchObject({
      startDate: "2026-12-03",
      endDate: "2026-12-04",
      startTime: "13:00",
      endTime: "12:00",
    })

    // 12/30 ~ 1/2 연도 넘김
    const yearCross = items.find((it) => it.title.includes("연말연시"))
    expect(yearCross).toMatchObject({
      startDate: "2026-12-30",
      endDate: "2027-01-02",
    })

    // includeCanceled=true 시 취소선 행을 canceled로 포함
    const withCanceled = parseCompanyScheduleMarkdown(SAMPLE_SCHEDULE_MD, {
      sourceDocPath: "common/alpha/schedule.md",
      from: "2026-11-01",
      to: "2026-11-30",
      includeCanceled: true,
    })
    const canceledItem = withCanceled.find((it) => it.startDate === "2026-11-26")
    expect(canceledItem?.status).toBe("canceled")
  })

  it("regular-schedule.yaml: 요일별·월말·첫째주 월요일·특정일 투영, 상태 필터 및 62일 클램프", () => {
    const items = parseRegularScheduleYaml(SAMPLE_REGULAR_YAML, {
      sourceDocPath: "common/team/regular-schedule.yaml",
      from: "2026-11-01",
      to: "2026-11-30",
    })

    // 보류/사람/부분 상태는 기본 제외
    expect(items.some((it) => it.title === "보류 항목")).toBe(false)
    expect(items.some((it) => it.title === "사람 직접 확인")).toBe(false)
    expect(items.some((it) => it.title === "타이머만 있는 부분 항목")).toBe(false)

    // 매일 회고: 11월 30일 전 날짜 투영 + 역할 레이블 매핑
    const dailyRetro = items.filter((it) => it.id.startsWith("company:reg:retro-daily-alpha:"))
    expect(dailyRetro).toHaveLength(30)
    expect(dailyRetro[0]).toMatchObject({
      id: "company:reg:retro-daily-alpha:2026-11-01",
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      startTime: "22:00",
      role: "alpha",
      roleLabel: "알파",
      state: "있음",
      kind: "regular",
      sourceDocPath: "common/team/regular-schedule.yaml",
    })

    // 화·목 배포 (2026-11: 3,5,10,12,17,19,24,26 -> 8회)
    const deploys = items.filter((it) => it.id.startsWith("company:reg:dev-dev-deploy:"))
    expect(deploys.map((d) => d.startDate)).toEqual([
      "2026-11-03",
      "2026-11-05",
      "2026-11-10",
      "2026-11-12",
      "2026-11-17",
      "2026-11-19",
      "2026-11-24",
      "2026-11-26",
    ])

    // 월말 정리 (day: last -> 2026-11-30)
    const monthEnd = items.filter((it) => it.id.startsWith("company:reg:dev-monthly-cleanup:"))
    expect(monthEnd.map((d) => d.startDate)).toEqual(["2026-11-30"])

    // 첫째 월요일 (2026-11-02)
    const firstMon = items.filter((it) => it.id.startsWith("company:reg:retro-monthly-minho:"))
    expect(firstMon.map((d) => d.startDate)).toEqual(["2026-11-02"])

    // month + week: 1 -> 첫째 주 월요일(2026-11-02)
    const monthWeek1 = items.filter((it) => it.id.startsWith("company:reg:dev-cost-close:"))
    expect(monthWeek1.map((d) => d.startDate)).toEqual(["2026-11-02"])

    // once: 2026-11-21
    const onceItems = items.filter((it) => it.id.startsWith("company:reg:naia-link-policy:"))
    expect(onceItems.map((d) => d.startDate)).toEqual(["2026-11-21"])

    // repeat 없이 times만 있는 항목
    const timedOnly = items.filter((it) => it.id.startsWith("company:reg:timed-no-repeat:"))
    expect(timedOnly).toHaveLength(30)
    expect(timedOnly[0].startTime).toBe("09:30")
    expect(timedOnly[0].times).toEqual(["09:30", "18:00"])

    // 62일 상한 클램프 검증
    const clampedRange = clampDateRange("2026-11-01", "2027-06-01")
    expect(clampedRange.ok).toBe(true)
    if (clampedRange.ok) {
      expect(clampedRange.clamped).toBe(true)
      expect(clampedRange.to).toBe("2027-01-01")
    }
    const clampedItems = parseRegularScheduleYaml(SAMPLE_REGULAR_YAML, {
      sourceDocPath: "common/team/regular-schedule.yaml",
      from: "2026-11-01",
      to: "2027-06-01",
    })
    const clampedDaily = clampedItems.filter((it) => it.id.startsWith("company:reg:retro-daily-alpha:"))
    expect(clampedDaily).toHaveLength(62)
  })

  describe("보안 가드 · 폴백 · Fastify 라우트 통합 시험", () => {
    let tempRoot: string
    let emptyRoot: string
    let outsideDir: string

    beforeAll(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-sched-"))
      emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-empty-"))
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-outside-"))

      fs.mkdirSync(path.join(tempRoot, "docs", "common", "alpha"), { recursive: true })
      fs.mkdirSync(path.join(tempRoot, "docs", "common", "team"), { recursive: true })
      fs.writeFileSync(path.join(tempRoot, "docs", "common", "alpha", "schedule.md"), SAMPLE_SCHEDULE_MD, "utf-8")
      fs.writeFileSync(
        path.join(tempRoot, "docs", "common", "team", "regular-schedule.yaml"),
        SAMPLE_REGULAR_YAML,
        "utf-8",
      )

      fs.writeFileSync(
        path.join(outsideDir, "secret.md"),
        "| 날짜 | 일 |\n|---|---|\n| 11/18(수) | SECRET_LEAK_MD |\n",
        "utf-8",
      )
      fs.writeFileSync(
        path.join(outsideDir, "secret.yaml"),
        "items:\n  - { id: leak, role: minho, title: SECRET_LEAK_YAML, repeat: { every: day }, state: 있음 }\n",
        "utf-8",
      )
    })

    afterAll(() => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        fs.rmSync(emptyRoot, { recursive: true, force: true })
        fs.rmSync(outsideDir, { recursive: true, force: true })
      } catch {}
    })

    it("파일 부재 시 200 빈 배열로 안전 폴백한다", async () => {
      const app = await createServer({ root: emptyRoot, port: 0, host: "127.0.0.1" })
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-11-01&to=2026-11-30",
          headers: { host: "localhost:0" },
        })
        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.payload)
        expect(json.items).toEqual([])
        expect(json.sources).toEqual({ companyDocPath: null, regularDocPath: null })
      } finally {
        await app.close()
      }
    })

    it("심볼릭 링크·하드 링크·경로 탈출을 차단하고 바깥 내용이 새지 않는다", () => {
      const symRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-sym-"))
      try {
        fs.mkdirSync(path.join(symRoot, "docs", "common", "alpha"), { recursive: true })
        fs.mkdirSync(path.join(symRoot, "docs", "common", "team"), { recursive: true })
        fs.symlinkSync(
          path.join(outsideDir, "secret.md"),
          path.join(symRoot, "docs", "common", "alpha", "schedule.md"),
        )
        fs.symlinkSync(
          path.join(outsideDir, "secret.yaml"),
          path.join(symRoot, "docs", "common", "team", "regular-schedule.yaml"),
        )

        const blockedSym = readCompanySchedules({
          adkRoot: symRoot,
          from: "2026-11-01",
          to: "2026-11-30",
          env: {},
        })
        expect(blockedSym.items).toEqual([])

        // 경로 탈출 환경변수 차단 (../outside/secret.md 및 data-private)
        const escaped = readCompanySchedules({
          adkRoot: emptyRoot,
          from: "2026-11-01",
          to: "2026-11-30",
          env: {
            NAIA_COMPANY_SCHEDULE_FILE: `../${path.basename(outsideDir)}/secret.md`,
            NAIA_REGULAR_SCHEDULE_FILE: "data-private/secret.yaml",
          },
        })
        expect(escaped.items).toEqual([])

        // 하드 링크(nlink > 1) 차단
        const hardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-hard-"))
        try {
          fs.mkdirSync(path.join(hardRoot, "docs", "common", "alpha"), { recursive: true })
          fs.mkdirSync(path.join(hardRoot, "docs", "common", "team"), { recursive: true })
          fs.linkSync(
            path.join(outsideDir, "secret.md"),
            path.join(hardRoot, "docs", "common", "alpha", "schedule.md"),
          )
          fs.linkSync(
            path.join(outsideDir, "secret.yaml"),
            path.join(hardRoot, "docs", "common", "team", "regular-schedule.yaml"),
          )
          const blockedHard = readCompanySchedules({
            adkRoot: hardRoot,
            from: "2026-11-01",
            to: "2026-11-30",
            env: {},
          })
          expect(blockedHard.items).toEqual([])
        } finally {
          fs.rmSync(hardRoot, { recursive: true, force: true })
        }

        // 유효한 환경변수 오버라이드(adkRoot 안의 커스텀 경로) 허용
        const customRes = readCompanySchedules({
          adkRoot: tempRoot,
          from: "2026-11-01",
          to: "2026-11-30",
          env: {
            NAIA_COMPANY_SCHEDULE_FILE: "docs/common/alpha/schedule.md",
            NAIA_REGULAR_SCHEDULE_FILE: path.join(tempRoot, "docs", "common", "team", "regular-schedule.yaml"),
          },
        })
        expect(customRes.sources).toEqual({
          companyDocPath: "common/alpha/schedule.md",
          regularDocPath: "common/team/regular-schedule.yaml",
        })
        expect(customRes.items.length).toBeGreaterThan(10)
      } finally {
        fs.rmSync(symRoot, { recursive: true, force: true })
      }
    })

    it("GET /api/portal/schedule/company 라우트가 결합 항목·62일 클램프·400/403 검사를 수행한다", async () => {
      const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-11-01&to=2026-12-05",
          headers: { host: "localhost:0" },
        })
        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.payload)
        expect(json.from).toBe("2026-11-01")
        expect(json.to).toBe("2026-12-05")
        expect(json.sources).toEqual({
          companyDocPath: "common/alpha/schedule.md",
          regularDocPath: "common/team/regular-schedule.yaml",
        })
        expect(json.items.some((it: any) => it.kind === "company" && it.title.includes("양평 AX 강의"))).toBe(true)
        expect(json.items.some((it: any) => it.kind === "regular" && it.id === "company:reg:naia-link-policy:2026-11-21")).toBe(true)
        expect(json.items.some((it: any) => it.startDate === "2026-11-26" && it.title.includes("815 IR"))).toBe(false)

        // 62일 초과 요청 클램프
        const longRes = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-11-01&to=2027-05-01",
          headers: { host: "localhost:0" },
        })
        expect(longRes.statusCode).toBe(200)
        const longJson = JSON.parse(longRes.payload)
        expect(longJson.to).toBe("2027-01-01")

        // 잘못된 날짜 / 역전 범위 400
        const badDate = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-02-30&to=2026-03-05",
          headers: { host: "localhost:0" },
        })
        expect(badDate.statusCode).toBe(400)

        const reversed = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-11-20&to=2026-11-10",
          headers: { host: "localhost:0" },
        })
        expect(reversed.statusCode).toBe(400)

        // cross-site 차단 403
        const crossSite = await app.inject({
          method: "GET",
          url: "/api/portal/schedule/company?from=2026-11-01&to=2026-11-30",
          headers: { host: "localhost:0", "sec-fetch-site": "cross-site" },
        })
        expect(crossSite.statusCode).toBe(403)
      } finally {
        await app.close()
      }
    })

    it("기본 후보 docs/common/schedule.md 폴백 및 표준 일정 표 원문 파싱 호환성 확인", () => {
      const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-company-fallback-"))
      try {
        fs.mkdirSync(path.join(fallbackRoot, "docs", "common"), { recursive: true })
        fs.writeFileSync(
          path.join(fallbackRoot, "docs", "common", "schedule.md"),
          "| 날짜 | 일정 | 담당 | 상태 |\n|---|---|---|---|\n| 11/18(수) | 대체 파일 일정 | 알파 | 확정 |\n",
          "utf-8",
        )
        const res = readCompanySchedules({
          adkRoot: fallbackRoot,
          from: "2026-11-01",
          to: "2026-11-30",
          env: {},
        })
        expect(res.sources.companyDocPath).toBe("common/schedule.md")
        expect(res.items).toHaveLength(1)
        expect(res.items[0].title).toBe("대체 파일 일정")
      } finally {
        fs.rmSync(fallbackRoot, { recursive: true, force: true })
      }
    })
  })
})
