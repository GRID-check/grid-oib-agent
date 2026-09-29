"""Verbatim transcription of scanned and garbled PDF pages through the vision model.

A scanned page has no text layer, and a garbled one has a text layer that
decodes to glyph ids (``page_triage``). Both are rendered and sent to the SAME
OpenAI-compatible endpoint the drawing analysis uses, with the same credential
(``resolve_vlm_credential``: org BYOK, then ``AIQ_VLM_API_KEY``, then the
provider key for ``AIQ_VLM_BASE_URL``), and the reply becomes the page's text.
It is then chunked like any other page: a transcription is text, not a visual,
so it never enters the drawing schema.

There is no local OCR engine by decision (2026-09-29): no tesseract, no new
container, no GPU. Why this route and not OpenRouter's ``file-parser`` plugin:
``docs/architecture/visual-ingestion.md`` ("Scans and garbled text layers").

Results are cached in the VLM cache (Dragonfly) under their own prompt type,
keyed by the rendered page's content hash and the model, so a re-ingest of the
same scan costs nothing and a prompt change never serves the old reply.
"""

from __future__ import annotations

import base64
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from dataclasses import field

logger = logging.getLogger(__name__)

#: Bumped whenever the prompt or the reply handling changes: it is part of the
#: cache identity, so a new prompt is never answered from the old one's cache.
PROMPT_VERSION = 1

#: The file failure for a scan with no vision model to read it. Same
#: ``reason: text`` shape as the image path's, so the failed-document UX offers
#: the same remedy instead of "no content extracted".
SCAN_NEEDS_VLM = "vlm_not_configured: scanned PDF pages need a vision model to be transcribed (AIQ_VLM_API_KEY)"

#: Reply that says the page carries no text worth indexing (blank, a photo).
NO_TEXT_MARKER = "[KEIN TEXT]"
#: Reply that says the page is a plan or technical drawing, not a text page.
DRAWING_MARKER = "[ZEICHNUNG]"

TRANSCRIPTION_PROMPT = f"""Du bist ein OCR-System. Transkribiere den Text dieser gescannten Dokumentseite wortgetreu.

Regeln:
- Gib ausschließlich den Text wieder, der auf der Seite steht. Nichts zusammenfassen,
  nichts erklären, nichts ergänzen, nichts übersetzen, nichts korrigieren.
- Behalte die Lesereihenfolge bei (bei mehreren Spalten: erst die linke Spalte vollständig, dann die rechte).
- Überschriften als Markdown-Überschriften (#, ##, ###) entsprechend ihrer Ebene.
- Tabellen als Markdown-Tabellen mit Kopfzeile; jede Zeile der Vorlage wird eine Tabellenzeile.
- Aufzählungen und Nummerierungen (1., a), -, •) so wie auf der Seite.
- Umlaute, ß, Paragraphenzeichen (§), Maßeinheiten und Zahlen exakt wie gedruckt (Dezimalkomma bleibt Komma).
- Unleserliche Stellen markierst du als [unleserlich]; rate keine Wörter.
- Stempel, handschriftliche Vermerke und Unterschriften: als [Stempel: …],
  [handschriftlich: …], [Unterschrift] kennzeichnen, lesbaren Text darin wiedergeben.
- Kopf- und Fußzeilen (Seitenzahlen, Aktenzahl) wiedergeben.
- Keine Einleitung, kein Kommentar, keine Codeblöcke um die Antwort.

Sonderfälle — dann antwortest du NUR mit der Markierung:
- Die Seite ist leer oder enthält keinen lesbaren Text: {NO_TEXT_MARKER}
- Die Seite ist überwiegend ein Plan, eine technische Zeichnung, ein Schnitt, eine Ansicht
  oder ein Foto (nicht ein Textdokument mit einer kleinen Abbildung): {DRAWING_MARKER}"""

# @environment_variable AIQ_OCR_MODEL
# @category Knowledge Layer
# @type string
# @default (the ingestion VLM model)
# @required false
# Model that transcribes scanned and garbled PDF pages. Unset, the ingestion
# VLM transcribes them (AIQ_VLM_MODEL, or the org's `ingest_vlm` override).
# Same endpoint and key as the VLM.
OCR_MODEL_ENV = "AIQ_OCR_MODEL"

#: Output budget for one page. A dense A4 page is ~900 German words, ~1 800
#: tokens; tables in Markdown roughly double that. ``_vlm_chat_create`` doubles
#: it once more on truncation.
_MAX_TOKENS = 4096

_FAILURE_PREFIX = "[transcription -"


def cache_prompt_type() -> str:
    """Cache namespace for transcriptions, distinct from every visual-analysis prompt."""
    return f"ocr:v{PROMPT_VERSION}"


