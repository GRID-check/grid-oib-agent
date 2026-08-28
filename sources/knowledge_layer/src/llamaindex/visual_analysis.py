"""Structured extraction schema for every ingested visual (schema v4).

One module owns everything about WHAT is extracted from an image and HOW that
extraction becomes indexable text — and nothing about how the VLM is called or
where chunks are stored. The adapter stays the orchestrator; this module is a
pure library (schema in, JSON out, text out) so the extraction schema, the VLM
backend, and the index layout can each be changed without touching the others.
That boundary is a stated backend requirement: see
``docs/architecture/visual-ingestion.md``.

Three things are kept apart here on purpose:

**The kernel** (this module) is domain-neutral and versioned. A visual is
segments; a segment holds entities, compositions, states, quantities,
relations and annotations. Nothing in it names a room or a floor plan.

**The vocabulary** (:mod:`visual_domains`) is data. A room is an entity whose
category is ``space`` in the ``architecture`` domain. Adding a domain must not
require a change here; if it does, the thing it needs belongs in the kernel.

**The domain is chosen per SEGMENT, not per image.** Real sheets mix — a plan
sheet carries a floor plan, a detail, a legend, a site photo and an energy
chart. Every enabled domain's vocabulary is offered, and each segment says
which one it was read with.

Schema v4 (canonical form, produced by :func:`parse_visual_analysis`)::

    {
      "schema_version": 4,
      "registry": "architecture+general",  # vocabulary that produced this
      "segments": [
        {
          "domain": "architecture",
          "segment_type": "floor_plan",    # from that domain's vocabulary
          "title": str|None,
          "scale": str|None,               # per SEGMENT, not per image
          "summary": str,                  # free text, kept deliberately
          "entities": [{"name": str, "category": str,
                        "role": str|None, "measure": str|None}],
          "compositions": [{"component": str,
                            "layers": [{"material": str,
                                        "thickness": str|None,
                                        "function": str|None}]}],
          "states": [{"element": str, "state": str}],
          "quantities": [{"object": str, "property": str, "value": str,
                          "unit": str|None, "source": str|None,
                          "confidence": str|None}],
          "relations": [{"subject": str, "relation": str, "object": str}],
          "annotations": [str],            # verbatim dimension/label strings
          "bbox": [x0, y0, x1, y1]|None,   # approximate, normalised 0-1
          "source": "text|visual|inferred",
          "confidence": "high|medium|low"
        }
      ],
      "document": {                        # title-block facts, once
        "title": str|None, "subtitle": str|None,
        "slogans": [str],                  # headlines — NEVER mixed into title
        "author": str|None, "institution": str|None,
        "supervision": str|None, "location": str|None,
        "strategies": [str], "process_steps": [str],
        "watermark": str|None,
        "summary": str
      }
    }

Design decisions that are easy to get wrong later:

- **Quantities carry meaning.** ``71 %`` alone is worthless; every number is
  stored as object + property + value + unit ("existing fabric retained",
  "share", "71", "%").
- **Provenance and confidence are first-class** on segments and quantities, so
  a visually-guessed scale is never laundered into a certain fact downstream.
- **Titles and slogans are separate fields.** A poster headline is not a
  subtitle.
- **The parser is lenient and versioned.** Any reply that is not valid v4 JSON
  falls back to the legacy ``KEY: value`` parser, so a weaker model (or an old
  cached caption) degrades to earlier behaviour, never to a failed page.
- **``bbox`` is groundwork, not truth.** A model's box on a technical sheet is
  approximate; it is stored (normalised, clamped) for the future crop-per-view
  stage and for highlighting, and must never be used as a measurement.
- **Identifiers and instructions are English**, because they are business
  logic. Free text (summaries, names read off the sheet) stays in the
  document's own language, because that is what retrieval has to match.
"""

from __future__ import annotations

import json
import re
from typing import Any

from knowledge_layer.llamaindex.visual_domains import Domain
from knowledge_layer.llamaindex.visual_domains import DomainRegistry
from knowledge_layer.llamaindex.visual_domains import resolve_registry

