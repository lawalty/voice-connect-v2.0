from __future__ import annotations

import re
from dataclasses import dataclass

from app.markdown_ir import parse_markdown


@dataclass(frozen=True)
class TextChunk:
    index: int
    content: str
    word_count: int
    heading_path: tuple[str, ...] = ()


def chunk_text(
    text: str, target_words: int = 280, overlap_words: int = 40
) -> list[TextChunk]:
    """Create bounded overlapping chunks without silently dropping text."""
    clean = re.sub(r"[ \t]+", " ", text.replace("\x00", " "))
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    words = clean.split()
    if not words:
        return []
    if target_words < 50 or not 0 <= overlap_words < target_words:
        raise ValueError("invalid chunk sizing")

    chunks: list[TextChunk] = []
    step = target_words - overlap_words
    for start in range(0, len(words), step):
        current = words[start : start + target_words]
        if not current:
            break
        chunks.append(
            TextChunk(
                index=len(chunks), content=" ".join(current), word_count=len(current)
            )
        )
        if start + target_words >= len(words):
            break
    return chunks


def chunk_markdown(
    markdown: str,
    title: str,
    target_words: int = 280,
    overlap_words: int = 40,
) -> list[TextChunk]:
    """Chunk canonical Markdown by section without crossing heading boundaries."""
    if target_words < 50 or not 0 <= overlap_words < target_words:
        raise ValueError("invalid chunk sizing")
    parsed = parse_markdown(markdown, title=title)
    sections: list[tuple[tuple[str, ...], list[str]]] = []
    for block in parsed.blocks:
        text = block.plain_text.strip()
        if not text or block.kind in {"heading", "rule"}:
            continue
        if not sections or sections[-1][0] != block.heading_path:
            sections.append((block.heading_path, []))
        sections[-1][1].append(text)

    output: list[TextChunk] = []
    for heading_path, block_texts in sections:
        section_text = "\n\n".join(block_texts)
        for part in chunk_text(section_text, target_words, overlap_words):
            context = [f"Title: {title}"]
            if heading_path:
                context.append(f"Section: {' > '.join(heading_path)}")
            content = "\n".join(context) + "\n\n" + part.content
            output.append(
                TextChunk(
                    index=len(output),
                    content=content,
                    word_count=len(content.split()),
                    heading_path=heading_path,
                )
            )
    return output
