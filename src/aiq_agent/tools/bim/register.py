"""``ifc_query`` tool — the project's BIM model, queried deterministically.

The model counterpart of ``knowledge_search``: a structured query against the
extracted index, run by the BFF's internal endpoint
(:mod:`aiq_agent.knowledge.bim_query`), rendered as the German lines the agent
quotes. Models are addressed by project and file name, never by UUID. The
defects each rule here answers are catalogued in
``docs/roadmap/ifc-review-findings.md``.
"""

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel
from pydantic import Field

from aiq_agent.knowledge.bim_query import run_bim_query
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.project_context import get_project_id_from_context
from aiq_agent.tools.bim.failures import NO_ORG_TEXT
from aiq_agent.tools.bim.failures import NO_PROJECT_TEXT
from aiq_agent.tools.bim.failures import QUERY_FAILURES
from aiq_agent.tools.bim.rendering import clipped
from aiq_agent.tools.bim.rendering import listed
from aiq_agent.tools.bim.rendering import render_unresolved
from aiq_agent.tools.bim.trace import model_handle
from aiq_agent.tools.bim.trace import record_ifc_call
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

__all__ = ["NO_PROJECT_TEXT", "VALID_OPERATIONS", "IfcQueryConfig", "IfcQueryInput", "ifc_query"]

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
    "needs a fact it was not given stands down WITH its reason rather than guessing. "
    "hauptnutzung must be one of wohnen, buero, beherbergung, versammlung, gesundheit, "
    "landwirtschaft, produzierend, lager, sonstiges — anything else makes rules stand down as "
    "'not applicable', which reads as a verdict and is not one. gebaeudeklasse is 1-5.\n"
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
    "ifcType, storey, predefinedType, typeName or material. This is how you answer "
    "'how many' and 'how much' — never add up an element list yourself.\n"
    "\n"
    'filters (JSON object, all optional): {"ifcTypes": ["IfcWall"], "storeys": '
    '["Erdgeschoss"], "nameContains": "Flucht", "material": "Beton", "classification": '
    '"B.1.2", "properties": [{"set": "Pset_WallCommon", "name": "IsExternal", '
    '"operator": "eq", "value": true}]}. Property operators: eq, neq, contains, gt, gte, lt, '
    "lte, exists, missing. 'set' may be omitted to search every property set. Use "
    '"source": "quantity" inside a property filter to match a quantity instead.\n'
    "\n"
    "STOREY NAMES are matched exactly, and exports name storeys whatever the modeller typed — "
    "'EG', '00 Erdgeschoss', 'Level 0', 'Niveau 0'. Call 'overview' first and copy the storey "
    "names it returns verbatim; a name that is not in that list matches nothing, and an empty "
    "result reads like 'the ground floor has no walls'. The same warning as for property names, "
    "for the same reason.\n"
    "\n"
    "Every filter key is validated. An unknown key is REJECTED, not ignored — if the tool says a "
    "key was not recognised, fix the spelling and call again rather than reporting the result of "
    "a query that never ran. Only 'elements', 'aggregate' and 'takeoff' take filters at all; the "
    "rest read the whole model and refuse one rather than quietly answering a wider question.\n"
    "\n"
    "If a result says its figures cover only PART of the model, say so in the answer. Those are "
    "not the building's totals and must not be presented as such.\n"
    "\n"
    "For aggregate: metric is count (default), sum, avg, min or max; sum/avg/min/max need "
    "'quantity' (e.g. NetFloorArea, NetSideArea, NetVolume). groupBy is optional. sum and avg "
    "SKIP elements that do not publish the quantity, and the summary says so as 'über X von Y "
    "Bauteilen' — report both numbers, because the gap between them is a fact about the export "
    "the architect needs.\n"
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
    "Whenever a row comes back with a 'Link:' value, the path is data: copy it verbatim if you "
    "name that element in a sentence. Never invent a path.\n"
    "\n"
    "How a query becomes a card is `ifc-spatial-reasoning`, not this description. Load that "
    "skill before emitting a model card. Highlight a set with the same filter that found it, "
    "rather than a list of ids. A highlight group takes exactly one of the two per group.\n"
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


# The Hauptnutzung values the rule catalogue knows — mirroring
# `BIM_HAUPTNUTZUNG` in `lib/bim/query.ts`, whose zod enum rejects anything
# else outright.
_HAUPTNUTZUNGEN = frozenset(
    {
        "wohnen",
        "buero",
        "beherbergung",
        "versammlung",
        "gesundheit",
        "landwirtschaft",
        "produzierend",
        "lager",
        "sonstiges",
    }
)