#: Bump when the kernel schema changes shape. Part of the VLM cache identity so
#: a schema change never serves output produced under the previous schema.
SCHEMA_VERSION = 4

# Bounds applied during normalisation. The model is instructed to be complete;
# these caps keep a runaway reply from turning one chunk into megabytes.
_MAX_SEGMENTS = 12
_MAX_LIST_ITEMS = 60
_MAX_STR = 2000

SOURCES = ("text", "visual", "inferred")
CONFIDENCES = ("high", "medium", "low")

#: Offered alongside the real values instead of allowing null. A nullable enum
#: is the one shape that falls outside the intersection every structured-output
#: implementation accepts, and "unknown" says the same thing in a plain string
#: enum. The parser maps it back to ``None``, since it is an absence.
UNKNOWN = "unknown"

_SOURCE_SET = frozenset(SOURCES)
_CONFIDENCE_SET = frozenset(CONFIDENCES)


def cache_prompt_type(registry: DomainRegistry) -> str:
    """Cache identity for one (schema, vocabulary) pair.

    The vocabulary's CONTENT is part of it, not just which domains are on:
    renaming a category or rewriting a hint changes what the model is asked to
    look for, and a key naming only the domain set would serve the old reading
    for the whole cache TTL.
    """
    return f"visual:v{SCHEMA_VERSION}:{registry.fingerprint}"


# ---------------------------------------------------------------------------
# JSON Schema
# ---------------------------------------------------------------------------


