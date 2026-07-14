"""End-of-wizard FREE-TEXT intake consistency-check endpoint.

Structured intake answers (selects/numbers/booleans) are checked
DETERMINISTICALLY on the client — see ``intake-consistency.ts``. This endpoint
is the LLM half: it looks ONLY at the free-text answers (goal details,
high-building details, …) and asks whether that prose contradicts the
structured answers (passed as read-only context) or itself. It does NOT
re-check the structured answers against each other, and it does NOT nag about
completeness: skipped/unknown answers are legitimate and are never sent here.

Mirrors ``generate_summary.py``: machine-readable error codes and an
always-200, best-effort shape. Any failure returns HTTP 200 with an ``error``
code and ``findings: None`` so a check outage never blocks the user from saving.
"""

import json
import logging
import os

import httpx
from fastapi import APIRouter

from ..models.requests import ConsistencyCheckRequest
from ..models.requests import ConsistencyCheckResponse
from ..models.requests import ConsistencyFinding

logger = logging.getLogger(__name__)

_VALID_SEVERITIES = {"warning", "inconsistency"}

SYSTEM_PROMPT = (
    "You are a building-code intake reviewer for an Austrian (OIB) architectural "
    "platform. A user filled in a project-intake wizard. You are given two lists "
    "of field/value pairs: FREE-TEXT ANSWERS (free-form notes the user typed) and "
    "STRUCTURED ANSWERS (fixed choices/numbers, given only as read-only context). "
    "Your ONLY job is to judge the FREE-TEXT answers: report a finding when a "
    "free-text answer CONTRADICTS one of the structured answers, or contradicts "
    "another free-text answer, or is internally self-contradictory. "
    "Only ever flag a free-text field. NEVER flag a contradiction that is purely "
    "between two structured answers — those are checked elsewhere. "
    "Do NOT report missing, skipped, or unknown answers — incompleteness is fine. "
    "Do NOT invent facts, apply external requirements, or nitpick style/wording; "
    "only report clear contradictions. If there is no contradiction, return an "
    "empty findings list. "
    "Respond with ONLY a JSON object of the form "
    '{"findings": [{"fields": ["<exact field label>", ...], '
    '"severity": "warning" | "inconsistency", "explanation": "<one or two sentences>"}]}. '
    "Each finding's \"fields\" MUST include the free-text field label, plus any "
    "structured field label it contradicts (echoed EXACTLY as given). "
    "Use \"inconsistency\" for a hard contradiction and \"warning\" for something "
    "merely worth double-checking. No prose outside the JSON, no markdown fences."
)


def _llm_settings() -> tuple[str, str, str]:
    """Resolve the model/api_key/base_url for the consistency-check LLM call.

    ``CONSISTENCY_LLM_*`` env vars take precedence, then generic ``LLM_*`` vars,
    then the OpenRouter default used by ``config_oib_openrouter.yml`` (matching
    ``generate_summary.py`` so both endpoints degrade identically).
    """
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
    default_model = "deepseek/deepseek-v4-flash" if openrouter_key else "gpt-4o-mini"
    default_base = "https://openrouter.ai/api/v1" if openrouter_key else "https://api.openai.com/v1"

    model = os.getenv("CONSISTENCY_LLM_MODEL", os.getenv("LLM_MODEL", default_model))
    api_key = os.getenv("CONSISTENCY_LLM_API_KEY", os.getenv("LLM_API_KEY", openrouter_key))
    base_url = os.getenv("CONSISTENCY_LLM_BASE_URL", os.getenv("LLM_BASE_URL", default_base))
    if not api_key:
        logger.warning(
            "No API key for consistency-check LLM (CONSISTENCY_LLM_API_KEY / LLM_API_KEY / OPENROUTER_API_KEY)"
        )
    return model, api_key, base_url.rstrip("/")


def _render_fields(fields: list) -> str:
    """One field/value pair per line, for the user turn."""
    return "\n".join(f"- {item.field}: {item.value}" for item in fields)


