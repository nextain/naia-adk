import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  inferKindFromPath,
  formatFileSize,
  formatDimensions,
  sortGridEntries,
  limitGridEntries,
  sortNotes,
  isFavoriteMissing,
  canEditDoc,
  determineDocViewMode,
  mapDocSaveError,
  mapFavoritesError,
  mapNotesError,
  formatJsonIfPossible,
  isSafeVisibleText,
  createBreadcrumbs,
  getFileName,
  getOpenNotesBannerText,
  MSG_TRUNCATED_GRID,
  MSG_TRUNCATED_TEXT,
  MSG_FORBIDDEN,
  MSG_READ_ONLY_DOC,
  MSG_CONFLICT_DOC,
  MSG_SAVED_DOC,
  MSG_ARCHIVED_DOC,
  MSG_UNSUPPORTED_PREVIEW,
  MSG_CONFIRM_DISCARD,
  MSG_FAVORITES_INVALID,
  MSG_RETRY_LATER,
  MSG_FAVORITES_LIMIT,
  MSG_READ_ONLY,
  MSG_NOT_FOUND,
  type FolderGridEntry,
  type DocNoteItem,
} from "./kinds.ts"
import { sectionsForTab, type TabSourceItem } from "./tabs.ts"

describe("파일 종류 판정 (inferKindFromPath)", () => {
  it("확장자에 따라 7가지 종류(doc, image, video, audio, pdf, text, other)로 올바르게 판정한다", () => {
    assert.equal(inferKindFromPath("guide.md"), "doc")
    assert.equal(inferKindFromPath("logo.PNG"), "image")
    assert.equal(inferKindFromPath("assets/photo.jpeg"), "image")
    assert.equal(inferKindFromPath("icon.svg"), "image")
    assert.equal(inferKindFromPath("clip.mp4"), "video")
    assert.equal(inferKindFromPath("record.wav"), "audio")
    assert.equal(inferKindFromPath("paper.pdf"), "pdf")
    assert.equal(inferKindFromPath("config.json"), "text")
    assert.equal(inferKindFromPath("spec.yaml"), "text")
    assert.equal(inferKindFromPath("env.toml"), "text")
    assert.equal(inferKindFromPath("unknown.xyz"), "other")
    assert.equal(inferKindFromPath("binary.exe"), "other")
  })

  it("서버가 kind를 주면 서버 값을 우선한다", () => {
    assert.equal(inferKindFromPath("unknown.ext", "text"), "text")
    assert.equal(inferKindFromPath("image.png", "other"), "other")
  })
})

describe("크기 사람 단위 변환 (formatFileSize)", () => {
  it("0, B, KB, MB, GB를 자연스러운 단위로 바꾼다", () => {
    assert.equal(formatFileSize(0), "0 B")
    assert.equal(formatFileSize(512), "512 B")
    assert.equal(formatFileSize(1024), "1 KB")
    assert.equal(formatFileSize(1536), "1.5 KB")
    assert.equal(formatFileSize(1048576), "1 MB")
    assert.equal(formatFileSize(1073741824), "1 GB")
    assert.equal(formatFileSize(null), "")
    assert.equal(formatFileSize(undefined), "")
  })

  it("formatDimensions: 가로×세로 문자열로 변환", () => {
    assert.equal(formatDimensions(1920, 1080), "1920×1080")
    assert.equal(formatDimensions(null, 100), null)
    assert.equal(formatDimensions(undefined, undefined), null)
  })
})

describe("격자 정렬 및 500개 자르기 (sortGridEntries, limitGridEntries)", () => {
  it("하위 폴더 먼저, 파일 다음, 각각 이름 순 정렬", () => {
    const entries: FolderGridEntry[] = [
      { name: "b.md", path: "b.md", type: "file" },
      { name: "dir2", path: "dir2", type: "directory" },
      { name: "a.png", path: "a.png", type: "file" },
      { name: "dir1", path: "dir1", type: "directory" },
    ]
    const sorted = sortGridEntries(entries)
    assert.deepEqual(
      sorted.map((e) => e.name),
      ["dir1", "dir2", "a.png", "b.md"],
    )
  })

  it("500개 초과 시 앞 500개만 남기고 truncated: true 및 문구 확인", () => {
    const many: FolderGridEntry[] = Array.from({ length: 550 }, (_, i) => ({
      name: `file_${String(i).padStart(4, "0")}.txt`,
      path: `file_${String(i).padStart(4, "0")}.txt`,
      type: "file",
    }))

    const result = limitGridEntries(many, 500)
    assert.equal(result.total, 550)
    assert.equal(result.entries.length, 500)
    assert.equal(result.truncated, true)
    assert.equal(MSG_TRUNCATED_GRID, "500개까지만 보입니다")

    const few = limitGridEntries(many.slice(0, 10), 500)
    assert.equal(few.total, 10)
    assert.equal(few.entries.length, 10)
    assert.equal(few.truncated, false)
  })
})

