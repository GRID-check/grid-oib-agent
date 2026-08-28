"""Structured extraction schema for architectural drawing pages (schema v2).

One module owns everything about WHAT is extracted from a rendered drawing
page and HOW that extraction becomes indexable text — and nothing about how
the VLM is called or where chunks are stored. The adapter stays the
orchestrator; this module is a pure library (prompt in, JSON out, text out)
so the extraction schema, the VLM backend, and the index layout can each be
changed without touching the others. That boundary is a stated backend
requirement: see ``docs/architecture/visual-ingestion.md``.

Why a schema at all
-------------------
The v1 drawing prompt asked for twelve ``KEY: value`` lines — one scale per
page, one comma-joined ``RÄUME/ELEMENTE`` bag, everything else prose. The
VLM demonstrably *recognises* far more than that (assemblies, structural
grids, existing-vs-new, quantified facts), and v1 threw the structure away
at the parsing step. v2 follows the extract-then-map pattern: the model is
told to first collect exhaustively, then map into a fixed JSON schema, and
the free-text summary is KEPT alongside the granular data rather than
replaced by it.

Schema v2 (canonical form, produced by :func:`parse_drawing_analysis`)::

    {
      "schema_version": 2,
      "segments": [            # one per drawing on the sheet — a sheet often
        {                      # carries a Grundriss AND a Schnitt AND details
          "segment_type": "grundriss|schnitt|ansicht|detail|lageplan|
                           perspektive|diagramm|axonometrie|sonstiges",
          "title": str|None,
          "scale": str|None,   # per SEGMENT, not per page
          "levels": [str],
          "summary": str,      # free text, kept deliberately
          "rooms": [{"name": str, "use": str|None, "area": str|None}],
          "circulation": [str],      # Treppen, Rampen, Aufzüge, Laubengänge
          "structure": [str],        # Stützen, Träger, Raster, Spannrichtung
          "envelope": [str],         # Fassade, Dach, Fenster
          "services": [str],         # Heizung, Lüftung, PV, Sonnenschutz
          "building_physics": [str], # Schallschutz, sommerlicher Wärmeschutz
          "other_elements": [str],
          "materials": [str],
          "structural_system": str|None,
          "surfaces": [str],
          "assemblies": [{"component": str,
                          "layers": [{"material": str,
                                      "thickness": str|None,
                                      "function": str|None}]}],
          "element_status": [{"element": str,
                              "status": "bestand|neu|rueckgebaut|
                                         weiterverwendet|transformiert"}],
          "quantities": [{"object": str, "property": str, "value": str,
                          "unit": str|None, "source": str|None,
                          "confidence": str|None}],
          "relations": [{"subject": str, "relation": str, "object": str}],
          "annotations": [str],      # verbatim dimension/label strings
          "bbox": [x0, y0, x1, y1]|None,  # approximate, normalised 0-1
          "source": "text|visual|inferred",
          "confidence": "high|medium|low"
        }
      ],
      "sheet": {               # title-block / sheet-level facts, once
        "project_title": str|None,
        "subtitle": str|None,
        "slogans": [str],      # graphic headlines — NEVER mixed into title
        "author": str|None, "institution": str|None,
        "supervision": str|None, "location": str|None,
        "design_strategies": [str],   # Rückbaubarkeit, Vorfertigung, …
        "process_steps": [str],       # "Abriss stoppen → transformieren → …"
        "watermark": str|None,
        "summary": str         # one-sentence free text for the whole sheet
      }
    }

Design decisions that are easy to get wrong later:

- **Quantities carry meaning.** ``71 %`` alone is worthless; every number is
  stored as object + property + value + unit ("Bausubstanz erhalten",
  "Anteil", "71", "%").
- **Provenance and confidence are first-class** on segments, quantities and
  (via the segment) relations, so a visually-guessed scale is never laundered
  into a certain fact downstream.
- **Titles and slogans are separate fields.** A poster headline is not a
  subtitle.
- **The parser is lenient and versioned.** Any VLM reply that is not valid
  v2 JSON falls back to the v1 ``KEY: value`` parser, so a weaker model (or
  an old cached caption) degrades to exactly yesterday's behaviour, never to
  a failed page.
- **``bbox`` is groundwork, not truth.** A VLM's box on a technical sheet is
  approximate; it is stored (normalised, clamped) for the future crop-per-view
  stage and for highlighting, and must never be used as a measurement.
"""

