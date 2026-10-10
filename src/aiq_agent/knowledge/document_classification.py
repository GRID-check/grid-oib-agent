"""Shared, backend-agnostic document classification helpers.

The ingestor runs two light LLM passes over freshly-extracted document text at
ingestion time:

1. A one-sentence summary (``summarize_document_text``) — surfaced in the Files
   metadata panel and in the per-turn ``available_documents`` prompt line.
2. A controlled set of German document tags (``classify_document_tags``) —
   document type + OIB discipline — stored alongside the summary.

The ingestor supplies the extracted text; everything downstream of it — the
prompt, the LLM call, and the defensive parsing — lives here, beside the tag
vocabulary the API routes validate against.

Both helpers are fully fail-open: any missing LLM, LLM error, timeout, or
unparseable output resolves to ``None`` and never disturbs ingestion.

Public, reusable vocabulary (the single source of truth for tags):

* ``DOCUMENT_TYPE_TAGS`` — ordered, immutable tuple of document-type tags.
* ``DISCIPLINE_TAGS`` — ordered, immutable tuple of the six OIB discipline tags.
* ``ALLOWED_TAGS`` — a ``frozenset`` union of the two, the closed vocabulary the
  deterministic post-filter validates against.

The classification prompt is *built from* these constants, so the instructions
the LLM sees and the vocabulary the post-filter enforces can never drift apart.
Any future user-facing tag-edit endpoint MUST validate against these same
constants so free-form, semantically-duplicate categories (e.g. "Feuerschutz"
vs the canonical "Brandschutz") can never enter storage.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable
from collections.abc import Sequence

from aiq_agent.common.message_utils import response_text

logger = logging.getLogger(__name__)

# Text longer than this is truncated before being sent to the summary/tagging
# LLM (~1000 tokens of input is plenty for a one-liner + a handful of tags).
CLASSIFY_MAX_INPUT_CHARS = 4000

# =============================================================================
# Controlled tag taxonomy (German)
# =============================================================================
# The LLM is instructed to choose from these two closed vocabularies, and a
# deterministic post-filter drops anything outside them — so a hallucinated tag
# can never reach storage. Keep these lists in sync with the taxonomy documented
# on FB-8 in docs/audit/feedback-backlog.md.

# 1–2 of these describe what the document *is*. Ordered + immutable so the
# prompt renders deterministically and callers cannot mutate the vocabulary.
DOCUMENT_TYPE_TAGS: tuple[str, ...] = (
    "Bebauungsplan",
    "Flächenwidmungsplan",
    "Grundriss",
    "Schnitt",
    "Ansicht",
    "Detail",
    "Gutachten",
    "Bescheid",
    "Norm/Richtlinie",
    "Vertrag",
    "Foto",
    "Sonstiges",
)

# 0–3 of these (the six OIB 2023 Richtlinien disciplines) apply when the
# document clearly concerns that discipline.
DISCIPLINE_TAGS: tuple[str, ...] = (
    "Standsicherheit",
    "Brandschutz",
    "Hygiene/Gesundheit/Umweltschutz",
    "Nutzungssicherheit/Barrierefreiheit",
    "Schallschutz",
    "Energieeinsparung/Wärmeschutz",
)

# The complete allowed vocabulary — the closed set the deterministic post-filter
# validates every LLM-returned tag against. The single source of truth shared by
# the prompt builder, the ingestion post-filter, and any future edit endpoint.
ALLOWED_TAGS: frozenset[str] = frozenset(DOCUMENT_TYPE_TAGS) | frozenset(DISCIPLINE_TAGS)

# Hard cap on the number of tags stored per document.
MAX_TAGS = 5

# =============================================================================
# Explicit per-document classification ("Dokumentart" / doc_class)
# =============================================================================
# Unlike the free-form ``tags`` above (document type + OIB discipline), the
# doc_class is a SINGLE, human-settable label describing what role a document
# plays in the norm hierarchy. It is the authoritative signal preferred over the
# filename guess (``norm_registry.oib_doc_class``) everywhere: stored on the
# summaries row, stamped into chunk metadata, shown to the LLM, and used by the
# lane/SourceKind classifiers. Each doc_class maps to exactly one fine lane key
# (see ``norm_registry._OIB_CLASS_LANES``/``_RANK_LANES`` and ADR-0026).
#
# Ordered + immutable so callers cannot mutate the vocabulary and any future
# edit endpoint validates against the same closed set. Fail-open: an unknown
# value validates to False and callers fall back to :data:`DEFAULT_DOC_CLASS`.

# doc_class key -> German label (the "Dokumentart" the user picks / the LLM sees).
DOCUMENT_CLASS_LABELS: dict[str, str] = {
    "oib_richtlinie": "OIB-Richtlinie (verbindlich)",
    "oib_leitfaden": "OIB-Leitfaden",
    "oib_erlaeuterung": "OIB-Erläuterung",
    "oib_begriffe": "OIB-Begriffsbestimmungen",
    "oib_referenz": "OIB-Referenzdokument",
    "oib_aenderung": "OIB-Änderungsdokument",
    "norm_extern": "Norm (ÖNORM u.a.)",
    "gesetz": "Gesetz / Bauordnung",
    "sonstiges": "Sonstiges Basisdokument",
}

# doc_class key -> fine lane key (``norm_registry`` stratum). The lane label is
# looked up from the registry's lane tables so the two never drift.
DOCUMENT_CLASS_LANES: dict[str, str] = {
    "oib_richtlinie": "baurecht_oib",
    "oib_leitfaden": "baurecht_oib_leitfaden",
    "oib_erlaeuterung": "baurecht_oib_erlaeuterung",
    "oib_begriffe": "baurecht_oib_begriffe",
    "oib_referenz": "baurecht_oib_referenz",
    "oib_aenderung": "baurecht_oib_diff",
    "norm_extern": "norm_extern",
    "gesetz": "baurecht_ris",
    "sonstiges": "baurecht_basis",
}

# The ordered, immutable vocabulary (keys), the single source of truth.
DOCUMENT_CLASSES: tuple[str, ...] = tuple(DOCUMENT_CLASS_LABELS.keys())

# Neutral base class assigned when no human class is set and the filename gives
# no OIB hint — a real value beats a null, and it lands in the neutral base lane.
DEFAULT_DOC_CLASS = "sonstiges"


def is_valid_doc_class(value: str | None) -> bool:
    """Return whether ``value`` is a member of the closed doc_class vocabulary."""
    return value in DOCUMENT_CLASS_LABELS


# The Dokumentart as a SUGGESTION (ADR-0064, use 8). A base-corpus file whose
# name carries no OIB hint lands in ``sonstiges`` (the neutral lane) until a
# platform owner reclassifies it. The decision model reads the text and picks
# one of the nine classes; the pick is stored beside the class, never as it,
# and the base-knowledge page offers it. The lane changes only when a person
# accepts. Measured 2026-09-25 on twelve openings under hint-less file names
# (``tests/fixtures/decisions/doc_class.yaml``): 12/12 at 0.97-1.00, where the
# filename guess had 3/12.

#: What each class is, in the decider's language.
DOCUMENT_CLASS_CRITERIA: dict[str, str] = {
    "oib_richtlinie": (
        "An OIB-Richtlinie itself: the binding technical guideline text (OIB-Richtlinie 1 to 6, 2.1, 2.2, "
        "2.3), with numbered Punkte and requirements."
    ),
    "oib_leitfaden": "An OIB-Leitfaden: guidance published by the OIB on how to apply or deviate from a Richtlinie.",
    "oib_erlaeuterung": (
        "Erläuternde Bemerkungen: the OIB's explanatory remarks on a Richtlinie, point by point, saying why a "
        "requirement is as it is."
    ),
    "oib_begriffe": "The OIB-Richtlinien Begriffsbestimmungen: the list of defined terms used by all Richtlinien.",
    "oib_referenz": (
        "An OIB reference or supporting document to a Richtlinie (a national plan, reference values, a "
        "calculation basis), not the Richtlinie itself."
    ),
    "oib_aenderung": "An OIB change document: what changed in a Richtlinie between two editions.",
    "norm_extern": "A technical standard not issued by the OIB: an ÖNORM, an EN or Eurocode, a DIN.",
    "gesetz": (
        "A law or ordinance: a Bauordnung, a Bautechnikgesetz, a Verordnung of a Land or the federal state, with §§."
    ),
    "sonstiges": (
        "Anything else: a leaflet, a presentation, a letter, a checklist, a publication that is none of the above."
    ),
}

#: The pick is offered at or above this. Every row measured chose at 0.97+;
#: held-out (16 openings written blind) 13/13 offered right, none wrong.
DOC_CLASS_SUGGESTION_THRESHOLD = 0.8
DOC_CLASS_DECISION_SLOT = "doc_class"
DOC_CLASS_QUESTION = (
    "What kind of document is this, in the hierarchy of Austrian building regulations? "
    "Read the text, then the file name."
)


def suggest_doc_class(text: str, file_name: str, *, organization_id: str | None = None) -> str | None:
    """A Dokumentart for a person to confirm, or ``None`` (unsure, ``sonstiges``, or no decision)."""
    if not text or not text.strip():
        return None
    try:
        from aiq_agent.common.decisions import choice
        from aiq_agent.common.decisions import decide_blocking

        decision = decide_blocking(
            {"file_name": file_name, "text": text[:CLASSIFY_MAX_INPUT_CHARS]},
            {"doc_class": choice(DOC_CLASS_QUESTION, {key: DOCUMENT_CLASS_CRITERIA[key] for key in DOCUMENT_CLASSES})},
            slot=DOC_CLASS_DECISION_SLOT,
            timeout=TAG_DECISION_TIMEOUT_S,
            organization_id=organization_id,
        )
    except Exception as e:  # noqa: BLE001 — a suggestion is worth less than the ingestion
        logger.warning("Dokumentart decision failed for %s: %s", file_name, type(e).__name__)
        return None
    if decision is None:
        return None
    chosen, distribution = decision.choice("doc_class")
    if not is_valid_doc_class(chosen) or chosen == DEFAULT_DOC_CLASS:
        return None
    return chosen if distribution.get(chosen, 0.0) >= DOC_CLASS_SUGGESTION_THRESHOLD else None


# Length cap for the deterministic, LLM-free fallback summary (see
# ``fallback_summary_from_text``).
FALLBACK_SUMMARY_MAX_CHARS = 200


def fallback_summary_from_text(text: str | None, max_chars: int = FALLBACK_SUMMARY_MAX_CHARS) -> str | None:
    """Deterministic, LLM-free summary derived from already-extracted text.

    Used when LLM summary generation failed/timed out but tag classification
    succeeded: the ``summaries.summary`` column is NOT NULL, so tags need an
    anchor row. Returns the first ``max_chars`` characters of ``text`` collapsed
    to a single line and ellipsized, or ``None`` when no usable text exists (so
    the caller skips registration exactly as it would with no summary).
    """
    if not text:
        return None
    single_line = " ".join(text.split())
    if not single_line:
        return None
    if len(single_line) <= max_chars:
        return single_line
    return single_line[:max_chars].rstrip() + "…"


# =============================================================================
# One-sentence summary (shared prompt + call + parse)
# =============================================================================


def summarize_document_text(text_content: str, file_name: str, llm) -> str | None:
    """Generate a one-sentence summary from already-extracted document text.

    The ingestor obtains ``text_content`` from its chunks; this function owns
    the prompt, the LLM call, and the response parsing.

    Args:
        text_content: Representative document text (e.g. first + last chunk).
        file_name: Filename, for log context only.
        llm: A LangChain-style LLM exposing ``.invoke``. ``None`` → no summary.

    Returns:
        A one-sentence summary, or ``None`` if no LLM was provided or generation
        failed.
    """
    if llm is None:
        return None

    text = text_content[:CLASSIFY_MAX_INPUT_CHARS]
    prompt = (
        "Fasse den Inhalt dieses Baudokuments in EINEM Satz auf Deutsch zusammen. "
        "Beschreibe, WAS das Dokument inhaltlich zeigt (z.B. Zeichnungstyp wie "
        "Grundriss/Schnitt/Ansicht, dargestellte Räume/Bauteile, Maßstab). "
        "Bei technischen Zeichnungen nenne Zeichnungstyp und Maßstab, falls "
        "erkennbar. Ignoriere Wasserzeichen sowie Software-/Lizenzhinweise "
        '(z.B. "VECTORWORKS EDUCATIONAL VERSION") vollständig — sie sind NICHT '
        "der Inhalt. Antworte nur mit dem Satz, ohne Einleitung.\n\n"
        f"{text}"
    )

    try:
        response = llm.invoke(prompt)
        summary = response_text(response).strip()
        logger.info("[SUMMARY] Generated (%d chars)", len(summary))
        return summary or None
    except Exception as e:
        logger.warning("Summary via LLM failed for %s: %s", file_name, e)
        return None


# =============================================================================
# Controlled tag classification (shared prompt + call + parse + post-filter)
# =============================================================================


def _build_tag_prompt(text: str, file_name: str) -> str:
    """Build the German tag-classification prompt with the closed vocabularies."""
    doc_types = ", ".join(DOCUMENT_TYPE_TAGS)
    disciplines = ", ".join(DISCIPLINE_TAGS)
    return (
        "Du klassifizierst ein Baudokument für ein österreichisches "
        "Architekturbüro (OIB-Richtlinien).\n\n"
        f"Dateiname: {file_name}\n\n"
        "Wähle:\n"
        f"- 1 bis 2 Dokumenttyp-Schlagwörter aus: [{doc_types}]\n"
        f"- 0 bis 3 Fachbereich-Schlagwörter aus: [{disciplines}] "
        "(nur wenn der Fachbereich eindeutig zutrifft)\n\n"
        "Regeln:\n"
        "- Verwende AUSSCHLIESSLICH Schlagwörter aus den obigen Listen, "
        "wortgleich.\n"
        "- Maximal 5 Schlagwörter insgesamt.\n"
        "- Erfinde keine neuen Schlagwörter.\n"
        "- Antworte NUR mit einem JSON-Array von Strings, ohne weiteren Text.\n\n"
        'Beispiel: ["Grundriss", "Brandschutz"]\n\n'
        "Dokumentinhalt:\n"
        f"{text}"
    )


def _parse_tags(raw: str) -> list[str] | None:
    """Defensively parse an LLM response into a validated tag list.

    Strips code fences, decodes the JSON array, keeps only strings that are in
    the allowed vocabulary (deduplicated, order-preserving), and caps the result
    at :data:`MAX_TAGS`. Any parse problem — or an empty result after filtering —
    yields ``None``.
    """
    if not raw:
        return None

    text = raw.strip()

    # Strip a leading ```json / ``` fence and its trailing counterpart.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()

    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(parsed, list):
        return None

    result: list[str] = []
    for item in parsed:
        if not isinstance(item, str):
            continue
        tag = item.strip()
        if tag in ALLOWED_TAGS and tag not in result:
            result.append(tag)

    result = result[:MAX_TAGS]
    return result or None


# =============================================================================
# Tags as a decision (ADR-0064): the closed vocabulary is the question
# =============================================================================
# Picking 1–2 of twelve types and 0–3 of six disciplines is a decision, not a
# generation: a choice and six nouls over the same text, answered by the
# decision model in well under a second for a fraction of what the generative
# call costs, and unable by construction to return a tag outside the
# vocabulary or a JSON array that does not parse. The generative prompt above
# stays as the fallback for a decision that did not run (no key, ZDR, BYOK
# elsewhere, the endpoint down). Tags annotate a file (the inventory line, the
# Files panel); nothing filters on them, so a wrong tag withholds nothing.

#: What each type tag means, in the decider's language; the German text is the state.
DOCUMENT_TYPE_CRITERIA: dict[str, str] = {
    "Bebauungsplan": "A development plan (Bebauungsplan): building lines, heights, density or use for plots.",
    "Flächenwidmungsplan": "A land-use zoning plan (Flächenwidmungsplan): which land may be used for what.",
    "Grundriss": "A floor plan drawing of a storey: rooms, walls, doors, dimensions seen from above.",
    "Schnitt": "A section drawing (Schnitt): the building cut vertically, storey heights and levels.",
    "Ansicht": "An elevation drawing (Ansicht): a facade seen from outside.",
    "Detail": "A construction detail drawing: a joint, a layer build-up, a connection at large scale.",
    "Gutachten": (
        "An expert's report, concept or assessment for the project (Gutachten, Konzept such as a "
        "Brandschutzkonzept, Stellungnahme, Nachweis, Berechnung)."
    ),
    "Bescheid": "An official decision or notice by an authority (Bescheid, Baubewilligung, Auflagen).",
    "Norm/Richtlinie": "A standard, guideline, regulation or law text (OIB-Richtlinie, ÖNORM, Bauordnung).",
    "Vertrag": "A contract or agreement between parties.",
    "Foto": "A photograph of a building, a site or a situation.",
    "Sonstiges": "Anything else: a letter, minutes, a list, a schedule, a form, a presentation.",
}

#: What each discipline tag covers.
DISCIPLINE_CRITERIA: dict[str, str] = {
    "Standsicherheit": "Structural stability: load-bearing structure, statics, foundations.",
    "Brandschutz": "Fire safety: fire resistance, compartments, escape routes, fire brigade access.",
    "Hygiene/Gesundheit/Umweltschutz": "Hygiene, health, environment: daylight, ventilation, moisture, sanitary.",
    "Nutzungssicherheit/Barrierefreiheit": "Safety in use and accessibility: stairs, railings, ramps, lifts.",
    "Schallschutz": "Sound insulation: airborne and impact sound, acoustics.",
    "Energieeinsparung/Wärmeschutz": "Energy saving and thermal insulation: U-values, Energieausweis.",
}

#: Every decision here acts at 0.8 (2026-09-26). The type is kept at this
#: probability; below it the decision is treated as not made and the
#: generative prompt tags the document. Tuning set (twelve openings): every
#: type at 0.99-1.00 once `Gutachten` names a Konzept (a Brandschutzkonzept
#: sat at 0.80 before). Held-out set (24 openings written blind): 24/24 types
#: at 0.8 with or without that change, 13 of 14 disciplines, no false one.
#: One type only: a second type was the choice's runner-up, which cannot
#: reach 0.8 beside a chosen one, and it never rode along in a measurement.
TYPE_THRESHOLD = 0.8
#: A discipline is tagged at this probability or above, the top three. The
#: answers split in two (2026-09-25, same twelve openings): every clear
#: discipline at 0.96-0.98, everything else at or below 0.52 — a false
#: Standsicherheit on a meeting protocol because a Statiker attended (0.47)
#: beside a true Schallschutz in a bauphysik report (0.52). A tag rides in the
#: inventory line of every prompt, and a false one tells the agent what a
#: document is about, so the borderline Schallschutz is left out. A plan that
#: merely draws a fire compartment is not tagged Brandschutz (0.30), which
#: the prompt's own "nur wenn der Fachbereich eindeutig zutrifft" asks for.
DISCIPLINE_THRESHOLD = 0.8
MAX_DISCIPLINE_TAGS = 3
#: The technical-record slot: ``status:decision:document_tags``.
TAG_DECISION_SLOT = "document_tags"
#: Ingestion is not a reader waiting: a slower answer is still worth having.
TAG_DECISION_TIMEOUT_S = 5.0


def tag_questions() -> dict[str, dict]:
    """The decision's questions, built from the vocabulary so the two cannot drift."""
    from aiq_agent.common.decisions import choice
    from aiq_agent.common.decisions import noul

    questions = {
        "type": choice(
            "What kind of document is this? Read the content and the file name.",
            {tag: DOCUMENT_TYPE_CRITERIA[tag] for tag in DOCUMENT_TYPE_TAGS},
        )
    }
    for index, tag in enumerate(DISCIPLINE_TAGS):
        questions[f"discipline_{index}"] = noul(
            "Is this document clearly about this building discipline?",
            true=f"The document's subject is, in substantial part: {DISCIPLINE_CRITERIA[tag]}",
            false="The discipline is not the document's subject, or is mentioned only in passing.",
        )
    return questions