def _valid_hauptnutzung(value: str) -> str:
    """The Hauptnutzung if the catalogue knows it, else "" — see below.

    The tool description says an unrecognised value makes the rules that need
    it "stand down as not applicable". It did not: the value went into a
    `.strict()` object whose field is an enum, so `"wohngebäude"` produced a
    400 and the whole compliance run failed — on a value the description
    presents as merely imprecise. Its sibling `_valid_gebaeudeklasse` is
    sanitised here for exactly this reason; this one was not.
    """
    lowered = value.strip().lower()
    return lowered if lowered in _HAUPTNUTZUNGEN else ""


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
    # `None` as well as an out-of-range int: `_valid_gebaeudeklasse` is the one
    # place that decides what an impossible value means, and the annotation
    # should admit what callers actually pass it.
    gebaeudeklasse: int | None = 0,
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


class IfcQueryInput(BaseModel):
    """The arguments of one ``ifc_query`` call. Every default is written here and nowhere else."""

    operation: str = "overview"
    filters: str = ""
    metric: str = "count"
    quantity: str = ""
    group_by: str = ""
    global_id: str = ""
    ifc_type: str = ""
    model_name: str = ""
    compare_with: str = ""
    gebaeudeklasse: int = 0
    hauptnutzung: str = ""
    limit: int = 0


# ── building the query ───────────────────────────────────────────────────────

#: Operations that need nothing beyond their name.
_BARE_OPS = frozenset({"overview", "types", "health", "schedule", "profile"})

#: Operations that read the WHOLE model and take no element filter — with what
#: each returns, for the refusal. A filter on these used to be dropped, so
#: ``schedule`` with a storey filter returned the whole building's Raumbuch and
#: the agent presented it as one floor's. Saying no is the only answer that does
#: not put a wrong number in front of someone.
_WHOLE_MODEL_OPS = {
    "overview": "eine Zusammenfassung des ganzen Modells",
    "types": "die Typenverteilung des ganzen Modells",
    "health": "die Modellprüfung des ganzen Modells",
    "schedule": "das Raumbuch des ganzen Modells",
    "profile": "die aus dem ganzen Modell ableitbaren Projektangaben",
    "compare": "einen Vergleich zweier vollständiger Stände",
    "element": "ein einzelnes Bauteil",
    "compliance": "eine Prüfung des ganzen Modells gegen den Regelkatalog",
    "compliance-diff": "eine Prüfung beider Stände gegen den Regelkatalog",
    "properties": "den Merkmalskatalog des Modells (mit 'ifc_type' auf einen Typ einschränkbar)",
}

_METRICS = frozenset({"count", "sum", "avg", "min", "max"})


@dataclass(frozen=True)
class _QueryArgs:
    """The tool's arguments, stripped and clamped, for one query builder."""

    filters: dict[str, Any]
    metric: str
    quantity: str
    group_by: str
    global_id: str
    ifc_type: str
    limit: int
    gebaeudeklasse: int | None
    hauptnutzung: str


def _parse_filters(filters: str) -> dict[str, Any] | str:
    """The ``filters`` JSON as a dict, or the error that says why it is not one.

    Silently dropping an unparseable filter would turn "external walls on the
    ground floor" into every element in the building, confidently counted.
    """
    if not filters.strip():
        return {}
    try:
        candidate = json.loads(filters)
    except json.JSONDecodeError:
        return 'Error: \'filters\' must be a JSON object, e.g. {"ifcTypes": ["IfcWall"]}.'
    if not isinstance(candidate, dict):
        return "Error: 'filters' must be a JSON object, not a list or scalar."
    return candidate


def _compliance_query(op: str, args: _QueryArgs) -> dict[str, Any]:
    """The rule catalogue takes project facts, not element filters.

    A fact that was not supplied is OMITTED rather than defaulted: the rules
    that need it stand down with their reason, which is the honest outcome.
    """
    query: dict[str, Any] = {"op": op}
    klasse = _valid_gebaeudeklasse(args.gebaeudeklasse)
    if klasse:
        query["gebaeudeklasse"] = klasse
    nutzung = _valid_hauptnutzung(args.hauptnutzung)
    if nutzung:
        query["hauptnutzung"] = nutzung
    return query