from __future__ import annotations

import json
import re
from typing import Any

#: Bump when the prompt/schema changes shape. Part of the VLM cache identity
#: (``processing.vlm_cache_key`` prompt_type) so a schema change never serves
#: captions produced under the previous schema.
SCHEMA_VERSION = 2

#: Cache identity for this prompt generation (v1 was the bare "drawing").
CACHE_PROMPT_TYPE = f"drawing:v{SCHEMA_VERSION}"

# Bounds applied during normalisation. The VLM is instructed to be complete;
# these caps keep a runaway reply from turning one chunk into megabytes.
_MAX_SEGMENTS = 12
_MAX_LIST_ITEMS = 60
_MAX_STR = 2000

_SEGMENT_TYPES = frozenset(
    {
        "grundriss",
        "schnitt",
        "ansicht",
        "detail",
        "lageplan",
        "perspektive",
        "diagramm",
        "axonometrie",
        "sonstiges",
    }
)
_ELEMENT_STATUS = frozenset({"bestand", "neu", "rueckgebaut", "weiterverwendet", "transformiert"})
_SOURCES = frozenset({"text", "visual", "inferred"})
_CONFIDENCES = frozenset({"high", "medium", "low"})

# German prompt — the corpus and its users are German-speaking, and the VLM
# reads German room labels/title blocks anyway. Instructs extract-then-map:
# phase 1 collect everything, phase 2 emit ONLY the JSON. Kept as plain text
# (not response_format=json_schema) because not every OpenAI-compatible VLM
# honours structured outputs; the parser is lenient instead.
DRAWING_ANALYSIS_PROMPT = """Du analysierst das Bild EINER PDF-Seite aus einem \
österreichischen Bauprojekt (Baurecht, OIB-Richtlinien): meist eine technische \
Zeichnung oder ein Plansatz-Blatt, oft mit MEHREREN Teilzeichnungen (z.B. \
Grundriss + Schnitt + Detail auf einem Blatt) und häufig als Vektorzeichnung \
ohne extrahierbaren Text.

Arbeite in zwei Schritten:
1. SAMMELN: Erfasse zuerst vollständig, was die Seite zeigt — jede \
Teilzeichnung einzeln, mit ihrem eigenen Maßstab.
2. ZUORDNEN: Gib das Ergebnis dann AUSSCHLIESSLICH als EIN JSON-Objekt nach \
dem Schema unten aus. Kein Text davor oder danach, keine Markdown-Zäune.

Regeln:
- Ein Eintrag in "segments" pro Teilzeichnung (Schnitt, Grundriss, Ansicht, \
Detail, Diagramm … jeweils separat). "scale" gehört zum Segment, nicht zur Seite. \
"bbox" ist die ungefähre Lage der Teilzeichnung im Bild als [x0, y0, x1, y1], \
normalisiert 0-1 (links oben = 0,0); null wenn unsicher.
- Zahlen NIE ohne Bedeutung: jede Kennzahl als Objekt+Eigenschaft+Wert+Einheit \
in "quantities" (z.B. {"object": "Bausubstanz erhalten", "property": "Anteil", \
"value": "71", "unit": "%"}).
- Räumliche Beziehungen zusätzlich als Tripel in "relations" \
(z.B. {"subject": "Rampe", "relation": "verbindet", "object": "Hofebene und Dachlandschaft"}).
- Bauteilaufbauten vollständig in "assemblies": Schichten in Reihenfolge mit \
Material, Dicke, Funktion.
- Bestand/Neu je Bauteil in "element_status" (bestand|neu|rueckgebaut|\
weiterverwendet|transformiert), nur wo erkennbar.
- "source" je Segment: "text" (explizit beschriftet), "visual" (aus der \
Zeichnung erkannt) oder "inferred" (semantisch abgeleitet); "confidence": \
high|medium|low. Unsichere Interpretationen NIE als sicher ausgeben.
- Projekttitel, Untertitel und grafische Schlagzeilen strikt trennen \
(project_title / subtitle / slogans).
- Wasserzeichen-/Lizenztext (z.B. "VECTORWORKS EDUCATIONAL VERSION") NUR in \
"sheet.watermark" nennen, nirgends sonst.
- Unbekannte Felder: null bzw. leere Liste. Erfinde nichts.
- "sheet.summary": EIN Satz zum Inhalt der Seite inkl. Maßstab, ohne Wasserzeichen.

Schema:
{
  "schema_version": 2,
  "segments": [{
    "segment_type": "grundriss|schnitt|ansicht|detail|lageplan|perspektive|diagramm|axonometrie|sonstiges",
    "title": "…"|null,
    "scale": "z.B. 1:100"|null,
    "levels": ["EG", "1.OG"],
    "summary": "1-2 Sätze Freitext",
    "rooms": [{"name": "…", "use": "…"|null, "area": "z.B. 24,5 m²"|null}],
    "circulation": ["Treppe …", "Rampe …"],
    "structure": ["Stützenraster 5,4 m", "Spannrichtung …"],
    "envelope": ["…"],
    "services": ["Wärmepumpe", "PV-Anlage", "…"],
    "building_physics": ["…"],
    "other_elements": ["…"],
    "materials": ["Stahlbeton", "Holz"],
    "structural_system": "…"|null,
    "surfaces": ["…"],
    "assemblies": [{"component": "…", "layers": [{"material": "…", "thickness": "…"|null, "function": "…"|null}]}],
    "element_status": [{"element": "…", "status": "bestand"}],
    "quantities": [{"object": "…", "property": "…", "value": "…", "unit": "…"|null,
                    "source": "text|visual|inferred"|null, "confidence": "high|medium|low"|null}],
    "relations": [{"subject": "…", "relation": "…", "object": "…"}],
    "annotations": ["wörtliche Maß-/Beschriftungstexte"],
    "bbox": [0.05, 0.1, 0.55, 0.9],
    "source": "text|visual|inferred",
    "confidence": "high|medium|low"
  }],
  "sheet": {
    "project_title": "…"|null, "subtitle": "…"|null, "slogans": ["…"],
    "author": "…"|null, "institution": "…"|null, "supervision": "…"|null, "location": "…"|null,
    "design_strategies": ["…"], "process_steps": ["…"],
    "watermark": "…"|null,
    "summary": "EIN Satz."
  }
}"""


