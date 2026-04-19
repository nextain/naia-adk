#!/usr/bin/env python3
"""Send triage report via email — HTML with Tailwind CSS, Korean."""

import smtplib
import sys
import re
import json
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent

def load_smtp_config():
    env_file = Path("/var/home/luke/dev/my-envs/smtp.env")
    config = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            config[key.strip()] = val.strip()
    return config

def load_knowledge():
    kf = SCRIPT_DIR / "knowledge.json"
    if kf.exists():
        return json.loads(kf.read_text(encoding="utf-8"))
    return {}

# English → Korean translation map for common issue titles
TITLE_KO = {
    # naia-os
    "Dynamic Panel Abstraction — AI-driven workspace": "동적 패널 추상화 — AI 자율 워크스페이스",
    "Dynamic Panel Abstraction — AI-driven workspace with visual self-perception": "동적 패널 추상화 — AI 자율 워크스페이스 + 시각적 자기인식",
    "Task lifecycle framework — tracked skill execution": "태스크 라이프사이클 — 스킬 실행 추적",
    "Tool safety metadata — concurrency and destructive declarations": "도구 안전 메타데이터 — 동시성/파괴적 작업 선언",
    "Tool safety metadata — concurrency + destructive declarations": "도구 안전 메타데이터 — 동시성/파괴적 작업 선언",
    "Epic: Agent Architecture Modernization": "에픽: 에이전트 아키텍처 현대화",
    "epic(agent): Agent Architecture Modernization — tool safety, task tracking, context budget": "에픽: 에이전트 아키텍처 현대화 — 도구 안전, 태스크 추적, 컨텍스트 예산",
    "Windows deep link login — protocol handler not registered in dev builds": "Windows 딥링크 로그인 — 개발 빌드에서 프로토콜 핸들러 미등록",
    "Windows deep link login — protocol handler": "Windows 딥링크 로그인 — 프로토콜 핸들러",
    "Wire Memory System into Naia Shell — real user integration": "메모리 시스템 Shell 연결 — 실사용자 통합",
    "Memory v1 출시 판정": "메모리 v1 출시 판정",
    "Context window budget management — token warning + auto-compact": "컨텍스트 윈도우 예산 관리 — 토큰 경고 + 자동 압축",
    "Memory System P2 — scale tests, activate decay/KG, cross-session": "메모리 P2 — 스케일 테스트, 감쇠/KG 활성화, 크로스 세션",
    "Memory benchmark comparison — evaluate against mem0, Zep, MemGPT baselines": "메모리 벤치마크 — mem0, Zep, MemGPT 대비 평가",
    "Remove OpenClaw runtime dependency — adopt ref-cc skill standard + any-llm gateway": "OpenClaw 런타임 제거 — ref-cc 스킬 표준 + any-llm 게이트웨이 채택",
    "MiniCPM-o 4.5 vllm-omni upstream PR — clean rewrite on upstream/main": "MiniCPM-o 4.5 vllm-omni 업스트림 PR — 클린 재작성",
    "Mobile companion app — PC pairing + always-connected communication": "모바일 컴패니언 앱 — PC 페어링 + 상시 연결",
    "Naia mobile companion app — PC pairing + always-connected communication": "모바일 컴패니언 앱 — PC 페어링 + 상시 연결",
    "Memo panel — Naia memo skill integration": "메모 패널 — 메모 스킬 통합",
    "Chrome X11 embed covers modal dialogs — hide on overlay open": "Chrome X11 임베드가 모달을 가림 — 오버레이 시 숨김",
    "Home Panel — ambient desktop with widget system": "홈 패널 — 위젯 시스템 기반 데스크톱",
    "Naia OS model selection strategy — Qwen3-8B abliteration, embedding, fine-tuning roadmap": "모델 선택 전략 — Qwen3-8B, 임베딩, 파인튜닝 로드맵",
    "restore bot token on Naia login for accounts with Discord linked": "Discord 연동 계정 Naia 로그인 시 봇 토큰 복원",
    "Shell autonomous context manager": "Shell 자율 컨텍스트 관리자",
    "Gateway service file not updated on upgrade": "게이트웨이 서비스 파일 업그레이드 미반영",
    "Cross-platform support (Windows/macOS/SteamOS)": "크로스 플랫폼 지원 (Windows/macOS/SteamOS)",
    # member-luke
    "Automated issue triage — local cron + Claude CLI headless agents": "자동 이슈 분류 — 로컬 cron + Claude CLI 헤드리스",
    "Automated AI development performance scorecard — periodic reporting to Naia": "AI 개발 성과 스코어카드 — Naia 주기적 보고",
    "AI 네이티브 개발 체계 특허 재검토": "AI 네이티브 개발 체계 특허 재검토",
    "harness: adopt gstack patterns — Completeness Principle, 2-pass review, plan scope modes, Error & Rescue Map": "하네스: gstack 패턴 도입 — 완전성 원칙, 2단계 리뷰",
    "dev gateway environment — safe multi-developer development": "개발 게이트웨이 환경 — 다중 개발자 안전 환경",
    "common skills architecture — shared SoT across multi-repo workspace": "공통 스킬 아키텍처 — 멀티레포 SoT 공유",
    "add project-specific context differences to root CLAUDE.md": "프로젝트별 컨텍스트 차이 CLAUDE.md에 추가",
    # aiedu
    "AI 교사 패널 terminal-test 추가 — 수업 가이드 + POE 교수법": "AI 교사 패널 터미널 테스트 — POE 교수법",
    "simulation terminal lesson-specific modes — project files, chat/agent mode, config variants": "시뮬레이션 터미널 수업별 모드 — 프로젝트 파일, 채팅/에이전트 모드",
    "terminal session not reset when switching lessons": "레슨 전환 시 터미널 세션 미초기화",
    "exercise.md not served by API and no UI to display exercises": "exercise.md API 미제공 + 연습문제 UI 없음",
    "terminal gwChatCompletionsRaw uses platform key without user field": "터미널 API 호출 시 사용자 필드 누락",
    "purchase page hardcoded Korean strings — i18n keys missing": "구매 페이지 하드코딩 문자열 — i18n 키 누락",
    "certificate completion trigger missing from frontend": "수료증 발급 트리거 프론트엔드 누락",
    "B2C purchase/mypage routes to wrong curriculum (always python-basics)": "B2C 구매/마이페이지 커리큘럼 매핑 오류",
    "AI 코딩 상세 페이지 → 교사용 가이드 수준 보강 + PDF 출력": "AI 코딩 상세 페이지 보강 + PDF 출력",
    "Naia 계정 연동 유료 크레딧 교육 구매 (B2C)": "Naia 계정 연동 유료 크레딧 구매 (B2C)",
    "Desktop API keys accumulate on repeated login — no cleanup": "반복 로그인 시 API 키 누적 — 정리 안 됨",
    "email inquiry form — replace mailto link with form submission": "이메일 문의 폼 — mailto 링크 → 폼 전환",
    "B2B extension — Organization, RBAC, License Keys, Prompt Logging": "B2B 확장 — 조직, RBAC, 라이선스, 프롬프트 로깅",
    "DB backup/rollback safety mechanism": "DB 백업/롤백 안전 메커니즘",
}

