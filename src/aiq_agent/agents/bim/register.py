"""``ifc_query`` tool — talk to the project's BIM model, deterministically.

This is the model counterpart of ``knowledge_search``. Where that tool retrieves
text and the agent reads it, this one runs a **structured query** and the agent
reports the number it gets back. The distinction is not stylistic: "how many
external walls are on the ground floor" has one right answer, it is a
``COUNT(*)`` with a ``WHERE``, and an LLM summing forty thousand elements from
retrieved prose is a fact turned into a guess.

The tool never touches the application database. It posts to the BFF's internal
endpoint (:mod:`aiq_agent.knowledge.bim_query`), which owns the SQL, the tenant
scope and the model selection. The agent addresses models the way a person does
— by project, and by name when a project has more than one — so no UUID has to
survive a conversation.

Every answer carries a rendered ``summary`` line the agent can quote verbatim.
"""

import asyncio
import json
import logging
from typing import Any
from urllib.parse import quote

from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

VALID_OPERATIONS = {
    "overview",
    "health",
    "schedule",
    "takeoff",
    "profile",
    "types",
    "elements",
    "element",
    "properties",
    "aggregate",
    "compare",
    "compliance",
    "compliance-diff",
}

_TOOL_DESCRIPTION = (
    "Query the project's IFC/BIM model for EXACT facts about the building: element counts, "
    "rooms and their areas, storeys, property values (fire rating, U-value, load-bearing, …), "
    "materials and classifications. Use this INSTEAD of knowledge_search whenever the question "
    "is about THIS building rather than about a regulation — 'how many escape doors', 'net floor "
    "area per storey', 'which walls are external', 'what is the U-value of the windows'.\n"
    "\n"
    "An IFC model is a TREE: project → site → building → storey → elements, and rooms are "
    "IfcSpace elements sitting in a storey. 'which storey is this on' and 'which rooms are in "
    "the Erdgeschoss' are answered by that containment, not by geometry.\n"
    "\n"
    "operation:\n"
    "  'overview'   — what the model is: project/site/building names, storeys, totals, areas. "
    "Start here when you do not yet know what the model contains.\n"
    "  'health'     — the model's VALIDATION report: elements assigned to no storey, rooms "
    "with no published area, duplicated GlobalIds, missing standard property sets. Read this "
    "before making a claim about model coverage, and never present a model as complete without "
    "it.\n"
    "  'types'      — element counts per IFC type (IfcWall: 128, IfcDoor: 34, …).\n"
    "  'properties' — the model's OWN property vocabulary: which property sets exist, which "
    "properties they carry, and the values those properties actually take, with counts. "
    "ALWAYS call this before filtering on a property you have not seen — guessing a plausible "
    "property name returns zero rows, which reads like 'the building has none'.\n"
    "  'elements'   — list matching elements (name, type, storey, tag).\n"
    "  'element'    — everything about ONE element, addressed by its IFC GlobalId.\n"
    "  'schedule'   — the Raumbuch: every room with its storey, area and volume, plus the "
    "per-storey and building totals. Use for 'Flächenaufstellung', 'welche Räume', 'wie groß ist'. "
    "The totals already say how many rooms publish no area — report that too.\n"
    "  'takeoff'    — Massenermittlung: one quantity summed per element type, optionally split "
    "by material. Set 'quantity' (NetSideArea, NetVolume, …) and group_by=\"material\" for a "
    "cost-estimate breakdown. The material split matches the material NAMES the export wrote "
    "(a substring match on names like 'Beton C25/30'); it does not read the layer structure, so "
    "a wall counts once under its first material rather than per layer.\n"
    "  'profile'    — project facts the MODEL implies: storeys above/below ground, the "
    "Fluchtniveau band, the main use. These are PROPOSALS with their evidence — offer them "
    "through a project_profile_patch card for the user to confirm, never state them as settled.\n"
    "  'compliance' — run the OIB rule catalogue against the model and report, per requirement, "
    "how many elements are erfüllt / nicht erfüllt / NICHT ENTSCHEIDBAR. The third state is the "
    "important one: it means the model does not publish the value, NOT that the building fails. "
    "Each row names the exact property (e.g. Pset_WallCommon.FireRating) that would settle it — "
    "report that list, it is what the architect has to add in their CAD. Pass "
    "gebaeudeklasse and hauptnutzung from the project data when you know them; a rule that "
    "needs a fact it was not given stands down WITH its reason rather than guessing.\n"
    "  'compliance-diff' — the same catalogue over two revisions, reporting only the "
    "requirements whose STATUS MOVED. Set 'compare_with' to a substring of the OLDER file's "
    "name. This answers 'was hat sich der letzte Stand kaputt gemacht' — including a "
    "requirement that stopped being decidable because the re-export dropped a property.\n"
    "  'compare'    — what changed between TWO revisions of the same building. Set "
    "'compare_with' to a substring of the OLDER file's name; this model is the newer one. "
    "Matched by IFC GlobalId, so a re-export that renumbers everything still reports zero "
    "changes. This is the question no pair of PDFs can answer — use it for 'what changed since "
    "the last submission'.\n"
    "  'aggregate'  — count/sum/avg/min/max over the matching elements, optionally grouped by "
    "ifcType, storey, predefinedType, typeName, material or property. This is how you answer "
    "'how many' and 'how much' — never add up an element list yourself.\n"
    "\n"
    'filters (JSON object, all optional): {"ifcTypes": ["IfcWall"], "storeys": '
    '["Erdgeschoss"], "nameContains": "Flucht", "material": "Beton", "classification": '
    '"B.1.2", "properties": [{"set": "Pset_WallCommon", "name": "IsExternal", '
    '"operator": "eq", "value": true}]}. Property operators: eq, neq, contains, gt, gte, lt, '
    "lte, exists, missing. 'set' may be omitted to search every property set. Use "
    '"source": "quantity" inside a property filter to match a quantity instead.\n'
    "\n"
    "For aggregate: metric is count (default), sum, avg, min or max; sum/avg/min/max need "
    "'quantity' (e.g. NetFloorArea, NetSideArea, NetVolume). groupBy is optional.\n"
    "\n"
    "Never turn a compliance result into a statement that the building complies. The catalogue "
    "is an orientierende Prüfung over the values the model publishes, it reads no geometry, and "
    "Fluchtweglängen, Geländerhöhen und Brandabschnittsgrößen are not in it at all. Say what was "
    "checked, what was not, and what could not be decided.\n"
    "\n"
    "Report the caveat line verbatim whenever one comes back — it says which parts of the "
    "building the numbers do NOT cover, and an answer that drops it is wrong.\n"
    "\n"
    "A missing value is a fact about the EXPORT, not about the building. IFC2X3 models in "
    "particular rarely publish Qto_* quantity sets at all, so 'no NetFloorArea' on a 2X3 file "
    "usually means the exporter did not write quantities — not that the rooms have no area. "
    "Check 'overview' for the schema version and say which of the two it is rather than "
    "reporting zero.\n"
    "\n"
    "Whenever a row comes back with a 'Link:' value, LINK the element when you name it: write "
    "[Aussenwand AW 38](/app/projects/…/model?…) using that exact path. The link opens the 3D "
    "model with that element selected and highlighted, which is the difference between telling "
    "someone about a wall and showing it to them. Copy the path verbatim — never invent one.\n"
    "\n"
    "SHOW THE BUILDING, do not only describe it. A link names one element inside a sentence; a "
    "card puts the model itself in the answer. After a model query, emit the matching card with "
    "`emit_card` IN ADDITION to your prose — this is the whole reason the building was uploaded:\n"
    "  • a set of elements the user would want to SEE (all external walls in the Erdgeschoss, "
    "the doors under 80 cm, the walls a requirement fails on) → `ifc_viewer`, one highlight group "
    "per meaning. Set 'storey' to isolate a single Geschoss.\n"
    "  • a compliance run → `ifc_compliance`, listing the ids from the 'Regel <id>:' lines "
    "above. Those are the only valid rule ids; never invent one.\n"
    "  • one element the answer is really about → `ifc_element` with its GlobalId.\n"
    "  • a Raumbuch / Flächenaufstellung ('schedule') → `ifc_schedule`.\n"
    "  • a revision comparison ('compare' / 'compliance-diff') → `ifc_diff`.\n"
    "A card is an addition to the written answer, never a replacement for it.\n"
    "\n"
    "In an `ifc_viewer` highlight, give 'match' — the SAME filters object you queried with — "
    "rather than a list of ids, whenever the group is a SET. The browser re-runs the filter "
    "against the model, so all 420 external walls light up; a list has to fit in this reply, so it "
    "would highlight the handful you managed to transcribe while the legend claimed the whole set. "
    "Use 'global_ids' only for the few elements your answer names one by one, copied from the "
    "'elements' or compliance rows in THIS turn. Give exactly one of the two per group — never "
    "both.\n"
    "\n"
    "'aggregate' answers HOW MANY and returns no ids at all, which is fine: pass its filters "
    "straight into an `ifc_viewer` highlight as 'match' and the set shows without a second query. "
    "Report the aggregate's number as the count.\n"
    "\n"
    "When a compliance result comes back with a 'BCF-Export der offenen Punkte:' path, OFFER it as "
    "a link at the end of the answer — [offene Punkte als BCF](/api/projects/…/bim/checks/export?…) "
    "using that exact path. It downloads the open requirements as a BCF 2.1 file that opens in "
    "ArchiCAD, Revit, Solibri or BIMcollab with the affected elements selected, which is how the "
    "missing properties actually get authored. Copy the path verbatim. The export is ONE-WAY: "
    "nothing reads the topics back, so a resolved item shows up here only after the corrected "
    "model is re-uploaded and checked again — say that rather than implying the BCF tracks "
    "status.\n"
    "\n"
    "model_name selects one model when the project has several (a substring of the file name); "
    "leave it empty when there is only one. Report the numbers this tool returns as they are — "
    "do not recompute, round differently, or extrapolate them."
)