describe("즐겨찾기 없어진 항목 표시 (isFavoriteMissing)", () => {
  it("exists === false인 항목은 없어진 항목으로 판정", () => {
    assert.equal(isFavoriteMissing({ exists: false }), true)
    assert.equal(isFavoriteMissing({ exists: true }), false)
    assert.equal(isFavoriteMissing({}), false)
  })
})

describe("메모 정렬 (sortNotes)", () => {
  it("열린 것 먼저, 최신 순 정렬", () => {
    const notes: DocNoteItem[] = [
      {
        id: "1",
        source: "adk",
        path: "a.md",
        quote: null,
        body: "old resolved",
        status: "resolved",
        reply: null,
        createdAt: "2026-09-20T10:00:00Z",
        updatedAt: "2026-09-20T10:00:00Z",
        resolvedAt: "2026-09-21T10:00:00Z",
      },
      {
        id: "2",
        source: "adk",
        path: "a.md",
        quote: null,
        body: "old open",
        status: "open",
        reply: null,
        createdAt: "2026-09-22T10:00:00Z",
        updatedAt: "2026-09-22T10:00:00Z",
        resolvedAt: null,
      },
      {
        id: "3",
        source: "adk",
        path: "a.md",
        quote: null,
        body: "new resolved",
        status: "resolved",
        reply: null,
        createdAt: "2026-09-25T10:00:00Z",
        updatedAt: "2026-09-25T10:00:00Z",
        resolvedAt: "2026-09-25T11:00:00Z",
      },
      {
        id: "4",
        source: "adk",
        path: "a.md",
        quote: null,
        body: "new open",
        status: "open",
        reply: null,
        createdAt: "2026-09-26T10:00:00Z",
        updatedAt: "2026-09-26T10:00:00Z",
        resolvedAt: null,
      },
    ]

    const sorted = sortNotes(notes)
    // 4(new open) -> 2(old open) -> 3(new resolved) -> 1(old resolved)
    assert.deepEqual(
      sorted.map((n) => n.id),
      ["4", "2", "3", "1"],
    )
  })
})

describe("오류 및 상태 문구 매핑", () => {
  it("403 Forbidden은 SP-06 안내 문구, Source is read-only는 보기 전용 문구", () => {
    assert.equal(mapDocSaveError(403), MSG_FORBIDDEN)
    assert.equal(mapDocSaveError(403, { error: "Forbidden" }), MSG_FORBIDDEN)
    assert.equal(mapDocSaveError(403, { error: "Source is read-only" }), MSG_READ_ONLY_DOC)
    assert.equal(MSG_READ_ONLY_DOC, "이 출처는 보기 전용이라 문서를 고칠 수 없습니다")
    assert.equal(mapFavoritesError(403), MSG_FORBIDDEN)
    assert.equal(mapNotesError(403), MSG_FORBIDDEN)
    assert.equal(MSG_FORBIDDEN, "이 주소에서는 문서만 볼 수 있습니다")
  })

  it("문서 저장 409 changed는 SP-04 충돌 문구", () => {
    assert.equal(mapDocSaveError(409, { error: "changed" }), MSG_CONFLICT_DOC)
    assert.equal(
      MSG_CONFLICT_DOC,
      "편집을 연 뒤 이 문서가 바뀌었습니다. 쓰신 글은 그대로 두었으니 복사해 두고 새로 고쳐 주세요.",
    )
  })

  it("즐겨찾기 오류 매핑", () => {
    assert.equal(mapFavoritesError(409, { error: "favorites_file_invalid" }), MSG_FAVORITES_INVALID)
    assert.equal(MSG_FAVORITES_INVALID, "즐겨찾기 파일을 읽을 수 없어 바꾸지 않았습니다")
    assert.equal(mapFavoritesError(409, { error: "changed" }), MSG_RETRY_LATER)
    assert.equal(MSG_RETRY_LATER, "잠시 뒤 다시 해 주세요")
    assert.equal(mapFavoritesError(400, { error: "Favorites limit reached (200)" }), MSG_FAVORITES_LIMIT)
    assert.equal(MSG_FAVORITES_LIMIT, "즐겨찾기는 200개까지입니다")
    assert.equal(mapFavoritesError(400, { error: "invalid path" }), "즐겨찾기를 변경하지 못했습니다. 다시 시도해 주세요.")
  })

  it("고정 화면 문구 일치 검증", () => {
    assert.equal(MSG_SAVED_DOC, "저장했습니다. 아직 저장소에는 올리지 않았습니다.")
    assert.equal(MSG_ARCHIVED_DOC, "보관 문서입니다")
    assert.equal(MSG_UNSUPPORTED_PREVIEW, "미리 볼 수 없는 파일입니다")
    assert.equal(MSG_CONFIRM_DISCARD, "고친 내용이 사라집니다. 나갈까요?")
    assert.equal(MSG_READ_ONLY, "보기 전용")
    assert.equal(MSG_NOT_FOUND, "찾을 수 없음")
    assert.equal(MSG_TRUNCATED_TEXT, "앞 1MB만 보입니다")
    assert.equal(getOpenNotesBannerText(3), "열린 메모 3건 · AI에게 '메모 처리해'라고 말하면 처리합니다")
  })
})