def resolve_ocr_model(vlm_model: str, org_override: str | None = None) -> str:
    """The model that transcribes: the org's vision override, else ``AIQ_OCR_MODEL``, else the VLM.

    The org's ``ingest_vlm`` override wins because it is the tenant's own choice
    of vision model, made in the admin UI; a separate ``ingest_ocr`` group was
    not added (it would be a new picker row, a new bootstrap default and a new
    config key in the BFF for a choice no tenant has asked to make separately).
    """
    return org_override or os.environ.get(OCR_MODEL_ENV, "").strip() or vlm_model


def _transcribe_live(image_bytes: bytes, *, ocr_model: str, base_url: str, api_key: str) -> str:
    """One transcription call. Returns the reply, or a failure placeholder (never cached)."""
    from knowledge_layer.llamaindex import adapter as _adapter

    try:
        from openai import OpenAI

        client = OpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=_adapter.VLM_REQUEST_TIMEOUT_SECONDS,
            max_retries=1,
        )
        image_b64 = base64.b64encode(image_bytes).decode("ascii")
        reply = _adapter._vlm_chat_create(
            client,
            model=ocr_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": TRANSCRIPTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    ],
                }
            ],
            max_tokens=_MAX_TOKENS,
            temperature=0.0,
        )
    except Exception as exc:  # noqa: BLE001 - one page's failure costs that page
        logger.warning("Page transcription failed (%s: %s)", type(exc).__name__, str(exc)[:120])
        return f"{_FAILURE_PREFIX} failed: {type(exc).__name__}]"
    return clean_reply(reply)


def clean_reply(reply: str | None) -> str:
    """Strip what a model wraps around a transcription despite being told not to."""
    text = (reply or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0]
    return text.strip()


def is_failed(reply: str | None) -> bool:
    return not reply or reply.startswith(_FAILURE_PREFIX)


def transcribe_image(image_bytes: bytes, *, model: str, base_url: str, api_key: str) -> str:
    """Transcribe one rendered page, through the content-hash VLM cache."""
    from knowledge_layer.llamaindex import processing as _processing

    return _processing._cached_vlm_call(
        image_bytes,
        cache_prompt_type(),
        _transcribe_live,
        image_bytes,
        ocr_model=model,
        base_url=base_url,
        api_key=api_key,
        model=model,
    )


@dataclass
class TranscriptionOutcome:
    """What happened to every page the triage sent to transcription.

    Every page lands in exactly one bucket, so ``over_cap`` and ``failed`` are
    the counts a file result reports rather than something a reader infers from
    a short chunk list.
    """

    texts: dict[int, str] = field(default_factory=dict)
    drawings: list[int] = field(default_factory=list)
    blank: list[int] = field(default_factory=list)
    failed: list[int] = field(default_factory=list)
    over_cap: list[int] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {
            "pages_transcribed": len(self.texts),
            "pages_transcription_failed": len(self.failed),
            "pages_over_ocr_cap": len(self.over_cap),
        }


def _classify_reply(outcome: TranscriptionOutcome, page_number: int, reply: str) -> None:
    if is_failed(reply):
        outcome.failed.append(page_number)
    elif reply.startswith(DRAWING_MARKER):
        outcome.drawings.append(page_number)
    elif reply.startswith(NO_TEXT_MARKER):
        outcome.blank.append(page_number)
    else:
        outcome.texts[page_number] = reply


def transcribe_pdf_pages(
    pdf_path: str,
    page_numbers: list[int],
    *,
    model: str,
    base_url: str,
    api_key: str,
    max_pages: int,
    max_dim: int,
    workers: int,
) -> TranscriptionOutcome:
    """Render and transcribe ``page_numbers`` of ``pdf_path``, at most ``max_pages`` of them.

    Pages past the cap are listed in ``over_cap``, never dropped quietly. Pages
    are rendered a batch at a time, so a 500-page scan never holds 500 JPEGs in
    memory.
    """
    from knowledge_layer.llamaindex import processing as _processing

    wanted = sorted(page_numbers)
    outcome = TranscriptionOutcome(over_cap=wanted[max_pages:])
    if outcome.over_cap:
        logger.warning(
            "OCR page cap (%d) reached for %s; %d scanned page(s) not transcribed",
            max_pages,
            pdf_path,
            len(outcome.over_cap),
        )

    to_run = wanted[:max_pages]
    batch_size = max(1, workers) * 2
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for start in range(0, len(to_run), batch_size):
            batch = to_run[start : start + batch_size]
            # Rendered here, on the calling thread, a batch at a time so a
            # 500-page scan stays out of memory. The render takes PDFium through
            # `pdfium_lock` (see that module); the pool's threads only call the VLM.
            rendered = _processing.render_pdf_pages(pdf_path, batch, max_dim=max_dim)
            outcome.failed.extend(number for number in batch if number not in rendered)
            jobs = [(number, rendered[number]) for number in batch if number in rendered]
            replies = pool.map(
                lambda job: transcribe_image(job[1], model=model, base_url=base_url, api_key=api_key), jobs
            )
            for (number, _image), reply in zip(jobs, replies, strict=True):
                _classify_reply(outcome, number, reply)
    if outcome.failed:
        logger.warning("Transcription failed on %d page(s) of %s", len(outcome.failed), pdf_path)
    return outcome