def _strip_code_fence(text: str) -> str:
    """Tolerate models that wrap JSON in ```json ... ``` fences."""
    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence line (``` or ```json) and the trailing fence.
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[: -len("```")]
    return stripped.strip()


def _parse_findings(content: str) -> list[ConsistencyFinding] | None:
    """Defensively parse the model's JSON into findings.

    Returns a (possibly empty) list of valid findings, or ``None`` if the
    payload is not the expected object shape. Individual malformed findings are
    skipped rather than failing the whole parse.
    """
    try:
        data = json.loads(_strip_code_fence(content))
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(data, dict):
        return None
    raw_findings = data.get("findings")
    if raw_findings is None:
        # A well-formed object without a findings key means "consistent".
        return []
    if not isinstance(raw_findings, list):
        return None

    findings: list[ConsistencyFinding] = []
    for entry in raw_findings:
        if not isinstance(entry, dict):
            continue
        explanation = entry.get("explanation")
        if not isinstance(explanation, str) or not explanation.strip():
            continue
        severity = entry.get("severity")
        if severity not in _VALID_SEVERITIES:
            severity = "warning"
        raw_fields = entry.get("fields")
        fields = [f for f in raw_fields if isinstance(f, str)] if isinstance(raw_fields, list) else []
        findings.append(
            ConsistencyFinding(fields=fields, severity=severity, explanation=explanation.strip())
        )
    return findings


def add_consistency_check_routes(router: APIRouter) -> None:
    """Register the intake consistency-check endpoint."""

    @router.post(
        "/v1/consistency-check",
        response_model=ConsistencyCheckResponse,
        tags=["projects"],
        summary="Detect internal contradictions between intake answers",
        description=(
            "Calls an LLM to detect internal contradictions between the intake "
            "answers the wizard collected. Best-effort: always HTTP 200; failures "
            "return an error code with findings=null so the wizard can save anyway."
        ),
    )
    async def consistency_check(request: ConsistencyCheckRequest) -> ConsistencyCheckResponse:
        if not request.free_text:
            # No free text to scrutinise — nothing for the LLM to do. The client
            # normally short-circuits before calling; this guards direct callers.
            return ConsistencyCheckResponse(findings=[])

        model, api_key, base_url = _llm_settings()
        if not api_key:
            # No credentials — surface a diagnosable code instead of a guaranteed 401.
            return ConsistencyCheckResponse(findings=None, error="llm_not_configured")

        language = "German" if request.locale.lower().startswith("de") else "English"
        structured_block = (
            f"Structured answers (read-only context — do NOT flag these against each other):\n"
            f"{_render_fields(request.structured)}\n\n"
            if request.structured
            else ""
        )
        user_content = (
            f"Write every explanation in {language}.\n\n"
            f"{structured_block}"
            "Free-text answers (scrutinise these):\n"
            f"{_render_fields(request.free_text)}"
        )

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        payload = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": 800,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Consistency-check LLM returned an error status: %s (%s)",
                exc.response.status_code if exc.response is not None else "unknown",
                type(exc).__name__,
            )
            return ConsistencyCheckResponse(findings=None, error="llm_request_failed")
        except httpx.RequestError as exc:
            logger.warning("Consistency-check LLM request failed: %s", type(exc).__name__)
            return ConsistencyCheckResponse(findings=None, error="llm_request_failed")
        except Exception:
            logger.exception("Unexpected error calling consistency-check LLM")
            return ConsistencyCheckResponse(findings=None, error="llm_request_failed")

        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            logger.warning("Consistency-check LLM response had an unexpected shape")
            return ConsistencyCheckResponse(findings=None, error="llm_response_malformed")

        findings = _parse_findings(content if isinstance(content, str) else "")
        if findings is None:
            logger.warning("Consistency-check LLM returned unparseable findings JSON")
            return ConsistencyCheckResponse(findings=None, error="llm_response_malformed")

        return ConsistencyCheckResponse(findings=findings)
