# -*- coding: utf-8 -*-
"""Nextain Standard ODT Template Generator

Generates a branded ODT document template based on naia.nextain.io design system.
Includes: cover page (no header/footer), body pages (header + footer with page number).

Usage:
    python gen_template_odt.py [--output PATH] [--title TITLE]
"""
import sys
import os
import argparse

sys.stdout.reconfigure(encoding='utf-8')

from odf.opendocument import OpenDocumentText
from odf.style import (
    Style, TextProperties, ParagraphProperties,
    TableRowProperties, TableCellProperties, TableColumnProperties,
    TableProperties, PageLayout, PageLayoutProperties, MasterPage,
)
from odf.text import P, Span, H, PageNumber, PageCount, Tab
from odf.table import Table, TableRow, TableCell, TableColumn

BRAND_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(BRAND_DIR, "brand", "logo-nextain.png")

C_PRIMARY = "#2563EB"
C_ACCENT = "#06B6D4"
C_TEXT = "#171717"
C_MUTED = "#64748B"
C_WHITE = "#FFFFFF"
C_TABLE_HEADER = "#2563EB"
C_TABLE_ALT = "#F1F5F9"
C_BORDER = "#DBEAFE"
FONT = "Pretendard"


def make_styles(doc):
    # ── Heading 1 ──
    h1 = Style(name="NxH1", family="paragraph")
    h1.addElement(ParagraphProperties(
        margintop="1.2cm", marginbottom="0.5cm",
        lineheight="130%",
        borderbottom="2pt solid #2563EB",
        paddingbottom="0.3cm",
    ))
    h1.addElement(TextProperties(
        fontsize="18pt", fontweight="bold", color=C_PRIMARY, fontfamily=FONT,
    ))
    doc.styles.addElement(h1)

    # ── Heading 2 ──
    h2 = Style(name="NxH2", family="paragraph")
    h2.addElement(ParagraphProperties(
        margintop="0.9cm", marginbottom="0.4cm",
        lineheight="140%",
        borderbottom="1pt solid #DBEAFE",
        paddingbottom="0.2cm",
    ))
    h2.addElement(TextProperties(
        fontsize="14pt", fontweight="bold", color=C_TEXT, fontfamily=FONT,
    ))
    doc.styles.addElement(h2)

    # ── Heading 3 ──
    h3 = Style(name="NxH3", family="paragraph")
    h3.addElement(ParagraphProperties(
        margintop="0.6cm", marginbottom="0.3cm", lineheight="140%",
    ))
    h3.addElement(TextProperties(
        fontsize="12pt", fontweight="bold", color=C_TEXT, fontfamily=FONT,
    ))
    doc.styles.addElement(h3)

    # ── Body ──
    body = Style(name="NxBody", family="paragraph")
    body.addElement(ParagraphProperties(
        lineheight="170%", marginbottom="0.3cm", textalign="justify",
    ))
    body.addElement(TextProperties(
        fontsize="10.5pt", color=C_TEXT, fontfamily=FONT,
    ))
    doc.styles.addElement(body)

    # ── Body indent ──
    bi = Style(name="NxBodyIndent", family="paragraph")
    bi.addElement(ParagraphProperties(
        lineheight="170%", marginbottom="0.2cm", marginleft="0.75cm",
    ))
    bi.addElement(TextProperties(
        fontsize="10.5pt", color=C_TEXT, fontfamily=FONT,
    ))
    doc.styles.addElement(bi)

    # ── Small ──
    sm = Style(name="NxSmall", family="paragraph")
    sm.addElement(ParagraphProperties(marginbottom="0.2cm"))
    sm.addElement(TextProperties(fontsize="9pt", color=C_MUTED, fontfamily=FONT))
    doc.styles.addElement(sm)

    # ── Section label ──
    sl = Style(name="NxSectionLabel", family="paragraph")
    sl.addElement(ParagraphProperties(marginbottom="0.1cm"))
    sl.addElement(TextProperties(
        fontsize="9pt", fontweight="bold", color=C_ACCENT, fontfamily=FONT,
    ))
    doc.styles.addElement(sl)

    # ── Cover styles ──
    ct = Style(name="NxCoverTitle", family="paragraph")
    ct.addElement(ParagraphProperties(textalign="center", margintop="2cm", marginbottom="0.5cm"))
    ct.addElement(TextProperties(fontsize="28pt", fontweight="bold", color=C_PRIMARY, fontfamily=FONT))
    doc.styles.addElement(ct)

    cs = Style(name="NxCoverSub", family="paragraph")
    cs.addElement(ParagraphProperties(textalign="center", marginbottom="0.3cm"))
    cs.addElement(TextProperties(fontsize="14pt", color=C_MUTED, fontfamily=FONT))
    doc.styles.addElement(cs)

    ci = Style(name="NxCoverInfo", family="paragraph")
    ci.addElement(ParagraphProperties(textalign="center", marginbottom="0.15cm"))
    ci.addElement(TextProperties(fontsize="11pt", color=C_TEXT, fontfamily=FONT))
    doc.styles.addElement(ci)

    dv = Style(name="NxDivider", family="paragraph")
    dv.addElement(ParagraphProperties(textalign="center", margintop="0.5cm", marginbottom="0.8cm"))
    dv.addElement(TextProperties(fontsize="14pt", color=C_PRIMARY, fontfamily=FONT))
    doc.styles.addElement(dv)

    # ── Bold / Accent spans ──
    bs = Style(name="NxBold", family="text")
    bs.addElement(TextProperties(fontweight="bold", color=C_TEXT, fontfamily=FONT))
    doc.styles.addElement(bs)

    acs = Style(name="NxAccent", family="text")
    acs.addElement(TextProperties(fontweight="bold", color=C_PRIMARY, fontfamily=FONT))
    doc.styles.addElement(acs)

    # ── Page break ──
    pb = Style(name="NxPageBreak", family="paragraph")
    pb.addElement(ParagraphProperties(breakbefore="page"))
    doc.styles.addElement(pb)

    # ── Header text ──
    hs = Style(name="NxHeaderText", family="paragraph")
    hs.addElement(ParagraphProperties(
        textalign="right", marginbottom="0cm",
        borderbottom="0.5pt solid #DBEAFE",
        paddingbottom="0.15cm",
    ))
    hs.addElement(TextProperties(fontsize="8pt", color=C_MUTED, fontfamily=FONT))
    doc.automaticstyles.addElement(hs)

    # ── Footer text ──
    fs = Style(name="NxFooterText", family="paragraph")
    fs.addElement(ParagraphProperties(textalign="center", margintop="0.1cm"))
    fs.addElement(TextProperties(fontsize="8pt", color=C_MUTED, fontfamily=FONT))
    doc.automaticstyles.addElement(fs)

    # ── Table styles ──
    doc.styles.addElement(_table_style("NxTable", "table", TableProperties(align="center")))
    doc.styles.addElement(_table_style("NxTHRow", "table-row", TableRowProperties(
        backgroundcolor=C_TABLE_HEADER, minrowheight="0.8cm")))
    doc.styles.addElement(_table_style("NxTDRow", "table-row", TableRowProperties(minrowheight="0.7cm")))
    doc.styles.addElement(_table_style("NxTDRowAlt", "table-row", TableRowProperties(
        backgroundcolor=C_TABLE_ALT, minrowheight="0.7cm")))

    thc = Style(name="NxTHCell", family="table-cell")
    thc.addElement(TableCellProperties(
        paddingtop="0.15cm", paddingbottom="0.15cm",
        paddingleft="0.3cm", paddingright="0.3cm",
        border="0.5pt solid #2563EB", backgroundcolor=C_TABLE_HEADER))
    thc.addElement(ParagraphProperties(textalign="center"))
    thc.addElement(TextProperties(fontsize="10pt", fontweight="bold", color=C_WHITE, fontfamily=FONT))
    doc.styles.addElement(thc)

    for name, bg in [("NxTDCell", None), ("NxTDCellAlt", C_TABLE_ALT)]:
        s = Style(name=name, family="table-cell")
        props = TableCellProperties(
            paddingtop="0.12cm", paddingbottom="0.12cm",
            paddingleft="0.3cm", paddingright="0.3cm",
            border=f"0.5pt solid {C_BORDER}")
        if bg:
            props.setAttribute("backgroundcolor", bg)
        s.addElement(props)
        s.addElement(ParagraphProperties(textalign="center"))
        s.addElement(TextProperties(fontsize="10pt", color=C_TEXT, fontfamily=FONT))
        doc.styles.addElement(s)


