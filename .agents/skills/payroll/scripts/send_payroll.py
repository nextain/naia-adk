#!/usr/bin/env python3
"""
급여명세서 PDF 생성 + 이메일 발송 스크립트

Usage:
    python send_payroll.py --data '<JSON>' [--smtp-user USER] [--smtp-pass PASS] [--dry-run] [--output-dir DIR] [--logo PATH]

Dependencies: pip install fpdf2
"""

import argparse
import json
import os
import smtplib
import sys
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from fpdf import FPDF


# ── Brand ───────────────────────────────────────────────────
NEXTAIN_BLUE = (37, 99, 235)       # #2563EB
FLOW_CYAN = (6, 182, 212)          # #06B6D4
DEEP_NODE = (15, 23, 42)           # #0F172A
HEADER_NAVY = (30, 58, 95)         # #1E3A5F
LABEL_BG = (239, 246, 255)         # #EFF6FF  (blue-50)
TOTAL_BG = (219, 234, 254)         # #DBEAFE  (blue-100)
BORDER_GRAY = (203, 213, 225)      # #CBD5E1
ALT_ROW = (241, 245, 249)          # #F1F5F9
WHITE = (255, 255, 255)
BLACK = (23, 23, 23)               # #171717
MUTED = (100, 116, 139)            # #64748B

# Font paths (extracted from TTC via fonttools)
FONT_DIR = "/tmp/nanum-fonts"
FONT_REGULAR = os.path.join(FONT_DIR, "NanumGothic-Regular.ttf")
FONT_BOLD = os.path.join(FONT_DIR, "NanumGothic-Bold.ttf")
FONT_DOWNLOAD_BASE = "https://github.com/google/fonts/raw/main/ofl/nanumgothic"
DEFAULT_LOGO = "about.nextain.io/public/assets/logos/nextain-light-logo.png"


def ensure_fonts():
    """Download NanumGothic TTF if not present."""
    if os.path.exists(FONT_REGULAR) and os.path.exists(FONT_BOLD):
        return FONT_REGULAR, FONT_BOLD

    os.makedirs(FONT_DIR, exist_ok=True)
    import urllib.request

    for name in ["NanumGothic-Regular.ttf", "NanumGothic-Bold.ttf"]:
        dest = os.path.join(FONT_DIR, name)
        if not os.path.exists(dest):
            url = f"{FONT_DOWNLOAD_BASE}/{name}"
            print(f"  Downloading {name}...")
            urllib.request.urlretrieve(url, dest)

    return FONT_REGULAR, FONT_BOLD


def fmt_money(amount: int) -> str:
    return f"{amount:,}"


# ── PDF ─────────────────────────────────────────────────────

