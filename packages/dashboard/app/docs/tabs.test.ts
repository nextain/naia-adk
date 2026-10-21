import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { DocTreeNode } from "./markdown.ts"
import {
  type DocTab,
  DEFAULT_DOC_TAB,
  DOC_TABS,
  DOC_TAB_RULES,
  archiveBadgeLabel,
  classifyDoc,
  computeActiveTab,
  docVisibleInTab,
  firstCurrentDoc,
  isArchiveDirName,
  isArchivedDocPath,
  orderArchiveLast,
  searchApiUrl,
  inferTab,
  isDocTab,
  pruneTree,
  searchResultHref,
  searchResultTabLabel,
  sectionsForTab,
  shouldAutoOpenFirstDoc,
  tabLabel,
  tabOfDoc,
  type DocTabRule,
} from "./tabs.ts"

const rules: Record<string, Record<string, DocTabRule>> = {
  adk: { common: "common", "brand-marketing": "brand", developer: "developer", "index.md": "common" },
  "company:x": { "01. 온보딩": "common", "01. 온보딩/dev.md": "developer", "05. 브랜드": "brand" },
}

const adkTree: DocTreeNode[] = [
  { name: "brand-marketing", path: "brand-marketing", type: "directory", children: [{ name: "index.md", path: "brand-marketing/index.md", type: "file" }] },
  { name: "common", path: "common", type: "directory", children: [{ name: "guide.md", path: "common/guide.md", type: "file" }] },
  {
    name: "developer",
    path: "developer",
    type: "directory",
    children: [
      { name: "archive", path: "developer/archive", type: "directory", children: [{ name: "a.md", path: "developer/archive/a.md", type: "file" }] },
      { name: "guide.md", path: "developer/guide.md", type: "file" },
    ],
  },
  { name: "index.md", path: "index.md", type: "file" },
  { name: "stray.md", path: "stray.md", type: "file" },
]

const companyTree: DocTreeNode[] = [
  {
    name: "01. 온보딩",
    path: "01. 온보딩",
    type: "directory",
    children: [
      { name: "all.md", path: "01. 온보딩/all.md", type: "file" },
      { name: "dev.md", path: "01. 온보딩/dev.md", type: "file" },
    ],
  },
  { name: "05. 브랜드", path: "05. 브랜드", type: "directory", children: [{ name: "b.md", path: "05. 브랜드/b.md", type: "file" }] },
]

const sources = [
  { id: "company:x", title: "회사", tree: companyTree },
  { id: "adk", title: "ADK", tree: adkTree },
]

describe("탭 목록", () => {
  it("공통이 맨 앞이고 기본 탭이다", () => {
    assert.deepEqual(DOC_TABS.map((t) => t.id), ["common", "brand", "developer"])
    assert.equal(DEFAULT_DOC_TAB, "common")
    assert.equal(tabLabel("common"), "공통")
    assert.ok(isDocTab("common") && isDocTab("brand") && isDocTab("developer"))
    assert.ok(!isDocTab("both") && !isDocTab(null))
  })
  it("규칙표: 회사 소개·첫날 온보딩·업무 보고·ADK 색인은 공통, 기술 문서는 개발자", () => {
    const exampleRules: Record<string, Record<string, DocTabRule>> = {
      ...DOC_TAB_RULES,
      "company:example-docs": {
        "01. 온보딩": "common",
        "01. 온보딩/02.개발자 온보딩 가이드.md": "developer",
        "01. 온보딩/03.마케팅·운영 온보딩 가이드.md": "brand",
        "02. 회사 소개": "common",
        "02. 회사 소개/03-기술 스택.md": "developer",
        "07. 업무 보고": "common",
      },
    }
    assert.equal(classifyDoc("adk", "index.md", exampleRules), "common")
    assert.equal(classifyDoc("adk", "common/docs-writing-guide.md", exampleRules), "common")
    assert.equal(classifyDoc("company:example-docs", "02. 회사 소개/00-README.md", exampleRules), "common")
    assert.equal(classifyDoc("company:example-docs", "02. 회사 소개/정본/history.md", exampleRules), "common")
    assert.equal(classifyDoc("company:example-docs", "02. 회사 소개/03-기술 스택.md", exampleRules), "developer")
    assert.equal(classifyDoc("company:example-docs", "01. 온보딩/01.환영인사.md", exampleRules), "common")
    assert.equal(classifyDoc("company:example-docs", "01. 온보딩/03.마케팅·운영 온보딩 가이드.md", exampleRules), "brand")
    assert.equal(classifyDoc("company:example-docs", "07. 업무 보고/업무 보고 작성 방법 및 양식.md", exampleRules), "common")
    assert.ok(Object.values(DOC_TAB_RULES).every((t) => Object.values(t).every((v) => isDocTab(v))))
  })
  it("규칙 없는 회사 문서는 분류 안 됨(개발자 탭)으로 간다", () => {
    assert.equal(classifyDoc("company:custom-docs", "01. 온보딩/01.환영인사.md"), null)
    const companySources = [
      {
        id: "company:custom-docs",
        title: "회사 문서",
        tree: [{ name: "01.환영인사.md", path: "01. 온보딩/01.환영인사.md", type: "file" as const }],
      },
    ]
    const devSections = sectionsForTab(companySources, "developer")
    assert.equal(devSections.length, 1)
    assert.equal(devSections[0].unclassified, true)
    assert.deepEqual(devSections[0].tree.map((n) => n.path), ["01. 온보딩/01.환영인사.md"])

    const commonSections = sectionsForTab(companySources, "common")
    assert.equal(commonSections.length, 0)
  })
})

