"""메신저 1차 화면 동작 확인(가짜 서버). 가짜 서버를 이 대본이 직접 띄우고 끈다(다시 붙기 확인용).

실행 예(저장소 루트, 대시보드는 NAIA_API_PORT=3241 로 3242 에 떠 있어야 함):
  python3 packages/dashboard/scripts/messenger-flow-check.py http://127.0.0.1:3242 3241
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

base, fake_port = sys.argv[1], int(sys.argv[2])
if not base.startswith("http://127.0.0.1:"):
    raise SystemExit("로컬 주소만 받는다")
fake = f"http://127.0.0.1:{fake_port}"
script = Path(__file__).with_name("messenger-fake-server.mjs")


def start_fake() -> subprocess.Popen:
    proc = subprocess.Popen(["node", str(script), str(fake_port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(fake + "/__fake/ids", timeout=0.5)
            return proc
        except Exception:
            time.sleep(0.1)
    raise SystemExit("가짜 서버가 뜨지 않음")


def fake_post(path: str, body: dict) -> dict:
    req = urllib.request.Request(fake + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as res:
        return json.load(res)


checks: list[str] = []
proc = start_fake()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, locale="ko-KR")
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/messages/work-request", wait_until="networkidle")
        status = page.get_by_test_id("messenger-stream-status")
        expect(status).to_have_attribute("title", "실시간 연결됨", timeout=10000)
        checks.append("SSE 연결")

        box = page.get_by_test_id("composer-input").first
        box.click()
        box.type("확인 부탁 @co")
        expect(page.get_by_test_id("mention-list")).to_be_visible()
        box.press("Enter")
        expect(box).to_have_value("확인 부탁 @coder ")
        checks.append("@ 자동 완성(Enter 로 고름)")
        box.press("Shift+Enter")
        box.type("둘째 줄")
        expect(box).to_have_value("확인 부탁 @coder \n둘째 줄")
        checks.append("Shift+Enter 줄바꿈")
        box.press("Enter")
        expect(box).to_have_value("")
        expect(page.get_by_test_id("msg-item").filter(has_text="둘째 줄")).to_have_count(1)
        checks.append("Enter 보내기 → 글 한 번만 보임(SSE 중복 없음)")

        last = page.get_by_test_id("msg-item").last
        last.hover()
        last.get_by_test_id("msg-reaction-add").click()
        page.get_by_test_id("msg-reaction-picker").get_by_text("🎉").click()
        expect(last.get_by_test_id("msg-reaction")).to_have_text("🎉1")
        last.get_by_test_id("msg-reaction").click()
        expect(last.get_by_test_id("msg-reaction")).to_have_count(0)
        checks.append("반응 더하기·지우기")

        page.get_by_test_id("msg-thread-open").first.click()
        thread = page.get_by_test_id("thread-panel")
        expect(thread.get_by_text("서버는 약속 모양 그대로 맞추겠습니다.")).to_be_visible()
        thread.get_by_test_id("composer-input").fill("스레드 답글 시험")
        thread.get_by_test_id("composer-input").press("Enter")
        expect(thread.get_by_text("스레드 답글 시험")).to_be_visible()
        expect(page.get_by_test_id("msg-thread-open").first).to_have_text("답글 3개")
        checks.append("스레드 열기·답글")

        page.get_by_test_id("approval-approve").click()
        expect(page.get_by_test_id("approval-status")).to_have_text("승인됨")
        expect(page.get_by_test_id("approval-approve")).to_have_count(0)
        expect(page.get_by_test_id("msg-item").filter(has_text="PLAN-MSG001 STEP-UI0001").last).to_be_visible()
        checks.append("승인 → 승인됨 + 코드 글")

        infra = page.locator('[data-testid="channel-item"][data-channel-id="infra"]')
        expect(infra.get_by_test_id("channel-unread")).to_have_text("3")
        fake_post("/__fake/message", {"channel_id": "infra", "body": "실시간 새 글"})
        expect(infra.get_by_test_id("channel-unread")).to_have_text("4")
        checks.append("다른 채널 새 글 → 안 읽은 수 실시간 증가")
        infra.click()
        expect(page.get_by_test_id("messenger-channel-title")).to_have_text("# 사내-인프라")
        expect(page.get_by_text("실시간 새 글")).to_be_visible()
        expect(infra.get_by_test_id("channel-unread")).to_have_count(0)
        checks.append("채널 고르면 읽음")

        proc.terminate()
        proc.wait()
        expect(status).to_have_attribute("title", "연결이 끊겨 다시 붙는 중", timeout=15000)
        proc = start_fake()
        fake_post("/__fake/message", {"channel_id": "infra", "body": "끊긴 뒤 새 글"})
        expect(status).to_have_attribute("title", "실시간 연결됨", timeout=30000)
        expect(page.get_by_text("끊긴 뒤 새 글")).to_be_visible(timeout=10000)
        checks.append("서버 끊김 → 다시 붙음 + 놓친 글 채움")

        if errors:
            raise SystemExit(f"화면 오류: {errors}")
        browser.close()
finally:
    proc.terminate()

print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))
