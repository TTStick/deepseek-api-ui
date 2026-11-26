#!/usr/bin/env python3
"""对话导出：stdin 读 Markdown，按模式输出。

用法:
  python3 export.py pdf  < chat.md > chat.pdf    # reportlab 生成 PDF（内置 CJK 字体）
  python3 export.py html < chat.md > chat.html   # 自包含 HTML 分享页
"""
import sys

MODE = sys.argv[1] if len(sys.argv) > 1 else "html"
SOURCE = sys.stdin.read()


def run_pdf() -> None:
    import re

    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        BaseDocTemplate, Frame, PageTemplate, Paragraph, Preformatted,
        Spacer, HRFlowable,
    )
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    FONT = "STSong-Light"

    normal = ParagraphStyle("normal", fontName=FONT, fontSize=10.5, leading=16, wordWrap="CJK")
    heading1 = ParagraphStyle("h1", fontName=FONT, fontSize=18, leading=24, spaceAfter=10, wordWrap="CJK")
    heading2 = ParagraphStyle("h2", fontName=FONT, fontSize=13, leading=18, spaceBefore=8, spaceAfter=4, wordWrap="CJK")
    heading3 = ParagraphStyle("h3", fontName=FONT, fontSize=11.5, leading=16, spaceBefore=6, spaceAfter=2, wordWrap="CJK")
    quote = ParagraphStyle("quote", fontName=FONT, fontSize=10, leading=15, leftIndent=10, textColor="#666666", wordWrap="CJK")
    code_style = ParagraphStyle("code", fontName=FONT, fontSize=9, leading=13, wordWrap="CJK")

    def inline(text: str) -> str:
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
        text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", text)
        text = re.sub(r"`([^`]+)`", r"<font face='Courier'>\1</font>", text)
        return text

    story = []
    in_code = False
    code_lines: list[str] = []
    para: list[str] = []

    def flush_para() -> None:
        nonlocal para
        if not para:
            return
        story.append(Paragraph(inline(" ".join(para)), normal))
        para = []

    def flush_code() -> None:
        if code_lines:
            story.append(Preformatted("\n".join(code_lines), code_style))
            story.append(Spacer(1, 6))

    for raw in SOURCE.splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            if in_code:
                flush_code()
                code_lines = []
                in_code = False
            else:
                flush_para()
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not line.strip():
            flush_para()
            story.append(Spacer(1, 4))
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            flush_para()
            level = len(m.group(1))
            style = heading1 if level == 1 else heading2 if level == 2 else heading3
            story.append(Paragraph(inline(m.group(2)), style))
            continue
        if line.startswith("---"):
            flush_para()
            story.append(HRFlowable(width="100%", thickness=0.6, color="#cccccc", spaceBefore=6, spaceAfter=6))
            continue
        if line.startswith("> "):
            flush_para()
            story.append(Paragraph(inline(line[2:]), quote))
            continue
        m = re.match(r"^(\s*)([-*+]|\d+\.)\s+(.*)$", line)
        if m:
            flush_para()
            text = inline(m.group(3))
            bullet = "•" if m.group(2) not in ("-", "*", "+") or m.group(2) == "-" else m.group(2)
            story.append(Paragraph(f"{bullet} {text}", ParagraphStyle("li", parent=normal, leftIndent=14, firstLineIndent=-8)))
            continue
        para.append(line.strip())
    flush_code()
    flush_para()

    doc = BaseDocTemplate(
        "out.pdf",
        pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame])])
    doc.build(story)
    with open("out.pdf", "rb") as fh:
        sys.stdout.buffer.write(fh.read())


def run_html() -> None:
    import markdown as md

    body = md.markdown(SOURCE, extensions=["fenced_code", "tables"])
    template = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%TITLE%</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 760px; padding: 32px 20px 64px;
         font: 15px/1.75 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 24px; border-bottom: 1px solid rgba(128,128,128,.3); padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 28px; }
  code { background: rgba(128,128,128,.14); padding: 2px 6px; border-radius: 5px;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: rgba(128,128,128,.1); padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 8px 0; padding: 4px 14px; color: rgba(128,128,128,.95);
               border-left: 3px solid #4d6bfe; }
  hr { border: none; border-top: 1px solid rgba(128,128,128,.25); margin: 24px 0; }
  @media print { body { max-width: none; } }
</style>
</head>
<body>
%BODY%
</body>
</html>"""
    title = ""
    for line in SOURCE.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            break
    html = template.replace("%TITLE%", title.replace("&", "&amp;").replace("<", "&lt;")).replace("%BODY%", body)
    sys.stdout.write(html)


if MODE == "pdf":
    run_pdf()
else:
    run_html()