def tags_from_decision(decision) -> list[str] | None:
    """The tags a decision earns: the type, then the disciplines; ``None`` when it chose no type at 0.8."""
    chosen, distribution = decision.choice("type")
    if chosen not in DOCUMENT_TYPE_TAGS or distribution.get(chosen, 0.0) < TYPE_THRESHOLD:
        return None
    tags = [chosen]
    disciplines = sorted(
        (
            (p, index)
            for index in range(len(DISCIPLINE_TAGS))
            if (p := decision.noul(f"discipline_{index}")) is not None and p >= DISCIPLINE_THRESHOLD
        ),
        reverse=True,
    )
    tags.extend(DISCIPLINE_TAGS[index] for _, index in disciplines[:MAX_DISCIPLINE_TAGS])
    return tags[:MAX_TAGS]


def decide_document_tags(text: str, file_name: str, *, organization_id: str | None = None) -> list[str] | None:
    """Tags from the decision model; ``None`` when no decision ran, so the caller falls back."""
    if not text or not text.strip():
        return None
    try:
        from aiq_agent.common.decisions import decide_blocking

        decision = decide_blocking(
            {"file_name": file_name, "text": text[:CLASSIFY_MAX_INPUT_CHARS]},
            tag_questions(),
            slot=TAG_DECISION_SLOT,
            timeout=TAG_DECISION_TIMEOUT_S,
            organization_id=organization_id,
        )
    except Exception as e:  # noqa: BLE001 — a tag is worth less than the ingestion
        logger.warning("Tag decision failed for %s: %s", file_name, type(e).__name__)
        return None
    return tags_from_decision(decision) if decision is not None else None


