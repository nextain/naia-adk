---
name: webapp-testing
description: Playwright로 로컬 웹 앱을 테스트합니다. naia.nextain.io, about.nextain.io, aiedu.nextain.io 등 Next.js 앱의 E2E 테스트, UI 동작 검증, 스크린샷 캡처, 콘솔 로그 확인 시 반드시 사용. 사용자에게 수동 테스트를 시키지 말고 이 스킬로 AI가 직접 검증할 것.
---

# 웹 앱 테스트

Playwright Python 스크립트로 로컬 웹 앱을 직접 테스트합니다.

**헬퍼 스크립트:**
- `.agents/skills/webapp-testing/scripts/with_server.py` — 서버 시작 → 포트 ready 대기 → 테스트 실행 → 서버 정리

**규칙:** 스크립트는 읽지 말고 실행만 할 것 (`--help` 먼저 실행).

```bash
python .agents/skills/webapp-testing/scripts/with_server.py --help
```

## 의사결정 트리

```
테스트 대상 → 정적 HTML?
    ├─ Yes → 파일 직접 Read → 셀렉터 파악 → Playwright 스크립트 작성
    └─ No (동적 앱) → 서버가 이미 실행 중?
        ├─ No → python .agents/skills/webapp-testing/scripts/with_server.py --help 실행 후 사용
        └─ Yes → Reconnaissance-then-action 패턴 사용
```

## Reconnaissance-then-Action 패턴

서버가 실행 중일 때:
1. `page.wait_for_load_state('networkidle')` 대기 (동적 앱 필수)
2. 스크린샷 또는 DOM 확인으로 셀렉터 발견
3. 발견된 셀렉터로 액션 실행

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:3000')
    page.wait_for_load_state('networkidle')  # 필수: JS 실행 대기

    # 1. 탐색
    page.screenshot(path='/tmp/inspect.png', full_page=True)
    buttons = page.locator('button').all()

    # 2. 액션
    page.click('text=로그인')
    browser.close()
```

## with_server.py 사용법

```bash
# Next.js 단일 서버
python .agents/skills/webapp-testing/scripts/with_server.py \
  --server "cd /var/home/luke/dev/naia.nextain.io && npm run dev" \
  --port 3000 --timeout 90 \
  -- python /tmp/test_script.py

# 백엔드 + 프론트엔드
python .agents/skills/webapp-testing/scripts/with_server.py \
  --server "cd backend && python server.py" --port 8000 \
  --server "cd frontend && npm run dev" --port 3000 --timeout 90 \
  -- python /tmp/test_script.py
```

## 콘솔 로그 캡처

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    console_logs = []
    page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))

    page.goto('http://localhost:3000')
    page.wait_for_load_state('networkidle')
    # 액션 수행 후
    print('\n'.join(console_logs))
    browser.close()
```

## 프로젝트별 참고

| 프로젝트 | 명령어 | 포트 | timeout |
|---------|--------|------|---------|
| naia.nextain.io | `npm run dev` | 3000 | 90s |
| about.nextain.io | `npm run dev` | 3000 | 60s |
| aiedu.nextain.io | `npm run dev` | 3000 | 60s |
| naia-os (Tauri) | tauri-driver 필요 — Tauri 공식 문서 참고 | - | - |

**naia-os Tauri 테스트**: 일반 Playwright headless 불가. `tauri-driver`로 WebDriver 서버를 실행하고 Playwright가 해당 포트에 연결하는 방식. 포트/설정은 [Tauri testing 문서](https://tauri.app/ko/develop/tests/webdriver/) 참고.

## 주의사항

- `networkidle` 없이 동적 앱 DOM 읽으면 빈 결과 나옴
- Next.js cold start는 90초 이상 걸릴 수 있음 — `--timeout 90` 이상 권장
- naia.nextain.io는 DB(Prisma + PostgreSQL)와 `.env` 필요 — 없으면 사용자에게 요청
- 스크린샷은 `/tmp/`에 저장