# ---------------------------------------------------------------------------
# The ingestion step: triage, transcribe, merge
# ---------------------------------------------------------------------------


@dataclass
class PageRoutes:
    """Where the triage sent each page of one PDF, and what came of it.

    ``drawing_pages`` is ``None`` when the PDF could not be measured: the
    renderer then applies its own drawing check, as before triage existed.
    """

    drawing_pages: set[int] | None = None
    scan_pages: set[int] = field(default_factory=set)
    outcome: TranscriptionOutcome = field(default_factory=TranscriptionOutcome)
    not_transcribed: list[int] = field(default_factory=list)
    garbled_kept: list[int] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        """The per-file counts that go on the job status; zero counts are left out."""
        counts = {
            **self.outcome.counts(),
            "pages_not_transcribed_no_vlm": len(self.not_transcribed),
            "pages_garbled_text_kept": len(self.garbled_kept),
        }
        return {key: value for key, value in counts.items() if value}


def _merge_transcriptions(
    text_pages: list[dict], garbled: set[int], texts: dict[int, str], blank: set[int] | frozenset[int] = frozenset()
) -> list[int]:
    """Put transcriptions in as page text, in place; return the garbled pages that kept their own text.

    A transcription replaces a garbled text layer. A garbled page nothing
    replaced (no key, a failed call, the OCR cap, an unmeasurable PDF) keeps
    what of its text is not glyph ids (``page_triage.salvage_text``): the
    garbled verdict is a heuristic, and dropping a false positive loses a clean
    page. A page the model read and called blank keeps nothing. Mutated in
    place so the caller's list keeps its type and attributes.
    """
    from knowledge_layer.llamaindex.page_triage import salvage_text

    by_number = {page["page_number"]: page for page in text_pages}
    kept: list[int] = []
    for number in sorted(garbled & by_number.keys()):
        salvaged = "" if number in blank or number in texts else salvage_text(by_number[number].get("text"))
        if salvaged:
            by_number[number] = {**by_number[number], "text": salvaged}
            kept.append(number)
        else:
            del by_number[number]
    for number, text in texts.items():
        by_number[number] = {"page_number": number, "text": text, "tables": [], "table_boxes": []}
    text_pages[:] = [by_number[number] for number in sorted(by_number)]
    return kept


def route_pdf_pages(
    pdf_path: str,
    text_pages: list[dict],
    page_texts: dict[int, str],
    *,
    vlm_api_key: str | None,
    model: str,
    base_url: str,
    min_text_chars: int,
    min_paths: int,
    max_ocr_pages: int,
    max_dim: int,
    workers: int | None = None,
) -> PageRoutes:
    """Triage every page, transcribe the scanned and garbled ones, merge them into ``text_pages``.

    ``text_pages`` is updated in place: transcriptions become ordinary page
    text (and flow through the normal chunker) and replace garbled text layers;
    an untranscribed garbled page keeps its salvageable text
    (``garbled_kept``). Without a vision key nothing is transcribed and the pages are
    counted in ``not_transcribed``; the caller decides whether the file stands.
    """
    from knowledge_layer.llamaindex import page_triage
    from knowledge_layer.llamaindex import processing as _processing

    triage = page_triage.triage_pdf(pdf_path, page_texts, min_text_chars=min_text_chars, min_paths=min_paths)
    garbled = {n for n, text in page_texts.items() if page_triage.text_quality(text).garbled}
    if triage is None:
        # pdfium cannot open the file, so nothing can be rendered: the glyph
        # ids still go, and the pages are counted as not transcribed.
        kept = _merge_transcriptions(text_pages, garbled, {})
        return PageRoutes(outcome=TranscriptionOutcome(failed=sorted(garbled)), garbled_kept=kept)
    routes = PageRoutes(
        drawing_pages=set(triage.drawings),
        scan_pages=set(triage.pages(page_triage.PageKind.SCAN)),
    )
    wanted = triage.transcribed
    if wanted and not vlm_api_key:
        routes.not_transcribed = wanted
        logger.warning("%d scanned/garbled page(s) of %s not transcribed: no vision key", len(wanted), pdf_path)
    elif wanted:
        routes.outcome = transcribe_pdf_pages(
            pdf_path,
            wanted,
            model=model,
            base_url=base_url,
            api_key=vlm_api_key,
            max_pages=max_ocr_pages,
            max_dim=max_dim,
            workers=workers or _processing.VLM_BATCH_WORKERS,
        )
        routes.drawing_pages.update(routes.outcome.drawings)
    routes.garbled_kept = _merge_transcriptions(
        text_pages, garbled, routes.outcome.texts, blank=set(routes.outcome.blank)
    )
    return routes