def json_schema(registry: DomainRegistry) -> dict[str, Any]:
    """The extraction schema as a standalone JSON Schema document.

    One artifact, three uses: it is handed to providers that support
    schema-constrained decoding (``response_format`` / guided decoding), it is
    rendered into the prompt for providers that do not, and it documents the
    contract for anything downstream.

    Written for the strict-structured-output subset rather than for expressive
    completeness: object types only, ``additionalProperties: false``, every
    property listed in ``required`` with nullability carried by the type union.
    Notably it does NOT try to express "a category must belong to the segment's
    domain" — that is conditional validation (``if``/``then``), which the
    strict subsets do not accept. Enums here are the flat union across enabled
    domains, and the domain-specific check happens in
    :func:`parse_visual_analysis`, where the segment's domain is known.
    """

    def nullable_string(description: str) -> dict[str, Any]:
        return {"type": ["string", "null"], "description": description}

    def string_array(description: str) -> dict[str, Any]:
        return {"type": "array", "items": {"type": "string"}, "description": description}

    def obj(properties: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        }

    entity = obj(
        {
            "name": {"type": "string", "description": "The thing as it is named on the image."},
            "category": {
                "type": "string",
                "enum": list(registry.category_keys()),
                "description": "Category from the vocabulary of this segment's domain.",
            },
            "role": nullable_string("What it is for, when stated."),
            "measure": nullable_string("A size or quantity belonging to this entity, e.g. '24.5 m²'."),
        }
    )

    layer = obj(
        {
            "material": {"type": "string"},
            "thickness": nullable_string("e.g. '200 mm'."),
            "function": nullable_string("e.g. 'load-bearing', 'insulation'."),
        }
    )

    composition = obj(
        {
            "component": {"type": "string", "description": "The assembled component, e.g. 'external wall'."},
            "layers": {
                "type": "array",
                "items": layer,
                "description": "Layers in order, outside to inside.",
            },
        }
    )

    state = obj(
        {
            "element": {"type": "string"},
            "state": {"type": "string", "enum": list(registry.state_keys())},
        }
    )

    quantity = obj(
        {
            "object": {"type": "string", "description": "What the number is ABOUT. Never omit this."},
            "property": {"type": "string", "description": "Which property of it, e.g. 'share', 'area'."},
            "value": {"type": "string"},
            "unit": nullable_string("e.g. '%', 'm²', 'mm'."),
            "source": {"type": "string", "enum": [*SOURCES, UNKNOWN]},
            "confidence": {"type": "string", "enum": [*CONFIDENCES, UNKNOWN]},
        }
    )

    relation = obj(
        {
            "subject": {"type": "string"},
            "relation": {"type": "string", "description": "e.g. 'connects', 'is above', 'serves'."},
            "object": {"type": "string"},
        }
    )

    segment = obj(
        {
            "domain": {
                "type": "string",
                "enum": list(registry.domain_ids),
                "description": "Which domain vocabulary this segment was read with.",
            },
            "segment_type": {
                "type": "string",
                "enum": list(registry.segment_type_keys()),
                "description": "What this depiction is, from that domain's vocabulary.",
            },
            "title": nullable_string("Title of this depiction, from the sheet."),
            "scale": nullable_string("Scale of THIS depiction, e.g. '1:100'."),
            "summary": {"type": "string", "description": "One or two sentences, in the document's language."},
            "entities": {"type": "array", "items": entity},
            "compositions": {"type": "array", "items": composition},
            "states": {"type": "array", "items": state},
            "quantities": {"type": "array", "items": quantity},
            "relations": {"type": "array", "items": relation},
            "annotations": string_array("Verbatim dimension and label strings."),
            "bbox": {
                "type": ["array", "null"],
                "items": {"type": "number"},
                "description": "Approximate [x0, y0, x1, y1] within the image, normalised 0-1.",
            },
            "source": {"type": "string", "enum": [*SOURCES, UNKNOWN]},
            "confidence": {"type": "string", "enum": [*CONFIDENCES, UNKNOWN]},
        }
    )

    document = obj(
        {
            "title": nullable_string("Project or document title from the title block."),
            "subtitle": nullable_string("Subtitle — never merged with the title."),
            "slogans": string_array("Graphic headlines — never merged with the title."),
            "author": nullable_string(""),
            "institution": nullable_string(""),
            "supervision": nullable_string(""),
            "location": nullable_string(""),
            "strategies": string_array("Stated strategies or approaches."),
            "process_steps": string_array("Ordered process or phasing steps."),
            "watermark": nullable_string("Licence/watermark text, quarantined here and nowhere else."),
            "summary": {"type": "string", "description": "ONE sentence about the whole image."},
        }
    )

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "VisualAnalysis",
        "description": (
            "Structured reading of one image: a list of depictions (segments), each read "
            "with one domain's vocabulary, plus the document-level facts printed on it."
        ),
        **obj(
            {
                "segments": {"type": "array", "items": segment, "description": "One entry per depiction."},
                "document": document,
            }
        ),
    }


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def _sketch(node: dict[str, Any], indent: int = 0) -> str:
    """A compact, readable shape derived FROM the JSON Schema.

    The prompt needs the shape, not the schema document: pasting the full
    schema in costs ~11k characters per image and repeats what the field
    descriptions already say. Deriving the sketch means there is still exactly
    one source of truth — a field added to :func:`json_schema` appears here
    without anyone remembering to add it.
    """
    pad = "  " * indent
    node_type = node.get("type")
    types = node_type if isinstance(node_type, list) else [node_type]

    if "object" in types:
        lines = ["{"]
        properties: dict[str, Any] = node.get("properties", {})
        for name, child in properties.items():
            rendered = _sketch(child, indent + 1)
            description = child.get("description", "")
            comment = f"   // {description}" if description and "\n" not in rendered else ""
            lines.append(f'{pad}  "{name}": {rendered},{comment}')
        lines.append(pad + "}")
        return "\n".join(lines)

    if "array" in types:
        return f"[{_sketch(node.get('items', {}), indent)}]"

    if node.get("enum"):
        allowed = [str(value) for value in node["enum"] if value is not None]
        suffix = "|null" if None in node["enum"] or "null" in types else ""
        return "|".join(allowed) + suffix

    base = next((t for t in types if t and t != "null"), "string")
    return f"{base}|null" if "null" in types else base