class PayrollPDF(FPDF):
    def __init__(self, company: dict, year: int, month: int,
                 logo_path: str | None = None, seal_path: str | None = None):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.company = company
        self.year = year
        self.month = month
        self.logo_path = logo_path
        self.seal_path = seal_path

        # Fonts
        regular, bold = ensure_fonts()
        self.add_font("NotoKR", "", regular)
        self.add_font("NotoKR", "B", bold)

        self.set_auto_page_break(auto=True, margin=15)

    # ── Helper: draw bordered cell ──
    def _rect_cell(self, x, y, w, h, text, bg=None, text_color=BLACK,
                   font_style="", font_size=9, align="L", border=True):
        if bg:
            self.set_fill_color(*bg)
            self.rect(x, y, w, h, "F")
        if border:
            self.set_draw_color(*BORDER_GRAY)
            self.rect(x, y, w, h)
        self.set_text_color(*text_color)
        self.set_font("NotoKR", font_style, font_size)
        # Vertical centering
        text_h = font_size * 0.35  # approximate
        ty = y + (h - text_h) / 2
        pad = 2
        if align == "R":
            tw = self.get_string_width(text)
            self.text(x + w - tw - pad, ty + text_h, text)
        elif align == "C":
            tw = self.get_string_width(text)
            self.text(x + (w - tw) / 2, ty + text_h, text)
        else:
            self.text(x + pad, ty + text_h, text)

    def _section_header(self, text, y):
        self.set_font("NotoKR", "B", 10)
        self.set_text_color(*NEXTAIN_BLUE)
        self.text(20, y, "\u25A0")
        tw = self.get_string_width("\u25A0")
        self.set_text_color(*BLACK)
        self.text(20 + tw + 1, y, f" {text}")
        return y + 5

    def generate(self, emp: dict) -> None:
        self.add_page()
        LM = 18  # left margin
        RM = 18
        CW = 210 - LM - RM  # content width = 174mm
        y = 15

        # ── Logo ──
        if self.logo_path and os.path.exists(self.logo_path):
            self.image(self.logo_path, x=LM, y=y, w=48)
            y += 16

        # ── Title ──
        self.set_font("NotoKR", "B", 20)
        self.set_text_color(*DEEP_NODE)
        title = "급 여 명 세 서"
        tw = self.get_string_width(title)
        self.text((210 - tw) / 2, y + 6, title)
        y += 12

        # Subtitle
        self.set_font("NotoKR", "", 11)
        self.set_text_color(*MUTED)
        sub = f"{self.year}년 {self.month:02d}월분"
        tw = self.get_string_width(sub)
        self.text((210 - tw) / 2, y + 4, sub)
        y += 9

        # Accent line
        self.set_draw_color(*NEXTAIN_BLUE)
        self.set_line_width(0.6)
        self.line(LM, y, 210 - RM, y)
        y += 5

        # ── Section 1: 사업장 정보 ──
        y = self._section_header("사업장 정보", y + 1)
        ROW_H = 8
        LABEL_W = 26
        VAL_W = (CW - 2 * LABEL_W) / 2

        rows = [
            [("회 사 명", self.company["name"]), ("대 표 자", self.company["ceo"])],
            [("사업자번호", self.company["biz_no"]), ("업     종", self.company.get("biz_type", ""))],
        ]
        for row in rows:
            x = LM
            for label, value in row:
                self._rect_cell(x, y, LABEL_W, ROW_H, label, bg=LABEL_BG, font_style="B", align="C")
                x += LABEL_W
                self._rect_cell(x, y, VAL_W, ROW_H, value)
                x += VAL_W
            y += ROW_H

        # Address row (spans full width)
        self._rect_cell(LM, y, LABEL_W, ROW_H, "주     소", bg=LABEL_BG, font_style="B", align="C")
        self._rect_cell(LM + LABEL_W, y, CW - LABEL_W, ROW_H, self.company["address"])
        y += ROW_H + 5

        # ── Section 2: 사원 정보 ──
        y = self._section_header("사원 정보", y)
        EMP_LBL_W = 22
        EMP_VAL_W = (CW - 3 * EMP_LBL_W) / 3

        emp_fields = [
            ("사원코드", str(emp["code"])),
            ("성     명", emp["name"]),
            ("입 사 일", emp.get("hire_date", "")),
        ]
        x = LM
        for label, value in emp_fields:
            self._rect_cell(x, y, EMP_LBL_W, ROW_H, label, bg=LABEL_BG, font_style="B", align="C")
            x += EMP_LBL_W
            self._rect_cell(x, y, EMP_VAL_W, ROW_H, value)
            x += EMP_VAL_W
        y += ROW_H

        # Resign info if present
        if emp.get("resign_date"):
            x = LM
            for label, value in [("퇴 사 일", emp["resign_date"]), ("퇴사사유", emp.get("resign_reason", "")), ("", "")]:
                self._rect_cell(x, y, EMP_LBL_W, ROW_H, label, bg=LABEL_BG if label else None, font_style="B" if label else "", align="C" if label else "L")
                x += EMP_LBL_W
                self._rect_cell(x, y, EMP_VAL_W, ROW_H, value)
                x += EMP_VAL_W
            y += ROW_H

        y += 5

        # ── Section 3: 급여 내역 ──
        y = self._section_header("급여 내역", y)

        items = emp.get("items", {})
        deductions = emp.get("deductions", {})
        max_rows = max(len(items), len(deductions), 1)
        item_keys = list(items.keys())
        deduct_keys = list(deductions.keys())

        COL_LABEL = 42
        COL_AMT = CW / 2 - COL_LABEL
        HDR_H = 9
        DATA_H = 8

        # Header
        x = LM
        for text in ["지 급 항 목", "금           액", "공 제 항 목", "금           액"]:
            w = COL_LABEL if "항 목" in text else COL_AMT
            self._rect_cell(x, y, w, HDR_H, text, bg=HEADER_NAVY, text_color=WHITE, font_style="B", align="C")
            x += w
        y += HDR_H

        # Divider line between pay/deduction
        mid_x = LM + COL_LABEL + COL_AMT

        # Data rows
        for i in range(max_rows):
            x = LM
            bg = ALT_ROW if i % 2 == 1 else None

            # Pay item
            if i < len(item_keys):
                k = item_keys[i]
                self._rect_cell(x, y, COL_LABEL, DATA_H, k, bg=bg)
                self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, fmt_money(items[k]), bg=bg, align="R")
            else:
                self._rect_cell(x, y, COL_LABEL, DATA_H, "", bg=bg)
                self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, "", bg=bg)

            x = mid_x
            # Deduction item
            if i < len(deduct_keys):
                k = deduct_keys[i]
                self._rect_cell(x, y, COL_LABEL, DATA_H, k, bg=bg)
                self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, fmt_money(deductions[k]), bg=bg, align="R")
            else:
                self._rect_cell(x, y, COL_LABEL, DATA_H, "", bg=bg)
                self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, "", bg=bg)
            y += DATA_H

        # Totals row
        x = LM
        self._rect_cell(x, y, COL_LABEL, DATA_H, "지급 합계", bg=TOTAL_BG, font_style="B", align="C")
        self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, fmt_money(emp.get("total_pay", 0)), bg=TOTAL_BG, font_style="B", align="R")
        x = mid_x
        self._rect_cell(x, y, COL_LABEL, DATA_H, "공제 합계", bg=TOTAL_BG, font_style="B", align="C")
        self._rect_cell(x + COL_LABEL, y, COL_AMT, DATA_H, fmt_money(emp.get("total_deduction", 0)), bg=TOTAL_BG, font_style="B", align="R")
        y += DATA_H

        y += 6

        # ── Net pay bar ──
        NET_H = 14
        self.set_fill_color(*NEXTAIN_BLUE)
        # Rounded rect approximation
        self.rect(LM, y, CW, NET_H, "F")

        self.set_text_color(*WHITE)
        self.set_font("NotoKR", "B", 12)
        label_text = "차 인 지 급 액  (실수령액)"
        self.text(LM + 10, y + NET_H / 2 + 2, label_text)

        net_text = f"{fmt_money(emp.get('net_pay', 0))} 원"
        self.set_font("NotoKR", "B", 15)
        ntw = self.get_string_width(net_text)
        self.text(210 - RM - ntw - 10, y + NET_H / 2 + 2.5, net_text)
        y += NET_H + 18

        # ── Sign-off ──
        self.set_text_color(*BLACK)
        self.set_font("NotoKR", "", 10)
        sign_text = f"위 금액을 {self.year}년 {self.month:02d}월분 급여로 지급합니다."
        stw = self.get_string_width(sign_text)
        self.text((210 - stw) / 2, y, sign_text)
        y += 10

        date_text = datetime.now().strftime("%Y년 %m월 %d일")
        dtw = self.get_string_width(date_text)
        self.text((210 - dtw) / 2, y, date_text)
        y += 10

        self.set_font("NotoKR", "B", 11)
        co_text = self.company["name"]
        ctw = self.get_string_width(co_text)
        self.text((210 - ctw) / 2, y, co_text)
        y += 7

        ceo_text = f"대표이사  {self.company['ceo']}"
        cetw = self.get_string_width(ceo_text)
        ceo_x = (210 - cetw) / 2 - 8  # shift left to make room for seal
        self.text(ceo_x, y, ceo_text)

        # Seal image (인감)
        seal_path = self.seal_path
        if seal_path and os.path.exists(seal_path):
            seal_size = 15
            seal_x = ceo_x + cetw + 2
            seal_y = y - seal_size + 4
            self.image(seal_path, x=seal_x, y=seal_y, w=seal_size, h=seal_size)
        else:
            self.text(ceo_x + cetw, y, "  (인)")
        y += 14

        # ── Footer ──
        self.set_draw_color(*BORDER_GRAY)
        self.set_line_width(0.3)
        self.line(LM, y, 210 - RM, y)
        y += 4

        self.set_font("NotoKR", "", 7.5)
        self.set_text_color(*MUTED)
        footer1 = "본 급여명세서는 근로기준법 제48조에 의거하여 교부합니다."
        f1w = self.get_string_width(footer1)
        self.text((210 - f1w) / 2, y, footer1)
        y += 4

        footer2 = f"{self.company['name']} | {self.company.get('eng_name', '')} | {self.company.get('biz_no', '')}"
        f2w = self.get_string_width(footer2)
        self.text((210 - f2w) / 2, y, footer2)


