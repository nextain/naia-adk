"use strict";
const assert = require("assert");
const { findPrivateBuckets } = require("./gcs-fixture-check.cjs");

const cmd = (c) => ({ cases: [{ name: "x", cmd: c, expect: "block" }] });
const cases = [
  ["예시 gs 허용", cmd("gsutil cp gs://example-prod-bucket/a ."), []],
  ["예시 https 허용", cmd("curl https://storage.googleapis.com/example-archive-bucket/a"), []],
  ["비예시 gs 거부", cmd("gsutil cp gs://acme-private/a ."), ["acme-private"]],
  ["비예시 gcs: 거부", cmd("rclone sync . gcs:acme-private"), ["acme-private"]],
  ["비예시 https 경로 거부", cmd("curl https://storage.googleapis.com/acme-private/a"), ["acme-private"]],
  ["비예시 JSON API 거부", cmd("curl https://storage.googleapis.com/storage/v1/b/acme-private/o"), ["acme-private"]],
  ["비예시 가상 호스트 거부", cmd("curl https://acme-private.storage.googleapis.com/a"), ["acme-private"]],
  ["대문자 거부", cmd("gsutil cp GS://Acme-Private/a ."), ["acme-private"]],
  ["키에 든 이름 거부", { "gs://acme-private": 1 }, ["acme-private"]],
];
for (const [label, fixture, want] of cases) {
  assert.deepStrictEqual(findPrivateBuckets(fixture), want, label);
}
// 이스케이프된 슬래시: 원문에선 gs:\/\/ 이지만 JSON 을 풀면 gs:// 이다.
const escaped = JSON.parse('{"cases":[{"cmd":"gsutil cp gs:\\/\\/acme-private\\/a ."}]}');
assert.deepStrictEqual(findPrivateBuckets(escaped), ["acme-private"], "이스케이프 gs 거부");
console.log(`gcs fixture check: ${cases.length + 1}/${cases.length + 1} PASS`);
