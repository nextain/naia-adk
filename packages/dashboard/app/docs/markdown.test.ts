import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  WIKI_HREF_PREFIX,
  convertWikiLinks,
  firstDoc,
  orderSources,
  findWikiTarget,
  resolveRelativePath,
  splitFrontmatter,
  type DocTreeNode,
} from "./markdown.ts"

const tree: DocTreeNode[] = [
  {
    name: "01. 온보딩",
    path: "01. 온보딩",
    type: "directory",
    children: [
      { name: "00.AI와 함께 일하기 시작하기.md", path: "01. 온보딩/00.AI와 함께 일하기 시작하기.md", type: "file" },
      { name: "README.md", path: "01. 온보딩/README.md", type: "file" },
    ],
  },
  {
    name: "05. 브랜드·마케팅",
    path: "05. 브랜드·마케팅",
    type: "directory",
    children: [{ name: "README.md", path: "05. 브랜드·마케팅/README.md", type: "file" }],
  },
]

describe("docs markdown helpers", () => {
  it("splitFrontmatter: 머리말을 떼고 본문만 남긴다", () => {
    const { meta, body } = splitFrontmatter("---\n작성일: 2026-09-25\n---\n# 제목\n")
    assert.equal(meta, "작성일: 2026-09-25")
    assert.equal(body, "# 제목\n")
    assert.deepEqual(splitFrontmatter("# 제목"), { meta: null, body: "# 제목" })
  })

  it("convertWikiLinks: [[ ]]를 링크로, 그림 끼워 넣기와 코드 안은 그대로", () => {
    const out = convertWikiLinks("보기 [[00.AI와 함께 일하기 시작하기]] 와 [[README|안내]] ![[a.png]] `[[코드]]`")
    assert.ok(out.includes(`[00.AI와 함께 일하기 시작하기](${WIKI_HREF_PREFIX}${encodeURIComponent("00.AI와 함께 일하기 시작하기")})`))
    assert.ok(out.includes(`[안내](${WIKI_HREF_PREFIX}README)`))
    assert.ok(out.includes(" a.png "))
    assert.ok(out.includes("`[[코드]]`"))
  })

  it("findWikiTarget: 이름만으로, 경로까지 적은 것으로 찾는다", () => {
    assert.equal(findWikiTarget(tree, "00.AI와 함께 일하기 시작하기"), "01. 온보딩/00.AI와 함께 일하기 시작하기.md")
    assert.equal(findWikiTarget(tree, "05. 브랜드·마케팅/README"), "05. 브랜드·마케팅/README.md")
    assert.equal(findWikiTarget(tree, "없는 문서"), null)
    assert.equal(findWikiTarget(tree, "02. 회사 소개/README"), null)
  })

  it("resolveRelativePath: 상대 경로와 인코딩된 이름을 푼다", () => {
    assert.equal(resolveRelativePath("01. 온보딩/README.md", "../05.%20브랜드·마케팅/README.md"), "05. 브랜드·마케팅/README.md")
    assert.equal(resolveRelativePath("a/b.md", "./c.md#절"), "a/c.md")
    assert.equal(resolveRelativePath("a/b.md", "%E0%A4%A.md"), "a/%E0%A4%A.md")
  })
})

describe("docs source helpers", () => {
  it("orderSources: 회사 문서 먼저, ADK 문서 맨 뒤", () => {
    const ids = orderSources([{ id: "adk" }, { id: "naia-comm" }, { id: "company:x" }]).map((s) => s.id)
    assert.deepEqual(ids, ["company:x", "naia-comm", "adk"])
  })

  it("firstDoc: 트리 순서대로 처음 나오는 문서", () => {
    assert.equal(firstDoc(tree), "01. 온보딩/00.AI와 함께 일하기 시작하기.md")
    assert.equal(firstDoc([]), null)
  })
})