describe("classifyDoc", () => {
  it("가장 길게 맞는 규칙이 이긴다", () => {
    assert.equal(classifyDoc("company:x", "01. 온보딩/dev.md", rules), "developer")
    assert.equal(classifyDoc("company:x", "01. 온보딩/all.md", rules), "common")
  })
  it("폴더 이름 앞부분만 같은 경로는 맞지 않는다", () => {
    assert.equal(classifyDoc("adk", "developer-notes/x.md", rules), null)
  })
  it("규칙표가 없는 출처는 분류 안 됨", () => {
    assert.equal(classifyDoc("other", "a.md", rules), null)
  })
})

describe("sectionsForTab", () => {
  it("공통 탭에는 공통 문서만 보인다", () => {
    const s = sectionsForTab(sources, "common", rules)
    const files = JSON.stringify(s)
    assert.ok(files.includes("01. 온보딩/all.md"))
    assert.ok(files.includes("common/guide.md"))
    assert.ok(files.includes('"index.md"'))
    assert.ok(!files.includes("01. 온보딩/dev.md"))
    assert.ok(!files.includes("brand-marketing/index.md"))
    assert.ok(s.every((x) => !x.unclassified))
  })
  it("브랜드 탭에는 공통 문서가 겹쳐 보이지 않는다", () => {
    const s = sectionsForTab(sources, "brand", rules)
    const files = JSON.stringify(s)
    assert.ok(files.includes("brand-marketing/index.md"))
    assert.ok(files.includes("05. 브랜드/b.md"))
    assert.ok(!files.includes("01. 온보딩/all.md"))
    assert.ok(!files.includes("common/guide.md"))
  })
  it("개발자 탭 끝에 분류 안 된 문서가 숨지 않고 붙는다", () => {
    const s = sectionsForTab(sources, "developer", rules)
    const last = s[s.length - 1]
    assert.equal(last.unclassified, true)
    assert.deepEqual(last.tree.map((n) => n.path), ["stray.md"])
    assert.ok(JSON.stringify(s).includes("developer/archive/a.md"))
    assert.ok(!JSON.stringify(s).includes("01. 온보딩/all.md"))
  })
})

describe("inferTab·docVisibleInTab·tabOfDoc", () => {
  it("탭 없는 옛 주소는 문서의 탭으로 열고, 문서가 없으면 공통", () => {
    assert.equal(inferTab("adk", "brand-marketing/index.md", undefined, rules), "brand")
    assert.equal(inferTab("company:x", "01. 온보딩/all.md", undefined, rules), "common")
    assert.equal(inferTab(null, null, undefined, rules), "common")
  })
  it("분류 안 된 문서는 공통이 아니라 개발자 탭에서 연다", () => {
    assert.equal(inferTab("adk", "stray.md", undefined, rules), "developer")
    assert.deepEqual(tabOfDoc("adk", "stray.md", rules), { tab: "developer", unclassified: true })
    assert.equal(docVisibleInTab("adk", "stray.md", "developer", rules), true)
    assert.equal(docVisibleInTab("adk", "stray.md", "common", rules), false)
  })
  it("공통 문서는 공통 탭에서만 보인다", () => {
    assert.equal(docVisibleInTab("company:x", "01. 온보딩/all.md", "common", rules), true)
    assert.equal(docVisibleInTab("company:x", "01. 온보딩/all.md", "brand", rules), false)
  })
  it("pruneTree는 빈 폴더를 뺀다", () => {
    assert.deepEqual(pruneTree(adkTree, (p) => p === "index.md").map((n) => n.path), ["index.md"])
  })
})