def generate_payroll_pdf(data: dict, emp: dict, output_path: str,
                         logo_path: str | None = None, seal_path: str | None = None):
    pdf = PayrollPDF(data["company"], data["year"], data["month"], logo_path, seal_path)
    pdf.generate(emp)
    pdf.output(output_path)
    print(f"  PDF 생성 완료: {output_path}")


# ── Email ──────────────────────────────────────────────────

def send_email(to: str, subject: str, body_html: str, attachment_path: str,
               smtp_user: str, smtp_pass: str):
    msg = MIMEMultipart()
    msg["From"] = f'"넥스테인 급여" <{smtp_user}>'
    msg["To"] = to
    msg["Subject"] = subject

    msg.attach(MIMEText(body_html, "html", "utf-8"))

    with open(attachment_path, "rb") as f:
        part = MIMEBase("application", "pdf")
        part.set_payload(f.read())
        encoders.encode_base64(part)
        filename = os.path.basename(attachment_path)
        from email.utils import encode_rfc2231
        encoded = encode_rfc2231(filename, "utf-8")
        part.add_header("Content-Disposition", "attachment", filename=("utf-8", "", filename))
        msg.attach(part)

    with smtplib.SMTP("smtp.office365.com", 587) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, to, msg.as_string())

    print(f"  이메일 발송 완료: {to}")