def build_prompt(registry: DomainRegistry) -> str:
    """The extraction instructions for one vocabulary.

    Rules that are ABOUT THE SCHEMA are written once, here — they are what the
    parser and the index depend on, and a domain that restated them would drift
    from them. A domain contributes only its vocabulary, when it applies, and
    its own guidance.
    """
    domain_blocks: list[str] = []
    for domain in registry.domains:
        types = "\n".join(
            f"    - {segment_type.key}: {segment_type.label}" for segment_type in domain.active_segment_types
        )
        categories = "\n".join(
            f"    - {category.key}: {category.label}" + (f" ({category.hint})" if category.hint else "")
            for category in domain.active_entity_categories
        )
        states = (
            f"\n  states: {', '.join(domain.states)}"
            if domain.states
            else "\n  states: none — leave the list empty"
        )
        guidance = "".join(f"\n  - {line}" for line in domain.guidance)
        domain_blocks.append(
            f"""### domain "{domain.id}" — {domain.label}
  Use for {domain.applies_to}.
  segment_type:
{types}
  entity categories:
{categories}
  measure: "{domain.measure_label}"{states}{guidance}"""
        )

    domains_text = "\n\n".join(domain_blocks)
    schema_text = _sketch(json_schema(registry))

    return f"""You are reading ONE image taken from an uploaded document. It may be a \
rendered page, a picture embedded in a PDF, or an uploaded image file.

Work in two steps.
1. LOOK: find every distinct depiction in the image. A single sheet often \
carries several — a plan, a section, a detail, a legend, a photograph, a chart.
2. RECORD: return ONE JSON object matching the schema below. No text before or \
after it, and no markdown fences.

Rules:
- One entry in "segments" per depiction. If the image shows only one thing, \
return exactly one segment.
- Choose the "domain" that fits each depiction, and take its "segment_type" and \
its entity "category" values from THAT domain's vocabulary below. Different \
segments of the same image may use different domains.
- "scale" belongs to the segment, not to the image.
- "bbox" is the approximate position of the depiction within the image as \
[x0, y0, x1, y1], normalised 0-1 with (0,0) at the top left; null when unsure.
- Never record a number without its meaning: every figure goes into \
"quantities" as object + property + value + unit. "71" alone is useless; \
{{"object": "existing fabric retained", "property": "share", "value": "71", "unit": "%"}} is not.
- Record relationships as triples in "relations", for example \
{{"subject": "ramp", "relation": "connects", "object": "courtyard level and roof landscape"}}.
- Record layered build-ups in "compositions", layers in order, with material, \
thickness and function.
- "source" says how you know: "text" when it is written on the image, "visual" \
when you read it from the depiction, "inferred" when you concluded it. \
"confidence" is high, medium or low. Never present an inference as certain.
- Put licence or watermark text (for example "VECTORWORKS EDUCATIONAL VERSION") \
in "document.watermark" and nowhere else. Never let it reach a summary.
- Unknown fields: null, or an empty list. Invent nothing.
- Write free text (summaries, titles, names) in the LANGUAGE OF THE DOCUMENT, \
not in English.

## Domain vocabularies

{domains_text}

## Shape

{schema_text}"""


# ---------------------------------------------------------------------------
# Normalisation helpers (lenient by design — model JSON is best-effort)
# ---------------------------------------------------------------------------


def _clip(value: Any, limit: int = _MAX_STR) -> str | None:
    """Coerce to a stripped, length-capped string; None for empty/non-scalars."""
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        # A model that answers with a comma-joined string instead of a list
        # still carries signal — split rather than drop.
        single = _clip(value)
        return [part.strip() for part in single.split(",") if part.strip()][:_MAX_LIST_ITEMS] if single else []
    out: list[str] = []
    for item in value[:_MAX_LIST_ITEMS]:
        text = _clip(item)
        if text:
            out.append(text)
    return out


def _term(value: Any, allowed: frozenset[str]) -> str | None:
    """A vocabulary term, or ``None``.

    Strings only: a numeric ``category`` is not a category, and coercing it
    would put "42" where a term belongs.
    """
    if not isinstance(value, str):
        return None
    slug = value.strip().lower()
    return slug if slug in allowed else None