def _table_style(name, family, props):
    s = Style(name=name, family=family)
    s.addElement(props)
    return s


def setup_page_layout(doc):
    """Create page layout with header + footer on all pages."""
    from odf.style import Header as StyleHeader, Footer as StyleFooter

    # Single page layout
    pl = PageLayout(name="NxPage")
    pl.addElement(PageLayoutProperties(
        pagewidth="21cm", pageheight="29.7cm",
        margintop="2.5cm", marginbottom="2.0cm",
        marginleft="2.5cm", marginright="2.0cm",
    ))
    doc.automaticstyles.addElement(pl)

    # Master page named "Standard" — odfpy uses this as default
    mp = MasterPage(name="Standard", pagelayoutname="NxPage")

    # Header
    header_p = P(stylename="NxHeaderText")
    header_p.addElement(Span(stylename="NxBold", text="Nextain"))
    header_p.addText("  |  Next AI Networks")
    hdr = StyleHeader()
    hdr.addElement(header_p)
    mp.addElement(hdr)

    # Footer
    footer_p = P(stylename="NxFooterText")
    footer_p.addText("Nextain Inc.  \u00b7  Next AI Networks    ")
    footer_p.addElement(PageNumber(selectpage="current", numformat="1"))
    footer_p.addText(" / ")
    footer_p.addElement(PageCount(numformat="1"))
    ftr = StyleFooter()
    ftr.addElement(footer_p)
    mp.addElement(ftr)

    doc.masterstyles.addElement(mp)