def classify_document_tags(text: str, file_name: str, llm, *, organization_id: str | None = None) -> list[str] | None:
    """Classify document text into 0–5 controlled German tags.

    The decision model first (:func:`decide_document_tags`); the generative
    call only when no decision ran. Fully fail-open: a missing LLM, an LLM
    error, or any unparseable/invalid output resolves to ``None``. Returned
    tags are always a subset of :data:`ALLOWED_TAGS` (unknown tags are dropped
    deterministically, so the LLM cannot invent vocabulary).

    Args:
        text: Representative document text (same source the summary uses).
        file_name: Filename, used both as a classification hint and log context.
        llm: A LangChain-style LLM exposing ``.invoke``, the fallback. ``None``
            and no decision → no tags.
        organization_id: The uploading organization, for its BYOK and ZDR
            policy; ingestion runs outside any request context.

    Returns:
        A validated, non-empty list of tags, or ``None``.
    """
    decided = decide_document_tags(text, file_name, organization_id=organization_id)
    if decided:
        logger.info("[TAGS] Decided %s -> %s", file_name, decided)
        return decided
    if llm is None:
        return None

    prompt = _build_tag_prompt(text[:CLASSIFY_MAX_INPUT_CHARS], file_name)

    try:
        response = llm.invoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
    except Exception as e:
        logger.warning("Tag classification via LLM failed for %s: %s", file_name, e)
        return None

    tags = _parse_tags(content)
    if tags:
        logger.info("[TAGS] Classified %s -> %s", file_name, tags)
    return tags


