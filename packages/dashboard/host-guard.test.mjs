import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import {
  hostGuard,
  getTailscaleDnsName,
  clearTailscaleDnsCache,
  getCustomDashboardHosts,
} from "./host-guard.mjs"

describe("Host Guard 단위 시험 (FE 8장 135행)", () => {
  it("IP 주소 Host는 포트 포함 여부와 무관하게 허용된다", () => {
    // IPv4
    assert.equal(hostGuard("127.0.0.1"), true)
    assert.equal(hostGuard("127.0.0.1:3142"), true)
    assert.equal(hostGuard("127.0.0.1:8080"), true)
    assert.equal(hostGuard("192.0.2.10:3142"), true)
    assert.equal(hostGuard("100.64.0.1:3172"), true)

    // IPv6 대괄호 형태
    assert.equal(hostGuard("[::1]"), true)
    assert.equal(hostGuard("[::1]:3142"), true)
    assert.equal(hostGuard("[fd7a:115c:a1e0::1]:3142"), true)
    assert.equal(hostGuard("[::ffff:127.0.0.1]:3142"), true)

    // 원시 IPv6 형태
    assert.equal(hostGuard("::1"), true)
  })

  it("localhost는 대소문자 및 포트와 무관하게 허용된다", () => {
    assert.equal(hostGuard("localhost"), true)
    assert.equal(hostGuard("localhost:3142"), true)
    assert.equal(hostGuard("LocalHost:80"), true)
    assert.equal(hostGuard("LOCALHOST:3172"), true)
  })

  it("Tailscale 정규 DNS 이름은 허용되고 60초간 캐시된다", () => {
    clearTailscaleDnsCache()
    const tsDns = getTailscaleDnsName()
    if (tsDns) {
      assert.equal(hostGuard(tsDns), true)
      assert.equal(hostGuard(`${tsDns}:3142`), true)
      assert.equal(hostGuard(`${tsDns}:3172`), true)
    }
  })

  it("NAIA_DASHBOARD_HOSTS에 등록된 이름은 허용된다", () => {
    const original = process.env.NAIA_DASHBOARD_HOSTS
    try {
      process.env.NAIA_DASHBOARD_HOSTS = "custom-portal.lan, test-host.local"
      assert.equal(hostGuard("custom-portal.lan"), true)
      assert.equal(hostGuard("custom-portal.lan:3142"), true)
      assert.equal(hostGuard("test-host.local:3172"), true)
    } finally {
      process.env.NAIA_DASHBOARD_HOSTS = original
    }
  })

  it("허용되지 않은 이름은 421 거절 대상(false)이다", () => {
    assert.equal(hostGuard("evil.ts.net"), false)
    assert.equal(hostGuard("evil.ts.net:3142"), false)
    assert.equal(hostGuard("evil.ts.net:3172"), false)
    assert.equal(hostGuard("attacker.example.com"), false)

    // 와일드카드, 짧은 이름, os.hostname() 거절
    assert.equal(hostGuard("*.ts.net"), false)
    assert.equal(hostGuard("*.ts.net:3142"), false)
    assert.equal(hostGuard(os.hostname()), false)
    assert.equal(hostGuard(`${os.hostname()}:3142`), false)

    // 빈 값 또는 잘못된 형식 거절
    assert.equal(hostGuard(""), false)
    assert.equal(hostGuard(undefined), false)
    assert.equal(hostGuard(null), false)
    assert.equal(hostGuard("localhost:invalidPort"), false)
    assert.equal(hostGuard("[::1]:invalidPort"), false)
  })
})
