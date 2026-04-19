#!/usr/bin/env python3
"""
Claude Code 사용량 모니터

사용법:
  python3 cc-monitor.py                # 상태 출력 + 임계 초과 시 이메일 경고
  python3 cc-monitor.py --status       # 상태만 출력
  python3 cc-monitor.py --snooze 18:00 # 오늘 18:00까지 알림 지연
  python3 cc-monitor.py --snooze "2026-04-09 10:00" # 특정 시각까지 지연
  python3 cc-monitor.py --unsnooze     # 지연 취소 (즉시 알림 다시 활성)

환경변수 (cc-monitor.env 또는 shell export):
  ALERT_EMAIL_TO        수신 Gmail
  ALERT_EMAIL_FROM      발신 Gmail
  ALERT_EMAIL_PASSWORD  Gmail 앱 비밀번호
  WEEKLY_TOKEN_LIMIT    주간 토큰 한도 (기본 80_000_000 = 80M)
  WARN_THRESHOLD        경고 임계값 0~1 (기본 0.70)
"""

import os, sys, json, smtplib
from datetime import date, datetime, timezone, timedelta
from email.mime.text import MIMEText
from pathlib import Path

# ── 설정 로드 ─────────────────────────────────────────────
DOTENV = Path(__file__).parent / "cc-monitor.env"
if DOTENV.exists():
    for line in DOTENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

EMAIL_TO       = os.environ.get("ALERT_EMAIL_TO", "")
EMAIL_FROM     = os.environ.get("ALERT_EMAIL_FROM", "")
EMAIL_PASS     = os.environ.get("ALERT_EMAIL_PASSWORD", "")
WEEKLY_LIMIT   = int(os.environ.get("WEEKLY_TOKEN_LIMIT", "80_000_000"))
WARN_THRESHOLD = float(os.environ.get("WARN_THRESHOLD", "0.70"))
STATE_FILE     = Path.home() / ".cache" / "cc-monitor-state.json"
LOG_DIR        = Path.home() / ".claude" / "projects"

# 리셋 시점 (사용자 스크린샷 기준: 금 15:59, 일 09:59)
RESET_POINTS = [
    {"day": 4, "hour": 15, "minute": 59}, # 금요일 15:59
    {"day": 6, "hour": 9, "minute": 59},  # 일요일 09:59
]

def get_next_reset(now: datetime) -> datetime:
    candidates = []
    for rp in RESET_POINTS:
        target = now.replace(hour=rp["hour"], minute=rp["minute"], second=0, microsecond=0)
        days_diff = rp["day"] - target.weekday()
        target += timedelta(days=days_diff)
        if target <= now:
            target += timedelta(days=7)
        candidates.append(target)
    return min(candidates)

# ── JSONL 파싱 ────────────────────────────────────────────
def collect_tokens(since: datetime) -> dict:
    days = {}
    for path in LOG_DIR.rglob("*.jsonl"):
        try:
            with open(path, encoding="utf-8", errors="ignore") as f:
                for raw in f:
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    ts_str = obj.get("timestamp")
                    usage  = obj.get("message", {}).get("usage")
                    if not ts_str or not usage:
                        continue
                    try:
                        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    except ValueError:
                        continue
                    if ts < since:
                        continue
                    day = ts.astimezone().strftime("%Y-%m-%d")
                    if day not in days:
                        days[day] = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
                    days[day]["input"]         += usage.get("input_tokens", 0)
                    days[day]["output"]         += usage.get("output_tokens", 0)
                    days[day]["cache_read"]     += usage.get("cache_read_input_tokens", 0)
                    days[day]["cache_creation"] += usage.get("cache_creation_input_tokens", 0)
        except (OSError, PermissionError):
            continue
    return days

def eff(t: dict) -> int:
    return t["input"] + t["output"] + t["cache_read"] + t["cache_creation"]

