import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { NotesBanner, NotesPanel, createNote, updateNote, deleteNote } from "./NotesPanel.tsx"
import { MSG_FORBIDDEN, MSG_QUOTE_WHOLE_DOC, type DocNoteItem } from "./kinds.ts"

describe("NotesBanner 렌더 시험 (SP-05)", () => {
  it("열린 메모가 없으면 배너를 그리지 않는다", () => {
    const html = renderToStaticMarkup(<NotesBanner openNotes={[]} tab="common" />)
    assert.equal(html, "")
  })

  it("열린 메모가 있으면 화면 위 한 줄 안내를 그린다", () => {
    const notes: DocNoteItem[] = [
      {
        id: "1",
        source: "adk",
        path: "guide.md",
        quote: null,
        body: "수정 제안",
        status: "open",
        reply: null,
        createdAt: "2026-09-26T10:00:00Z",
        updatedAt: "2026-09-26T10:00:00Z",
        resolvedAt: null,
      },
    ]
    const html = renderToStaticMarkup(<NotesBanner openNotes={notes} tab="common" />)
    assert.ok(html.includes("열린 메모 1건 · AI에게 &#x27;메모 처리해&#x27;라고 말하면 처리합니다"))
  })
})

describe("NotesPanel 렌더 시험 (SP-05, SP-06)", () => {
  const sampleNotes: DocNoteItem[] = [
    {
      id: "note-open",
      source: "adk",
      path: "guide.md",
      quote: "특정 문장 인용",
      body: "이 부분을 고쳐 주세요",
      status: "open",
      reply: null,
      createdAt: "2026-09-26T10:00:00Z",
      updatedAt: "2026-09-26T10:00:00Z",
      resolvedAt: null,
    },
    {
      id: "note-resolved",
      source: "adk",
      path: "guide.md",
      quote: null,
      body: "이미 고쳐진 메모",
      status: "resolved",
      reply: "수정 완료했습니다.",
      createdAt: "2026-09-25T10:00:00Z",
      updatedAt: "2026-09-25T12:00:00Z",
      resolvedAt: "2026-09-25T12:00:00Z",
    },
  ]

  it("열린 메모에는 [고치기][지우기]가 있고, 처리된 메모에는 [다시 열기]와 AI 답변이 있다", () => {
    const html = renderToStaticMarkup(
      <NotesPanel source="adk" path="guide.md" notes={sampleNotes} />,
    )

    // 열린 메모 영역
    assert.ok(html.includes("열림"))
    assert.ok(html.includes("&quot;특정 문장 인용&quot;"))
    assert.ok(html.includes("이 부분을 고쳐 주세요"))
    assert.ok(html.includes("고치기"))
    assert.ok(html.includes("지우기"))

    // 처리된 메모 영역
    assert.ok(html.includes("처리됨"))
    assert.ok(html.includes(MSG_QUOTE_WHOLE_DOC))
    assert.ok(html.includes("이미 고쳐진 메모"))
    assert.ok(html.includes("다시 열기"))
    assert.ok(html.includes("AI 답변"))
    assert.ok(html.includes("수정 완료했습니다."))
  })

  it("SP-06 forbidden 상태에서는 안내 문구가 표시되고 버튼이 제한된다", () => {
    const html = renderToStaticMarkup(
      <NotesPanel source="adk" path="guide.md" notes={sampleNotes} forbidden={true} />,
    )

    assert.ok(html.includes(MSG_FORBIDDEN))
    assert.ok(!html.includes("고치기"))
    assert.ok(!html.includes("지우기"))
    assert.ok(!html.includes("다시 열기"))
  })
})

describe("Notes API 함수 동작 시험", () => {
  it("createNote: 인용이 없으면 quote: null로 POST 전송", async () => {
    let capturedBody = ""
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedBody = String(init?.body ?? "")
      return new Response(JSON.stringify({ ok: true, note: { id: "new-id" } }), { status: 200 })
    }

    const res = await createNote({
      source: "adk",
      path: "test.md",
      quote: null,
      body: "내용",
      fetchFn: fakeFetch,
    })

    assert.equal(res.ok, true)
    const parsed = JSON.parse(capturedBody)
    assert.equal(parsed.quote, null)
    assert.equal(parsed.body, "내용")
  })

  it("updateNote: status와 body를 올바르게 PATCH 전송", async () => {
    let capturedMethod = ""
    let capturedBody = ""
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedMethod = init?.method ?? ""
      capturedBody = String(init?.body ?? "")
      return new Response(JSON.stringify({ ok: true, note: { id: "1", status: "open" } }), {
        status: 200,
      })
    }

    const res = await updateNote({
      id: "1",
      status: "open",
      fetchFn: fakeFetch,
    })

    assert.equal(res.ok, true)
    assert.equal(capturedMethod, "PATCH")
    const parsed = JSON.parse(capturedBody)
    assert.equal(parsed.status, "open")
  })

  it("deleteNote: DELETE 요청 전송", async () => {
    let capturedMethod = ""
    let capturedUrl = ""
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedMethod = init?.method ?? ""
      capturedUrl = String(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const res = await deleteNote({ id: "note-123", fetchFn: fakeFetch })
    assert.equal(res.ok, true)
    assert.equal(capturedMethod, "DELETE")
    assert.ok(capturedUrl.includes("/api/portal/notes/note-123"))
  })
})
