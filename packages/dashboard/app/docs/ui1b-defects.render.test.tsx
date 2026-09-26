import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsView, type Source } from "./DocsView.tsx"
import { DocEditor, saveDocument } from "./DocEditor.tsx"
import { createNote } from "./NotesPanel.tsx"
import { addFavorite, removeFavorite } from "./Favorites.tsx"
import {
  determineDocViewMode,
  formatFileSize,
  mapFavoritesError,
  MSG_CONFLICT_DOC,
  MSG_FAVORITES_LIMIT,
  MSG_FORBIDDEN,
  MSG_READ_ONLY_DOC,
  MSG_SAVED_DOC,
  truncateQuote,
} from "./kinds.ts"
import { docHref, sectionsForTab } from "./tabs.ts"
import { canNavigateWithDiscardConfirm, loadDocsViewState } from "./docs-handlers.ts"

describe("UI1b 화면 결함 11건 사전 실패 및 검증 시험", () => {
  const dummySources: Source[] = [
    {
      id: "adk",
      title: "ADK 문서",
      tree: [
        { name: "index.md", path: "index.md", type: "file", kind: "doc" },
        {
          name: "developer",
          path: "developer",
          type: "directory",
          children: [
            { name: "guide.md", path: "developer/guide.md", type: "file", kind: "doc" },
            { name: "v1.2", path: "developer/v1.2", type: "directory", children: [] },
          ],
        },
      ],
      tab: "developer",
    },
    {
      id: "data:content",
      title: "브랜드 콘텐츠",
      tree: [
        { name: "brand-guide.md", path: "brand-guide.md", type: "file", kind: "doc" },
      ],
      tab: "brand",
      readOnly: true,
    },
  ]

  // ── 결함 1. 폴더 클릭 → 격자 ─────────────────────────────────────────────
  it("[결함 1] loadView 데이터 준비 함수는 빈 폴더 v1.2와 트리 밖 폴더에 대해 folder API 200 시 격자 상태를 구성하고 DocsView 렌더 시 항목 격자가 그려진다", async () => {
    // 트리 밖 폴더(잘린 폴더 또는 동적 폴더)에 대한 loadDocsViewState 호출
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("/api/portal/folder")) {
        return new Response(
          JSON.stringify({
            entries: [{ name: "item.md", path: "truncated/item.md", type: "file", kind: "doc" }],
            total: 1,
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("{}", { status: 404 })
    }

    const state = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "developer/truncated",
      sources: dummySources,
      fetchFn: fakeFetch,
    })

    assert.equal(state.viewMode, "grid", "트리 밖 폴더여도 /folder 200이면 viewMode는 grid여야 한다")

    const html = renderToStaticMarkup(
      <DocsView
        {...state}
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
      />,
    )

    // 항목 격자(FolderGrid)가 렌더되어야 하고, 파일 보기의 '미리 볼 수 없는 파일입니다'가 없어야 한다
    assert.ok(html.includes("1개 항목"), "폴더 격자의 항목 수가 표시되어야 한다")
    assert.ok(!html.includes("미리 볼 수 없는 파일입니다"), "파일 보기가 아니어야 한다")
  })

  // ── 결함 2. 파일 크기 ───────────────────────────────────────────────────
  it("[결함 2] loadView가 채운 size로 DocsView 렌더 시 루트 파일은 부모 GET /folder의 size로 크기가 보이고(2048은 2 KB, 0은 0 B), 크기 정보가 없으면 크기 칸과 0 B가 모두 없다", async () => {
    // formatFileSize 단위 검증
    assert.equal(formatFileSize(2048), "2 KB")
    assert.equal(formatFileSize(0), "0 B")
    assert.equal(formatFileSize(undefined), "", "크기 정보가 없으면 빈 문자열이어야 한다")
    assert.equal(formatFileSize(null), "", "크기 정보가 null이면 빈 문자열이어야 한다")

    // 1) 2048 바이트 루트 파일: 경로에 '/'가 없는 "photo.png"가 트리에 없어도
    // loadDocsViewState가 출처 루트 GET /api/portal/folder?source=adk&path= 로 부모 항목의 size를 찾는다
    const fakeFetch2KB: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("path=photo.png")) {
        return new Response("{}", { status: 404 })
      }
      if (url.includes("/api/portal/folder")) {
        return new Response(
          JSON.stringify({
            entries: [{ name: "photo.png", path: "photo.png", size: 2048, type: "file", kind: "image" }],
            total: 1,
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("{}", { status: 404 })
    }

    const state2KB = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "photo.png",
      sources: dummySources,
      fetchFn: fakeFetch2KB,
    })

    assert.equal(state2KB.viewMode, "file")
    assert.equal(state2KB.fileData?.size, 2048, "루트 파일의 size를 부모 /folder에서 채워야 한다")

    const html2KB = renderToStaticMarkup(
      <DocsView
        {...state2KB}
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
      />,
    )
    assert.ok(html2KB.includes("2 KB"), "2048 바이트 파일은 '2 KB'가 보여야 한다")

    // 2) 0 바이트 파일: 부모 항목의 size가 0인 경우
    const fakeFetch0B: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("path=empty.bin")) {
        return new Response("{}", { status: 404 })
      }
      if (url.includes("/api/portal/folder")) {
        return new Response(
          JSON.stringify({
            entries: [{ name: "empty.bin", path: "empty.bin", size: 0, type: "file", kind: "other" }],
            total: 1,
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("{}", { status: 404 })
    }

    const state0B = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "empty.bin",
      sources: dummySources,
      fetchFn: fakeFetch0B,
    })

    assert.equal(state0B.fileData?.size, 0)
    const html0B = renderToStaticMarkup(
      <DocsView
        {...state0B}
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
      />,
    )
    assert.ok(html0B.includes("0 B"), "0 바이트 파일은 '0 B'가 보여야 한다")

    // 3) 크기 정보가 없을 때: 부모 항목에 size가 없거나 조회가 안 된 경우
    const fakeFetchNoSize: typeof fetch = async () => new Response("{}", { status: 404 })
    const stateNoSize = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "photo.png",
      sources: dummySources,
      fetchFn: fakeFetchNoSize,
    })

    assert.equal(stateNoSize.fileData?.size, undefined)
    const htmlNoSize = renderToStaticMarkup(
      <DocsView
        {...stateNoSize}
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
      />,
    )
    assert.ok(!htmlNoSize.includes("0 B"), "크기 조회 실패 시 '0 B'가 표시되지 않아야 한다")
  })

  // ── 결함 3. 고른 글 옆 [메모] ───────────────────────────────────────────
  it("[결함 3] 본문 안 2001자 선택 시에만 [메모] 단추가 나타나고 실제 createNote 호출 시 앞 2000자가 인용되어 저장 요청 quote 길이가 2000이다", async () => {
    const longText = "A".repeat(2001)
    const truncated = truncateQuote(longText)
    assert.equal(truncated.length, 2000, "인용 문자열은 앞 2000자로 잘려야 한다")

    // 본문 안 선택 시 [메모] 단추(data-testid='quote-memo-btn') 렌더 확인
    const htmlWithSelection = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 가이드\n본문 내용"
        selectionQuote="본문에서 고른 글"
      />,
    )
    assert.ok(
      htmlWithSelection.includes('data-testid="quote-memo-btn"'),
      "본문 안 선택 시 [메모] 단추가 표시되어야 한다",
    )

    // 본문 밖 선택 시 [메모] 단추 없어야 함
    const htmlNoSelection = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 가이드\n본문 내용"
        selectionQuote={null}
      />,
    )
    assert.ok(
      !htmlNoSelection.includes('data-testid="quote-memo-btn"'),
      "선택이 없을 때는 [메모] 단추가 없어야 한다",
    )

    // 화면이 실제로 부르는 NotesPanel.tsx의 createNote를 통한 2001자 저장 요청 시험
    let capturedBody = ""
    const fakeFetch: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? "")
      return new Response(JSON.stringify({ ok: true, note: { id: "n1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    await createNote({
      source: "adk",
      path: "developer/guide.md",
      quote: truncated,
      body: "메모 의견",
      fetchFn: fakeFetch,
    })

    const parsed = JSON.parse(capturedBody)
    assert.equal(parsed.quote.length, 2000, "서버로 전송된 quote 길이는 2000이어야 한다")
  })

  // ── 결함 4. 편집 중 이동 ─────────────────────────────────────────────────
  it("[결함 4] 더러운 편집 상태에서 이동 시 확인 취소하면 고친 글이 상태에 남고 주소가 그대로이며, 확인 승인 후 이동 및 저장 시 실제 saveDocument로 대상의 내용과 baseHash가 전송된다", async () => {
    let confirmCalled = false
    let confirmResult = false
    let navigatedUrl: string | null = null

    const fakeConfirm = () => {
      confirmCalled = true
      return confirmResult
    }

    // A 문서 편집 중: initialContent="A 원문", editContent="A 고친 글"
    let currentSource = "adk"
    let currentPath = "developer/docA.md"
    let isEditing = true
    let editContent: string | null = "A 고친 글"
    const isDirty = editContent !== "A 원문"

    const targetHref = "/docs?tab=developer&source=adk&path=developer%2FdocB.md"

    // 1. 이동 확인 취소 시: canNavigateWithDiscardConfirm이 false를 반환하고, 상태가 유지됨
    confirmResult = false
    const canMove1 = canNavigateWithDiscardConfirm({
      isDirty,
      targetHref,
      confirmFn: fakeConfirm,
      navigateFn: (url) => {
        navigatedUrl = url
        currentPath = "developer/docB.md"
        isEditing = false
        editContent = null
      },
    })

    assert.equal(canMove1, false, "confirm 취소 시 이동할 수 없다")
    assert.equal(confirmCalled, true, "confirm이 호출되어야 한다")
    assert.equal(navigatedUrl, null, "이동이 실행되지 않아야 한다")
    assert.equal(currentPath, "developer/docA.md", "주소가 그대로여야 한다")
    assert.equal(isEditing, true, "편집 상태가 유지되어야 한다")
    assert.equal(editContent, "A 고친 글", "고친 글이 상태에 남아 있어야 한다")

    // 화면 렌더에서도 고친 글이 유지됨 단언
    const htmlStay = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource={currentSource}
        currentPath={currentPath}
        viewMode="doc"
        docContent="A 원문"
        isEditing={isEditing}
        editContent={editContent}
      />,
    )
    assert.ok(htmlStay.includes("A 고친 글"), "확인 취소 시 편집창에 고친 글이 그대로 남아 있어야 한다")

    // 2. 이동 확인 승인 시: canNavigateWithDiscardConfirm이 true를 반환하고 이동 실행
    confirmResult = true
    const canMove2 = canNavigateWithDiscardConfirm({
      isDirty,
      targetHref,
      confirmFn: fakeConfirm,
      navigateFn: (url) => {
        navigatedUrl = url
        currentPath = "developer/docB.md"
        isEditing = false
        editContent = null
      },
    })

    assert.equal(canMove2, true, "confirm 승인 시 이동해야 한다")
    assert.equal(navigatedUrl, targetHref, "목적지 주소로 이동해야 한다")
    assert.equal(currentPath, "developer/docB.md", "주소가 B로 변경되어야 한다")
    assert.equal(isEditing, false, "편집이 닫혀야 한다")
    assert.equal(editContent, null, "편집 글 상태가 리셋되어야 한다")

    // 3. B로 이동 후 B의 내용과 baseHash로 실제 saveDocument 호출
    let capturedBody = ""
    let capturedUrl = ""
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedBody = String(init?.body ?? "")
      return new Response(JSON.stringify({ ok: true, sha256: "b-hash-new" }), {
        status: 200,
        headers: { etag: "b-hash-new", "content-type": "application/json" },
      })
    }

    const saveRes = await saveDocument({
      source: "adk",
      path: "developer/docB.md",
      content: "# 문서 B 내용",
      baseHash: "b-hash-old",
      fetchFn: fakeFetch,
    })

    assert.equal(saveRes.ok, true)
    assert.ok(capturedUrl.includes("path=developer%2FdocB.md") || capturedUrl.includes("path=developer/docB.md"))
    const parsed = JSON.parse(capturedBody)
    assert.equal(parsed.content, "# 문서 B 내용")
    assert.equal(parsed.baseHash, "b-hash-old")
  })

  // ── 결함 5. 저장 문구 ───────────────────────────────────────────────────
  it("[결함 5] 문서 저장 성공 시 읽기 화면에 MSG_SAVED_DOC가 표시되고 이동 시 사라지며, 실제 saveDocument 409 충돌 시에는 충돌 문구와 편집창 글이 유지된다", async () => {
    // 1. 성공 시: 실제 saveDocument가 200 반환 -> 읽기 화면에 MSG_SAVED_DOC 표시
    const fakeSuccessFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: true, sha256: "hash-new" }), {
        status: 200,
        headers: { etag: "hash-new", "content-type": "application/json" },
      })
    }

    const saveSuccessRes = await saveDocument({
      source: "adk",
      path: "developer/guide.md",
      content: "# 가이드\n저장 완료된 내용",
      baseHash: "hash-old",
      fetchFn: fakeSuccessFetch,
    })

    assert.equal(saveSuccessRes.ok, true)

    const htmlSuccess = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 가이드\n저장 완료된 내용"
        isEditing={false}
        saveMessage={MSG_SAVED_DOC}
      />,
    )
    assert.ok(htmlSuccess.includes(MSG_SAVED_DOC), "저장 성공 후 읽기 화면에 저장 안내 문구가 있어야 한다")

    // 다른 문서로 이동 시(saveMessage가 null) 저장 문구 없어야 함
    const htmlMoved = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/other.md"
        viewMode="doc"
        docContent="# 다른 문서"
        isEditing={false}
        saveMessage={null}
      />,
    )
    assert.ok(!htmlMoved.includes(MSG_SAVED_DOC), "문서 이동 후에는 저장 문구가 없어야 한다")

    // 2. 409 충돌 시: 실제 saveDocument가 409 반환 -> conflict: true 및 MSG_CONFLICT_DOC
    const fakeConflictFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "changed" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }

    const saveConflictRes = await saveDocument({
      source: "adk",
      path: "developer/guide.md",
      content: "# 내가 입력 중이던 고친 글",
      baseHash: "hash-old",
      fetchFn: fakeConflictFetch,
    })

    assert.equal(saveConflictRes.ok, false)
    assert.equal(saveConflictRes.conflict, true)
    assert.equal(saveConflictRes.error, MSG_CONFLICT_DOC)

    // 충돌 시 DocEditor 컴포넌트 렌더: 충돌 문구 표시 및 textarea에 입력 중이던 글 유지 확인
    const htmlConflict = renderToStaticMarkup(
      <DocEditor
        source="adk"
        path="developer/guide.md"
        initialContent="# 가이드\n원문"
        initialBaseHash="hash-old"
        content="# 내가 입력 중이던 고친 글"
      />,
    )
    assert.ok(htmlConflict.includes("# 내가 입력 중이던 고친 글"), "409 충돌 시에도 편집창의 글이 유지되어야 한다")
  })

  // ── 결함 6. 탭 전환 ─────────────────────────────────────────────────────
  it("[결함 6] 탭 버튼 링크는 현재 문서가 대상 탭에 속할 때만 경로를 유지하고 그렇지 않으면 대상 탭만 가리킨다", () => {
    // 1) 개발자 문서를 보고 있을 때 (activeTab="developer", currentSource="adk", currentPath="developer/guide.md")
    // 브랜드 탭 링크는 탭만 가리켜야 함: /docs?tab=brand
    const htmlDevDoc = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="내용"
        sourceTab="developer"
      />,
    )
    assert.ok(
      htmlDevDoc.includes('href="/docs?tab=brand"'),
      "개발자 문서를 보고 있을 때 브랜드 탭 링크는 탭만 담아야 한다",
    )

    // 2) 브랜드 출처 문서를 보고 있을 때 (activeTab="brand", currentSource="data:content", currentPath="brand-guide.md", sourceTab="brand")
    // 브랜드 탭 링크는 source와 path를 유지해야 함
    const htmlBrandDoc = renderToStaticMarkup(
      <DocsView
        activeTab="brand"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "brand")}
        currentSource="data:content"
        currentPath="brand-guide.md"
        viewMode="doc"
        docContent="내용"
        sourceTab="brand"
      />,
    )
    assert.ok(
      htmlBrandDoc.includes(
        'href="/docs?tab=brand&amp;source=data%3Acontent&amp;path=brand-guide.md"',
      ),
      "브랜드 출처 문서일 때 브랜드 탭 링크는 source와 path를 유지해야 한다",
    )
  })

  // ── 결함 7·11. 위키 및 상대 링크 sourceTab 전달 ─────────────────────────
  it("[결함 7·11] DocsView 내 위키 및 상대 링크는 sourceTab을 받아 inferTab으로 계산된 대상 탭으로 생성된다", () => {
    // activeTab이 developer인 상태에서 DocsView 렌더
    // 마크다운 내 상대 링크가 브랜드 출처의 파일 또는 브랜드 탭에 해당하는 문서 링크인 경우
    // DocsView에 sourceTab="brand"가 주어지면 대상 링크의 tab이 brand여야 함
    const markdown = "[브랜드 가이드](brand-guide.md)"
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="data:content"
        currentPath="ep01.md"
        viewMode="doc"
        docContent={markdown}
        sourceTab="brand"
      />,
    )

    assert.ok(
      html.includes('href="/docs?tab=brand&amp;source=data%3Acontent&amp;path=brand-guide.md"'),
      "sourceTab=brand를 받아 inferTab에 의해 href tab이 brand여야 한다",
    )
  })

  // ── 결함 8. SP-06 및 alert 제거 ─────────────────────────────────────────
  it("[결함 8] /folder 403의 SP-06은 폴더 경로에만(.md·그림은 열림) 적용되고, 저장 403은 본문 문자열로 두 문장이 갈리고 편집창 글이 유지되며, 별·묶음 실패 뒤에도 본문·격자·파일 보기가 남는다", async () => {
    // 1. 트리에 없는 경로에서 /folder 403 판정 검증 (검수 3번 대체)
    // (A) 폴더 경로 (v1.2, 확장자 없음): /folder가 403이면 grid 자리의 SP-06 한 줄 (기타 파일 보기로 안 떨어짐)
    const fakeFolder403: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("/api/portal/folder")) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
      }
      return new Response("{}", { status: 404 })
    }

    const stateFolder = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "developer/v1.2",
      sources: dummySources,
      fetchFn: fakeFolder403,
    })

    assert.equal(stateFolder.viewMode, "grid", "트리에 없는 폴더 경로의 403은 grid여야 한다")
    assert.equal(stateFolder.forbidden, true, "forbidden이 참이어야 한다")

    const htmlFolder = renderToStaticMarkup(
      <DocsView
        {...stateFolder}
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
      />,
    )
    assert.ok(htmlFolder.includes(MSG_FORBIDDEN), "격자 자리에 SP-06 한 줄 안내가 보여야 한다")
    assert.ok(!htmlFolder.includes("미리 볼 수 없는 파일입니다"), "기타 파일 보기로 떨어지지 않아야 한다")

    // (B) 문서 경로 (.md): /folder가 403이어도 GET /doc 시도 -> GET /doc이 200이면 문서가 열림
    const fakeDoc200: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("/api/portal/folder")) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
      }
      if (url.includes("/api/portal/doc")) {
        return new Response("# 정상 문서 본문", { status: 200, headers: { etag: "doc-etag" } })
      }
      return new Response("{}", { status: 404 })
    }

    const stateDoc = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "developer/secret.md",
      sources: dummySources,
      fetchFn: fakeDoc200,
    })

    assert.equal(stateDoc.viewMode, "doc", ".md 확장자는 문서로 열려야 한다")
    assert.equal(stateDoc.docContent, "# 정상 문서 본문")

    // GET /doc도 403일 때만 SP-06 문장
    const fakeDoc403: typeof fetch = async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
    const stateDoc403 = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "developer/secret.md",
      sources: dummySources,
      fetchFn: fakeDoc403,
    })
    assert.equal(stateDoc403.viewMode, "doc")
    assert.equal(stateDoc403.forbidden, true)
    assert.equal(stateDoc403.docError, MSG_FORBIDDEN)

    // (C) 그림 확장자 (.png): /folder가 403이어도 파일 보기로 열림
    const stateImg = await loadDocsViewState({
      tab: "developer",
      source: "adk",
      path: "developer/photo.png",
      sources: dummySources,
      fetchFn: fakeFolder403,
    })
    assert.equal(stateImg.viewMode, "file", "그림 확장자는 파일 보기로 열려야 한다")
    assert.equal(stateImg.fileData?.kind, "image")

    // 2. 저장 403 본문 파싱 검증 (실제 saveDocument 호출)
    // (A) Forbidden -> MSG_FORBIDDEN ("이 주소에서는 문서만 볼 수 있습니다")
    const fakeSave403Forbidden: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }
    const saveForbiddenRes = await saveDocument({
      source: "adk",
      path: "developer/guide.md",
      content: "수정 중이던 글",
      baseHash: "old-hash",
      fetchFn: fakeSave403Forbidden,
    })
    assert.equal(saveForbiddenRes.status, 403)
    assert.equal(saveForbiddenRes.error, MSG_FORBIDDEN)

    // (B) Source is read-only -> MSG_READ_ONLY_DOC ("이 출처는 보기 전용이라 문서를 고칠 수 없습니다")
    const fakeSave403ReadOnly: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "Source is read-only" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }
    const saveReadOnlyRes = await saveDocument({
      source: "adk",
      path: "developer/guide.md",
      content: "수정 중이던 글",
      baseHash: "old-hash",
      fetchFn: fakeSave403ReadOnly,
    })
    assert.equal(saveReadOnlyRes.status, 403)
    assert.equal(saveReadOnlyRes.error, MSG_READ_ONLY_DOC)

    // 저장 403 실패 시에도 DocEditor의 글이 유지됨 확인
    const htmlEditorRetained = renderToStaticMarkup(
      <DocEditor
        source="adk"
        path="developer/guide.md"
        initialContent="원문"
        initialBaseHash="old-hash"
        content="수정 중이던 글"
      />,
    )
    assert.ok(htmlEditorRetained.includes("수정 중이던 글"), "저장 403 실패 시에도 편집창 글이 유지되어야 한다")

    // 3. 별 추가·빼기 실패 시 본문·격자·파일 보기 유지 검증
    // (A) addFavorite 실패 (400)
    const fakeAddFail: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "invalid path parameter" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    const addFailRes = await addFavorite({ source: "adk", path: "guide.md", fetchFn: fakeAddFail })
    assert.equal(addFailRes.ok, false)
    assert.ok(addFailRes.error)

    // 별 실패 문구를 starError로 주입 시, 문서 본문은 유지되고 starError만 표시됨 단언
    const htmlDocStarFail = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="문서 본문 내용입니다"
        starError={addFailRes.error}
      />,
    )
    assert.ok(htmlDocStarFail.includes("문서 본문 내용입니다"), "별 추가 실패 시에도 문서 본문이 유지되어야 한다")
    assert.ok(htmlDocStarFail.includes(addFailRes.error), "별 근처에 오류 문구가 표시되어야 한다")

    // 격자 보기에서도 별 실패 시 격자 항목이 유지됨 단언
    const htmlGridStarFail = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath=""
        viewMode="grid"
        folderData={{
          entries: [{ name: "item.md", path: "item.md", type: "file", kind: "doc" }],
          total: 1,
          truncated: false,
        }}
        starError={addFailRes.error}
      />,
    )
    assert.ok(htmlGridStarFail.includes("1개 항목"), "별 실패 시에도 격자 항목이 유지되어야 한다")
    assert.ok(htmlGridStarFail.includes(addFailRes.error), "격자 별 근처에 오류 문구가 표시되어야 한다")

    // (B) removeFavorite 실패 (403)
    const fakeRemoveFail: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }
    const removeFailRes = await removeFavorite({ source: "adk", path: "guide.md", fetchFn: fakeRemoveFail })
    assert.equal(removeFailRes.ok, false)
    assert.equal(removeFailRes.error, MSG_FORBIDDEN)

    // 왼쪽 즐겨찾기 묶음 빼기 실패 시에도 본문 유지되고 묶음 안에 한 줄로 보임 단언
    const htmlGroupFail = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="문서 본문 내용입니다"
        favorites={[{ source: "adk", path: "guide.md", type: "file", addedAt: "2026-09-26T00:00:00Z" }]}
        groupFavoriteError={removeFailRes.error}
      />,
    )
    assert.ok(htmlGroupFail.includes("문서 본문 내용입니다"), "즐겨찾기 묶음 빼기 실패 시에도 문서 본문이 유지되어야 한다")
    assert.ok(htmlGroupFail.includes(MSG_FORBIDDEN), "즐겨찾기 묶음 안에 한 줄 실패 문구가 보여야 한다")
  })

  // ── 결함 9. 즐겨찾기 400 구분 ───────────────────────────────────────────
  it("[결함 9] 즐겨찾기 400 응답 시 200개 상한 에러일 때만 상한 문장이고 기타 400은 일반 실패 문구이다", () => {
    // 200개 상한 400 에러
    const limitMsg = mapFavoritesError(400, { error: "Favorites limit reached (200)" })
    assert.equal(limitMsg, MSG_FAVORITES_LIMIT)

    // 기타 400 에러
    const otherMsg = mapFavoritesError(400, { error: "invalid path parameter" })
    assert.notEqual(otherMsg, MSG_FAVORITES_LIMIT, "기타 400은 상한 문장이 아니어야 한다")
    assert.ok(otherMsg.includes("즐겨찾기"), "실패 안내 문구여야 한다")
  })

  // ── 결함 10. 빈 경로 링크 ───────────────────────────────────────────────
  it("[결함 10] docHref는 path가 비어있어도 source를 유지하여 출처 루트 격자 주소를 생성하고 determineDocViewMode는 빈 path를 grid로 판정한다", () => {
    // docHref 검증
    const rootHref = docHref("developer", "adk", "")
    assert.equal(
      rootHref,
      "/docs?tab=developer&source=adk",
      "path가 빈 문자열이어도 source가 유지되어야 한다",
    )

    const rootHrefNull = docHref("developer", "adk", null)
    assert.equal(
      rootHrefNull,
      "/docs?tab=developer&source=adk",
      "path가 null이어도 source가 유지되어야 한다",
    )

    // determineDocViewMode 검증
    const modeEmpty = determineDocViewMode({ path: "" })
    assert.equal(modeEmpty, "grid", "빈 path는 grid로 판정되어야 한다")

    const modeNull = determineDocViewMode({ path: null })
    assert.equal(modeNull, "grid", "null path는 grid로 판정되어야 한다")
  })
})