# ── 주간 집계 + 예측 ──────────────────────────────────────
def compute(days: dict) -> dict:
    today      = date.today()
    week_start = today - timedelta(days=today.weekday())
    week_days  = [(week_start + timedelta(days=i)).isoformat() for i in range(7)]

    week_total  = sum(eff(days[d]) for d in week_days if d in days)
    days_so_far = (today - week_start).days + 1
    avg_daily   = week_total / days_so_far
    projected   = avg_daily * 7
    pct         = projected / WEEKLY_LIMIT * 100 if WEEKLY_LIMIT else 0
    today_str   = today.isoformat()
    today_tok   = eff(days[today_str]) if today_str in days else 0

    return dict(
        week_start=week_start.isoformat(), today=today_str,
        today_tokens=today_tok, week_total=week_total,
        projected=projected, avg_daily=avg_daily,
        days_so_far=days_so_far, pct=pct,
        over_warn=(projected >= WEEKLY_LIMIT * WARN_THRESHOLD),
        over_budget=(projected >= WEEKLY_LIMIT),
        days=days, week_days=week_days,
    )

# ── 터미널 상태 출력 ──────────────────────────────────────
def fmt(n: int) -> str:
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.0f}K"
    return str(n)

BAR = 28
def print_status(c: dict, snooze_until: datetime = None):
    fill  = min(int(c["pct"] / 100 * BAR), BAR)
    bar   = "█" * fill + "░" * (BAR - fill)
    level = "🔴 초과" if c["over_budget"] else ("🟡 경고" if c["over_warn"] else "🟢 정상")
    limit = fmt(WEEKLY_LIMIT)
    
    snooze_status = f" (Snoozed until {snooze_until.strftime('%H:%M')})" if snooze_until and datetime.now() < snooze_until else ""

    print()
    print("  ┌─ Claude Code 주간 토큰 모니터 ─────────────────────┐")
    print(f"  │  오늘:          {fmt(c['today_tokens']):>8}                       │")
    print(f"  │  이번주:        {fmt(c['week_total']):>8}  (일평균 {fmt(int(c['avg_daily']))})     │")
    print(f"  │  주말까지 예측: {fmt(int(c['projected'])):>8}  / {limit} ({c['pct']:.0f}%)  │")
    print(f"  │  [{bar}] {level}{snooze_status:<20} │")
    print(f"  │                                                      │")
    print( "  │  일별 상세:                                          │")
    for d in c["week_days"]:
        tok  = c["days"].get(d)
        mark = " ◀ today" if d == c["today"] else ""
        val  = fmt(eff(tok)) if tok else "—"
        print(f"  │    {d}  {val:>8}{mark:<10}             │")
    print( "  └──────────────────────────────────────────────────────┘")
    print()

# ── 알림 상태 및 지연 ──────────────────────────────────────
def load_state() -> dict:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists(): return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}

def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state))

def is_muted(c: dict, next_reset_str: str) -> bool:
    state = load_state()
    # 1. 리셋 기반 뮤트
    if state.get("next_reset_target") == next_reset_str:
        return True
    
    # 2. 사용자 지연(Snooze) 기반 뮤트
    snooze_until_str = state.get("snooze_until")
    if snooze_until_str:
        snooze_until = datetime.fromisoformat(snooze_until_str)
        if datetime.now() < snooze_until:
            return True
    return False

# ── 데스크탑 알림 ─────────────────────────────────────────
def desktop_notify(c: dict):
    status = "초과 예상" if c["over_budget"] else "경고 임계 도달"
    body   = (
        f"이번주 {fmt(c['week_total'])} 사용 • 주말 {fmt(int(c['projected']))} 예상 ({c['pct']:.0f}%)\n"
        f"한도: {fmt(WEEKLY_LIMIT)}"
    )
    os.system(f'notify-send -u critical "Claude Code {status}" "{body}" 2>/dev/null')

