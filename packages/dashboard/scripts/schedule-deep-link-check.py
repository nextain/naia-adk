"""Browser regression with fake data; pass the URL of an isolated dashboard test server."""

import argparse
import json
from urllib.parse import urlencode, urlparse

from playwright.sync_api import sync_playwright


DATE = "2026-11-18"


def work_item(item_id, title, kind, *, completed=False, cancelled=False):
    return {
        "id": item_id, "title": title, "issue": "", "status": "완료" if completed else "취소",
        "kind": kind, "completed": completed, "cancelled": cancelled, "overdue": False,
        "hasDates": True, "startDate": DATE, "endDate": DATE, "dueDate": DATE,
        "startSource": "startAt", "endSource": "dueDate", "dueSource": "dueDate",
        "dateSources": ["startAt", "dueDate"], "milestoneId": None, "milestoneName": None,
        "parentGroupId": None, "parentGroupName": None,
    }


BOARD = {
    "todayDate": DATE, "observedAt": None, "undatedItems": [],
    "workItems": [
        work_item("done", "완료 가상 작업", "work_document", completed=True),
        work_item("cancelled", "취소 가상 작업", "work_document", cancelled=True),
        work_item("queue", "취소 가상 큐", "queue", cancelled=True),
    ],
    "milestones": [{"id": "m1", "name": "가상 마일스톤", "description": "", "order": 1,
                    "dueDate": DATE, "daysRemaining": 0, "completed": 0, "total": 1, "overdue": False}],
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base", help="URL of the isolated local dashboard server")
    args = parser.parse_args()
    parsed = urlparse(args.base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        parser.error("base must be a local HTTP test server")
    cases = [
        ("work:done", "완료 가상 작업"),
        ("work:cancelled", "취소 가상 작업"),
        ("queue:queue", "취소 가상 큐"),
        ("milestone:m1", "가상 마일스톤"),
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        try:
            for target, expected in cases:
                page = browser.new_page()
                try:
                    page.add_init_script("localStorage.setItem('portal.schedule.mode.v1','list'); localStorage.setItem('portal.schedule.workFilter.v1','open')")
                    page.route("**/board-schedule", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(BOARD, ensure_ascii=False)))
                    page.route("**/schedule-personal", lambda route: route.fulfill(status=403, content_type="application/json", body='{"error":"personal-schedule-identity-required"}'))
                    page.route("**/api/portal", lambda route: route.fulfill(status=200, content_type="application/json", body='{"board":{"port":1}}'))
                    page.goto(f"{args.base.rstrip('/')}/schedule?{urlencode({'item': target, 'date': DATE})}", wait_until="networkidle")
                    detail = page.get_by_test_id("schedule-event-detail-backdrop")
                    detail.wait_for(state="visible", timeout=10000)
                    assert expected in detail.inner_text(), target
                    assert page.get_by_text("일정을 찾지 못했습니다.", exact=False).count() == 0, target
                    assert page.evaluate("localStorage.getItem('portal.schedule.mode.v1')") == "list", target
                    assert page.evaluate("localStorage.getItem('portal.schedule.workFilter.v1')") == "open", target
                    print(f"PASS {target}")
                finally:
                    page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
