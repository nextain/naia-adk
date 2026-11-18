"""메신저 1차 화면 캡처(가짜 서버로 띄운 대시보드). 운영 주소는 받지 않는다.

실행 예(저장소 루트):
  node packages/dashboard/scripts/messenger-fake-server.mjs 3241 &
  NODE_ENV=production NAIA_API_PORT=3241 NAIA_SHORT_LINKS_FILE=tmp/msgui1/short-links.json node packages/dashboard/server.mjs -p 3242 -H 127.0.0.1 &
  python3 packages/dashboard/scripts/messenger-shots.py http://127.0.0.1:3242 http://127.0.0.1:3241 tmp/msgui1/shots
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

base, fake, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
if not base.startswith("http://127.0.0.1:") or not fake.startswith("http://127.0.0.1:"):
    raise SystemExit("로컬 주소만 받는다")
out.mkdir(parents=True, exist_ok=True)


def fake_post(path: str, body: dict) -> dict:
    req = urllib.request.Request(fake + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as res:
        return json.load(res)


with urllib.request.urlopen(fake + "/__fake/ids") as res:
    ids = json.load(res)

VIEWS = {"desktop": {"width": 1440, "height": 900}, "mobile": {"width": 412, "height": 915}}
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, size in VIEWS.items():
        mobile = name == "mobile"
        ctx = browser.new_context(viewport=size, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, locale="ko-KR")
        page = ctx.new_page()
        fake_post("/__fake/clear-alerts", {})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1) 채널 목록 + 표 글
        if mobile:
            page.goto(f"{base}/messages", wait_until="networkidle")
            expect(page.get_by_test_id("channel-list")).to_be_visible()
            page.screenshot(path=str(out / f"{name}-0-channel-list.png"))
            page.get_by_test_id("channel-item").first.click()
            expect(page.get_by_test_id("message-list")).to_be_visible()
        else:
            page.goto(f"{base}/messages/work-request", wait_until="networkidle")
        table = page.get_by_test_id("msg-table").first
        expect(table).to_be_visible()
        expect(page.get_by_test_id("messenger-stream-status")).to_have_attribute("title", "실시간 연결됨", timeout=10000)
        page.locator(f"#msg-{ids['table']}").scroll_into_view_if_needed()
        page.evaluate(f"document.getElementById('msg-{ids['table']}').scrollIntoView({{block:'start'}})")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"{name}-1-channels-table.png"))

        # 2) 승인 카드 (+ 데스크톱은 오른쪽 문서 미리보기)
        page.goto(f"{base}/messages/work-request/{ids['approval']}", wait_until="networkidle")
        card = page.get_by_test_id("approval-card")
        expect(card).to_be_visible()
        expect(page.get_by_test_id("approval-approve")).to_be_visible()
        if not mobile:
            page.get_by_test_id("approval-doc-link").click()
            expect(page.get_by_test_id("doc-preview").get_by_text("나이아 메신저 1차 설계").first).to_be_visible(timeout=10000)
        page.evaluate(f"document.getElementById('msg-{ids['approval']}').scrollIntoView({{block:'center'}})")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"{name}-2-approval-card.png"))
        if mobile:
            page.get_by_test_id("approval-doc-link").click()
            expect(page.get_by_test_id("doc-preview").get_by_text("나이아 메신저 1차 설계").first).to_be_visible(timeout=10000)
            page.screenshot(path=str(out / f"{name}-2b-doc-preview.png"))
            page.get_by_test_id("doc-preview-close").click()

        # 3) 30분 무응답 빨간 띠 (SSE 로 실시간 도착)
        page.goto(f"{base}/messages/work-request", wait_until="networkidle")
        expect(page.get_by_test_id("messenger-stream-status")).to_have_attribute("title", "실시간 연결됨", timeout=10000)
        fake_post("/__fake/alert", {"message_id": ids["table"], "channel_id": "work-request", "target_id": "coder"})
        expect(page.get_by_test_id("messenger-alert")).to_be_visible(timeout=10000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"{name}-3-alert-banner.png"))
        results.append({"view": name, "page_errors": errors})
        ctx.close()
    browser.close()

print(json.dumps(results, ensure_ascii=False))
