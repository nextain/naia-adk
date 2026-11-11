import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"
import { buildPublishBundle, canonicalBytes, hashBytes, PUBLISH_ASSET_LIMIT, PUBLISH_BUNDLE_LIMIT, PublishError, selectPublishBody, type PublishDescriptor } from "../src/publish-bundle.js"
import { PUBLISH_MAPPER_HASH } from "../src/publish-preview.js"

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const selector = { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" as const }
function fixture(body = "\n본문  \r\n![한 장](pictures/a.png)\r\n\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-bundle-"))
  fs.mkdirSync(path.join(root, "pictures"))
  fs.writeFileSync(path.join(root, "pictures/a.png"), png)
  const source = Buffer.from(`내부 기록\r\n## 본문\r\n${body}---\r\n\r\n## 근거표\r\n비공개\r\n`, "utf8")
  fs.writeFileSync(path.join(root, "source.md"), source)
  const descriptor: PublishDescriptor = {
    source: "test", path: "source.md", slug: "test-post", body_selector: { ...selector },
    frontmatter: {
      kind: "post", slug: "test-post", title: "게시 제목", summary: "게시 요약", date: "2026-11-01T23:00+09:00",
      hero: "assets/a.png", targets: ["site-a", "site-b"], languages: { "site-a": ["ko", "en"], "site-b": ["ko", "en"] },
      secondary_category: "ai", tags: ["둘", "하나"],
    },
    asset_roots: ["pictures"], asset_path_map: {},
    media_map: { ko: { ready: true, hero: "assets/a.png", body_images: ["assets/a.png"] }, en: { ready: false } },
  }
  return { root, descriptor, source }
}
const build = (f: ReturnType<typeof fixture>) => buildPublishBundle(f.descriptor, f.root)
function sizedImage(filename: string, size: number) {
  const fd = fs.openSync(filename, "w")
  fs.writeSync(fd, png)
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
}
describe("게시 고정 직렬화", () => {
  it("객체 순서는 지문에 영향을 주지 않고 의미 있는 배열 순서는 보존한다", () => {
    expect(canonicalBytes({ z: [1, 2], a: { 나: true, a: null } })).toEqual(canonicalBytes({ a: { a: null, 나: true }, z: [1, 2] }))
    expect(hashBytes(canonicalBytes(["a", "b"]))).not.toBe(hashBytes(canonicalBytes(["b", "a"])))
    expect(canonicalBytes("e\u0301")).not.toEqual(canonicalBytes("é"))
  })
  it.each([undefined, NaN, Infinity, 1.5, -0, 2 ** 53, new Date(), { x: undefined }, [undefined], Array(1)])("지원하지 않는 자료를 거절한다: %s", value => {
    expect(() => canonicalBytes(value)).toThrow(PublishError)
  })
})
describe("게시 원문과 묶음 지문", () => {
  it("CRLF·공백·끝 개행·문자 바이트를 보존하고 같은 버퍼를 보관한다", async () => {
    const f = fixture()
    const result = await build(f)
    expect(result.source_bytes).toEqual(f.source)
    expect(result.body_bytes).toEqual(Buffer.from("\n본문  \r\n![한 장](assets/a.png)\r\n\n"))
    expect(fs.readFileSync(path.join(f.root, "source.md"))).toEqual(f.source)
    expect(result.files["source.bin"]).toBe(result.source_bytes)
    expect(result.files["index.ko.md"]).toBe(result.index_bytes)
    expect(result.files["assets/a.png"]).toBe(result.assets[0].bytes)
    expect(result.files["previews/site-a/ko.json"]).toBe(result.previews["site-a"].ko.bytes)
    expect(result.files["descriptor.json"]).toBe(result.descriptor_bytes)
    expect(hashBytes(result.files["mapper.json"])).toBe(result.manifest.mapper_hash)
    expect(result.revision_id).toBe(`rev_${hashBytes(result.manifest_bytes)}`)
    expect(result.preview_hash).toBe(hashBytes(canonicalBytes(result.manifest)))
    expect(result.manifest.mapper_hash).toBe(PUBLISH_MAPPER_HASH)
    expect(result.assets[0].source_path).toBe("pictures/a.png")
    expect(Object.keys(result.manifest).sort()).toEqual(["schema_version", "input_hash", "slug", "source", "path", "source_hash", "descriptor_hash", "body_hash", "frontmatter_hash", "asset_hashes", "media_map_hash", "targets", "languages", "date", "mapper_version", "mapper_hash", "preview_hashes"].sort())
  })
  it("본문 첫 문자에 있는 BOM도 바꾸지 않는다", async () => {
    const f = fixture("\ufeff내용\r\n")
    f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: [] }
    expect((await build(f)).body_bytes).toEqual(Buffer.from("\ufeff내용\r\n"))
  })
  it("사이트와 언어 집합 순서만 바꾸면 같은 판이다", async () => {
    const f = fixture()
    const first = await build(f)
    f.descriptor.frontmatter.targets = ["site-b", "site-a"]
    f.descriptor.frontmatter.languages = { "site-b": ["en", "ko"], "site-a": ["en", "ko"] }
    expect((await build(f)).preview_hash).toBe(first.preview_hash)
  })
  it.each(["body", "frontmatter", "whole_source", "asset", "media", "targets", "languages", "date", "tag_order", "descriptor"])("%s 한 요소의 변경을 검출한다", async change => {
    const f = fixture()
    const first = await build(f)
    if (change === "body") fs.writeFileSync(path.join(f.root, "source.md"), f.source.toString().replace("본문  ", "본문 변경  "))
    if (change === "whole_source") fs.appendFileSync(path.join(f.root, "source.md"), "비공개 내용 변경")
    if (change === "frontmatter") f.descriptor.frontmatter.title = "다른 제목"
    if (change === "asset") fs.writeFileSync(path.join(f.root, "pictures/a.png"), Buffer.concat([png, Buffer.from([2])]))
    if (change === "media") f.descriptor.media_map.en = { ready: false, hero: "assets/a.png" }
    if (change === "targets") { f.descriptor.frontmatter.targets = ["site-a"]; f.descriptor.frontmatter.languages = { "site-a": ["ko", "en"] } }
    if (change === "languages") { f.descriptor.frontmatter.languages = { "site-a": ["ko"], "site-b": ["ko"] }; delete f.descriptor.media_map.en }
    if (change === "date") f.descriptor.frontmatter.date = "2026-11-02T00:00+09:00"
    if (change === "tag_order") f.descriptor.frontmatter.tags = ["하나", "둘"]
    if (change === "descriptor") f.descriptor.source = "different-source"
    const second = await build(f)
    expect(second.preview_hash).not.toBe(first.preview_hash)
    if (change === "whole_source") expect(second.manifest.body_hash).toBe(first.manifest.body_hash)
    if (change === "asset") expect(second.manifest.asset_hashes[0].sha256).not.toBe(first.manifest.asset_hashes[0].sha256)
  })
  it("사이트별 표시 칸과 한국 날짜·원시각을 함께 고정한다", async () => {
    const result = await build(fixture())
    expect(result.previews["site-a"].ko.frontmatter).toMatchObject({ title: "게시 제목", description: "게시 요약", og_image: "assets/a.png" })
    expect(result.previews["site-b"].ko.frontmatter).toMatchObject({ titleKo: "게시 제목", summaryKo: "게시 요약", thumbnail: "assets/a.png", date: "2026-11-01", publishedAt: "2026-11-01T23:00+09:00", category: "ai" })
  })
})
describe("본문 경계와 필수 게시 정보", () => {
  it.each(["## 본문\n내용\n---\n\n다른 끝", "## 본문\n## 본문\n내용\n---\n\n## 근거표", "## 본문\n내용\n---\n\n## 근거표\n## 근거표", "## 본문\n내용\n\n## 근거표"])("누락·중복·임의 구분선을 거절한다", source => {
    expect(() => selectPublishBody(Buffer.from(source), selector)).toThrow(PublishError)
  })
  it.each([
    ["approved", true], ["title", ""], ["summary", "x".repeat(201)], ["hero", "../a.png"], ["category", "unknown"],
    ["tags", [1]], ["date", "2026-02-30T12:00+09:00"], ["date", "2026-11-01T23:00Z"], ["canonical", "javascript:alert(1)"],
    ["episode_no", 1.5], ["pages", ["https://example.com/a.png"]], ["shorts_url", "https://example.com/video"], ["event", { id: "e", deadline: "2026-11-01T00:00+09:00", items: [{ id: "i", name: "선택", image: "assets/missing.png" }] }],
  ])("알 수 없거나 지원하지 않는 앞머리 %s를 정확한 칸 오류로 거절한다", async (field, value) => {
    const f = fixture()
    f.descriptor.frontmatter[field as string] = value as any
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: expect.stringContaining("frontmatter.") })
  })
  it("연구노트처럼 필수 게시 정보가 없으면 승인 묶음을 만들지 않는다", async () => {
    const f = fixture()
    delete f.descriptor.frontmatter.hero
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "frontmatter.hero" })
  })
})
describe("준비된 언어별 회차 매체 검사", () => {
  const episode = (pageCount: number) => {
    const f = fixture("\n웹툰 본문\n")
    const pages = Array.from({ length: pageCount }, (_, i) => `assets/en-${String(i).padStart(2, "0")}.png`).reverse()
    for (const page of [...pages, "assets/en-cover.png"]) fs.writeFileSync(path.join(f.root, "pictures", path.posix.basename(page)), png)
    f.descriptor.frontmatter = {
      kind: "episode", slug: f.descriptor.slug, title: "언어별 웹툰", date: "2026-11-01T23:00+09:00",
      targets: ["site-a"], languages: { "site-a": ["ko", "en"] },
      series: "clock-out", format: "webtoon", episode_no: 1, cover: "assets/a.png", pages: ["assets/a.png"],
    }
    f.descriptor.media_map = {
      ko: { ready: true, cover: "assets/a.png", pages: ["assets/a.png"], body_images: [] },
      en: { ready: true, cover: "assets/en-cover.png", pages, body_images: [] },
    }
    return { ...f, pages }
  }
  it.each([0, 1, 40, 41])("한국어 1장과 별개로 준비된 영어 웹툰 %i장의 1~40 경계를 검사한다", async count => {
    const f = episode(count)
    if (count === 0 || count === 41) {
      await expect(build(f)).rejects.toMatchObject({ status: 422, code: "invalid_bundle", field: "media_map.en.pages" })
    } else {
      const result = await build(f)
      expect((result.media_map.ko as any).pages.map((ref: any) => ref.path)).toEqual(["assets/a.png"])
      expect((result.media_map.en as any).pages).toEqual(f.pages.map(p => ({ path: p, sha256: hashBytes(png) })))
      expect((result.media_map.en as any).cover.path).toBe("assets/en-cover.png")
      for (const page of f.pages) expect(result.files[page]).toEqual(png)
    }
  })
  it.each([
    ["cover", undefined, "media_map.en.cover"],
    ["cover", "assets/missing.png", "media_map.en.cover"],
    ["cover", { path: "assets/en-cover.png", sha256: "0".repeat(64) }, "media_map.en.cover"],
    ["pages", "assets/en-00.png", "media_map.en.pages"],
    ["pages", ["https://example.com/page.png"], "media_map.en.pages.0"],
    ["body_images", undefined, "media_map.en.body_images"],
    ["shorts_url", "https://example.com/video", "media_map.en.shorts_url"],
    ["event", { id: "event", deadline: "2026-11-01T23:00+09:00", items: [{ id: "item", name: "항목", image: "assets/missing.png" }] }, "media_map.en.event.items.0.image"],
  ])("준비된 영어의 %s에도 필수·경로·지문·형식 검사를 적용한다", async (key, value, field) => {
    const f = episode(1)
    const entry = f.descriptor.media_map.en as Record<string, any>
    if (value === undefined) delete entry[key as string]
    else entry[key as string] = value
    await expect(build(f)).rejects.toMatchObject({ status: 422, field })
  })
  it("웹툰이 아닌 준비된 언어도 장 목록 40장 한도를 지키며 빈 목록을 허용한다", async () => {
    const f = episode(41)
    f.descriptor.frontmatter.format = "shorts"
    f.descriptor.frontmatter.pages = []
    f.descriptor.frontmatter.shorts_url = "https://youtube.com/shorts/korean"
    f.descriptor.media_map.ko = { ready: true, cover: "assets/a.png", pages: [], shorts_url: "https://youtube.com/shorts/korean", body_images: [] }
    const en = f.descriptor.media_map.en as Record<string, any>
    en.shorts_url = "https://youtu.be/english"
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "media_map.en.pages" })
    en.pages = []
    const result = await build(f)
    expect((result.media_map.en as any).pages).toEqual([])
    expect((result.media_map.en as any).shorts_url).toBe("https://youtu.be/english")
  })
})
describe("그림 묶음 검사", () => {
  it.each(["![그림](pictures/a.png)", "<div>\n<img src=pictures/a.png>\n</div>"])("공백과 구문 문자가 있는 게시 목적지를 422로 거절한다: %s", async syntax => {
    const f = fixture(`\n${syntax}\n`)
    for (const destination of ["assets/a b.png", "assets/a\tb.png", "assets/a'b.png", 'assets/a"b.png', "assets/a<b.png", "assets/a>b.png", "assets/a`b.png", "assets/a=b.png", "assets/a(b).png", "assets/a&b.png", "assets/a\\b.png", "assets/a\u007fb.png", "assets/a\u0085b.png", "assets/a\u202eb.png"]) {
      f.descriptor.asset_path_map = { "pictures/a.png": destination }
      f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: [destination] }
      await expect(build(f), destination).rejects.toMatchObject({ status: 422, field: "asset_path_map.pictures/a.png" })
    }
  })
  it("기본 게시 경로에도 안전한 문자 제한을 적용한다", async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, "pictures/a b.png"), png)
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "asset_path_map.pictures/a b.png" })
  })
  it.each(["![그림](pictures/a.png)", "<div>\n<img src=pictures/a.png>\n</div>", "![그림][image]\n\n[image]: pictures/a.png"].flatMap(syntax => ["assets/Room-1/A_b.2.png", "assets/방-1/그림_é.２.png", "assets/𐐀/그림_𝟘.png"].map(destination => [syntax, destination])))("최종 본문 그림과 대응표에 안전한 게시 경로를 같은 순서로 보존한다: %s → %s", async (syntax, destination) => {
    const f = fixture(`\n${syntax}\n`)
    f.descriptor.asset_path_map = { "pictures/a.png": destination }
    f.descriptor.frontmatter.hero = destination
    f.descriptor.media_map.ko = { ready: true, hero: destination, body_images: [destination] }
    const result = await build(f)
    expect(result.body_bytes).toEqual(Buffer.from(`\n${syntax.replace("pictures/a.png", destination)}\n`))
    expect((result.media_map.ko as any).body_images).toEqual([{ path: destination, sha256: hashBytes(png) }])
    expect(result.files[destination]).toEqual(png)
    for (const preview of Object.values(result.previews)) expect(preview.ko.body).toBe(result.body_bytes.toString())
    f.descriptor.media_map.ko = { ready: true, hero: destination, body_images: [] }
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "media_map.ko.body_images" })
  })
  it.each(["원고 누락", "그림 누락", "원고가 폴더", "그림 폴더 누락"])("입력의 %s는 최초 422이며 대기판 뒤에만 409 변경이다", async change => {
    const f = fixture()
    const original = await build(f)
    if (change === "원고 누락") fs.renameSync(path.join(f.root, "source.md"), path.join(f.root, "renamed.md"))
    if (change === "그림 누락") fs.renameSync(path.join(f.root, "pictures/a.png"), path.join(f.root, "a.png"))
    if (change === "원고가 폴더") { fs.renameSync(path.join(f.root, "source.md"), path.join(f.root, "renamed.md")); fs.mkdirSync(path.join(f.root, "source.md")) }
    if (change === "그림 폴더 누락") fs.renameSync(path.join(f.root, "pictures"), path.join(f.root, "renamed"))
    await expect(build(f)).rejects.toMatchObject({ status: 422 })
    await expect(buildPublishBundle(f.descriptor, f.root, original.input_hash)).rejects.toMatchObject({ status: 409, code: "PREVIEW_CHANGED" })
  })
  it("참조하지 않은 그림도 포함하고 순서를 바이트 경로 순서로 정한다", async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, "pictures/z.png"), png)
    fs.writeFileSync(path.join(f.root, "pictures/B.png"), png)
    fs.writeFileSync(path.join(f.root, "pictures/그림.png"), png)
    const result = await build(f)
    expect(result.assets.map(a => a.path)).toEqual(["assets/B.png", "assets/a.png", "assets/z.png", "assets/그림.png"])
    expect(result.files["assets/그림.png"]).toEqual(png)
    expect(result.manifest.asset_hashes).toHaveLength(4)
  })
  it("그림 게시 경로가 다른 원래 경로와 겹쳐도 본문·바이트·미디어 대응은 원래 경로를 우선한다", async () => {
    const f = fixture("\n![그림 가](assets/a.png)\r\n![그림 나](assets/b.png)\r\n\n")
    fs.renameSync(path.join(f.root, "pictures"), path.join(f.root, "assets"))
    const second = Buffer.concat([png, Buffer.from([2])])
    fs.writeFileSync(path.join(f.root, "assets/b.png"), second)
    f.descriptor.asset_roots = ["assets"]
    f.descriptor.asset_path_map = { "assets/a.png": "assets/c.png", "assets/b.png": "assets/a.png" }
    f.descriptor.frontmatter.hero = "assets/c.png"
    f.descriptor.media_map.ko = { ready: true, hero: "assets/c.png", body_images: ["assets/c.png", "assets/a.png"] }
    const result = await build(f)
    expect(result.body_bytes).toEqual(Buffer.from("\n![그림 가](assets/c.png)\r\n![그림 나](assets/a.png)\r\n\n"))
    expect(result.assets).toEqual([
      { path: "assets/a.png", source_path: "assets/b.png", format: "png", size: second.length, sha256: hashBytes(second), bytes: second },
      { path: "assets/c.png", source_path: "assets/a.png", format: "png", size: png.length, sha256: hashBytes(png), bytes: png },
    ])
    expect(result.files["assets/c.png"]).toEqual(png)
    expect(result.files["assets/a.png"]).toEqual(second)
    expect((result.media_map.ko as any).body_images).toEqual([{ path: "assets/c.png", sha256: hashBytes(png) }, { path: "assets/a.png", sha256: hashBytes(second) }])
    for (const preview of Object.values(result.previews)) expect(preview.ko.body).toBe(result.body_bytes.toString())
    for (const body_images of [["assets/a.png", "assets/b.png"], ["assets/a.png", "assets/a.png"]]) {
      f.descriptor.media_map.ko = { ready: true, hero: "assets/c.png", body_images }
      await expect(build(f)).rejects.toMatchObject({ status: 422, field: expect.stringMatching(/^media_map\.ko\.body_images/) })
    }
    f.descriptor.media_map.ko = { ready: true, hero: "assets/c.png", body_images: ["assets/c.png"] }
    fs.writeFileSync(path.join(f.root, "source.md"), f.source.toString().replace("![그림 가](assets/a.png)\r\n![그림 나](assets/b.png)", "![게시 경로](assets/c.png)"))
    expect((await build(f)).body_bytes.toString()).toContain("![게시 경로](assets/c.png)")
    f.descriptor.asset_path_map["assets/b.png"] = "assets/c.png"
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "assets/c.png" })
  })
  it("인용·HTML 그림 순서를 검증하며 코드 예시와 주석 바이트는 그대로 둔다", async () => {
    const body = '\n<img src="pictures/b.png">\n\n![참조][first]\n\n[first]: pictures/a.png\n\n`![코드](https://example.com/code.png)`\n```md\n![예시](missing.png)\n```\n<!-- <img src="missing.png"> -->\n'
    const f = fixture(body)
    fs.writeFileSync(path.join(f.root, "pictures/b.png"), png)
    f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: ["assets/b.png", "assets/a.png"] }
    const result = await build(f)
    expect(result.body_bytes.toString()).toContain('<img src="assets/b.png">')
    expect(result.body_bytes.toString()).toContain("[first]: assets/a.png")
    expect(result.body_bytes.toString()).toContain('`![코드](https://example.com/code.png)`\n```md\n![예시](missing.png)\n```\n<!-- <img src="missing.png"> -->')
  })
  it.each([
    '![첫줄\n둘째줄](pictures/a.png)',
    '![첫줄\r\n둘째줄](<pictures/a.png> "여러 줄 대체문구")',
    '![중첩 [대체] 문구](pictures/a.png)',
    '![첫줄\n둘째줄][body-image]\n\n[body-image]:\n  pictures/a.png "참조 그림"',
    '![body-image][]\n\n[body-image]: pictures/a.png',
    '![body-image]\n\n[body-image]: pictures/a.png',
    '<img\nsrc="pictures/a.png" alt="줄바꿈\n문구 > 포함">',
    '<div>\n<img src=pictures/a.png>\n</div>',
    '| 그림 |\n| --- |\n| ![표 그림](pictures/a.png) |',
  ])("표시 파서가 인식하는 모든 그림을 고정하고 경로 이외 바이트를 보존한다: %s", async syntax => {
    const f = fixture(`\n${syntax}\n`)
    const result = await build(f)
    expect(result.body_bytes).toEqual(Buffer.from(`\n${syntax.replace("pictures/a.png", "assets/a.png")}\n`))
    expect((result.media_map.ko as any).body_images).toEqual([{ path: "assets/a.png", sha256: hashBytes(png) }])
    f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: [] }
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "media_map.ko.body_images" })
  })
  it.each([
    '![첫줄\n둘째줄](https://example.com/a.png)',
    '![첫줄\r\n둘째줄](<https://example.com/a.png>)',
    '![첫줄\n둘째줄](pictures/missing.png)',
    '![첫줄\n둘째줄][image]\n\n[image]: https://example.com/a.png',
    '![image][]\n\n[image]: pictures/missing.png',
    '![image]\n\n[image]: https://example.com/a.png',
    '<img\nsrc="https://example.com/a.png" alt="문구 > 포함">',
    '<div>\n<img src=https://example.com/a.png>\n</div>',
    '<img src="pictures/missing.png">',
    '<img src="pictures/a.png" srcset="https://example.com/a.png 2x">',
    '<div>\n<<img src="https://example.com/a.png">\n</div>',
    '<div>\n<!--><img src="https://example.com/a.png">\n</div>',
    '<div>\n<!---><img src="https://example.com/a.png">\n</div>',
    '<div>\n<!-- comment --!><img src="https://example.com/a.png">\n</div>',
    '> ![첫줄\n> 둘째줄](https://example.com/a.png)',
    '> ![image]\n>\n> [image]:\n>   pictures/a.png',
    '![그림](pictures/a&#46;png)',
  ])("빈 미디어 목록도 외부·미등록 파서 그림을 숨길 수 없다: %s", async syntax => {
    const f = fixture(`\n${syntax}\n`)
    f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: [] }
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "body.image" })
  })
  it("게시할 이름의 확장자도 실제 그림 형식과 맞아야 한다", async () => {
    const f = fixture()
    f.descriptor.asset_path_map["pictures/a.png"] = "assets/a.jpg"
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "assets/a.jpg" })
  })
  it.each([
    ["jpg", Buffer.from([255, 216, 255, 224]), "jpg"],
    ["webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from([1])]), "webp"],
  ])("%s의 실제 머리 바이트를 인식한다", async (extension, bytes, format) => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, `pictures/extra.${extension}`), bytes as Buffer)
    const result = await build(f)
    expect(result.assets.find(asset => asset.path === `assets/extra.${extension}`)?.format).toBe(format)
  })
  it("준비하지 않은 언어도 대응표에 명시하고 알 수 없는 매체 칸은 거절한다", async () => {
    const f = fixture()
    delete f.descriptor.media_map.en
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "media_map.en" })
    f.descriptor.media_map.en = { ready: false, hidden: "폐기하면 안 되는 값" }
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "media_map.en.hidden" })
  })
  it.each([
    '<img data-src="pictures/a.png" src="https://example.com/external.png">',
    '<img src="pictures/a.png" src="https://example.com/external.png">',
    '![그림][same]\n\n[same]: https://example.com/external.png\n[same]: pictures/a.png',
  ])("중복·가짜 속성으로 실제 외부 그림을 숨길 수 없다", async html => {
    const f = fixture(`\n${html}\n`)
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "body.image" })
  })
  it.each(["missing", "magic", "extension", "escape", "external", "symlink", "hardlink", "root_symlink", "map_missing", "collision", "media_hash", "media_order"])("%s 그림을 거절한다", async mode => {
    const f = fixture()
    if (mode === "missing") f.descriptor.frontmatter.hero = "assets/missing.png"
    if (mode === "magic") fs.writeFileSync(path.join(f.root, "pictures/a.png"), "PNG가 아님")
    if (mode === "extension") { fs.renameSync(path.join(f.root, "pictures/a.png"), path.join(f.root, "pictures/a.jpg")) }
    if (mode === "escape") f.descriptor.asset_roots = ["../pictures"]
    if (mode === "external") fs.writeFileSync(path.join(f.root, "source.md"), f.source.toString().replace("pictures/a.png", "https://example.com/a.png"))
    if (mode === "symlink") fs.symlinkSync(path.join(f.root, "pictures/a.png"), path.join(f.root, "pictures/link.png"))
    if (mode === "hardlink") fs.linkSync(path.join(f.root, "pictures/a.png"), path.join(f.root, "pictures/link.png"))
    if (mode === "root_symlink") { fs.symlinkSync(path.join(f.root, "pictures"), path.join(f.root, "linked")); f.descriptor.asset_roots = ["linked"] }
    if (mode === "map_missing") f.descriptor.asset_path_map["pictures/missing.png"] = "assets/b.png"
    if (mode === "collision") { fs.writeFileSync(path.join(f.root, "pictures/b.png"), png); f.descriptor.asset_path_map["pictures/b.png"] = "assets/a.png" }
    if (mode === "media_hash") f.descriptor.media_map.ko = { ready: true, hero: { path: "assets/a.png", sha256: "0".repeat(64) }, body_images: ["assets/a.png"] }
    if (mode === "media_order") f.descriptor.media_map.ko = { ready: true, hero: "assets/a.png", body_images: [] }
    await expect(build(f)).rejects.toMatchObject({ status: 422 })
  })
  it("문서 파일·출처 루트 링크와 경계 밖 경로를 거절한다", async () => {
    const f = fixture()
    fs.symlinkSync(path.join(f.root, "source.md"), path.join(f.root, "link.md"))
    f.descriptor.path = "link.md"
    await expect(build(f)).rejects.toMatchObject({ status: 422 })
    f.descriptor.path = "../source.md"
    await expect(build(f)).rejects.toMatchObject({ status: 422, field: "path" })
    f.descriptor.path = "source.md"
    fs.symlinkSync(f.root, path.join(f.root, "alias"))
    await expect(buildPublishBundle(f.descriptor, path.join(f.root, "alias"))).rejects.toMatchObject({ status: 422 })
  })
  it("한 장의 정확한 한도는 허용하고 1바이트 초과는 413이다", async () => {
    const f = fixture()
    sizedImage(path.join(f.root, "pictures/a.png"), PUBLISH_ASSET_LIMIT)
    expect((await build(f)).assets[0].size).toBe(5_242_880)
    sizedImage(path.join(f.root, "pictures/a.png"), PUBLISH_ASSET_LIMIT + 1)
    await expect(build(f)).rejects.toMatchObject({ status: 413, code: "asset_limit" })
  })
  it("같은 바이트의 다른 16개 경로도 모두 합산하며 정확히 80MiB까지 허용한다", async () => {
    const f = fixture()
    sizedImage(path.join(f.root, "pictures/a.png"), PUBLISH_ASSET_LIMIT)
    for (let i = 1; i < 16; i++) sizedImage(path.join(f.root, `pictures/${i}.png`), PUBLISH_ASSET_LIMIT)
    const result = await build(f)
    expect(result.assets).toHaveLength(16)
    expect(new Set(result.assets.map(a => a.sha256)).size).toBe(1)
    expect(result.assets.reduce((total, a) => total + a.size, 0)).toBe(PUBLISH_BUNDLE_LIMIT)
    fs.writeFileSync(path.join(f.root, "pictures/over.png"), png)
    await expect(build(f)).rejects.toMatchObject({ status: 413, code: "bundle_limit" })
  })
})

