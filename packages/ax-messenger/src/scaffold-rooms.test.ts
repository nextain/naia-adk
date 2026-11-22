import assert from "node:assert/strict"
import test from "node:test"
import { isScaffoldRoom, parseScaffoldRoomIds } from "./scaffold-rooms.js"

test("쉼표 목록을 방 식별자 배열로 만든다", () => {
  assert.deepEqual(parseScaffoldRoomIds(undefined), [])
  assert.deepEqual(parseScaffoldRoomIds("  "), [])
  assert.deepEqual(
    parseScaffoldRoomIds(" !a:tenant.example.invalid , !b:tenant.example.invalid,"),
    ["!a:tenant.example.invalid", "!b:tenant.example.invalid"],
  )
})

test("목록에 든 방 식별자일 때만 대상이다", () => {
  const allowlist = ["!a:tenant.example.invalid"]
  assert.equal(isScaffoldRoom("!a:tenant.example.invalid", allowlist), true)
  // 이름에 표지가 들어도 목록 밖이면 대상이 아니다.
  assert.equal(isScaffoldRoom("!b:tenant.example.invalid", allowlist), false)
  assert.equal(isScaffoldRoom("", allowlist), false)
})

test("목록이 비어 있으면 이름이 맞아도 대상이 아니다", () => {
  assert.equal(isScaffoldRoom("!a:tenant.example.invalid", []), false)
  assert.equal(isScaffoldRoom("", []), false)
});

test("초대·질답·재조정 세 경로가 같은 판정을 본다", () => {
  // 봇의 세 경로(초대 입장·질문 응답·미확정 인사 재조정)는 모두 이 함수 하나로
  // 목록을 검사한다. 목록 밖 방은 제공자를 부르지 않고 답·인사를 남기지 않는다.
  const allowlist = ["!a:tenant.example.invalid"]
  assert.equal(isScaffoldRoom("!b:tenant.example.invalid", allowlist), false)
  assert.equal(isScaffoldRoom("!a:tenant.example.invalid", allowlist), true)
});

test("앞뒤 공백·빈 표지는 대상이 아니다", () => {
  const allowlist = ["!a:tenant.example.invalid"]
  assert.equal(isScaffoldRoom("  !a:tenant.example.invalid  ", allowlist), true)
  assert.equal(isScaffoldRoom("   ", allowlist), false)
  assert.equal(isScaffoldRoom("!a:tenant.example.invalid ", [" !a:tenant.example.invalid "]), false)
});