describe("검색 도우미", () => {
  it("결과 주소는 문서가 보이는 탭으로 가고 검색어가 없다", () => {
    assert.equal(
      searchResultHref("company:x", "01. 온보딩/all.md", rules),
      `/docs?tab=common&source=company%3Ax&path=${encodeURIComponent("01. 온보딩/all.md")}`,
    )
    assert.ok(searchResultHref("adk", "stray.md", rules).startsWith("/docs?tab=developer&"))
    assert.ok(!searchResultHref("adk", "common/guide.md", rules).includes("q="))
  })
  it("결과의 탭 이름", () => {
    assert.equal(searchResultTabLabel("adk", "brand-marketing/index.md", rules), "브랜드·마케팅")
    assert.equal(searchResultTabLabel("adk", "stray.md", rules), "개발자(분류 안 됨)")
  })
  it("검색어가 있으면 첫 문서로 자동으로 넘어가지 않는다", () => {
    assert.equal(shouldAutoOpenFirstDoc({ query: "스튜디오", sourceId: null, docPath: null, portalLoaded: true }), false)
    assert.equal(shouldAutoOpenFirstDoc({ query: " ", sourceId: null, docPath: null, portalLoaded: true }), true)
    assert.equal(shouldAutoOpenFirstDoc({ query: null, sourceId: null, docPath: null, portalLoaded: true }), true)
    assert.equal(shouldAutoOpenFirstDoc({ query: null, sourceId: null, docPath: null, portalLoaded: false }), false)
    assert.equal(shouldAutoOpenFirstDoc({ query: null, sourceId: "adk", docPath: "index.md", portalLoaded: true }), false)
  })
})

describe("보관 문서", () => {
  const f = (p: string): DocTreeNode => ({ name: p.split("/").pop() as string, path: p, type: "file" })
  const d = (p: string, children: DocTreeNode[]): DocTreeNode => ({ name: p.split("/").pop() as string, path: p, type: "directory", children })

  it("보관 폴더 이름은 archive(대소문자 무시)와 지난 기록(분해형 한글 포함)", () => {
    assert.equal(isArchiveDirName("archive"), true)
    assert.equal(isArchiveDirName("Archive"), true)
    assert.equal(isArchiveDirName("지난 기록".normalize("NFD")), true)
    assert.equal(isArchiveDirName("archives"), false)
    assert.equal(isArchiveDirName("archive-guide.md"), false)
  })

  it("문서 경로는 폴더만 보고 판단한다", () => {
    assert.equal(isArchivedDocPath("developer/archive/2026-09-25/x.md"), true)
    assert.equal(isArchivedDocPath("05. 브랜드·마케팅/소개서/지난 기록/a.md"), true)
    assert.equal(isArchivedDocPath("common/archive.md"), false)
    assert.equal(isArchivedDocPath("common/guide.md"), false)
  })

  it("같은 층에서 보관 폴더를 맨 아래로 보내고 나머지 순서는 지킨다", () => {
    const tree = [
      d("developer", [d("developer/archive", [f("developer/archive/old.md")]), f("developer/a.md"), d("developer/product", [f("developer/product/b.md")])]),
      f("index.md"),
    ]
    const out = orderArchiveLast(tree)
    assert.deepEqual(out.map((n) => n.path), ["developer", "index.md"])
    assert.deepEqual(out[0].children?.map((n) => n.path), ["developer/a.md", "developer/product", "developer/archive"])
  })

  it("탭 구역도 보관 폴더를 맨 아래에 둔다", () => {
    const rules = { adk: { developer: "developer" as DocTabRule } }
    const sections = sectionsForTab(
      [{ id: "adk", title: "ADK", tree: [d("developer", [d("developer/archive", [f("developer/archive/old.md")]), f("developer/z.md")])] }],
      "developer",
      rules,
    )
    assert.deepEqual(sections[0].tree[0].children?.map((n) => n.path), ["developer/z.md", "developer/archive"])
  })

  it("탭 첫 문서는 현행 문서를 고르고, 보관뿐이면 보관 문서", () => {
    assert.equal(firstCurrentDoc([d("archive", [f("archive/old.md")]), f("now.md")]), "now.md")
    assert.equal(firstCurrentDoc([d("archive", [f("archive/old.md")])]), "archive/old.md")
    assert.equal(firstCurrentDoc([]), null)
  })

  it("문서 화면의 첫 문서가 그림이 아닌 md를 고르고 그림만 있는 폴더가 남는다 (FE 2장, RQ-01 AC1)", () => {
    const tree: DocTreeNode[] = [
      { name: "logo.png", path: "logo.png", type: "file", kind: "image" },
      { name: "intro.md", path: "intro.md", type: "file", kind: "doc" },
    ]
    assert.equal(firstCurrentDoc(tree), "intro.md")

    // RQ-01 AC1: 그림만 있는 폴더와 파일도 pruneTree에서 남는다
    const pruned = pruneTree(tree, () => true)
    assert.deepEqual(pruned.map((n) => n.path), ["logo.png", "intro.md"])

    const imageFolderTree: DocTreeNode[] = [
      {
        name: "images",
        path: "images",
        type: "directory",
        children: [{ name: "logo.png", path: "images/logo.png", type: "file", kind: "image" }],
      },
    ]
    const prunedFolder = pruneTree(imageFolderTree, () => true)
    assert.deepEqual(prunedFolder.map((n) => n.path), ["images"])
    assert.deepEqual(prunedFolder[0].children?.map((n) => n.path), ["images/logo.png"])
  })

  it("검색 결과 보관 표시", () => {
    assert.equal(archiveBadgeLabel(null), null)
    assert.equal(archiveBadgeLabel({ kind: "대체됨", date: "2026-09-25" }), "보관 · 대체됨 2026-09-25")
    assert.equal(archiveBadgeLabel({ kind: "보관", date: "2026-09-20" }), "보관 2026-09-20")
    assert.equal(archiveBadgeLabel({ kind: null, date: null }), "보관")
  })

  it("검색 API 주소는 보관 문서 포함을 켰을 때만 archived=1", () => {
    assert.equal(searchApiUrl("gateway", false), "/api/portal/search?q=gateway")
    assert.equal(searchApiUrl("게이트 웨이", true), `/api/portal/search?q=${encodeURIComponent("게이트 웨이")}&archived=1`)
  })
})