def _valid_gebaeudeklasse(value: int | None) -> int:
    """The Gebäudeklasse if it is one, else 0 — the single place that decides.

    OIB knows GK 1–5. A model asked for "Gebäudeklasse 9" will occasionally
    supply one, and the two consumers of this value MUST agree on what to do
    with it: the catalogue omits an invalid fact so the rules stand down with
    their reason, and the BCF link has to omit it for the same reason. Deciding
    that twice is how they came to disagree — the run happened at "no
    Gebäudeklasse given" while the download link said `gebaeudeklasse=9`, so the
    archive an architect opened was built against thresholds nobody chose.
    """
    return value if value and 1 <= value <= 5 else 0


def _element_link(
    project_id: str | None,
    filename: str | None,
    global_id: str | None,
    status: str = "info",
) -> str:
    """The in-app path that opens the model on one element.

    Mirrors `buildModelHref` in the frontend (`features/bim/lib/model-link.ts`);
    the parameter names are the contract between the two. Returns an empty
    string when anything needed is missing, so a caller can append it
    unconditionally and get nothing rather than a broken link.

    Emitted per row rather than described as a template: a model asked to
    compose a URL from a pattern will eventually compose a wrong one, and a
    link to the wrong wall is worse than no link.

    `status` colours the highlight. Every link this tool emitted was `info`
    (blue) regardless of what the row said, so a wall that FAILS a requirement
    opened in the same neutral colour as one the user merely asked to look at —
    the viewer supports `pass|fail|warning|info` and the whole set was
    collapsed to one. An unknown status falls back to `info` rather than
    reaching the URL: the frontend parser drops a highlight it cannot read, and
    a dropped highlight means the element does not light up at all.
    """
    if not project_id or not global_id:
        return ""
    tone = status if status in {"pass", "fail", "warning", "info"} else "info"
    query = f"element={quote(global_id, safe='')}&hl={tone}%3A{quote(global_id, safe='')}"
    if filename:
        query = f"model={quote(filename, safe='')}&{query}"
    return f"/app/projects/{quote(project_id, safe='')}/model?{query}"