def _takeoff_query(args: _QueryArgs) -> dict[str, Any] | str:
    """Material is the only split a Massenermittlung has; any other grouping is refused, not ignored."""
    grouping = args.group_by.lower()
    if grouping and grouping != "material":
        return (
            f"Error: operation 'takeoff' can only group by 'material', not '{args.group_by}'. "
            "Use 'aggregate' with metric='sum' to group a quantity by storey or type."
        )
    return {
        "op": "takeoff",
        "quantity": args.quantity or "NetSideArea",
        "byMaterial": grouping == "material",
        "filter": args.filters,
    }


def _properties_query(args: _QueryArgs) -> dict[str, Any]:
    query: dict[str, Any] = {"op": "properties"}
    if args.ifc_type:
        query["ifcType"] = args.ifc_type
    return query


def _element_query(args: _QueryArgs) -> dict[str, Any] | str:
    if not args.global_id:
        return "Error: operation 'element' needs a global_id (the element's IFC GlobalId)."
    return {"op": "element", "globalId": args.global_id}


def _elements_query(args: _QueryArgs) -> dict[str, Any]:
    return {"op": "elements", "filter": args.filters, "limit": args.limit, "offset": 0}


def _aggregate_query(args: _QueryArgs) -> dict[str, Any] | str:
    metric = (args.metric or "count").lower()
    if metric not in _METRICS:
        return "Error: metric must be one of count, sum, avg, min, max."
    query: dict[str, Any] = {"op": "aggregate", "filter": args.filters, "metric": metric, "limit": args.limit}
    if metric != "count" and not args.quantity:
        return f"Error: metric '{metric}' needs a 'quantity' (e.g. NetFloorArea)."
    if metric != "count":
        query["quantity"] = args.quantity
    if args.group_by.lower() == "property":
        # `property` needs a companion `groupProperty` this tool has no
        # parameter for, so the endpoint would reject it every time.
        return (
            "Error: group_by='property' is not available through this tool. "
            "Use operation='properties' to see which values a property takes and how many "
            "elements carry each, or filter on the property and count."
        )
    if args.group_by:
        query["groupBy"] = args.group_by
    return query


_QUERY_BUILDERS: dict[str, Callable[[_QueryArgs], dict[str, Any] | str]] = {
    "compliance": lambda args: _compliance_query("compliance", args),
    "compliance-diff": lambda args: _compliance_query("compliance-diff", args),
    "takeoff": _takeoff_query,
    # `baseModelId` is deliberately absent: the endpoint resolves the other
    # revision from `compare_with`, so no UUID has to survive the turn.
    "compare": lambda args: {"op": "compare", "limit": 20000},
    "properties": _properties_query,
    "element": _element_query,
    "elements": _elements_query,
    "aggregate": _aggregate_query,
}


def _build_query(
    operation: str,
    filters: str,
    metric: str,
    quantity: str,
    group_by: str,
    global_id: str,
    ifc_type: str,
    limit: int,
    gebaeudeklasse: int | None = 0,
    hauptnutzung: str = "",
) -> dict[str, Any] | str:
    """Assemble the endpoint's query object, or return an error string.

    The endpoint validates the result again with the same zod schema the UI
    uses — this is convenience, not a security boundary.
    """
    if operation not in VALID_OPERATIONS:
        return f"Error: unknown operation '{operation}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."
    parsed = _parse_filters(filters)
    if isinstance(parsed, str):
        return parsed
    if parsed and operation in _WHOLE_MODEL_OPS:
        return (
            f"Error: operation '{operation}' takes no filters — it returns {_WHOLE_MODEL_OPS[operation]}. "
            "Use 'elements' or 'aggregate' to ask a filtered question, or drop 'filters'."
        )
    if operation in _BARE_OPS:
        return {"op": operation}
    args = _QueryArgs(
        filters=parsed,
        metric=metric.strip(),
        quantity=quantity.strip(),
        group_by=group_by.strip(),
        global_id=global_id.strip(),
        ifc_type=ifc_type.strip(),
        limit=max(1, min(limit, 200)),
        gebaeudeklasse=gebaeudeklasse,
        hauptnutzung=hauptnutzung,
    )
    return _QUERY_BUILDERS[operation](args)


# ── rendering ────────────────────────────────────────────────────────────────

_clipped = clipped

_Lines = list[str | None]


