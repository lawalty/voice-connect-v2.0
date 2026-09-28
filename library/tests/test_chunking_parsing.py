from __future__ import annotations

import io
import subprocess

import pytest
from docx import Document
from pypdf import PdfWriter
from reportlab.pdfgen import canvas

import app.parsers as parsers
from app.chunking import chunk_text
from app.parsers import DocumentParseError, extract_text, validate_document


def test_chunking_overlaps_and_preserves_tail() -> None:
    words = [f"w{i}" for i in range(820)]
    chunks = chunk_text(" ".join(words), target_words=350, overlap_words=50)
    assert [chunk.word_count for chunk in chunks] == [350, 350, 220]
    assert chunks[0].content.split()[-50:] == chunks[1].content.split()[:50]
    assert chunks[-1].content.split()[-1] == "w819"


def test_text_and_docx_extraction() -> None:
    assert extract_text("notes.txt", "text/plain", b"alpha\nbeta") == "alpha\nbeta"
    document = Document()
    document.add_paragraph("Church policy")
    buffer = io.BytesIO()
    document.save(buffer)
    assert "Church policy" in extract_text(
        "policy.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer.getvalue(),
    )


def test_unsupported_and_empty_documents_fail_closed() -> None:
    with pytest.raises(DocumentParseError):
        validate_document("payload.exe", "application/octet-stream")
    with pytest.raises(DocumentParseError, match="no extractable text"):
        extract_text("empty.txt", "text/plain", b"  \n")


def test_windows_encoded_text_is_detected_without_corrupting_smart_quotes() -> None:
    source = "The employee’s policy – revised".encode("windows-1252")
    assert extract_text("policy.txt", "text/plain", source) == "The employee’s policy – revised"


def _blank_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _text_pdf(value: str) -> bytes:
    output = io.BytesIO()
    document = canvas.Canvas(output, pagesize=(612, 792))
    document.drawString(72, 720, value)
    document.save()
    return output.getvalue()


def test_automatic_pdf_ocr_fills_image_only_pages_locally(monkeypatch) -> None:
    commands: list[list[str]] = []

    monkeypatch.setattr(parsers.shutil, "which", lambda name: name)

    def fake_run(
        command: list[str], *, operation: str, timeout_seconds: float
    ) -> subprocess.CompletedProcess[str]:
        del operation, timeout_seconds
        commands.append(command)
        stdout = "Unburdened at Calvary OCR text" if command[0] == "tesseract" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(parsers, "_run_ocr_command", fake_run)

    extracted = extract_text(
        "devotion.pdf",
        "application/pdf",
        _blank_pdf(),
        pdf_ocr_enabled=True,
    )

    assert extracted == "Unburdened at Calvary OCR text"
    assert [command[0] for command in commands] == ["pdftoppm", "tesseract"]


def test_automatic_pdf_ocr_does_not_reprocess_clean_embedded_text(monkeypatch) -> None:
    def unexpected_command(*args, **kwargs):
        raise AssertionError("OCR command should not run for a clean text page")

    monkeypatch.setattr(parsers, "_run_ocr_command", unexpected_command)
    source = _text_pdf(
        "This devotion already contains enough embedded text for direct extraction."
    )

    extracted = extract_text(
        "devotion.pdf",
        "application/pdf",
        source,
        pdf_ocr_enabled=True,
    )

    assert "enough embedded text" in extracted


def test_pdf_ocr_reports_missing_local_runtime(monkeypatch) -> None:
    monkeypatch.setattr(parsers.shutil, "which", lambda name: None)

    with pytest.raises(DocumentParseError, match="pdftoppm or Tesseract is missing"):
        extract_text(
            "scan.pdf",
            "application/pdf",
            _blank_pdf(),
            pdf_ocr_enabled=True,
        )