def _dict_list(value: Any, normalise_item) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for item in value[:_MAX_LIST_ITEMS]:
        if not isinstance(item, dict):
            continue
        normalised = normalise_item(item)
        if normalised:
            out.append(normalised)
    return out


def _normalise_entity(item: dict[str, Any], domain: Domain) -> dict[str, Any] | None:
    name = _clip(item.get("name"), 300)
    if not name:
        return None
    # This is where the domain-conditional check lives that the JSON Schema
    # cannot express. An unknown category is filed as "other" rather than
    # dropped: the thing WAS recognised, and losing it because the model
    # coined a word is the worse failure.
    category = _term(item.get("category"), domain.category_keys) or "other"
    return {
        "name": name,
        "category": category,
        "role": _clip(item.get("role"), 300),
        "measure": _clip(item.get("measure"), 100),
    }


def _normalise_layer(item: dict[str, Any]) -> dict[str, Any] | None:
    material = _clip(item.get("material"), 300)
    if not material:
        return None
    return {
        "material": material,
        "thickness": _clip(item.get("thickness"), 100),
        "function": _clip(item.get("function"), 300),
    }


def _normalise_composition(item: dict[str, Any]) -> dict[str, Any] | None:
    component = _clip(item.get("component"), 300)
    layers = _dict_list(item.get("layers"), _normalise_layer)
    if not component and not layers:
        return None
    return {"component": component or "component", "layers": layers}


def _normalise_state(item: dict[str, Any], domain: Domain) -> dict[str, Any] | None:
    element = _clip(item.get("element"), 300)
    state = _term(item.get("state"), frozenset(domain.states))
    if not element or not state:
        return None
    return {"element": element, "state": state}


def _normalise_quantity(item: dict[str, Any]) -> dict[str, Any] | None:
    value = _clip(item.get("value"), 100)
    obj = _clip(item.get("object"), 300)
    if not value or not obj:
        # A bare number with no object is exactly the "71 %" failure the
        # schema exists to prevent — drop it rather than index it.
        return None
    return {
        "object": obj,
        "property": _clip(item.get("property"), 300) or "value",
        "value": value,
        "unit": _clip(item.get("unit"), 60),
        "source": _term(item.get("source"), _SOURCE_SET),
        "confidence": _term(item.get("confidence"), _CONFIDENCE_SET),
    }


def _normalise_relation(item: dict[str, Any]) -> dict[str, Any] | None:
    subject = _clip(item.get("subject"), 300)
    relation = _clip(item.get("relation"), 300)
    obj = _clip(item.get("object"), 300)
    if not (subject and relation and obj):
        return None
    return {"subject": subject, "relation": relation, "object": obj}


def _normalise_bbox(value: Any) -> list[float] | None:
    """Normalised ``[x0, y0, x1, y1]`` clamped to 0-1, or ``None``.

    Groundwork for the crop-per-view stage: approximate by nature, so anything
    malformed, degenerate or out-of-order is dropped rather than repaired into
    a wrong-but-plausible box.
    """
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        coords = [min(1.0, max(0.0, float(part))) for part in value]
    except (TypeError, ValueError):
        return None
    x0, y0, x1, y1 = coords
    if x1 <= x0 or y1 <= y0:
        return None
    return [round(part, 4) for part in coords]


