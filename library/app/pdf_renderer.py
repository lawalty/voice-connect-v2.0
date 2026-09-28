from __future__ import annotations

import html
import io
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    LongTable,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.markdown_ir import MarkdownBlock, parse_markdown

RENDERER_VERSION = "1"
_FONT_LOCK = threading.Lock()
_FONTS_READY = False
_ASSET_DIR = Path(__file__).parent / "assets" / "fonts"


def _register_fonts() -> None:
    global _FONTS_READY
    if _FONTS_READY:
        return
    with _FONT_LOCK:
        if _FONTS_READY:
            return
        files = {
            "PTSerif": "PTSerif-Regular.ttf",
            "PTSerif-Bold": "PTSerif-Bold.ttf",
            "PTSerif-Italic": "PTSerif-Italic.ttf",
            "PTSerif-BoldItalic": "PTSerif-BoldItalic.ttf",
            "PTSans": "PTSans-Regular.ttf",
            "PTSans-Bold": "PTSans-Bold.ttf",
        }
        for name, filename in files.items():
            pdfmetrics.registerFont(TTFont(name, str(_ASSET_DIR / filename)))
        pdfmetrics.registerFontFamily(
            "PTSerif",
            normal="PTSerif",
            bold="PTSerif-Bold",
            italic="PTSerif-Italic",
            boldItalic="PTSerif-BoldItalic",
        )
        pdfmetrics.registerFontFamily("PTSans", normal="PTSans", bold="PTSans-Bold")
        _FONTS_READY = True


def pdf_filename(title: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._ -]+", "_", title).strip(" ._")
    clean = re.sub(r"\s+", " ", clean)[:70].rstrip()
    return f"{clean or 'Hermes Document'}.pdf"


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "HermesTitle",
            parent=base["Title"],
            fontName="PTSans-Bold",
            fontSize=24,
            leading=29,
            textColor=colors.HexColor("#17233A"),
            alignment=TA_CENTER,
            spaceAfter=10,
        ),
        "meta": ParagraphStyle(
            "HermesMeta",
            fontName="PTSans",
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#657087"),
            alignment=TA_CENTER,
            spaceAfter=18,
        ),
        "body": ParagraphStyle(
            "HermesBody",
            fontName="PTSerif",
            fontSize=10.5,
            leading=14.2,
            textColor=colors.HexColor("#202838"),
            spaceAfter=8,
        ),
        "quote": ParagraphStyle(
            "HermesQuote",
            fontName="PTSerif-Italic",
            fontSize=10.2,
            leading=14,
            textColor=colors.HexColor("#45536A"),
        ),
        "code": ParagraphStyle(
            "HermesCode",
            fontName="Courier",
            fontSize=8,
            leading=10.5,
            textColor=colors.HexColor("#1F2937"),
            leftIndent=6,
            rightIndent=6,
        ),
        **{
            f"h{level}": ParagraphStyle(
                f"HermesH{level}",
                fontName="PTSans-Bold",
                fontSize={1: 18, 2: 15, 3: 12.5, 4: 11.5}.get(level, 11),
                leading={1: 22, 2: 19, 3: 16, 4: 15}.get(level, 14),
                textColor=colors.HexColor("#17233A"),
                spaceBefore={1: 14, 2: 12, 3: 10, 4: 8}.get(level, 8),
                spaceAfter=5,
                keepWithNext=True,
            )
            for level in range(1, 7)
        },
    }


def _page(canvas, doc) -> None:  # type: ignore[no-untyped-def]
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#D9DFE9"))
    canvas.line(22 * mm, height - 17 * mm, width - 22 * mm, height - 17 * mm)
    canvas.setFont("PTSans", 7.5)
    canvas.setFillColor(colors.HexColor("#778197"))
    canvas.drawString(22 * mm, height - 13.2 * mm, str(doc.title)[:70])
    canvas.drawRightString(
        width - 22 * mm, 12 * mm, f"Written by Hermes  |  {canvas.getPageNumber()}"
    )
    canvas.restoreState()