# ---------------------------------------------------------------------------
# Normalisation helpers (lenient by design — VLM JSON is best-effort)
# ---------------------------------------------------------------------------


def _clip(value: Any, limit: int = _MAX_STR) -> str | None:
    """Coerce to a stripped, length-capped string; None for empty/non-scalars."""
    if value is None or isinstance(value, (dict, list)):
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


def _enum(value: Any, allowed: frozenset[str]) -> str | None:
    text = _clip(value, 60)
    if not text:
        return None
    slug = text.lower()
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


def _normalise_room(item: dict[str, Any]) -> dict[str, Any] | None:
    name = _clip(item.get("name"), 300)
    if not name:
        return None
    return {"name": name, "use": _clip(item.get("use"), 300), "area": _clip(item.get("area"), 100)}


def _normalise_layer(item: dict[str, Any]) -> dict[str, Any] | None:
    material = _clip(item.get("material"), 300)
    if not material:
        return None
    return {
        "material": material,
        "thickness": _clip(item.get("thickness"), 100),
        "function": _clip(item.get("function"), 300),
    }


def _normalise_assembly(item: dict[str, Any]) -> dict[str, Any] | None:
    component = _clip(item.get("component"), 300)
    layers = _dict_list(item.get("layers"), _normalise_layer)
    if not component and not layers:
        return None
    return {"component": component or "Bauteil", "layers": layers}


def _normalise_status(item: dict[str, Any]) -> dict[str, Any] | None:
    element = _clip(item.get("element"), 300)
    status = _enum(item.get("status"), _ELEMENT_STATUS)
    if not element or not status:
        return None
    return {"element": element, "status": status}