def translate_title(en_title: str) -> str:
    """Return Korean translation if available, else empty string."""
    # Exact match first
    if en_title in TITLE_KO:
        return TITLE_KO[en_title]
    # Partial match — try matching the longest substring
    for k, v in sorted(TITLE_KO.items(), key=lambda x: len(x[0]), reverse=True):
        if k in en_title:
            return v
    return ""

def md_to_html_report(md_text: str) -> str:
    """Convert triage markdown report to styled HTML email."""
    knowledge = load_knowledge()
    today = date.today().isoformat()

    # Parse stats from knowledge
    history = knowledge.get("triage_history", [])
    latest = history[-1] if history else {}
    total = latest.get("total_issues", "?")
    by_p = latest.get("by_priority", {})
    changes = latest.get("changes_made", 0)
    anomalies = latest.get("anomalies_flagged", 0)

    # Parse sections from markdown
    sections = md_text.split("\n## ")

    # Extract sections
    p0_items = []
    p1_key_items = []
    anomaly_items = []
    recommendations = []
    dependencies = []
    parallel_items = []
    release_items = []

    for section in sections:
        if section.startswith("Priority Overview"):
            # Extract P0 table rows
            for line in section.split("\n"):
                m = re.match(r'\|\s*#(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|', line)
                if m and not line.startswith("| # |") and "---" not in line:
                    p0_items.append({
                        "num": m.group(1),
                        "title": m.group(2).strip(),
                        "notes": m.group(3).strip()
                    })
            # Extract P1 key items
            for line in section.split("\n"):
                m = re.match(r'- `(.+?)` #(\d+) — (.+)', line)
                if m:
                    p1_key_items.append({
                        "repo": m.group(1),
                        "num": m.group(2),
                        "title": m.group(3).strip()
                    })

        elif section.startswith("Anomalies"):
            for line in section.split("\n"):
                m = re.match(r'### \d+\. ⚠\s*(.+)', line)
                if m:
                    anomaly_items.append(m.group(1).strip())

        elif section.startswith("Recommendations"):
            for line in section.split("\n"):
                m = re.match(r'\d+\. \*\*(.+?)\*\* — (.+)', line)
                if m:
                    recommendations.append({
                        "title": m.group(1),
                        "desc": m.group(2)
                    })

        elif section.startswith("Parallel Work"):
            parallel_items = []
            for line in section.split("\n"):
                m = re.match(r'- \*\*Session ([A-Z])\*\*:\s*(.+)', line)
                if m:
                    parallel_items.append({
                        "session": m.group(1),
                        "desc": m.group(2).strip()
                    })

        elif section.startswith("Release Readiness"):
            release_items = []
            for line in section.split("\n"):
                m = re.match(r'\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|', line)
                if m and not line.startswith("| Project") and not line.startswith("|--"):
                    release_items.append({
                        "project": m.group(1).strip(),
                        "last": m.group(2).strip(),
                        "completed": m.group(3).strip(),
                        "blockers": m.group(4).strip(),
                        "verdict": m.group(5).strip()
                    })

        elif section.startswith("Cross-Project"):
            for line in section.split("\n"):
                m = re.match(r'\|\s*(.+?)\s*\|\s*(.+?)\s*\|', line)
                if m and not line.startswith("| Dep") and not line.startswith("|--"):
                    dependencies.append({
                        "dep": m.group(1).strip(),
                        "detail": m.group(2).strip()
                    })

    # Repo slug → GitHub URL map
    REPO_URLS = {
        "naia-os": "https://github.com/nextain/naia-os/issues/",
        "member-luke": "https://github.com/nextain/member-luke/issues/",
        "aiedu.nextain.io": "https://github.com/nextain/aiedu.nextain.io/issues/",
        "aiedu": "https://github.com/nextain/aiedu.nextain.io/issues/",
        "naia.nextain.io": "https://github.com/nextain/naia.nextain.io/issues/",
        "admin.nextain.io": "https://github.com/nextain/admin.nextain.io/issues/",
        "any-llm": "https://github.com/nextain/any-llm/issues/",
    }

    def guess_repo_url(title, notes=""):
        """Guess the repo URL from context clues in title/notes."""
        text = f"{title} {notes}".lower()
        if "aiedu" in text or "launch-blocker" in text or "교사" in text or "terminal" in text or "exercise" in text or "curriculum" in text or "purchase" in text or "certificate" in text:
            return REPO_URLS["aiedu.nextain.io"]
        if "member-luke" in text or "triage" in text or "harness" in text or "scorecard" in text or "특허" in text:
            return REPO_URLS["member-luke"]
        if "admin" in text:
            return REPO_URLS["admin.nextain.io"]
        if ("any-llm" in text) or ("gateway" in text and "naia" not in text):
            return REPO_URLS["any-llm"]
        return REPO_URLS["naia-os"]  # default

    def title_cell(title, num, repo_hint=""):
        """Build title cell with Korean translation + linked original."""
        ko = translate_title(title)
        url = REPO_URLS.get(repo_hint, guess_repo_url(title)) + num
        if ko:
            return f'''<div style="font-weight: 500;">{ko}</div>
            <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;"><a href="{url}" style="color: #94a3b8; text-decoration: underline;">{title}</a></div>'''
        else:
            return f'''<div><a href="{url}" style="color: #1e293b; text-decoration: none; font-weight: 500;">{title}</a></div>'''

    # Translate notes too
    def translate_notes(notes):
        """Translate common notes phrases."""
        tr = {
            "launch-blocker": "런칭 블로커",
            "depends on": "의존:",
            "Game-changer per strategic priorities": "전략적 게임체인저",
            "Part of Epic": "에픽 소속",
            "See anomaly below": "아래 이상 참조",
            "Depends on": "의존:",
            "This system (currently being built)": "현재 구축 중인 시스템",
            "core feature gap": "핵심 기능 부재",
            "UX bug": "UX 버그",
            "content delivery broken": "콘텐츠 전달 불가",
            "Umbrella for": "하위 이슈:",
        }
        result = notes
        for en, ko in tr.items():
            result = result.replace(en, ko)
        return result

    # Build P0 rows HTML
    p0_html = ""
    for item in p0_items:
        ko_notes = translate_notes(item["notes"])
        p0_html += f'''
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 12px; font-weight: 600; color: #6366f1; vertical-align: top;">#{item["num"]}</td>
          <td style="padding: 10px 12px;">{title_cell(item["title"], item["num"])}</td>
          <td style="padding: 10px 12px; color: #6b7280; font-size: 13px; vertical-align: top;">{ko_notes}</td>
        </tr>'''

    # Build P1 rows HTML
    p1_html = ""
    for item in p1_key_items[:10]:  # Top 10
        p1_html += f'''
        <tr style="border-bottom: 1px solid #f8fafc;">
          <td style="padding: 8px 12px; color: #6b7280; font-size: 13px;">{item["repo"]}</td>
          <td style="padding: 8px 12px; font-weight: 500;">#{item["num"]}</td>
          <td style="padding: 8px 12px; font-size: 13px;">{title_cell(item["title"], item["num"], item["repo"])}</td>
        </tr>'''

    # Release verdict color helper
    def verdict_colors(verdict: str) -> tuple:
        """Return (bg_color, text_color) for release verdict badge."""
        if "Not ready" in verdict or "미준비" in verdict:
            return "#fef2f2", "#dc2626"
        if "away" in verdict or "남음" in verdict:
            return "#fef3c7", "#92400e"
        if "Ready" in verdict or "준비" in verdict:
            return "#dcfce7", "#166534"
        return "#f1f5f9", "#64748b"  # unknown

    # Translate recommendations
    REC_KO = {
        "aiedu launch-blockers first": "aiedu 런칭 블로커 최우선",
        "Review naia-os P0 count": "naia-os P0 개수 재검토",
        "naia-os #187 (Dynamic Panel)": "naia-os #187 (동적 패널)",
        "Epic #182 (Agent Architecture)": "에픽 #182 (에이전트 아키텍처)",
        "member-luke #8 (scorecard)": "member-luke #8 (스코어카드)",
    }

    def translate_rec(title, desc):
        ko_title = REC_KO.get(title, title)
        ko_desc = desc
        ko_desc = ko_desc.replace("4 P0s blocking revenue", "매출 차단 P0 4건")
        ko_desc = ko_desc.replace("Suggested order:", "추천 순서:")
        ko_desc = ko_desc.replace("These should consume most available cycles until resolved", "해결될 때까지 가용 시간 집중")
        ko_desc = ko_desc.replace("is too many for a 1-person team to hold simultaneously", "1인 팀이 동시에 감당하기에 너무 많음")
        ko_desc = ko_desc.replace("Consider triaging", "분류 조정 검토:")
        ko_desc = ko_desc.replace("down to P1 to focus the P0 list on true blockers", "P1로 하향하여 P0을 진짜 블로커에만 집중")
        ko_desc = ko_desc.replace("is marked P0 and labeled game-changer, but it's a large feature", "P0이지만 대규모 피처")
        ko_desc = ko_desc.replace("Consider if it's truly blocking or if it should be P1-high with a target date", "진짜 블로커인지 검토, P1로 조정 가능")
        ko_desc = ko_desc.replace("has 3 P0 children", "P0 하위 이슈 3개")
        ko_desc = ko_desc.replace("ensure this isn't inflating the P0 count artificially", "P0 수가 인위적으로 부풀려진 건 아닌지 확인")
        ko_desc = ko_desc.replace("The epic itself could be P1 since it's a tracking issue", "에픽 자체는 추적용이므로 P1이 적절")
        ko_desc = ko_desc.replace("at P1 synergizes with #12 (triage)", "P1이며 #12(triage)와 시너지")
        ko_desc = ko_desc.replace("consider combining outputs", "출력 통합 검토")
        return ko_title, ko_desc

    # Build recommendations HTML
    rec_html = ""
    for i, r in enumerate(recommendations, 1):
        ko_title, ko_desc = translate_rec(r["title"], r["desc"])
        rec_html += f'''
        <div style="padding: 12px 16px; background: #f8fafc; border-radius: 8px; margin-bottom: 8px;">
          <span style="font-weight: 600; color: #1e293b;">{i}. {ko_title}</span>
          <span style="color: #64748b;"> — {ko_desc}</span>
        </div>'''

    # Build anomaly badges
    anomaly_html = ""
    for a in anomaly_items:
        anomaly_html += f'<span style="display: inline-block; background: #fef3c7; color: #92400e; padding: 4px 10px; border-radius: 12px; font-size: 13px; margin: 3px;">{a}</span> '

    # Build dependency rows
    dep_html = ""
    for d in dependencies:
        dep_html += f'''
        <tr style="border-bottom: 1px solid #f8fafc;">
          <td style="padding: 6px 12px; font-family: monospace; font-size: 13px; color: #6366f1;">{d["dep"]}</td>
          <td style="padding: 6px 12px; font-size: 13px; color: #6b7280;">{d["detail"]}</td>
        </tr>'''

    html = f'''<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 680px; margin: 0 auto; padding: 24px 16px;">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 16px; padding: 32px; margin-bottom: 24px; color: white;">
      <div style="font-size: 13px; opacity: 0.8; margin-bottom: 4px;">NAIA TRIAGE</div>
      <div style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">일일 이슈 보고서</div>
      <div style="font-size: 15px; opacity: 0.9;">{today}</div>
    </div>

    <!-- Stats Cards -->
    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
      <div style="flex: 1; background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 28px; font-weight: 700; color: #1e293b;">{total}</div>
        <div style="font-size: 13px; color: #94a3b8;">전체 이슈</div>
      </div>
      <div style="flex: 1; background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 28px; font-weight: 700; color: #ef4444;">{by_p.get("P0", 0)}</div>
        <div style="font-size: 13px; color: #94a3b8;">P0 긴급</div>
      </div>
      <div style="flex: 1; background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 28px; font-weight: 700; color: #f59e0b;">{by_p.get("P1", 0)}</div>
        <div style="font-size: 13px; color: #94a3b8;">P1 높음</div>
      </div>
      <div style="flex: 1; background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 28px; font-weight: 700; color: #22c55e;">{changes}</div>
        <div style="font-size: 13px; color: #94a3b8;">변경</div>
      </div>
    </div>

    <!-- Anomalies -->
    {"" if not anomaly_items else f'''
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
      <div style="font-weight: 600; color: #92400e; margin-bottom: 8px;">&#9888; 이상 감지 ({anomalies}건)</div>
      <div>{anomaly_html}</div>
    </div>
    '''}

    <!-- P0 Table -->
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">P0 긴급 이슈</span>
        <span style="background: #fef2f2; color: #dc2626; padding: 2px 8px; border-radius: 8px; font-size: 12px; font-weight: 600; margin-left: 8px;">{by_p.get("P0", 0)}</span>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8; font-weight: 600;">#</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8; font-weight: 600;">제목</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8; font-weight: 600;">비고</th>
          </tr>
        </thead>
        <tbody>{p0_html}</tbody>
      </table>
    </div>

    <!-- P1 Table -->
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">P1 주요 이슈</span>
        <span style="background: #fefce8; color: #ca8a04; padding: 2px 8px; border-radius: 8px; font-size: 12px; font-weight: 600; margin-left: 8px;">{by_p.get("P1", 0)}</span>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 6px 12px; text-align: left; font-size: 12px; color: #94a3b8;">레포</th>
            <th style="padding: 6px 12px; text-align: left; font-size: 12px; color: #94a3b8;">#</th>
            <th style="padding: 6px 12px; text-align: left; font-size: 12px; color: #94a3b8;">제목</th>
          </tr>
        </thead>
        <tbody>{p1_html}</tbody>
      </table>
    </div>

    <!-- Parallel Work -->
    {"" if not parallel_items else f'''
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">병행 작업 추천</span>
        <span style="font-size: 13px; color: #94a3b8; margin-left: 8px;">터미널 세션별 동시 진행 가능</span>
      </div>
      <div style="padding: 16px;">
        {"".join(f'<div style="padding: 10px 16px; background: #f0fdf4; border-left: 3px solid #22c55e; border-radius: 0 8px 8px 0; margin-bottom: 8px;"><span style="font-weight: 600; color: #166534;">세션 {p["session"]}</span> <span style="color: #374151;">{p["desc"]}</span></div>' for p in parallel_items)}
      </div>
    </div>
    '''}

    <!-- Release Readiness -->
    {"" if not release_items else f'''
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">릴리즈 판단</span>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8;">프로젝트</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8;">최근 릴리즈</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8;">완료</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8;">남은 블로커</th>
            <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #94a3b8;">판정</th>
          </tr>
        </thead>
        <tbody>
          {"".join(f'<tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; font-weight: 500;">{r["project"]}</td><td style="padding: 8px 12px; font-size: 13px; color: #94a3b8;">{r["last"]}</td><td style="padding: 8px 12px; font-size: 13px;">{r["completed"]}</td><td style="padding: 8px 12px; font-size: 13px; color: #dc2626;">{r["blockers"]}</td><td style="padding: 8px 12px; font-size: 13px;"><span style="background: {verdict_colors(r["verdict"])[0]}; color: {verdict_colors(r["verdict"])[1]}; padding: 2px 8px; border-radius: 8px; font-size: 12px;">{r["verdict"]}</span></td></tr>' for r in release_items)}
        </tbody>
      </table>
    </div>
    '''}

    <!-- Cross-Project Dependencies -->
    {"" if not dependencies else f'''
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">크로스 프로젝트 의존성</span>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <tbody>{dep_html}</tbody>
      </table>
    </div>
    '''}

    <!-- Recommendations -->
    {"" if not recommendations else f'''
    <div style="background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; overflow: hidden;">
      <div style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
        <span style="font-size: 16px; font-weight: 700; color: #1e293b;">추천 조치</span>
      </div>
      <div style="padding: 16px;">{rec_html}</div>
    </div>
    '''}

    <!-- Footer -->
    <div style="text-align: center; padding: 16px; color: #94a3b8; font-size: 12px;">
      Naia Issue Triage Agent &middot; 이 메일에 회신하면 다음 분석에 반영됩니다<br>
      P2: {by_p.get("P2", 0)}건 &middot; P3: {by_p.get("P3", 0)}건 &middot; 전체 {total}건
    </div>

  </div>
</body>
</html>'''
    return html

def send_report(report_path: str):
    config = load_smtp_config()
    report_md = Path(report_path).read_text(encoding="utf-8")
    today = date.today().isoformat()

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[Naia] 일일 이슈 보고서 — {today}"
    msg["From"] = config["SMTP_USER"]
    msg["To"] = "dev@nextain.io"
    msg["Reply-To"] = "dev@nextain.io"

    # Plain text fallback (Korean header)
    plain = f"Naia 일일 이슈 보고서 — {today}\n\n{report_md}"
    msg.attach(MIMEText(plain, "plain", "utf-8"))

    # HTML version
    html = md_to_html_report(report_md)
    msg.attach(MIMEText(html, "html", "utf-8"))

    with smtplib.SMTP("smtp.office365.com", 587) as server:
        server.starttls()
        server.login(config["SMTP_USER"], config["SMTP_PASS"])
        server.send_message(msg)

    print(f"Report sent to dev@nextain.io")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <report.md>")
        sys.exit(1)
    send_report(sys.argv[1])