def _table_block(block: MarkdownBlock, styles: dict[str, ParagraphStyle], width: float):
    rows = [
        [Paragraph(html.escape(cell), styles["body"]) for cell in row]
        for row in block.rows
    ]
    if not rows:
        return Spacer(1, 0)
    columns = max(len(row) for row in rows)
    normalized = [
        row + [Paragraph("", styles["body"])] * (columns - len(row)) for row in rows
    ]
    table = LongTable(
        normalized, colWidths=[width / columns] * columns, repeatRows=1, splitByRow=True
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF0F8")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#17233A")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C8D1DF")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def render_markdown_pdf(
    title: str, markdown: str, updated_at: datetime | None = None
) -> bytes:
    _register_fonts()
    parsed = parse_markdown(markdown, title=title)
    styles = _styles()
    output = io.BytesIO()
    doc = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=22 * mm,
        rightMargin=22 * mm,
        topMargin=23 * mm,
        bottomMargin=19 * mm,
        title=title,
        author="Hermes",
        creator=f"Hermes PDF Renderer {RENDERER_VERSION}",
    )
    story: list[object] = [
        Paragraph(html.escape(title), styles["title"]),
        Paragraph(
            f"Written by Hermes  |  {(updated_at or datetime.now(timezone.utc)).strftime('%B %d, %Y')}",
            styles["meta"],
        ),
    ]
    for block in parsed.blocks:
        if block.kind == "heading":
            story.append(
                Paragraph(
                    block.markup or html.escape(block.plain_text),
                    styles[f"h{min(block.level, 6)}"],
                )
            )
        elif block.kind == "paragraph":
            story.append(
                Paragraph(block.markup or html.escape(block.plain_text), styles["body"])
            )
        elif block.kind == "list_item":
            story.append(
                Paragraph(
                    f"<b>{html.escape(block.marker)}</b>&nbsp;&nbsp;{block.markup or html.escape(block.plain_text)}",
                    styles["body"],
                )
            )
        elif block.kind == "quote":
            quote = Table(
                [
                    [
                        Paragraph(
                            block.markup or html.escape(block.plain_text),
                            styles["quote"],
                        )
                    ]
                ],
                colWidths=[doc.width],
            )
            quote.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F3F6FA")),
                        ("LINEBEFORE", (0, 0), (0, -1), 3, colors.HexColor("#6D83A5")),
                        ("LEFTPADDING", (0, 0), (-1, -1), 10),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                        ("TOPPADDING", (0, 0), (-1, -1), 7),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                    ]
                )
            )
            story.extend([quote, Spacer(1, 7)])
        elif block.kind == "code":
            code = Table(
                [[Preformatted(block.plain_text, styles["code"], maxLineLength=92)]],
                colWidths=[doc.width],
            )
            code.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F3F4F6")),
                        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
                        ("LEFTPADDING", (0, 0), (-1, -1), 7),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                        ("TOPPADDING", (0, 0), (-1, -1), 6),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ]
                )
            )
            story.extend([code, Spacer(1, 8)])
        elif block.kind == "table":
            story.extend([_table_block(block, styles, doc.width), Spacer(1, 9)])
        elif block.kind == "rule":
            story.append(
                HRFlowable(
                    width="100%",
                    thickness=0.6,
                    color=colors.HexColor("#C8D1DF"),
                    spaceBefore=8,
                    spaceAfter=10,
                )
            )
    if parsed.links:
        story.append(PageBreak() if len(parsed.links) > 12 else Spacer(1, 8))
        story.append(Paragraph("Sources", styles["h2"]))
        for index, link in enumerate(parsed.links, 1):
            escaped = html.escape(link)
            story.append(
                Paragraph(
                    f'{index}. <a href="{escaped}" color="#2563A8">{escaped}</a>',
                    styles["body"],
                )
            )
    doc.build(story, onFirstPage=_page, onLaterPages=_page)
    payload = output.getvalue()
    reader = PdfReader(io.BytesIO(payload))
    if not reader.pages:
        raise RuntimeError("PDF renderer produced no pages")
    return payload