def _normalise_quantity(item: dict[str, Any]) -> dict[str, Any] | None:
    value = _clip(item.get("value"), 100)
    obj = _clip(item.get("object"), 300)
    if not value or not obj:
        # A bare number with no object is exactly the "71 %" failure the
        # schema exists to prevent — drop it rather than index it.
        return None
    return {
        "object": obj,
        "property": _clip(item.get("property"), 300) or "Wert",
        "value": value,
        "unit": _clip(item.get("unit"), 60),
        "source": _enum(item.get("source"), _SOURCES),
        "confidence": _enum(item.get("confidence"), _CONFIDENCES),
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

    Groundwork for the crop-per-view stage: approximate by nature (a VLM's box
    on a technical sheet is a guess), so anything malformed, degenerate or
    out-of-order is dropped rather than repaired into a wrong-but-plausible box.
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


def _normalise_segment(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    segment = {
        "segment_type": _enum(raw.get("segment_type"), _SEGMENT_TYPES) or "sonstiges",
        "title": _clip(raw.get("title"), 300),
        "scale": _clip(raw.get("scale"), 100),
        "levels": _str_list(raw.get("levels")),
        "summary": _clip(raw.get("summary")) or "",
        "rooms": _dict_list(raw.get("rooms"), _normalise_room),
        "circulation": _str_list(raw.get("circulation")),
        "structure": _str_list(raw.get("structure")),
        "envelope": _str_list(raw.get("envelope")),
        "services": _str_list(raw.get("services")),
        "building_physics": _str_list(raw.get("building_physics")),
        "other_elements": _str_list(raw.get("other_elements")),
        "materials": _str_list(raw.get("materials")),
        "structural_system": _clip(raw.get("structural_system"), 500),
        "surfaces": _str_list(raw.get("surfaces")),
        "assemblies": _dict_list(raw.get("assemblies"), _normalise_assembly),
        "element_status": _dict_list(raw.get("element_status"), _normalise_status),
        "quantities": _dict_list(raw.get("quantities"), _normalise_quantity),
        "relations": _dict_list(raw.get("relations"), _normalise_relation),
        "annotations": _str_list(raw.get("annotations")),
        "bbox": _normalise_bbox(raw.get("bbox")),
        "source": _enum(raw.get("source"), _SOURCES),
        "confidence": _enum(raw.get("confidence"), _CONFIDENCES),
    }
    # A segment that carries nothing at all (no type signal, no content) is
    # model noise, not a drawing.
    has_content = any(
        segment[key]
        for key in (
            "title",
            "scale",
            "summary",
            "rooms",
            "circulation",
            "structure",
            "envelope",
            "services",
            "materials",
            "other_elements",
            "annotations",
        )
    )
    if segment["segment_type"] == "sonstiges" and not has_content:
        return None
    return segment


def _normalise_sheet(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "project_title": _clip(raw.get("project_title"), 300),
        "subtitle": _clip(raw.get("subtitle"), 300),
        "slogans": _str_list(raw.get("slogans")),
        "author": _clip(raw.get("author"), 300),
        "institution": _clip(raw.get("institution"), 300),
        "supervision": _clip(raw.get("supervision"), 300),
        "location": _clip(raw.get("location"), 300),
        "design_strategies": _str_list(raw.get("design_strategies")),
        "process_steps": _str_list(raw.get("process_steps")),
        "watermark": _clip(raw.get("watermark"), 300),
        "summary": _clip(raw.get("summary"), 600) or "",
    }


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)


def parse_drawing_analysis(reply: str | None) -> dict[str, Any] | None:
    """Parse a VLM reply into the canonical v2 analysis dict, or ``None``.

    Lenient the way the whole pipeline is lenient: markdown fences are
    stripped, leading/trailing prose around the outermost ``{...}`` is
    ignored, unknown keys are dropped, enum values are normalised, list and
    string sizes are capped. ``None`` (not an exception) for anything that
    does not contain a JSON object with at least one usable segment — the
    caller then falls back to the v1 line parser.
    """
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
            segment = _normalise_segment(item)
            if segment:
                segments.append(segment)
    if not segments:
        return None
    return {"schema_version": SCHEMA_VERSION, "segments": segments, "sheet": _normalise_sheet(raw.get("sheet"))}


# ---------------------------------------------------------------------------
# Legacy-field mapping (v1 flat dict, so every existing consumer keeps working)
# ---------------------------------------------------------------------------


def legacy_fields(analysis: dict[str, Any]) -> dict[str, str]:
    """Flatten a v2 analysis into the v1 field dict.

    ``_summary_from_drawing_fields``, the chunk metadata (``drawing_type``,
    ``drawing_scale``) and every test written against v1 read this shape; the
    mapping keeps them working while the granular data travels alongside.
    Only non-empty values are emitted, exactly like the v1 parser.
    """
    segments = analysis.get("segments") or []
    sheet = analysis.get("sheet") or {}
    out: dict[str, str] = {}

    types = list(dict.fromkeys(s["segment_type"] for s in segments))
    if types:
        out["drawing_type"] = ", ".join(types)
    scales = list(dict.fromkeys(s["scale"] for s in segments if s.get("scale")))
    if scales:
        out["scale"] = ", ".join(scales)
    if sheet.get("project_title"):
        out["title"] = sheet["project_title"]

    levels = list(dict.fromkeys(level for s in segments for level in s.get("levels") or []))
    if levels:
        out["levels"] = ", ".join(levels)

    uses = list(dict.fromkeys(room["use"] for s in segments for room in s.get("rooms") or [] if room.get("use")))
    if uses:
        out["use"] = ", ".join(uses[:10])

    elements = list(
        dict.fromkeys(
            [room["name"] for s in segments for room in s.get("rooms") or []]
            + [el for s in segments for el in (s.get("circulation") or []) + (s.get("other_elements") or [])]
        )
    )
    if elements:
        out["elements"] = ", ".join(elements[:25])

    materials = list(dict.fromkeys(m for s in segments for m in s.get("materials") or []))
    systems = [s["structural_system"] for s in segments if s.get("structural_system")]
    if materials or systems:
        out["materials"] = ", ".join(list(dict.fromkeys(materials + systems))[:15])

    dims = [
        f"{q['object']} {q['property']}: {q['value']}{' ' + q['unit'] if q.get('unit') else ''}"
        for s in segments
        for q in s.get("quantities") or []
    ]
    if dims:
        out["dimensions"] = "; ".join(dims[:15])

    relations = [f"{r['subject']} {r['relation']} {r['object']}" for s in segments for r in s.get("relations") or []]
    if relations:
        out["spatial_relations"] = ". ".join(relations[:10])

    details = [s["summary"] for s in segments if s.get("summary")]
    if details:
        out["detail"] = " ".join(details)[:_MAX_STR]

    if sheet.get("watermark"):
        out["watermark"] = sheet["watermark"]
    if sheet.get("summary"):
        out["summary"] = sheet["summary"]
    elif details:
        out["summary"] = details[0][:600]
    return out


# ---------------------------------------------------------------------------
# Rendering (analysis → embedding-friendly German text)
# ---------------------------------------------------------------------------

_SECTION_LABELS: tuple[tuple[str, str], ...] = (
    ("levels", "Geschosse/Ebenen"),
    ("circulation", "Erschließung"),
    ("structure", "Tragwerk"),
    ("envelope", "Gebäudehülle"),
    ("services", "Gebäudetechnik"),
    ("building_physics", "Bauphysik"),
    ("materials", "Materialien"),
    ("surfaces", "Oberflächen"),
    ("other_elements", "Weitere Bauteile"),
    ("annotations", "Beschriftungen/Maße"),
)

_STATUS_LABELS = {
    "bestand": "Bestand",
    "neu": "neu",
    "rueckgebaut": "rückgebaut",
    "weiterverwendet": "weiterverwendet",
    "transformiert": "transformiert",
}

_SOURCE_LABELS = {"text": "expliziter Text", "visual": "visuell erkannt", "inferred": "abgeleitet"}
_CONFIDENCE_LABELS = {"high": "hoch", "medium": "mittel", "low": "niedrig"}


def render_segment_text(segment: dict[str, Any], sheet: dict[str, Any] | None = None) -> str:
    """Render ONE segment as structured German text — the chunk body.

    The renderer decides what retrieval sees, so it states every populated
    category under its own label (a query about "Wärmepumpe" or "Stützenraster"
    must hit lexically as well as semantically) and keeps the free-text
    summary as the opening line.
    """
    sheet = sheet or {}
    lines: list[str] = []
    header = segment["segment_type"].capitalize()
    if segment.get("title"):
        header += f" — {segment['title']}"
    if segment.get("scale"):
        header += f" (Maßstab {segment['scale']})"
    lines.append(header)
    if segment.get("summary"):
        lines.append(segment["summary"])

    if segment.get("rooms"):
        room_bits = []
        for room in segment["rooms"]:
            bit = room["name"]
            extras = [part for part in (room.get("use"), room.get("area")) if part]
            if extras:
                bit += f" ({', '.join(extras)})"
            room_bits.append(bit)
        lines.append(f"Räume: {', '.join(room_bits)}")

    for key, label in _SECTION_LABELS:
        values = segment.get(key) or []
        if values:
            lines.append(f"{label}: {', '.join(values)}")

    if segment.get("structural_system"):
        lines.append(f"Tragwerkssystem: {segment['structural_system']}")

    for assembly in segment.get("assemblies") or []:
        layer_bits = []
        for layer in assembly["layers"]:
            bit = layer["material"]
            if layer.get("thickness"):
                bit += f" {layer['thickness']}"
            if layer.get("function"):
                bit += f" ({layer['function']})"
            layer_bits.append(bit)
        rendered_layers = " | ".join(layer_bits) if layer_bits else "Aufbau nicht lesbar"
        lines.append(f"Bauteilaufbau {assembly['component']}: {rendered_layers}")

    if segment.get("element_status"):
        status_bits = [f"{item['element']}: {_STATUS_LABELS[item['status']]}" for item in segment["element_status"]]
        lines.append(f"Bestand/Neu: {', '.join(status_bits)}")

    for quantity in segment.get("quantities") or []:
        unit = f" {quantity['unit']}" if quantity.get("unit") else ""
        lines.append(f"Kennwert: {quantity['object']} — {quantity['property']}: {quantity['value']}{unit}")

    for relation in segment.get("relations") or []:
        lines.append(f"Beziehung: {relation['subject']} → {relation['relation']} → {relation['object']}")

    if segment.get("source") or segment.get("confidence"):
        provenance = _SOURCE_LABELS.get(segment.get("source") or "", "")
        confidence = _CONFIDENCE_LABELS.get(segment.get("confidence") or "", "")
        bits = [b for b in (provenance and f"Quelle: {provenance}", confidence and f"Konfidenz: {confidence}") if b]
        if bits:
            lines.append(", ".join(bits))

    return "\n".join(lines)


def render_sheet_text(sheet: dict[str, Any]) -> str:
    """Render the sheet-level facts (title block, strategies) as text lines."""
    lines: list[str] = []
    title_bits = [part for part in (sheet.get("project_title"), sheet.get("subtitle")) if part]
    if title_bits:
        lines.append("Projekt: " + " — ".join(title_bits))
    meta_bits = [
        part
        for part in (
            sheet.get("author"),
            sheet.get("institution"),
            sheet.get("supervision"),
            sheet.get("location"),
        )
        if part
    ]
    if meta_bits:
        lines.append("Angaben: " + ", ".join(meta_bits))
    if sheet.get("slogans"):
        lines.append("Schlagzeilen: " + ", ".join(sheet["slogans"]))
    if sheet.get("design_strategies"):
        lines.append("Entwurfsstrategien: " + ", ".join(sheet["design_strategies"]))
    if sheet.get("process_steps"):
        lines.append("Prozess: " + " → ".join(sheet["process_steps"]))
    return "\n".join(lines)


def render_analysis_text(analysis: dict[str, Any]) -> str:
    """Full-page rendering: sheet facts plus every segment, blank-line separated.

    Used as the page ``caption`` (document-summary input, single-segment chunk
    body) and as the human-readable body the visual-details view shows.
    """
    sheet = analysis.get("sheet") or {}
    parts: list[str] = []
    if sheet.get("summary"):
        parts.append(sheet["summary"])
    sheet_text = render_sheet_text(sheet)
    if sheet_text:
        parts.append(sheet_text)
    for segment in analysis.get("segments") or []:
        parts.append(render_segment_text(segment, sheet))
    return "\n\n".join(part for part in parts if part)


# ---------------------------------------------------------------------------
# Index payloads (analysis → one chunk per segment)
# ---------------------------------------------------------------------------


def segment_payloads(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """Chunk payloads for one analysed page — ONE per segment.

    Each payload carries the text to embed, the per-segment metadata scalars
    the store can filter on, and ``drawing_data``: the segment plus sheet as a
    JSON string, so the detail view (and any later re-mapper) gets the full
    structure back without re-running the VLM. Chroma metadata must stay
    scalar, hence the JSON string.

    The sheet-level text rides on the FIRST segment only — repeating the
    title block on every chunk would let a project-name query retrieve five
    near-identical chunks from one sheet.
    """
    sheet = analysis.get("sheet") or {}
    segments = analysis.get("segments") or []
    payloads: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        text = render_segment_text(segment, sheet)
        if index == 0:
            lead = [part for part in (sheet.get("summary"), render_sheet_text(sheet)) if part]
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
                        "segment": segment,
                        "sheet": sheet,
                    },
                    ensure_ascii=False,
                ),
            }
        )
    return payloads