describe("data: 출처 탭 분류 (FE 4장, W1c)", () => {
  const f = (p: string): DocTreeNode => ({ name: p.split("/").pop() as string, path: p, type: "file", kind: "doc" })

  it("data: 출처의 모든 문서는 경로와 무관하게 출처의 tab으로 분류된다", () => {
    assert.equal(classifyDoc("data:marketing", "any/deep/path/doc.md", rules, "brand"), "brand")
    assert.equal(classifyDoc("data:marketing", "01. 온보딩/dev.md", rules, "brand"), "brand")
    assert.equal(classifyDoc("data:dev-tools", "index.md", rules, "developer"), "developer")
    assert.equal(classifyDoc("data:dev-tools", "some.md", rules, "developer"), "developer")
    assert.equal(classifyDoc("data:unspecified", "doc.md", rules), "common")
  })

  it("sectionsForTab: data: 출처는 지정된 탭에만 보이고 개발자 탭의 [분류 안 됨]에 나오지 않는다", () => {
    const dataSources = [
      {
        id: "data:content",
        title: "콘텐츠 결과물",
        tree: [f("ep01.md"), f("ep02.md")],
        tab: "brand" as const,
        readOnly: true,
      },
    ]

    const brandSections = sectionsForTab(dataSources, "brand", rules)
    assert.equal(brandSections.length, 1)
    assert.equal(brandSections[0].sourceId, "data:content")
    assert.equal(brandSections[0].unclassified, false)
    assert.equal(brandSections[0].readOnly, true)

    const commonSections = sectionsForTab(dataSources, "common", rules)
    assert.equal(commonSections.length, 0)

    const devSections = sectionsForTab(dataSources, "developer", rules)
    assert.equal(devSections.length, 0)
  })

  it("sectionsForTab: missing: true 출처는 트리가 비어 있어도 해당 탭에 남긴다 (RQ-04 AC4)", () => {
    const dataSources = [
      {
        id: "data:missing-brand",
        title: "사라진 브랜드 폴더",
        tree: [],
        tab: "brand" as const,
        readOnly: true,
        missing: true,
      },
      {
        id: "data:missing-common",
        title: "사라진 공통 폴더",
        tree: [],
        readOnly: true,
        missing: true,
      },
    ]

    const brandSections = sectionsForTab(dataSources, "brand", rules)
    assert.equal(brandSections.length, 1)
    assert.equal(brandSections[0].sourceId, "data:missing-brand")
    assert.equal(brandSections[0].missing, true)
    assert.deepEqual(brandSections[0].tree, [])

    const commonSections = sectionsForTab(dataSources, "common", rules)
    assert.equal(commonSections.length, 1)
    assert.equal(commonSections[0].sourceId, "data:missing-common")
    assert.equal(commonSections[0].missing, true)
    assert.deepEqual(commonSections[0].tree, [])
  })

  it("tabOfDoc: data: 출처는 unclassified가 항상 false이고 출처의 tab을 반환한다", () => {
    const result = tabOfDoc("data:media", "sub/folder/file.md", rules, "brand")
    assert.deepEqual(result, { tab: "brand", unclassified: false })
  })
})