@dataclass(frozen=True)
class _RenderContext:
    """What a rendered row needs beyond the payload: where its links point."""

    project_id: str | None
    filename: str | None
    gebaeudeklasse: int
    hauptnutzung: str

    def link(self, global_id: Any, status: str = "info") -> str:
        link = _element_link(self.project_id, self.filename, global_id, status)
        return f" · Link: {link}" if link else ""


def _entry_label(entry: dict[str, Any], storey: bool = True) -> str:
    """`IfcWall „Aussenwand Nord“ · Erdgeschoss` — one comparison row, named."""
    label = f"{entry.get('ifcType')} „{entry.get('name') or entry.get('globalId')}“"
    return f"{label} · {entry.get('storeyName') or '—'}" if storey else label


def _render_overview(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    overview = result.get("overview")
    if not isinstance(overview, dict):
        return []
    lines: _Lines = []
    storeys = overview.get("storeys") or []
    if storeys:
        lines.append(
            "Geschoße: "
            + ", ".join(f"{s.get('name') or '—'} ({s.get('elementCount', 0)} Bauteile)" for s in storeys[:20])
        )
        lines.append(clipped(storeys, 20, "Geschoße"))
    types = list((overview.get("typeCounts") or {}).items())
    if types:
        lines.append("Bauteiltypen: " + ", ".join(f"{name} ({count})" for name, count in types[:15]))
        lines.append(clipped(types, 15, "Bauteiltypen"))
    return lines


def _render_elements(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    def row(element: dict[str, Any]) -> str:
        label = element.get("name") or element.get("tag") or element.get("globalId")
        storey = element.get("storeyName") or "—"
        global_id = element.get("globalId")
        return f"- {element.get('ifcType')} „{label}“ · {storey} · GlobalId {global_id}{ctx.link(global_id)}"

    return listed(result.get("elements") or [], 50, "Bauteile", row)


def _render_element(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    element = result.get("element")
    if not isinstance(element, dict):
        return []
    link = _element_link(ctx.project_id, ctx.filename, element.get("globalId"))
    lines: _Lines = [f"GlobalId: {element.get('globalId')}", f"Link: {link}" if link else None]
    if element.get("storeyName"):
        lines.append(f"Geschoß: {element['storeyName']}")
    if element.get("materials"):
        lines.append("Materialien: " + ", ".join(element["materials"]))
    for group in ("properties", "quantities"):
        for set_name, values in (element.get(group) or {}).items():
            lines.append(f"{set_name}: " + ", ".join(f"{key}={value}" for key, value in values.items()))
    return lines


def _render_schedule(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    schedule = result.get("schedule")
    if not isinstance(schedule, dict):
        return []
    area_unit = (schedule.get("units") or {}).get("area", "m²")

    def room(entry: dict[str, Any]) -> str:
        area = entry.get("netFloorArea")
        return f"  · {entry.get('name')} — {area if area is not None else 'ohne Fläche'}"

    def storey(entry: dict[str, Any]) -> list[str]:
        rooms = entry.get("rooms") or []
        head = f"{entry.get('storeyName')}: {entry.get('netFloorArea')} {area_unit} ({len(rooms)} Räume)"
        return [head, *listed(rooms, 30, "Räume", room, indent="  ")]

    return listed(schedule.get("storeys") or [], 12, "Geschoße", storey)


def _render_takeoff(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    def row(entry: dict[str, Any]) -> str:
        missing = f", {entry.get('missing')} ohne Wert" if entry.get("missing") else ""
        return f"- {entry.get('group')}: {entry.get('value')} ({entry.get('elements')} Bauteile{missing})"

    return listed(result.get("takeoff") or [], 40, "Gruppen", row)


def _shopping_row(entry: dict[str, Any]) -> str:
    count = entry.get("elements")
    where = "an einem Bauteil" if count == 1 else f"an {count} Bauteilen"
    return f"- fehlt: {entry.get('path')} {where} (entscheidet: {', '.join(entry.get('rules') or [])})"


def _rule_rows(rule: dict[str, Any], ctx: _RenderContext) -> list[str]:
    """The rule id for every rule that left work behind, then its breaches, each opening RED."""

    def verdict(entry: dict[str, Any]) -> str:
        name = entry.get("name") or entry.get("globalId")
        return f"  ✗ {rule.get('richtlinie')} {name}: {entry.get('reading')}{ctx.link(entry.get('globalId'), 'fail')}"

    lines: list[str] = []
    failed = int(rule.get("failed") or 0)
    undecidable = int(rule.get("undecidable") or 0)
    if rule.get("ruleId") and (failed or undecidable):
        lines.append(
            f"- Regel {rule.get('ruleId')}: {rule.get('titleDe')} — "
            f"{failed} nicht erfüllt, {undecidable} nicht entscheidbar"
        )
    # The server list is itself capped at 25 verdicts per rule; `failed` above
    # is the real count and the clip note says the LIST is not.
    return lines + listed(rule.get("failures") or [], 10, "betroffene Bauteile", verdict, indent="  ")


def _render_compliance(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    """The verdict lines are already in `summary`; this adds the shopping list, the rule ids and the BCF export."""
    lines: _Lines = listed(result.get("complianceShoppingList") or [], 15, "fehlende Merkmale", _shopping_row)
    lines += listed(result.get("compliance") or [], 40, "Regeln", lambda rule: _rule_rows(rule, ctx))
    bcf = _bcf_link(ctx.project_id, ctx.filename, ctx.gebaeudeklasse, ctx.hauptnutzung)
    if bcf:
        lines.append(f"BCF-Export der offenen Punkte: {bcf}")
    return lines


def _render_profile(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    return [
        f"- {s.get('key')} = {s.get('value')} [{s.get('confidence')}] — {s.get('evidence')}"
        for s in result.get("profileSuggestions") or []
    ]


def _render_compare(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    comparison = result.get("comparison")
    if not isinstance(comparison, dict):
        return []

    def changed_row(entry: dict[str, Any]) -> str:
        deltas = "; ".join(
            f"{c.get('field')}: {c.get('before')} → {c.get('after')}" for c in (entry.get("changes") or [])[:6]
        )
        return f"~ {_entry_label(entry, storey=False)} — {deltas}"

    added = comparison.get("added") or []
    removed = comparison.get("removed") or []
    changed = comparison.get("changed") or []
    lines: _Lines = [f"+ {_entry_label(entry)}" for entry in added[:25]]
    lines += [f"- {_entry_label(entry)}" for entry in removed[:25]]
    lines += [changed_row(entry) for entry in changed[:25]]
    lines += [
        clipped(bucket, 25, f"{noun} Bauteile")
        for bucket, noun in ((added, "neue"), (removed, "entfallene"), (changed, "geänderte"))
    ]
    return lines


def _render_properties(result: dict[str, Any], ctx: _RenderContext) -> _Lines:
    def row(entry: dict[str, Any]) -> str:
        values = ", ".join(f"{v.get('value')} ({v.get('elements')}×)" for v in (entry.get("values") or [])[:6])
        kind = "Menge" if entry.get("source") == "quantity" else "Merkmal"
        return f"- [{kind}] {entry.get('set')}.{entry.get('name')}: {values}"

    return listed(result.get("properties") or [], 60, "Merkmale", row)


#: Per-op detail under the summary line. `health` and `aggregate` have none:
#: their summary is the whole answer.
_QUERY_RENDERERS: dict[str, Callable[[dict[str, Any], _RenderContext], _Lines]] = {
    "overview": _render_overview,
    "elements": _render_elements,
    "element": _render_element,
    "schedule": _render_schedule,
    "takeoff": _render_takeoff,
    "compliance": _render_compliance,
    "compliance-diff": _render_compliance,
    "profile": _render_profile,
    "compare": _render_compare,
    "properties": _render_properties,
}

#: Ops whose `truncated` means "these figures cover part of the building", not
#: "there are more rows to page through". Telling the agent to narrow a Raumbuch
#: invites it to quote a partial sum as a total.
_PARTIAL_MODEL_OPS = frozenset({"schedule", "takeoff", "compliance", "compliance-diff", "compare", "profile", "health"})


def _truncation_note(op: str) -> str:
    """What a `truncated` result means, for the op that produced it."""
    if op in _PARTIAL_MODEL_OPS:
        return (
            "(Achtung: diese Zahlen beziehen sich nur auf einen Teil des Modells. "
            "Sie sind KEINE Gesamtwerte für das Gebäude — bitte im Text so kennzeichnen.)"
        )
    return "(Weitere Treffer vorhanden — Abfrage eingrenzen oder aggregieren.)"


def _render(
    result: dict[str, Any],
    project_id: str | None = None,
    gebaeudeklasse: int = 0,
    hauptnutzung: str = "",
) -> str:
    """Turn the endpoint's body into the string the model reads.

    The `summary` line is the answer; the `caveat` is not optional colour (a
    storey breakdown over unplaced elements is a subset presented as a total);
    the per-op detail follows, clipped so a broad query cannot flood the
    context with forty thousand element names.
    """
    if not result.get("resolved"):
        return render_unresolved(result, "Das Modell konnte nicht abgefragt werden.")
    model = result.get("model") or {}
    ctx = _RenderContext(project_id, model.get("filename"), gebaeudeklasse, hauptnutzung)
    op = str(result.get("op") or "")
    lines: _Lines = [
        f"Modell: {ctx.filename}" if ctx.filename else None,
        str(result.get("summary") or ""),
        str(result.get("caveat") or ""),
    ]
    renderer = _QUERY_RENDERERS.get(op)
    if renderer is not None:
        lines += renderer(result, ctx)
    if result.get("truncated"):
        lines.append(_truncation_note(op))
    return "\n".join(line for line in lines if line)


# ── tracing and the tool ─────────────────────────────────────────────────────

_model_handle = model_handle


def _trace(
    query: dict[str, Any],
    result: dict[str, Any] | None,
    *,
    unavailable: bool = False,
    outcome: str | None = None,
) -> None:
    """Which operation, which model, whether it resolved, whether the answer covered the WHOLE building.

    The BFF exports no traces, so this is the only shape Langfuse gets. The
    honesty flags matter for correctness, not speed: a truncated or sampled
    result is a subset presented as a total.
    """
    operation = str(query.get("op", "unknown"))
    found = result or {}
    if outcome is None and unavailable:
        outcome = "service_unavailable"
    if outcome is None and not found.get("resolved"):
        outcome = f"unresolved:{found.get('reason', 'unknown')}"
    if outcome is not None:
        record_ifc_call(operation, outcome)
        return
    model = found.get("model") or {}
    scan = found.get("propertyScan") or {}
    record_ifc_call(
        operation,
        "resolved",
        ifc_model=model_handle(model.get("filename")),
        ifc_elements=model.get("elementCount"),
        ifc_truncated=bool(found.get("truncated")) or None,
        ifc_total_is_lower_bound=bool(found.get("totalIsLowerBound")) or None,
        ifc_catalog_sampled=(not scan.get("complete")) if scan else None,
    )


async def _query(arguments: IfcQueryInput, default_limit: int) -> str:
    """The tool body: guard, build, post, render — every failure as text the agent can act on."""
    organization_id = get_organization_id_from_context()
    if not organization_id:
        return NO_ORG_TEXT
    project_id = get_project_id_from_context()
    if not project_id:
        return NO_PROJECT_TEXT
    query = _build_query(
        operation=arguments.operation.strip().lower() or "overview",
        filters=arguments.filters,
        metric=arguments.metric,
        quantity=arguments.quantity,
        group_by=arguments.group_by,
        global_id=arguments.global_id,
        ifc_type=arguments.ifc_type,
        limit=arguments.limit if arguments.limit > 0 else default_limit,
        gebaeudeklasse=arguments.gebaeudeklasse,
        hauptnutzung=arguments.hauptnutzung,
    )
    if isinstance(query, str):
        return query
    try:
        result = await asyncio.to_thread(
            run_bim_query,
            organization_id=organization_id,
            project_id=project_id,
            query=query,
            model_name=arguments.model_name.strip() or None,
            compare_with_name=arguments.compare_with.strip() or None,
        )
    except QUERY_FAILURES.exceptions as exc:
        failure = QUERY_FAILURES.describe(exc)
        logger.log(failure.level, "ifc_query %s: %s", failure.outcome, exc)
        _trace(query, None, outcome=failure.outcome)
        return failure.text(exc)
    _trace(query, result)
    return _render(result, project_id, arguments.gebaeudeklasse, arguments.hauptnutzung.strip().lower())


class IfcQueryConfig(FunctionBaseConfig, name="ifc_query"):
    """Configuration for the ``ifc_query`` BIM tool."""

    default_limit: int = Field(default=25, description="Rows returned by 'elements' when none is given.")


@register_function(config_type=IfcQueryConfig)
async def ifc_query(tool_config: IfcQueryConfig, builder: Builder):
    async def _ifc_query(arguments: IfcQueryInput) -> str:
        """Query the project's IFC/BIM model for exact building facts."""
        return await _query(arguments, tool_config.default_limit)

    yield FunctionInfo.from_fn(_ifc_query, input_schema=IfcQueryInput, description=_TOOL_DESCRIPTION)