#: The vision model's segment type for a photograph or rendering
#: (``visual_domains._PICTORIAL_TYPES``).
PHOTO_SEGMENT_TYPE = "photo"
PHOTO_TAG = "Foto"


def reconcile_image_tags(
    tags: list[str] | None,
    *,
    content_type: str | None,
    segment_types: Iterable[str],
) -> list[str] | None:
    """Make sure an uploaded image the vision model saw as a photograph says ``Foto``.

    The tag classifier reads TEXT — for an image, the vision model's caption —
    so it never saw the pixels the vision model did. A photo with a sparse
    caption came out with no type at all, while the vision model had already
    said "photograph". ``Foto`` is ADDED, first; what the classifier read from
    the caption stays: a photo of the ground-floor plan pinned on the site
    office wall is a Foto AND a Grundriss, and a photo of a fire door keeps its
    Brandschutz. Capped at ``MAX_TAGS``, dropping from the end, so ``Foto`` and
    the classifier's first reading survive.

    Only for an image whose dominant content is pictorial (``content_type ==
    "image"``): a scanned plan is typed ``drawing`` and keeps the classifier's
    plan type alone. Deterministic and model-free.
    """
    if content_type != "image" or PHOTO_SEGMENT_TYPE not in set(segment_types):
        return tags
    rest = [tag for tag in (tags or []) if tag != PHOTO_TAG]
    return [PHOTO_TAG, *rest][:MAX_TAGS]