def _normalise_segment(raw: Any, registry: DomainRegistry) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    domain = registry.get(_term(raw.get("domain"), frozenset(registry.domain_ids)))
    segment_type = _term(raw.get("segment_type"), domain.segment_type_keys)
    if segment_type is None:
        # The type named is not one this domain has. Rather than guess a
        # domain that does have it — which would silently re-file the segment
        # under a vocabulary the model did not choose — fall back to "other"
        # within the domain it did choose.
        segment_type = "other" if "other" in domain.segment_type_keys else domain.segment_types[0].key

    segment = {
        "domain": domain.id,
        "segment_type": segment_type,
        "title": _clip(raw.get("title"), 300),
        "scale": _clip(raw.get("scale"), 100),
        "summary": _clip(raw.get("summary")) or "",
        "entities": _dict_list(raw.get("entities"), lambda item: _normalise_entity(item, domain)),
        "compositions": _dict_list(raw.get("compositions"), _normalise_composition),
        "states": _dict_list(raw.get("states"), lambda item: _normalise_state(item, domain)),
        "quantities": _dict_list(raw.get("quantities"), _normalise_quantity),
        "relations": _dict_list(raw.get("relations"), _normalise_relation),
        "annotations": _str_list(raw.get("annotations")),
        "bbox": _normalise_bbox(raw.get("bbox")),
        "source": _term(raw.get("source"), _SOURCE_SET),
        "confidence": _term(raw.get("confidence"), _CONFIDENCE_SET),
    }
    # A segment that carries nothing at all is model noise, not a depiction.
    has_content = any(
        segment[key]
        for key in ("title", "scale", "summary", "entities", "compositions", "quantities", "annotations")
    )
    if segment["segment_type"] == "other" and not has_content:
        return None
    return segment


def _normalise_document(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "title": _clip(raw.get("title"), 300),
        "subtitle": _clip(raw.get("subtitle"), 300),
        "slogans": _str_list(raw.get("slogans")),
        "author": _clip(raw.get("author"), 300),
        "institution": _clip(raw.get("institution"), 300),
        "supervision": _clip(raw.get("supervision"), 300),
        "location": _clip(raw.get("location"), 300),
        "strategies": _str_list(raw.get("strategies")),
        "process_steps": _str_list(raw.get("process_steps")),
        "watermark": _clip(raw.get("watermark"), 300),
        "summary": _clip(raw.get("summary"), 600) or "",
    }


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)