# ── 이메일 ───────────────────────────────────────────────
def send_email(c: dict):
    if not all([EMAIL_TO, EMAIL_FROM, EMAIL_PASS]):
        return
    status  = "초과 예상" if c["over_budget"] else "경고 임계 도달"
    subject = f"[Claude Code] 주간 토큰 {status} — {fmt(int(c['projected']))} / {fmt(WEEKLY_LIMIT)} ({c['pct']:.0f}%)"
    lines = [f"Claude Code 주간 사용량 {status}\n", f"오늘 사용: {fmt(c['today_tokens'])}", f"이번주 합계: {fmt(c['week_total'])}", f"주말 예측: {fmt(int(c['projected']))} ({c['pct']:.0f}%)", f"주간 한도: {fmt(WEEKLY_LIMIT)}", f"일 평균: {fmt(int(c['avg_daily']))}\n", "─" * 40, "일별 사용량:"]
    for d in c["week_days"]:
        tok  = c["days"].get(d)
        mark = " ◀ today" if d == c["today"] else ""
        val  = fmt(eff(tok)) if tok else "—"
        lines.append(f"  {d}: {val}{mark}")
    lines += ["", "※ cc-monitor.py 자동 발송"]
    msg = MIMEText("\n".join(lines), "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(EMAIL_FROM, EMAIL_PASS)
            smtp.sendmail(EMAIL_FROM, EMAIL_TO, msg.as_bytes())
    except Exception: pass

# ── main ─────────────────────────────────────────────────
def main():
    now = datetime.now()
    state = load_state()

    # ── 지연(Snooze) 강력 차단 ────────
    snooze_until_str = state.get("snooze_until")
    if snooze_until_str and "--unsnooze" not in sys.argv and "--snooze" not in sys.argv:
        snooze_until = datetime.fromisoformat(snooze_until_str)
        if now < snooze_until:
            print(f"🤫 알림 지연 중 (~{snooze_until.strftime('%m/%d %H:%M')}). 종료합니다.")
            sys.exit(0)

    # ── 인자 처리 ──────────────────
    if "--snooze" in sys.argv:
        idx = sys.argv.index("--snooze")
        try:
            val = sys.argv[idx+1]
            if val == "reset":
                target = get_next_reset(now)
            elif ":" in val and "-" not in val: # HH:MM
                h, m = map(int, val.split(":"))
                target = now.replace(hour=h, minute=m, second=0, microsecond=0)
                if target <= now: target += timedelta(days=1)
            else: # YYYY-MM-DD HH:MM
                target = datetime.fromisoformat(val)
            
            state["snooze_until"] = target.isoformat()
            save_state(state)
            print(f"⏰ 알림을 다음 리셋 시점({target.strftime('%m/%d %H:%M')})까지 지연합니다.")
            return
        except Exception as e:
            print(f"✗ 사용법: --snooze HH:MM 또는 --snooze 'YYYY-MM-DD HH:MM' ({e})")
            return

    if "--unsnooze" in sys.argv:
        state["snooze_until"] = None
        save_state(state)
        print("🔔 지연이 취소되었습니다. 알림이 다시 활성화됩니다.")
        return

    # ── 모니터링 로직 ───────────────
    next_reset = get_next_reset(now)
    next_reset_str = next_reset.isoformat()
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    since = datetime(week_start.year, week_start.month, week_start.day, tzinfo=timezone.utc)

    days = collect_tokens(since)
    c    = compute(days)
    
    snooze_until = None
    if state.get("snooze_until"):
        snooze_until = datetime.fromisoformat(state["snooze_until"])

    print_status(c, snooze_until)

    if "--status" in sys.argv:
        return

    if c["over_warn"]:
        if is_muted(c, next_reset_str):
            muted_msg = f"지연 중 (~{snooze_until.strftime('%H:%M')})" if (snooze_until and now < snooze_until) else "리셋 전까지 뮤트됨"
            print(f"ℹ 알림 {muted_msg}")
            return
            
        print(f"🚨 임계치 도달! 알림을 전송합니다.")
        desktop_notify(c)
        send_email(c)
        # 리셋 기반 뮤트 상태만 저장 (사용자 수동 지연은 유지)
        state["next_reset_target"] = next_reset_str
        save_state(state)
    else:
        # 정상 범위로 돌아오면 리셋 기반 뮤트 해제
        if state.get("next_reset_target"):
            state["next_reset_target"] = None
            save_state(state)
        print(f"✓ 정상 ({c['pct']:.0f}% 예측 — 경고 기준 {WARN_THRESHOLD*100:.0f}% 미만)")

if __name__ == "__main__":
    main()