def add_cover(doc, title):
    if os.path.exists(LOGO_PATH):
        doc.addPicture(LOGO_PATH)

    doc.text.addElement(P(stylename="NxCoverSub"))

    t = P(stylename="NxCoverTitle")
    t.addText(title)
    doc.text.addElement(t)

    s = P(stylename="NxCoverSub")
    s.addText("Nextain Inc.  |  Next AI Networks")
    doc.text.addElement(s)

    d = P(stylename="NxDivider")
    d.addText("━" * 40)
    doc.text.addElement(d)

    for line in [
        "문서번호: NX-2026-XXXX",
        "작성일자: 2026.    .    .",
        "작 성 자: (작성자명)",
        "수 신: (수신자)",
        "분    류: (분류)",
    ]:
        p = P(stylename="NxCoverInfo")
        p.addText(line)
        doc.text.addElement(p)

    # Switch to body master page after cover
    doc.text.addElement(P(stylename="NxPageBreak"))


def add_sample(doc):
    doc.text.addElement(P(stylename="NxSectionLabel", text="01  OVERVIEW"))
    doc.text.addElement(H(outlinelevel=1, stylename="NxH1", text="1. 개요"))

    doc.text.addElement(P(
        stylename="NxBody",
        text="본 문서는 주식회사 넥스테인(Nextain Inc.)의 표준 문서 템플릿입니다. "
             "naia.nextain.io 디자인 시스템을 기반으로 한 일관된 브랜딩이 적용되어 있습니다. "
             "모든 공식 문서는 본 템플릿을 기준으로 작성합니다.",
    ))
    doc.text.addElement(P(
        stylename="NxBody",
        text="이 템플릿은 A4 규격, Pretendard 폰트, Nextain Blue(#2563EB) 기반 컬러 체계를 "
             "사용합니다. 표, 목록, 강조 등 모든 요소에 브랜드 가이드가 자동 적용됩니다.",
    ))

    doc.text.addElement(P(stylename="NxSectionLabel", text="02  STYLES"))
    doc.text.addElement(H(outlinelevel=2, stylename="NxH2", text="2. 스타일 가이드"))
    doc.text.addElement(H(outlinelevel=3, stylename="NxH3", text="2.1 텍스트 강조"))

    bp = P(stylename="NxBody")
    bp.addText("일반 텍스트와 함께 ")
    bp.addElement(Span(stylename="NxBold", text="볼드 텍스트"))
    bp.addText(" 그리고 ")
    bp.addElement(Span(stylename="NxAccent", text="액센트 텍스트"))
    bp.addText("를 사용할 수 있습니다.")
    doc.text.addElement(bp)

    doc.text.addElement(P(stylename="NxSectionLabel", text="03  TABLE"))
    doc.text.addElement(H(outlinelevel=2, stylename="NxH2", text="3. 표 스타일"))

    table = Table(stylename="NxTable")
    for _ in range(4):
        table.addElement(TableColumn())

    hr = TableRow(stylename="NxTHRow")
    for h in ["항목", "내용", "상태", "비고"]:
        c = TableCell(stylename="NxTHCell")
        c.addElement(P(text=h))
        hr.addElement(c)
    table.addElement(hr)

    data = [
        ["브랜드 컬러", "Nextain Blue #2563EB", "적용", ""],
        ["기본 폰트", "Pretendard 10.5pt", "적용", ""],
        ["페이지", "A4 (210 × 297mm)", "적용", ""],
        ["여백", "상2.5 하2 좌2.5 우2 cm", "적용", ""],
        ["헤더", "Nextain Inc. + 하단 구분선", "적용", ""],
        ["푸터", "페이지 번호 (— n / N —)", "적용", ""],
    ]
    for i, row_data in enumerate(data):
        r = TableRow(stylename="NxTDRowAlt" if i % 2 == 0 else "NxTDRow")
        cs = "NxTDCellAlt" if i % 2 == 0 else "NxTDCell"
        for val in row_data:
            c = TableCell(stylename=cs)
            c.addElement(P(text=val))
            r.addElement(c)
        table.addElement(r)
    doc.text.addElement(table)

    doc.text.addElement(P(stylename="NxSectionLabel", text="04  LIST"))
    doc.text.addElement(H(outlinelevel=2, stylename="NxH2", text="4. 목록 스타일"))

    for item in ["첫 번째 항목", "두 번째 항목", "세 번째 항목"]:
        doc.text.addElement(P(stylename="NxBodyIndent", text=f"• {item}"))

    doc.text.addElement(P(
        stylename="NxSmall",
        text="본 문서는 비밀문서이므로 외부 유출을 금지합니다. — 주식회사 넥스테인",
    ))


def main():
    parser = argparse.ArgumentParser(description="Generate Nextain standard ODT template")
    parser.add_argument("--output", "-o", default=None)
    parser.add_argument("--title", "-t", default="Nextain Standard Document")
    args = parser.parse_args()

    if args.output is None:
        out_dir = os.path.dirname(os.path.abspath(__file__))
        args.output = os.path.join(out_dir, "nextain-standard-template.odt")

    args.output = os.path.abspath(args.output)

    doc = OpenDocumentText()
    doc.meta.title = args.title
    doc.meta.initial_creator = "Nextain Inc."

    setup_page_layout(doc)
    make_styles(doc)
    add_cover(doc, args.title)
    add_sample(doc)

    doc.save(args.output)
    print(f"OK: {args.output}")


if __name__ == "__main__":
    main()
