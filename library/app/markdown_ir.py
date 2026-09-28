from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

from markdown_it import MarkdownIt
from markdown_it.token import Token

BlockKind = Literal[
    "heading", "paragraph", "list_item", "quote", "code", "table", "rule"
]


@dataclass(frozen=True)
class MarkdownBlock:
    kind: BlockKind
    plain_text: str
    markup: str = ""
    level: int = 0
    marker: str = ""
    rows: tuple[tuple[str, ...], ...] = ()
    heading_path: tuple[str, ...] = ()


@dataclass(frozen=True)
class ParsedMarkdown:
    blocks: tuple[MarkdownBlock, ...]
    links: tuple[str, ...] = ()


def _clean_text(value: str) -> str:
    value = re.sub(r"<[^>]*>", "", value)
    return html.unescape(value).replace("\x00", " ")


def _safe_href(value: str) -> str:
    href = _clean_text(value).strip()
    try:
        return href if urlsplit(href).scheme.casefold() in {"http", "https"} else ""
    except ValueError:
        return ""


def _inline(tokens: list[Token] | None, links: list[str]) -> tuple[str, str]:
    plain: list[str] = []
    markup: list[str] = []
    link_stack: list[int] = []
    for token in tokens or []:
        kind = token.type
        if kind == "text":
            clean = _clean_text(token.content)
            plain.append(clean)
            markup.append(html.escape(clean))
        elif kind in {"softbreak", "hardbreak"}:
            plain.append(" ")
            markup.append("<br/>" if kind == "hardbreak" else " ")
        elif kind == "code_inline":
            clean = _clean_text(token.content)
            plain.append(clean)
            markup.append(f'<font name="Courier">{html.escape(clean)}</font>')
        elif kind == "strong_open":
            markup.append("<b>")
        elif kind == "strong_close":
            markup.append("</b>")
        elif kind == "em_open":
            markup.append("<i>")
        elif kind == "em_close":
            markup.append("</i>")
        elif kind == "link_open":
            href = _safe_href(token.attrGet("href") or "")
            if href and href not in links:
                links.append(href)
            number = links.index(href) + 1 if href else 0
            link_stack.append(number)
            if href:
                markup.append(
                    f'<a href="{html.escape(href, quote=True)}" color="#2563A8">'
                )
        elif kind == "link_close":
            number = link_stack.pop() if link_stack else 0
            if number:
                markup.append(f"</a> <super>[{number}]</super>")
                plain.append(f" [{number}]")
        elif kind == "image":
            alt = _clean_text(token.content or token.attrGet("alt") or "Image")
            plain.append(alt)
            markup.append(f"<i>[Image: {html.escape(alt)}]</i>")
        elif kind in {"html_inline", "html_block"}:
            clean = _clean_text(token.content)
            plain.append(clean)
            markup.append(html.escape(clean))
    return "".join(plain).strip(), "".join(markup).strip()


def _normalize_title(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def parse_markdown(markdown: str, title: str = "") -> ParsedMarkdown:
    parser = MarkdownIt("commonmark", {"html": False, "linkify": True}).enable("table")
    tokens = parser.parse(markdown.replace("\x00", " "))
    blocks: list[MarkdownBlock] = []
    links: list[str] = []
    headings: list[str] = []
    heading_level = 0
    quote_depth = 0
    list_stack: list[dict[str, int | bool]] = []
    current_item: tuple[str, tuple[str, ...]] | None = None
    table_rows: list[tuple[str, ...]] | None = None
    table_row: list[str] | None = None
    in_table_cell = False

    for token in tokens:
        kind = token.type
        if kind == "blockquote_open":
            quote_depth += 1
            continue
        if kind == "blockquote_close":
            quote_depth = max(0, quote_depth - 1)
            continue
        if kind in {"bullet_list_open", "ordered_list_open"}:
            start = (
                int(token.attrGet("start") or 1) if kind == "ordered_list_open" else 0
            )
            list_stack.append({"ordered": kind == "ordered_list_open", "next": start})
            continue
        if kind in {"bullet_list_close", "ordered_list_close"}:
            if list_stack:
                list_stack.pop()
            continue
        if kind == "list_item_open":
            if list_stack:
                state = list_stack[-1]
                if bool(state["ordered"]):
                    marker = f"{int(state['next'])}."
                    state["next"] = int(state["next"]) + 1
                else:
                    marker = "-"
            else:
                marker = "-"
            current_item = (marker, tuple(headings))
            continue
        if kind == "list_item_close":
            current_item = None
            continue
        if kind == "heading_open":
            heading_level = int(kind[-1]) if kind[-1].isdigit() else int(token.tag[1:])
            continue
        if kind == "heading_close":
            heading_level = 0
            continue
        if kind == "table_open":
            table_rows = []
            continue
        if kind == "table_close":
            rows = tuple(table_rows or [])
            flat = "\n".join(" | ".join(row) for row in rows)
            blocks.append(
                MarkdownBlock("table", flat, rows=rows, heading_path=tuple(headings))
            )
            table_rows = None
            continue
        if kind == "tr_open":
            table_row = []
            continue
        if kind == "tr_close":
            if table_rows is not None and table_row is not None:
                table_rows.append(tuple(table_row))
            table_row = None
            continue
        if kind in {"th_open", "td_open"}:
            in_table_cell = True
            continue
        if kind in {"th_close", "td_close"}:
            in_table_cell = False
            continue
        if kind == "hr":
            blocks.append(MarkdownBlock("rule", "", heading_path=tuple(headings)))
            continue
        if kind in {"fence", "code_block"}:
            clean = _clean_text(token.content).rstrip()
            blocks.append(MarkdownBlock("code", clean, heading_path=tuple(headings)))
            continue
        if kind != "inline":
            continue

        plain, markup = _inline(token.children, links)
        if in_table_cell and table_row is not None:
            table_row.append(plain)
            continue
        if heading_level:
            if (
                heading_level == 1
                and title
                and not blocks
                and _normalize_title(plain) == _normalize_title(title)
            ):
                continue
            while len(headings) >= heading_level:
                headings.pop()
            headings.append(plain)
            blocks.append(
                MarkdownBlock(
                    "heading",
                    plain,
                    markup,
                    heading_level,
                    heading_path=tuple(headings),
                )
            )
            continue
        if not plain:
            continue
        if current_item is not None:
            blocks.append(
                MarkdownBlock(
                    "list_item",
                    plain,
                    markup,
                    marker=current_item[0],
                    heading_path=current_item[1],
                )
            )
        else:
            blocks.append(
                MarkdownBlock(
                    "quote" if quote_depth else "paragraph",
                    plain,
                    markup,
                    heading_path=tuple(headings),
                )
            )
    return ParsedMarkdown(tuple(blocks), tuple(links))
