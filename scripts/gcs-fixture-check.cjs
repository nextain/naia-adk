"use strict";
// 공개 GCS 관문 시험 자료에 예시가 아닌 버킷 이름이 있는지 찾는다(#99, #100).
// JSON 을 먼저 풀어 이스케이프된 주소도 원래 모양으로 본 뒤, 모든 키·문자열 값에서 버킷 이름을 뽑는다.
const NAME = "([a-z0-9][a-z0-9._-]*)";
const PATTERNS = [
  new RegExp(`gs://${NAME}`, "gi"),
  new RegExp(`gcs:${NAME}`, "gi"),
  new RegExp(`(?<![a-z0-9._-])storage\\.googleapis\\.com/storage/v1/b/${NAME}`, "gi"),
  new RegExp(`(?<![a-z0-9._-])storage\\.(?:cloud\\.)?googleapis\\.com/(?!storage/v1/)${NAME}`, "gi"),
  new RegExp(`${NAME}\\.storage\\.googleapis\\.com`, "gi"),
];
const EXAMPLE = /^(example-[a-z0-9-]+|other-bucket)$/;

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectStrings(child, out);
    }
  }
  return out;
}

function findPrivateBuckets(fixture) {
  const names = new Set();
  for (const text of collectStrings(fixture)) {
    for (const re of PATTERNS) for (const m of text.matchAll(re)) names.add(m[1].toLowerCase());
  }
  return [...names].filter((name) => !EXAMPLE.test(name));
}

module.exports = { findPrivateBuckets };