def parse_visual_analysis(reply: str | None, registry: DomainRegistry | None = None) -> dict[str, Any] | None:
    """Parse a model reply into the canonical v4 analysis, or ``None``.

    Lenient the way the whole pipeline is lenient: markdown fences are
    stripped, prose around the outermost ``{...}`` is ignored, unknown keys are
    dropped, vocabulary terms are validated against the segment's own domain,
    and list and string sizes are capped. ``None`` (not an exception) for
    anything that does not contain a JSON object with at least one usable
    segment — the caller then falls back to the legacy line parser.
    """
    registry = registry or resolve_registry()
    if not reply:
        return None
    text = _FENCE_RE.sub("", reply.strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        raw = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None

    raw_segments = raw.get("segments")
    segments: list[dict[str, Any]] = []
    if isinstance(raw_segments, list):
        for item in raw_segments[:_MAX_SEGMENTS]:
            segment = _normalise_segment(item, registry)
            if segment:
                segments.append(segment)
    if not segments:
        return None
    return {
        "schema_version": SCHEMA_VERSION,
        "registry": registry.fingerprint,
        "segments": segments,
        "document": _normalise_document(raw.get("document")),
    }


def content_type_for(analysis: dict[str, Any], registry: DomainRegistry | None = None) -> str:
    """The chunk ``content_type`` this analysis describes.

    One rule for every visual, whatever it came from and whichever domains read
    it: each segment's role comes from its own domain, and precedence picks one
    for the image — so a plan sheet carrying a chart is still typed a drawing.
    """
    registry = registry or resolve_registry()
    return registry.content_type_for(analysis.get("segments") or [])


# ---------------------------------------------------------------------------
# Legacy-field mapping (flat dict, so every pre-schema consumer keeps working)
# ---------------------------------------------------------------------------


def legacy_fields(analysis: dict[str, Any]) -> dict[str, str]:
    """Flatten an analysis into the flat field dict older consumers read.

    ``_summary_from_drawing_fields``, the chunk metadata (``drawing_type``,
    ``drawing_scale``) and every test written against the line format read this
    shape; the mapping keeps them working while the granular data travels
    alongside. Only non-empty values are emitted.
    """
    segments = analysis.get("segments") or []
    document = analysis.get("document") or {}
    out: dict[str, str] = {}

    types = list(dict.fromkeys(segment["segment_type"] for segment in segments))
    if types:
        out["drawing_type"] = ", ".join(types)
    scales = list(dict.fromkeys(s["scale"] for s in segments if s.get("scale")))
    if scales:
        out["scale"] = ", ".join(scales)
    if document.get("title"):
        out["title"] = document["title"]

    entities = [entity for segment in segments for entity in segment.get("entities") or []]
    names = list(dict.fromkeys(entity["name"] for entity in entities))
    if names:
        out["elements"] = ", ".join(names[:25])
    roles = list(dict.fromkeys(entity["role"] for entity in entities if entity.get("role")))
    if roles:
        out["use"] = ", ".join(roles[:10])
    materials = list(dict.fromkeys(e["name"] for e in entities if e["category"] == "material"))
    if materials:
        out["materials"] = ", ".join(materials[:15])

    dims = [
        f"{q['object']} {q['property']}: {q['value']}{' ' + q['unit'] if q.get('unit') else ''}"
        for segment in segments
        for q in segment.get("quantities") or []
    ]
    if dims:
        out["dimensions"] = "; ".join(dims[:15])

    relations = [
        f"{r['subject']} {r['relation']} {r['object']}" for segment in segments for r in segment.get("relations") or []
    ]
    if relations:
        out["spatial_relations"] = ". ".join(relations[:10])

    details = [segment["summary"] for segment in segments if segment.get("summary")]
    if details:
        out["detail"] = " ".join(details)[:_MAX_STR]

    if document.get("watermark"):
        out["watermark"] = document["watermark"]
    if document.get("summary"):
        out["summary"] = document["summary"]
    elif details:
        out["summary"] = details[0][:600]
    return out


# ---------------------------------------------------------------------------
# Rendering (analysis → embedding-friendly text)
# ---------------------------------------------------------------------------


def render_segment_text(segment: dict[str, Any], registry: DomainRegistry | None = None) -> str:
    """Render ONE segment as structured text — the chunk body.

    The renderer decides what retrieval sees, so it states every populated
    category under its own label and keeps the free-text summary as the opening
    line. Labels come from the segment's domain, so a new domain reads in its
    own words without touching this function. The labels are English (business
    logic); the VALUES stay in the document's language, which is what a German
    query has to match.
    """
    registry = registry or resolve_registry()
    domain = registry.get(segment.get("domain"))
    labels = {category.key: category.label for category in domain.entity_categories}

    lines: list[str] = []
    header = segment["segment_type"].replace("_", " ").capitalize()
    if segment.get("title"):
        header += f" — {segment['title']}"
    if segment.get("scale"):
        header += f" ({domain.measure_label} {segment['scale']})"
    lines.append(header)
    if segment.get("summary"):
        lines.append(segment["summary"])

    # Entities grouped by category, in the domain's declared order, so the
    # rendering is stable and every line is labelled in the domain's words.
    grouped: dict[str, list[str]] = {}
    for entity in segment.get("entities") or []:
        rendered = entity["name"]
        extras = [part for part in (entity.get("role"), entity.get("measure")) if part]
        if extras:
            rendered += f" ({', '.join(extras)})"
        grouped.setdefault(entity["category"], []).append(rendered)
    for category in domain.entity_categories:
        values = grouped.get(category.key)
        if values:
            lines.append(f"{category.label}: {', '.join(values)}")
    for key, values in grouped.items():
        if key not in labels:
            lines.append(f"{key}: {', '.join(values)}")

    if segment.get("annotations"):
        lines.append(f"Annotations: {', '.join(segment['annotations'])}")

    for composition in segment.get("compositions") or []:
        layer_bits = []
        for layer in composition["layers"]:
            bit = layer["material"]
            if layer.get("thickness"):
                bit += f" {layer['thickness']}"
            if layer.get("function"):
                bit += f" ({layer['function']})"
            layer_bits.append(bit)
        rendered_layers = " | ".join(layer_bits) if layer_bits else "layers not legible"
        lines.append(f"Build-up {composition['component']}: {rendered_layers}")

    if segment.get("states"):
        state_bits = [f"{item['element']}: {item['state']}" for item in segment["states"]]
        lines.append(f"State: {', '.join(state_bits)}")

    for quantity in segment.get("quantities") or []:
        unit = f" {quantity['unit']}" if quantity.get("unit") else ""
        lines.append(f"Figure: {quantity['object']} — {quantity['property']}: {quantity['value']}{unit}")

    for relation in segment.get("relations") or []:
        lines.append(f"Relation: {relation['subject']} → {relation['relation']} → {relation['object']}")

    if segment.get("source") or segment.get("confidence"):
        bits = [
            b
            for b in (
                segment.get("source") and f"Source: {segment['source']}",
                segment.get("confidence") and f"Confidence: {segment['confidence']}",
            )
            if b
        ]
        if bits:
            lines.append(", ".join(bits))

    return "\n".join(lines)


def render_document_text(document: dict[str, Any]) -> str:
    """Render the document-level facts (title block, strategies) as text lines."""
    lines: list[str] = []
    title_bits = [part for part in (document.get("title"), document.get("subtitle")) if part]
    if title_bits:
        lines.append("Project: " + " — ".join(title_bits))
    meta_bits = [
        part
        for part in (
            document.get("author"),
            document.get("institution"),
            document.get("supervision"),
            document.get("location"),
        )
        if part
    ]
    if meta_bits:
        lines.append("Details: " + ", ".join(meta_bits))
    if document.get("slogans"):
        lines.append("Headlines: " + ", ".join(document["slogans"]))
    if document.get("strategies"):
        lines.append("Strategies: " + ", ".join(document["strategies"]))
    if document.get("process_steps"):
        lines.append("Process: " + " → ".join(document["process_steps"]))
    return "\n".join(lines)


def render_analysis_text(analysis: dict[str, Any], registry: DomainRegistry | None = None) -> str:
    """Full rendering: document facts plus every segment, blank-line separated.

    Used as the ``caption`` (document-summary input, single-segment chunk body)
    and as the human-readable body the visual-details view shows.
    """
    registry = registry or resolve_registry()
    document = analysis.get("document") or {}
    parts: list[str] = []
    if document.get("summary"):
        parts.append(document["summary"])
    document_text = render_document_text(document)
    if document_text:
        parts.append(document_text)
    for segment in analysis.get("segments") or []:
        parts.append(render_segment_text(segment, registry))
    return "\n\n".join(part for part in parts if part)


# ---------------------------------------------------------------------------
# Index payloads (analysis → one chunk per segment)
# ---------------------------------------------------------------------------


def segment_payloads(analysis: dict[str, Any], registry: DomainRegistry | None = None) -> list[dict[str, Any]]:
    """Chunk payloads for one analysed visual — ONE per segment.

    Each payload carries the text to embed, the per-segment metadata scalars
    the store can filter on, and ``drawing_data``: the segment plus document
    facts as a JSON string, so the detail view (and any later re-mapper) gets
    the full structure back without re-running the model. Chroma metadata must
    stay scalar, hence the JSON string.

    The document-level text rides on the FIRST segment only — repeating the
    title block on every chunk would let a project-name query retrieve five
    near-identical chunks from one sheet.
    """
    registry = registry or resolve_registry()
    document = analysis.get("document") or {}
    segments = analysis.get("segments") or []
    payloads: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        text = render_segment_text(segment, registry)
        if index == 0:
            lead = [part for part in (document.get("summary"), render_document_text(document)) if part]
            if lead:
                text = "\n".join(lead) + "\n\n" + text
        payloads.append(
            {
                "text": text,
                "drawing_type": segment["segment_type"],
                "drawing_scale": segment.get("scale") or "",
                "segment_index": index,
                "segment_count": len(segments),
                "drawing_data": json.dumps(
                    {
                        "schema_version": analysis.get("schema_version", SCHEMA_VERSION),
                        "registry": analysis.get("registry", registry.fingerprint),
                        "segment": segment,
                        "document": document,
                    },
                    ensure_ascii=False,
                ),
            }
        )
    return payloads