describe("편집 가능 여부 판정 (canEditDoc)", () => {
  it("data: 출처, readOnly, missing 출처는 편집 불가", () => {
    assert.equal(canEditDoc("adk"), true)
    assert.equal(canEditDoc("company:docs"), true)
    assert.equal(canEditDoc("data:content"), false)
    assert.equal(canEditDoc("adk", true), false)
    assert.equal(canEditDoc("adk", false, true), false)
    assert.equal(canEditDoc(null), false)
  })
})

describe("탭 거르기의 missing 유지 (RQ-04 AC4)", () => {
  it("sectionsForTab은 트리가 빈 missing: true 출처를 유지한다", () => {
    const sources: TabSourceItem[] = [
      { id: "data:missing", title: "사라진 출처", tree: [], tab: "common", missing: true },
      { id: "data:empty", title: "빈 출처", tree: [], tab: "common" },
    ]
    const sections = sectionsForTab(sources, "common")
    assert.equal(sections.length, 1)
    assert.equal(sections[0].sourceId, "data:missing")
    assert.equal(sections[0].missing, true)
  })
})

describe("보기 종류 결정 (determineDocViewMode)", () => {
  it("path가 없거나 디렉터리면 grid, md/doc이면 doc, 그 밖은 file", () => {
    assert.equal(determineDocViewMode({ path: null }), "grid")
    assert.equal(determineDocViewMode({ path: "" }), "grid")
    assert.equal(determineDocViewMode({ path: "images", type: "directory" }), "grid")
    assert.equal(determineDocViewMode({ path: "readme.md", type: "file", kind: "doc" }), "doc")
    assert.equal(determineDocViewMode({ path: "readme.md" }), "doc")
    assert.equal(determineDocViewMode({ path: "photo.png", type: "file", kind: "image" }), "file")
    assert.equal(determineDocViewMode({ path: "video.mp4" }), "file")
    assert.equal(determineDocViewMode({ path: "archive.zip" }), "file")
  })
})

describe("화면 텍스트 안전성 검사 (isSafeVisibleText)", () => {
  it("화면 글에 파일 경로, API 이름, 해시가 없어야 통과한다", () => {
    assert.equal(isSafeVisibleText("정상적인 화면 안내 문구입니다."), true)
    assert.equal(isSafeVisibleText("guide.md 파일을 열었습니다."), true)
    assert.equal(isSafeVisibleText("새로운 문서를 저장했습니다."), true)

    // API 누출
    assert.equal(isSafeVisibleText("오류: /api/portal/doc 요청 실패"), false)
    assert.equal(isSafeVisibleText("주소 /api/portal/notes 가 작동하지 않음"), false)

    // 절대 경로 누출
    assert.equal(isSafeVisibleText("파일 위치: /var/home/runner/work/app/doc.md"), false)
    assert.equal(isSafeVisibleText("경로: /tmp/scratch/temp.txt"), false)
    assert.equal(isSafeVisibleText("/run/user/1000/naia-adk"), false)

    // 해시 누출 (64자리 hex)
    assert.equal(
      isSafeVisibleText("해시 a751086100000000000000000000000000000000000000000000000000000000 가 일치하지 않음"),
      false,
    )
  })
})

describe("JSON 들여쓰기 및 경로 도우미", () => {
  it("유효한 JSON은 들여쓰기하고, 유효하지 않으면 원문 유지", () => {
    const valid = '{"a":1,"b":[2,3]}'
    const formatted = formatJsonIfPossible(valid)
    assert.ok(formatted.includes("\n"))
    assert.ok(formatted.includes('  "a": 1'))

    const invalid = "not a json string"
    assert.equal(formatJsonIfPossible(invalid), invalid)
  })

  it("getFileName 및 createBreadcrumbs", () => {
    assert.equal(getFileName("a/b/c.md"), "c.md")
    assert.equal(getFileName("intro.md"), "intro.md")
    assert.equal(getFileName(""), "")

    const crumbs = createBreadcrumbs("ADK 문서", "developer/sub/guide.md")
    assert.deepEqual(crumbs, [
      { name: "ADK 문서", path: "" },
      { name: "developer", path: "developer" },
      { name: "sub", path: "developer/sub" },
      { name: "guide.md", path: "developer/sub/guide.md" },
    ])
  })
})