def _bcf_link(
    project_id: str | None,
    filename: str | None,
    gebaeudeklasse: int = 0,
    hauptnutzung: str = "",
) -> str:
    """The download path for the open items as a BCF 2.1 file.

    Addressed by file NAME rather than by model id, like every other link this
    tool emits: a UUID carried through a conversation is a reliable source of
    hallucinated identifiers, and the route resolves the name within the
    project the same way `ifc_query` does.

    The facts are carried along so the archive is built against the same
    Gebäudeklasse the answer was — an export whose fire-resistance thresholds
    belong to a different building would be worse than no export.
    """
    if not project_id or not filename:
        return ""
    query = f"model={quote(filename, safe='')}"
    # Through the same gate the catalogue run went through, so the archive can
    # never carry a fact the verdicts did not use.
    valid_klasse = _valid_gebaeudeklasse(gebaeudeklasse)
    if valid_klasse:
        query = f"{query}&gebaeudeklasse={valid_klasse}"
    if hauptnutzung:
        query = f"{query}&hauptnutzung={quote(hauptnutzung, safe='')}"
    return f"/api/projects/{quote(project_id, safe='')}/bim/checks/export?{query}"


def _build_query(
    operation: str,
    filters: str,
    metric: str,
    quantity: str,
    group_by: str,
    global_id: str,
    ifc_type: str,
    limit: int,
    gebaeudeklasse: int = 0,
    hauptnutzung: str = "",
) -> dict[str, Any] | str:
    """Assemble the endpoint's query object, or return an error string.

    Kept separate from the tool body so the (error-prone) argument handling is
    unit-testable without a running frontend. The endpoint validates the result
    again with the same zod schema the UI uses — this is convenience, not a
    security boundary.
    """
    if operation not in VALID_OPERATIONS:
        return f"Error: unknown operation '{operation}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."

    if operation in {"compliance", "compliance-diff"}:
        # The rule catalogue takes project facts, not element filters. A fact
        # that was not supplied is OMITTED rather than defaulted: the rules that
        # need it stand down with their reason, which is the honest outcome.
        compliance_query: dict[str, Any] = {"op": operation}
        if _valid_gebaeudeklasse(gebaeudeklasse):
            compliance_query["gebaeudeklasse"] = _valid_gebaeudeklasse(gebaeudeklasse)
        if hauptnutzung.strip():
            compliance_query["hauptnutzung"] = hauptnutzung.strip().lower()
        return compliance_query

    parsed_filters: dict[str, Any] = {}
    if filters.strip():
        try:
            candidate = json.loads(filters)
        except json.JSONDecodeError:
            return 'Error: \'filters\' must be a JSON object, e.g. {"ifcTypes": ["IfcWall"]}.'
        if not isinstance(candidate, dict):
            return "Error: 'filters' must be a JSON object, not a list or scalar."
        parsed_filters = candidate

    if operation == "overview":
        return {"op": "overview"}
    if operation == "types":
        return {"op": "types"}
    if operation == "health":
        return {"op": "health"}
    if operation == "schedule":
        return {"op": "schedule"}
    if operation == "profile":
        return {"op": "profile"}
    if operation == "takeoff":
        return {
            "op": "takeoff",
            "quantity": quantity.strip() or "NetSideArea",
            "byMaterial": group_by.strip().lower() == "material",
            "filter": parsed_filters,
        }
    if operation == "compare":
        # `baseModelId` is deliberately absent: the endpoint resolves the other
        # revision from `compare_with`, so no UUID has to survive the turn.
        return {"op": "compare", "limit": 20000}
    if operation == "properties":
        query: dict[str, Any] = {"op": "properties"}
        if ifc_type.strip():
            query["ifcType"] = ifc_type.strip()
        return query
    if operation == "element":
        if not global_id.strip():
            return "Error: operation 'element' needs a global_id (the element's IFC GlobalId)."
        return {"op": "element", "globalId": global_id.strip()}
    if operation == "elements":
        return {"op": "elements", "filter": parsed_filters, "limit": max(1, min(limit, 200)), "offset": 0}

    aggregate: dict[str, Any] = {
        "op": "aggregate",
        "filter": parsed_filters,
        "metric": (metric or "count").strip().lower(),
        "limit": max(1, min(limit, 200)),
    }
    if aggregate["metric"] not in {"count", "sum", "avg", "min", "max"}:
        return "Error: metric must be one of count, sum, avg, min, max."
    if aggregate["metric"] != "count":
        if not quantity.strip():
            return f"Error: metric '{aggregate['metric']}' needs a 'quantity' (e.g. NetFloorArea)."
        aggregate["quantity"] = quantity.strip()
    if group_by.strip():
        aggregate["groupBy"] = group_by.strip()
    return aggregate


