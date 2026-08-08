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

from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

VALID_OPERATIONS = {
    "overview",
    "health",
    "types",
    "elements",
    "element",
    "properties",
    "aggregate",
    "compare",
}

_TOOL_DESCRIPTION = (
    "Query the project's IFC/BIM model for EXACT facts about the building: element counts, "
    "rooms and their areas, storeys, property values (fire rating, U-value, load-bearing, …), "
    "materials and classifications. Use this INSTEAD of knowledge_search whenever the question "
    "is about THIS building rather than about a regulation — 'how many escape doors', 'net floor "
    "area per storey', 'which walls are external', 'what is the U-value of the windows'.\n"
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
    "  'compare'    — what changed between TWO revisions of the same building. Set "
    "'compare_with' to a substring of the OLDER file's name; this model is the newer one. "
    "Matched by IFC GlobalId, so a re-export that renumbers everything still reports zero "
    "changes. This is the question no pair of PDFs can answer — use it for 'what changed since "
    "the last submission'.\n"
    "  'aggregate'  — count/sum/avg/min/max over the matching elements, optionally grouped by "
    "ifcType, storey, predefinedType, typeName, material or property. This is how you answer "
    "'how many' and 'how much' — never add up an element list yourself.\n"
    "\n"
    "filters (JSON object, all optional): {\"ifcTypes\": [\"IfcWall\"], \"storeys\": "
    "[\"Erdgeschoss\"], \"nameContains\": \"Flucht\", \"material\": \"Beton\", \"classification\": "
    "\"B.1.2\", \"properties\": [{\"set\": \"Pset_WallCommon\", \"name\": \"IsExternal\", "
    "\"operator\": \"eq\", \"value\": true}]}. Property operators: eq, neq, contains, gt, gte, lt, "
    "lte, exists, missing. 'set' may be omitted to search every property set. Use "
    "\"source\": \"quantity\" inside a property filter to match a quantity instead.\n"
    "\n"
    "For aggregate: metric is count (default), sum, avg, min or max; sum/avg/min/max need "
    "'quantity' (e.g. NetFloorArea, NetSideArea, NetVolume). groupBy is optional.\n"
    "\n"
    "Report the caveat line verbatim whenever one comes back — it says which parts of the "
    "building the numbers do NOT cover, and an answer that drops it is wrong.\n"
    "\n"
    "model_name selects one model when the project has several (a substring of the file name); "
    "leave it empty when there is only one. Report the numbers this tool returns as they are — "
    "do not recompute, round differently, or extrapolate them."
)


def _build_query(
    operation: str,
    filters: str,
    metric: str,
    quantity: str,
    group_by: str,
    global_id: str,
    ifc_type: str,
    limit: int,
) -> dict[str, Any] | str:
    """Assemble the endpoint's query object, or return an error string.

    Kept separate from the tool body so the (error-prone) argument handling is
    unit-testable without a running frontend. The endpoint validates the result
    again with the same zod schema the UI uses — this is convenience, not a
    security boundary.
    """
    if operation not in VALID_OPERATIONS:
        return f"Error: unknown operation '{operation}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."

    parsed_filters: dict[str, Any] = {}
    if filters.strip():
        try:
            candidate = json.loads(filters)
        except json.JSONDecodeError:
            return "Error: 'filters' must be a JSON object, e.g. {\"ifcTypes\": [\"IfcWall\"]}."
        if not isinstance(candidate, dict):
            return "Error: 'filters' must be a JSON object, not a list or scalar."
        parsed_filters = candidate

    if operation == "overview":
        return {"op": "overview"}
    if operation == "types":
        return {"op": "types"}
    if operation == "health":
        return {"op": "health"}
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


def _render(result: dict[str, Any]) -> str:
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
    if model.get("filename"):
        lines.append(f"Modell: {model['filename']}")
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
            rendered = ", ".join(
                f"{s.get('name') or '—'} ({s.get('elementCount', 0)} Bauteile)" for s in storeys[:20]
            )
            lines.append(f"Geschosse: {rendered}")
        type_counts = overview.get("typeCounts") or {}
        if type_counts:
            top = list(type_counts.items())[:15]
            lines.append("Bauteiltypen: " + ", ".join(f"{name} ({count})" for name, count in top))
    elif op == "elements":
        for element in (result.get("elements") or [])[:50]:
            label = element.get("name") or element.get("tag") or element.get("globalId")
            storey = element.get("storeyName") or "—"
            lines.append(f"- {element.get('ifcType')} „{label}“ · {storey} · GlobalId {element.get('globalId')}")
    elif op == "element" and isinstance(result.get("element"), dict):
        element = result["element"]
        lines.append(f"GlobalId: {element.get('globalId')}")
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
    elif op == "compare" and isinstance(result.get("comparison"), dict):
        comparison = result["comparison"]
        for entry in (comparison.get("added") or [])[:25]:
            lines.append(f"+ {entry.get('ifcType')} „{entry.get('name') or entry.get('globalId')}“ · {entry.get('storeyName') or '—'}")
        for entry in (comparison.get("removed") or [])[:25]:
            lines.append(f"- {entry.get('ifcType')} „{entry.get('name') or entry.get('globalId')}“ · {entry.get('storeyName') or '—'}")
        for entry in (comparison.get("changed") or [])[:25]:
            deltas = "; ".join(
                f"{change.get('field')}: {change.get('before')} → {change.get('after')}"
                for change in (entry.get("changes") or [])[:6]
            )
            lines.append(f"~ {entry.get('ifcType')} „{entry.get('name') or entry.get('globalId')}“ — {deltas}")
    elif op == "properties":
        for entry in (result.get("properties") or [])[:60]:
            values = ", ".join(f"{v.get('value')} ({v.get('elements')}×)" for v in (entry.get("values") or [])[:6])
            kind = "Menge" if entry.get("source") == "quantity" else "Merkmal"
            lines.append(f"- [{kind}] {entry.get('set')}.{entry.get('name')}: {values}")

    if result.get("truncated"):
        lines.append("(Weitere Treffer vorhanden — Abfrage eingrenzen oder aggregieren.)")
    return "\n".join(line for line in lines if line)


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
            return (
                "Error: the BIM model could not be queried right now (the model service is "
                "unavailable). Do NOT state anything about the building's contents; tell the user "
                "the model could not be read."
            )

        return _render(result)

    yield FunctionInfo.from_fn(_ifc_query, description=_TOOL_DESCRIPTION)