# =============================================================================
# Open topics: the model's own keywords, beside the controlled vocabulary
# =============================================================================
#
# The controlled tags answer two closed questions — what KIND of document is
# this, which OIB discipline does it concern — and they are closed on purpose:
# a filter over eighteen words is one a person can scan. They cannot say what a
# document is ABOUT. "Alle Attikadetails in Holzrahmenbauweise" (feld72, Jour
# fixe 2026-10-09) is a question about a building part and a construction
# method, and no list a platform writes in advance holds every Bauteil, Bauweise
# and Gewerk an office works with.
#
# So beside the tags the model names a few TOPICS of its own, under three
# guards: only those it is confident of; none that restate a controlled tag;
# and the project's existing topics offered first, so one office's "Attika"
# stays "Attika" instead of drifting into "Attikaaufbau", "Attika-Detail" and
# "Dachrand". A person corrects them in the same place as the tags, and a
# correction is kept across re-reads the same way.

#: Topics stored per document. Few, so each one says something.
MAX_TOPICS = 6
#: The model's own confidence a topic must reach to be kept.
TOPIC_THRESHOLD = 0.75
#: A topic is a term, not a sentence.
MAX_TOPIC_CHARS = 40
MAX_TOPIC_WORDS = 3
#: Existing topics of the collection offered to the model to reuse, most used first.
MAX_TOPIC_VOCABULARY = 60

