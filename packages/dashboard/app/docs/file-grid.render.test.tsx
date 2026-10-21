import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { FileView } from "./FileView.tsx"
import { FolderGrid } from "./FolderGrid.tsx"
import {
  MSG_FORBIDDEN,
  MSG_TRUNCATED_GRID,
  MSG_TRUNCATED_TEXT,
  MSG_UNSUPPORTED_PREVIEW,
} from "./kinds.ts"

describe("FileView 렌더 시험 (SP-03)", () => {
  it("그림 파일 보기: 이미지 태그와 주소 속성에 /api/portal/asset이 있고 내려받기 링크 포함", () => {
    const html = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="assets/logo.png"
        tab="common"
        size={2048}
        kind="image"
      />,
    )

    // 파일 이름과 크기가 보이는 글에 있음
    assert.ok(html.includes("logo.png"))
    assert.ok(html.includes("2 KB"))

    // 주소 속성에 /api/portal/asset 포함
    assert.ok(html.includes('src="/api/portal/asset?source=adk&amp;path=assets%2Flogo.png"'))
    assert.ok(
      html.includes('href="/api/portal/asset?source=adk&amp;path=assets%2Flogo.png&amp;download=1"'),
    )
    assert.ok(html.includes("내려받기"))

    // 보이는 텍스트에 경로나 API 누출 없음
    assert.ok(!html.includes(">assets/logo.png<"))
    assert.ok(!html.includes(">/api/"))
  })

  it("글자 파일 보기: 앞 1MB 문구는 truncated===true일 때만 표시", () => {
    const htmlNormal = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="config.json"
        tab="developer"
        size={100}
        kind="text"
        textContent='{"key": "value"}'
        textTruncated={false}
      />,
    )
    assert.ok(!htmlNormal.includes(MSG_TRUNCATED_TEXT))

    const htmlTruncated = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="config.json"
        tab="developer"
        size={2000000}
        kind="text"
        textContent='{"key": "value"}'
        textTruncated={true}
      />,
    )
    assert.ok(htmlTruncated.includes(MSG_TRUNCATED_TEXT))
  })

  it("PDF 파일 보기: object 태그와 /api/portal/asset 주소 및 내려받기 링크", () => {
    const html = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="manual.pdf"
        tab="developer"
        size={50000}
        kind="pdf"
      />,
    )
    assert.ok(html.includes('data="/api/portal/asset?source=adk&amp;path=manual.pdf"'))
    assert.ok(html.includes("내려받기"))
  })

  it("기타 파일 보기: 미리 볼 수 없는 파일입니다 문구와 내려받기", () => {
    const html = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="archive.zip"
        tab="developer"
        size={10240}
        kind="other"
      />,
    )
    assert.ok(html.includes(MSG_UNSUPPORTED_PREVIEW))
    assert.ok(html.includes("내려받기"))
  })
})

describe("FolderGrid 렌더 시험 (SP-02, SP-06)", () => {
  it("폴더 격자: 대표 그림, 그림 칸, 항목 수 표시", () => {
    const entries = [
      { name: "subfolder", path: "images/subfolder", type: "directory" as const, cover: "images/subfolder/c.png" },
      { name: "photo.jpg", path: "images/photo.jpg", type: "file" as const, kind: "image" as const, size: 4096 },
      { name: "data.csv", path: "images/data.csv", type: "file" as const, kind: "text" as const, size: 1024 },
    ]

    const html = renderToStaticMarkup(
      <FolderGrid
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="images"
        tab="common"
        entries={entries}
        total={3}
      />,
    )

    // 항목 수 표시
    assert.ok(html.includes("3개 항목"))
    // 대표 그림 주소 포함
    assert.ok(html.includes('src="/api/portal/asset?source=adk&amp;path=images%2Fsubfolder%2Fc.png"'))
    // 그림 칸 주소 포함
    assert.ok(html.includes('src="/api/portal/asset?source=adk&amp;path=images%2Fphoto.jpg"'))
    // 파일명만 보이고 전체 경로는 텍스트에 없음
    assert.ok(html.includes(">subfolder<"))
    assert.ok(html.includes(">photo.jpg<"))
    assert.ok(html.includes(">data.csv<"))
    assert.ok(!html.includes(">images/photo.jpg<"))
  })

  it("500개 초과 문구는 truncated===true일 때만 표시", () => {
    const htmlNormal = renderToStaticMarkup(
      <FolderGrid
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="items"
        tab="common"
        entries={[{ name: "a.txt", path: "items/a.txt", type: "file" }]}
        total={1}
        truncated={false}
      />,
    )
    assert.ok(!htmlNormal.includes(MSG_TRUNCATED_GRID))

    const htmlTruncated = renderToStaticMarkup(
      <FolderGrid
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="items"
        tab="common"
        entries={[{ name: "a.txt", path: "items/a.txt", type: "file" }]}
        total={550}
        truncated={true}
      />,
    )
    assert.ok(htmlTruncated.includes(MSG_TRUNCATED_GRID))
  })

  it("SP-06 403 상태일 때는 격자 대신 안내 한 줄 표시", () => {
    const html = renderToStaticMarkup(
      <FolderGrid
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="restricted"
        tab="common"
        entries={[{ name: "secret.txt", path: "restricted/secret.txt", type: "file" }]}
        forbidden={true}
      />,
    )
    assert.ok(html.includes(MSG_FORBIDDEN))
    assert.ok(!html.includes("secret.txt"))
  })
})