def _entry_label(entry: dict[str, Any], storey: bool = True) -> str:
    """`IfcWall „Aussenwand Nord“ · Erdgeschoss` — one comparison row, named."""
    label = f"{entry.get('ifcType')} „{entry.get('name') or entry.get('globalId')}“"
    return f"{label} · {entry.get('storeyName') or '—'}" if storey else label


def _render(
    result: dict[str, Any],
    project_id: str | None = None,
    gebaeudeklasse: int = 0,
    hauptnutzung: str = "",
) -> str:
    """Turn the endpoint's body into the string the model reads.

    Deliberately compact. The `summary` line is the answer; the structured
    payload follows only where it adds something the summary cannot carry (a
    property vocabulary, an element list), and it is trimmed so a broad query
    cannot flood the context window with forty thousand element names.
    """
    if not result.get("resolved"):
        message = result.get("message") or "Das Modell konnte nicht abgefragt werden."
        models = result.get("models") or []
        if models:
            listed = ", ".join(
                f"{m.get('filename')} ({m.get('status')}, {m.get('elements', 0)} Bauteile)" for m in models[:10]
            )
            return f"{message} Verfügbare Modelle: {listed}."
        return str(message)

    lines: list[str] = []
    model = result.get("model") or {}
    filename = model.get("filename")
    if filename:
        lines.append(f"Modell: {filename}")
    lines.append(str(result.get("summary") or ""))

    # The caveat is appended for every op whose numbers the model's structural
    # defects distort. It is NOT optional colour: a storey breakdown over a
    # model with unplaced elements is a subset presented as a total, and this
    # line is the only thing that stops the agent reporting it as one.
    caveat = result.get("caveat")
    if caveat:
        lines.append(str(caveat))

    op = result.get("op")
    if op == "overview" and isinstance(result.get("overview"), dict):
        overview = result["overview"]
        storeys = overview.get("storeys") or []
        if storeys:
            rendered = ", ".join(f"{s.get('name') or '—'} ({s.get('elementCount', 0)} Bauteile)" for s in storeys[:20])
            lines.append(f"Geschosse: {rendered}")
        type_counts = overview.get("typeCounts") or {}
        if type_counts:
            top = list(type_counts.items())[:15]
            lines.append("Bauteiltypen: " + ", ".join(f"{name} ({count})" for name, count in top))
    elif op == "elements":
        for element in (result.get("elements") or [])[:50]:
            label = element.get("name") or element.get("tag") or element.get("globalId")
            storey = element.get("storeyName") or "—"
            link = _element_link(project_id, filename, element.get("globalId"))
            suffix = f" · Link: {link}" if link else ""
            lines.append(
                f"- {element.get('ifcType')} „{label}“ · {storey} · GlobalId {element.get('globalId')}{suffix}"
            )
    elif op == "element" and isinstance(result.get("element"), dict):
        element = result["element"]
        lines.append(f"GlobalId: {element.get('globalId')}")
        link = _element_link(project_id, filename, element.get("globalId"))
        if link:
            lines.append(f"Link: {link}")
        if element.get("storeyName"):
            lines.append(f"Geschoss: {element['storeyName']}")
        if element.get("materials"):
            lines.append("Materialien: " + ", ".join(element["materials"]))
        for set_name, properties in (element.get("properties") or {}).items():
            rendered = ", ".join(f"{key}={value}" for key, value in properties.items())
            lines.append(f"{set_name}: {rendered}")
        for set_name, quantities in (element.get("quantities") or {}).items():
            rendered = ", ".join(f"{key}={value}" for key, value in quantities.items())
            lines.append(f"{set_name}: {rendered}")
    elif op == "schedule" and isinstance(result.get("schedule"), dict):
        schedule = result["schedule"]
        area_unit = (schedule.get("units") or {}).get("area", "m²")
        for storey in (schedule.get("storeys") or [])[:12]:
            lines.append(
                f"{storey.get('storeyName')}: {storey.get('netFloorArea')} {area_unit} "
                f"({len(storey.get('rooms') or [])} Räume)"
            )
            for room in (storey.get("rooms") or [])[:30]:
                area = room.get("netFloorArea")
                lines.append(f"  · {room.get('name')} — {area if area is not None else 'ohne Fläche'}")
    elif op == "takeoff":
        for row in (result.get("takeoff") or [])[:40]:
            missing = f", {row.get('missing')} ohne Wert" if row.get("missing") else ""
            lines.append(f"- {row.get('group')}: {row.get('value')} ({row.get('elements')} Bauteile{missing})")
    elif op in {"compliance", "compliance-diff"}:
        # The endpoint already renders the German verdict lines into `summary`;
        # what the model needs on top is the shopping list, because that is the
        # part it must hand back to the architect as actions.
        for entry in (result.get("complianceShoppingList") or [])[:15]:
            rules = ", ".join(entry.get("rules") or [])
            lines.append(f"- fehlt: {entry.get('path')} an {entry.get('elements')} Bauteilen (entscheidet: {rules})")
        for rule in (result.get("compliance") or [])[:40]:
            # The rule id, printed for every rule that left work behind.
            #
            # `ifc_compliance` asks for "rule ids from ifc_query
            # operation='compliance'" and this renderer never printed one
            # except inside the shopping list's `entscheidet:` clause — which
            # only covers rules with a MISSING property. For a rule that
            # cleanly fails, the agent had no valid id to put in the card, so
            # it either invented one (rendered as unresolved) or sent none.
            rule_id = rule.get("ruleId")
            failed = int(rule.get("failed") or 0)
            undecidable = int(rule.get("undecidable") or 0)
            if rule_id and (failed or undecidable):
                lines.append(
                    f"- Regel {rule_id}: {rule.get('titleDe')} — {failed} nicht erfüllt, "
                    f"{undecidable} nicht entscheidbar"
                )
            for verdict in (rule.get("failures") or [])[:10]:
                # A breach opens RED. This is the one place the tool knows the
                # verdict at link time, and it used to throw it away.
                link = _element_link(project_id, filename, verdict.get("globalId"), "fail")
                suffix = f" · Link: {link}" if link else ""
                lines.append(
                    f"  ✗ {rule.get('richtlinie')} {verdict.get('name') or verdict.get('globalId')}: "
                    f"{verdict.get('reading')}{suffix}"
                )
        # The list of open items is the answer; this is what the architect DOES
        # with it. Emitted as a path rather than described as a template, for
        # the same reason the element links are.
        bcf = _bcf_link(project_id, filename, gebaeudeklasse, hauptnutzung)
        if bcf:
            lines.append(f"BCF-Export der offenen Punkte: {bcf}")

    elif op == "profile":
        for suggestion in result.get("profileSuggestions") or []:
            lines.append(
                f"- {suggestion.get('key')} = {suggestion.get('value')} "
                f"[{suggestion.get('confidence')}] — {suggestion.get('evidence')}"
            )
    elif op == "compare" and isinstance(result.get("comparison"), dict):
        comparison = result["comparison"]
        for entry in (comparison.get("added") or [])[:25]:
            lines.append(f"+ {_entry_label(entry)}")
        for entry in (comparison.get("removed") or [])[:25]:
            lines.append(f"- {_entry_label(entry)}")
        for entry in (comparison.get("changed") or [])[:25]:
            deltas = "; ".join(
                f"{change.get('field')}: {change.get('before')} → {change.get('after')}"
                for change in (entry.get("changes") or [])[:6]
            )
            lines.append(f"~ {_entry_label(entry, storey=False)} — {deltas}")
    elif op == "properties":
        for entry in (result.get("properties") or [])[:60]:
            values = ", ".join(f"{v.get('value')} ({v.get('elements')}×)" for v in (entry.get("values") or [])[:6])
            kind = "Menge" if entry.get("source") == "quantity" else "Merkmal"
            lines.append(f"- [{kind}] {entry.get('set')}.{entry.get('name')}: {values}")

    if result.get("truncated"):
        lines.append("(Weitere Treffer vorhanden — Abfrage eingrenzen oder aggregieren.)")
    return "\n".join(line for line in lines if line)