_CONTROLLED_FOLDED = frozenset(tag.casefold() for tag in ALLOWED_TAGS)


def _build_topic_prompt(text: str, file_name: str, existing: Sequence[str]) -> str:
    vocabulary = (
        "Vorhandene Themen in diesem Projekt (verwende eines davon, wenn es passt, in genau dieser Schreibweise):\n"
        + ", ".join(existing[:MAX_TOPIC_VOCABULARY])
        + "\n\n"
        if existing
        else ""
    )
    return (
        "Nenne die Themen dieses Baudokuments: konkrete Fachbegriffe, nach denen ein Architekturbüro "
        "Unterlagen sucht — Bauteile (Attika, Fenster, Stiege), Bauweisen und Materialien "
        "(Holzrahmenbau, Stahlbeton), Räume und Bereiche (Tiefgarage, Fluchtweg), Gewerke und Themen "
        "(Abdichtung, Lüftung).\n"
        "Regeln:\n"
        f"- Höchstens {MAX_TOPICS} Themen, jedes ein Begriff aus 1 bis {MAX_TOPIC_WORDS} Wörtern, "
        "Substantiv im Singular.\n"
        "- KEINE Dokumentart (Grundriss, Schnitt, Gutachten …) und KEIN OIB-Fachbereich (Brandschutz, "
        "Schallschutz …) — die werden getrennt erfasst.\n"
        "- KEINE Namen von Personen, Firmen, Projekten oder Adressen.\n"
        "- Gib zu jedem Thema an, wie sicher du bist, dass es das Dokument wirklich betrifft (0.0 bis 1.0). "
        "Lieber kein Thema als ein geratenes.\n\n"
        f"{vocabulary}"
        'Antworte NUR mit einem JSON-Array, z.B. [{"thema": "Attika", "sicherheit": 0.9}].\n\n'
        f"Dateiname: {file_name}\n\n"
        f"{text[:CLASSIFY_MAX_INPUT_CHARS]}"
    )