# ── Main ──────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="급여명세서 PDF 생성 + 이메일 발송")
    parser.add_argument("--data", required=True, help="JSON data string")
    parser.add_argument("--smtp-user", default=os.environ.get("SMTP_USER", "noreply@nextain.io"))
    parser.add_argument("--smtp-pass", default=os.environ.get("SMTP_PASS", ""))
    parser.add_argument("--dry-run", action="store_true", help="PDF만 생성, 이메일 미발송")
    parser.add_argument("--output-dir", default=".", help="PDF 출력 디렉토리")
    parser.add_argument("--logo", default=None, help="Logo image path")
    parser.add_argument("--seal", default=None, help="Seal (인감) image path")
    args = parser.parse_args()

    data = json.loads(args.data)
    year = data["year"]
    month = data["month"]
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Resolve logo & seal
    script_dir = Path(__file__).resolve().parent
    workspace_root = script_dir.parent.parent.parent.parent

    logo_path = args.logo
    if logo_path is None:
        candidate = workspace_root / DEFAULT_LOGO
        if candidate.exists():
            logo_path = str(candidate)

    seal_path = args.seal
    if seal_path is None:
        candidate = workspace_root / "docs-business/07.증명서/nextain-인감.png"
        if candidate.exists():
            seal_path = str(candidate)

    results = []
    for emp in data["employees"]:
        filename = f"급여명세서_{year}{month:02d}_{emp['name']}.pdf"
        output_path = str(output_dir / filename)

        print(f"\n[{emp['name']}]")
        generate_payroll_pdf(data, emp, output_path, logo_path, seal_path)

        if not args.dry_run and args.smtp_pass:
            subject = f"[넥스테인] {year}년 {month:02d}월 급여명세서"
            body = f"""
            <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0F172A;color:#e2e8f0;border-radius:12px;">
                <div style="margin-bottom:20px;">
                    <span style="color:#2563EB;font-size:13px;font-weight:bold;">nextain Inc.</span>
                </div>
                <h2 style="color:#F8FAFC;margin-bottom:8px;font-size:20px;">{year}년 {month:02d}월 급여명세서</h2>
                <p style="color:#94a3b8;margin-bottom:24px;">안녕하세요, {emp['name']}님.<br>{year}년 {month:02d}월분 급여명세서를 첨부드립니다.</p>
                <div style="background:rgba(37,99,235,0.15);border:1px solid rgba(37,99,235,0.3);border-radius:8px;padding:20px;margin-bottom:20px;">
                    <p style="color:#94a3b8;font-size:12px;margin:0 0 8px;">실수령액</p>
                    <p style="color:#60A5FA;font-size:28px;font-weight:bold;margin:0;">{fmt_money(emp.get('net_pay', 0))}원</p>
                </div>
                <p style="color:#475569;font-size:12px;margin-top:24px;">문의: accounting@nextain.io</p>
                <p style="color:#334155;font-size:11px;margin-top:8px;">(주)넥스테인 | nextain Inc.</p>
            </div>
            """
            send_email(emp["email"], subject, body, output_path,
                       args.smtp_user, args.smtp_pass)
            results.append({"name": emp["name"], "email": emp["email"], "pdf": output_path, "sent": True})
        else:
            if args.dry_run:
                print("  (dry-run: 이메일 미발송)")
            elif not args.smtp_pass:
                print("  (SMTP_PASS 미설정: 이메일 미발송)")
            results.append({"name": emp["name"], "email": emp["email"], "pdf": output_path, "sent": False})

    print(f"\n완료: {len(results)}건 처리")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