def _trace(query: dict[str, Any], result: dict[str, Any] | None, *, unavailable: bool = False) -> None:
    """Tell Langfuse what this call did, since the BFF cannot (ADR-0045).

    Everything expensive in a research turn is traced span by span in the agent
    process. This tool is the exception: the parse, the SQL and the rule
    catalogue all run in the BFF, which exports OTel logs and no traces, so the
    span Langfuse receives is opaque — a duration and a rendered German string.
    An operator asked why an answer was slow, or why it said a building has no
    fire-rated walls, can recover none of the four things that would explain it.

    So the four things go on the trace: which operation, which model, whether
    the model could be resolved at all, and whether the answer covered the
    WHOLE building. The last is the one that matters for correctness rather
    than for speed — a truncated or sampled result is a subset presented as a
    total, and a trace that does not record it cannot be used to audit an
    answer after the fact.

    No element names, no property values: this is the shape of the query, not
    its contents, which are already in `output.value` under the redaction
    policy that governs it.
    """
    from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
    from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

    # One tag for "this turn read a building model", which is the filter an
    # operator reaches for first; the per-call detail goes in metadata.
    add_trace_tag("feature:ifc")

    operation = str(query.get("op", "unknown"))
    if unavailable:
        record_trace_metadata(ifc_op=operation, ifc_outcome="service_unavailable")
        return
    if not (result or {}).get("resolved"):
        record_trace_metadata(
            ifc_op=operation,
            ifc_outcome=f"unresolved:{(result or {}).get('reason', 'unknown')}",
        )
        return

    model = (result or {}).get("model") or {}
    scan = (result or {}).get("propertyScan") or {}
    record_trace_metadata(
        ifc_op=operation,
        ifc_outcome="resolved",
        ifc_model=model.get("filename"),
        ifc_elements=model.get("elementCount"),
        # The honesty flags, verbatim from the payload. `truncated` means the
        # answer covers part of the building; `propertyScan.complete=false`
        # means the property catalogue was built from a sample.
        ifc_truncated=bool((result or {}).get("truncated")) or None,
        ifc_total_is_lower_bound=bool((result or {}).get("totalIsLowerBound")) or None,
        ifc_catalog_sampled=(False if scan.get("complete") else True) if scan else None,
    )