describe("W1c-2 결함 3: data: 출처의 tab 연동 및 activeTab 계산", () => {
  const portalSources = [
    { id: "data:content", title: "콘텐츠 결과물", tab: "brand" as const, tree: [] },
    { id: "data:devtool", title: "개발자 도구", tab: "developer" as const, tree: [] },
    { id: "adk", title: "ADK 문서", tree: [] },
  ]

  it("1. computeActiveTab: ?tab=brand&source=data:<id>&path=<md> 에서 brand 반환", () => {
    // path가 명시된 주소에서 정상 동작 확인
    const tab1 = computeActiveTab("brand", "data:content", "ep01.md", portalSources, rules)
    assert.equal(tab1, "brand")

    // 주소에 tab이 없는 경우(?source=data:content&path=ep01.md)도 출처의 tab인 brand로 계산
    const tab2 = computeActiveTab(null, "data:content", "ep01.md", portalSources, rules)
    assert.equal(tab2, "brand")

    // 주소에 잘못된 tab(?tab=common&source=data:content&path=ep01.md)이 들어와도 문서 출처의 brand로 교정
    const tab3 = computeActiveTab("common", "data:content", "ep01.md", portalSources, rules)
    assert.equal(tab3, "brand")

    // adk 출처는 기존 규칙 유지
    const tabAdk = computeActiveTab(null, "adk", "developer/guide.md", portalSources, rules)
    assert.equal(tabAdk, "developer")
  })

  it("2. 위키·상대 .md 링크는 inferTab 다섯 번째 인자로 출처 tab을 전달받아 brand로 판정", () => {
    // 5번째 인자 sourceTab으로 "brand"가 전달되면 data: 출처 문서는 brand로 계산됨
    const tabWiki = inferTab("data:content", "target.md", undefined, rules, "brand")
    assert.equal(tabWiki, "brand")

    const tabRel = inferTab("data:content", "relative/sub.md", undefined, rules, "brand")
    assert.equal(tabRel, "brand")

    // 5번째 인자가 없으면 data: 출처는 기본 common
    const tabDefault = inferTab("data:content", "target.md", undefined, rules)
    assert.equal(tabDefault, "common")
  })

  it("3. 검색 링크·배지는 searchResultHref·searchResultTabLabel의 sourceTab으로 그 출처 tab이 들어가 tab 없는 hit도 brand", () => {
    // searchResultHref에 sourceTab으로 "brand" 전달
    const href = searchResultHref("data:content", "ep01.md", rules, "brand")
    assert.equal(href, `/docs?tab=brand&source=data%3Acontent&path=${encodeURIComponent("ep01.md")}`)

    // searchResultTabLabel에 sourceTab으로 "brand" 전달
    const label = searchResultTabLabel("data:content", "ep01.md", rules, "brand")
    assert.equal(label, "브랜드·마케팅")

    // developer 출처는 "개발자"
    const devLabel = searchResultTabLabel("data:devtool", "tool.md", rules, "developer")
    assert.equal(devLabel, "개발자")
  })

  it("4. data: 출처 tab 연동 실제 동작 시험 (computeActiveTab, inferTab, searchResultHref)", () => {
    const dummySources = [
      { id: "adk", title: "ADK", tree: [], tab: "developer" as DocTab },
      { id: "data:brand", title: "브랜드", tree: [], tab: "brand" as DocTab },
    ]

    // computeActiveTab 동작 검증
    assert.equal(
      computeActiveTab("developer", "data:brand", "guide.md", dummySources),
      "brand",
      "data: 출처 문서는 tabParam보다 출처의 tab이 우선 반영되어야 한다",
    )

    // inferTab 다섯 번째 인자(sourceTab) 동작 검증
    assert.equal(
      inferTab("data:brand", "guide.md", "developer", undefined, "brand"),
      "brand",
      "inferTab은 sourceTab이 brand일 때 brand를 반환해야 한다",
    )

    // searchResultHref 동작 검증
    assert.equal(
      searchResultHref("data:brand", "guide.md", undefined, "brand"),
      "/docs?tab=brand&source=data%3Abrand&path=guide.md",
      "searchResultHref는 sourceTab이 반영된 href를 반환해야 한다",
    )
  })
})