def normalize_topic(raw: object) -> str | None:
    """A topic as stored: trimmed, one space, bounded; ``None`` when it is not a usable term."""
    if not isinstance(raw, str):
        return None
    term = " ".join(raw.replace(" ", " ").split()).strip(" .,;:-–—\"'„“")
    if not term or len(term) > MAX_TOPIC_CHARS or len(term.split(" ")) > MAX_TOPIC_WORDS:
        return None
    if not any(char.isalpha() for char in term):
        return None
    return term


def parse_topics(content: str, existing: Sequence[str] = ()) -> list[str] | None:
    """Keep the confident, new-information topics, spelled as the project already spells them.

    Pure. A reply that is not the JSON array asked for yields ``None``; so does
    one whose every topic was dropped. Order is the model's (most relevant
    first), duplicates by case are dropped, and the result is capped.
    """
    if not content:
        return None
    body = content.strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", body, re.DOTALL)
    if fenced:
        body = fenced.group(1)
    try:
        items = json.loads(body)
    except (TypeError, ValueError):
        return None
    if not isinstance(items, list):
        return None
    known = {term.casefold(): term for term in existing if isinstance(term, str)}
    kept: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        confidence = item.get("sicherheit", item.get("confidence"))
        # A bool is an int to Python and NaN compares False to everything: neither is a confidence.
        if isinstance(confidence, bool) or not isinstance(confidence, int | float) or not confidence >= TOPIC_THRESHOLD:
            continue
        term = normalize_topic(item.get("thema", item.get("topic")))
        if term is None:
            continue
        folded = term.casefold()
        if folded in _CONTROLLED_FOLDED or folded in seen:
            continue
        seen.add(folded)
        kept.append(known.get(folded, term))
        if len(kept) >= MAX_TOPICS:
            break
    return kept or None


def suggest_topics(
    text: str,
    file_name: str,
    llm,
    *,
    existing: Sequence[str] = (),
) -> list[str] | None:
    """The model's confident topics for a document, or ``None``. Fully fail-open.

    Runs beside the summary and the tags at ingest, on the same text and the
    same summary model (so it lands on the same cost ledger and trace).
    """
    if llm is None or not text or not text.strip():
        return None
    try:
        response = llm.invoke(_build_topic_prompt(text, file_name, existing))
    except Exception as e:  # noqa: BLE001 — a topic is worth less than the ingestion
        logger.warning("Topic suggestion failed for %s: %s", file_name, e)
        return None
    topics = parse_topics(response_text(response), existing)
    if topics:
        logger.info("[TOPICS] %s -> %s", file_name, topics)
    return topics