class IfcQueryConfig(FunctionBaseConfig, name="ifc_query"):
    """Configuration for the ``ifc_query`` BIM tool."""

    default_limit: int = Field(default=25, description="Rows returned by 'elements' when none is given.")


@register_function(config_type=IfcQueryConfig)
async def ifc_query(tool_config: IfcQueryConfig, builder: Builder):
    from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
    from aiq_agent.knowledge.bim_query import run_bim_query
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context

    async def _ifc_query(
        operation: str = "overview",
        filters: str = "",
        metric: str = "count",
        quantity: str = "",
        group_by: str = "",
        global_id: str = "",
        ifc_type: str = "",
        model_name: str = "",
        compare_with: str = "",
        gebaeudeklasse: int = 0,
        hauptnutzung: str = "",
        limit: int = 0,
    ) -> str:
        """Query the project's IFC/BIM model for exact building facts."""
        organization_id = get_organization_id_from_context()
        if not organization_id:
            return "Error: organization unknown for this session — the BIM model cannot be queried. Do not retry."
        project_id = get_project_id_from_context()

        query = _build_query(
            operation=(operation or "overview").strip().lower(),
            filters=filters or "",
            metric=metric or "count",
            quantity=quantity or "",
            group_by=group_by or "",
            global_id=global_id or "",
            ifc_type=ifc_type or "",
            limit=limit if limit and limit > 0 else tool_config.default_limit,
            gebaeudeklasse=gebaeudeklasse or 0,
            hauptnutzung=hauptnutzung or "",
        )
        if isinstance(query, str):
            return query

        try:
            result = await asyncio.to_thread(
                run_bim_query,
                organization_id=organization_id,
                project_id=project_id,
                query=query,
                model_name=(model_name or "").strip() or None,
                compare_with_name=(compare_with or "").strip() or None,
            )
        except BimQueryUnavailableError:
            # "Could not look" is not "looked and found nothing" — say so, or the
            # user reads a transport failure as a fact about their building.
            logger.warning("ifc_query could not reach the BIM endpoint")
            _trace(query, None, unavailable=True)
            return (
                "Error: the BIM model could not be queried right now (the model service is "
                "unavailable). Do NOT state anything about the building's contents; tell the user "
                "the model could not be read."
            )

        _trace(query, result)
        return _render(result, project_id, gebaeudeklasse or 0, (hauptnutzung or "").strip().lower())

    yield FunctionInfo.from_fn(_ifc_query, description=_TOOL_DESCRIPTION)
