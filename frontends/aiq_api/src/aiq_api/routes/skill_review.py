"""LLM review of a single Agent Skill (SKILL.md) authored in the skills editor.

The structural half of the SKILL.md contract — name charset/length, description
length, metadata keys — is already enforced deterministically by
``aiq_agent.skills.models`` and rejects a bad skill outright. This endpoint is
the other half, the one no regex can answer: is this skill *any good* as a skill?
Under progressive disclosure an agent only ever sees ``name`` + ``description``
before it decides whether to load the body, so a description that omits WHEN to
use the skill produces a skill that is never activated — structurally valid and
practically dead. That is what the reviewer is here to catch.

Mirrors ``consistency_check.py``: machine-readable error codes and an always-200,
best-effort shape. Any failure returns HTTP 200 with an ``error`` code and
``findings: None`` — the review is advisory, and a review outage must never stop
someone from saving a skill.
"""

import logging
import os

import httpx
from fastapi import APIRouter
from fastapi import Header

from ..models.requests import SkillReviewFinding
from ..models.requests import SkillReviewRequest
from ..models.requests import SkillReviewResponse
from ._llm_json import extract_json_object
from ._llm_json import message_content

logger = logging.getLogger(__name__)

_VALID_SEVERITIES = {"error", "warning", "suggestion"}
_VALID_FIELDS = {"name", "description", "body"}

#: Clamps on the model's output. A reviewer that returns forty findings is not
#: reviewing, it is nagging, and the editor surface can only usefully show a
#: handful; the char caps keep one runaway generation from bloating a response
#: the UI renders inline. Deliberately the same numbers the BFF applies in
#: `lib/skills/review.ts`: it re-clamps whatever arrives, and two different
#: limits would mean the second cut lands mid-sentence in text the first had
#: already trimmed.
MAX_FINDINGS = 12
MAX_MESSAGE_CHARS = 400
MAX_FIX_CHARS = 400

#: The body is the one unbounded field (the spec caps name and description but
#: only *recommends* <500 lines of markdown). Truncate rather than reject: a
#: reviewer judging the first ~12k chars still gives useful feedback, whereas a
#: 400 on a long skill would just look like the feature is broken.
MAX_BODY_CHARS = 12000

SYSTEM_PROMPT = (
    "You review Agent Skills. A skill is a SKILL.md with a `name`, a `description` "
    "and a markdown instruction body, and it is consumed under PROGRESSIVE "
    "DISCLOSURE: the name and description are permanently in the agent's context, "
    "while the body is loaded only once the agent decides to activate the skill. "
    "Judge the skill as a skill, not as prose.\n"
    "In order of importance:\n"
    "1. The description MUST say both WHAT the skill does AND WHEN to use it. This "
    "is the single most important property — it is the only text the agent sees "
    "before deciding whether to load the skill. A description missing the WHEN is "
    "an error.\n"
    "2. The description must be specific enough to match real user requests: it "
    "should name the concrete triggers, tasks, file types or phrasings that should "
    "activate it, not vague generalities.\n"
    "3. The name should describe domain + action, be lowercase and hyphenated, and "
    "read like what the skill does.\n"
    "4. The instructions in the body must be concrete and ordered — actual steps, "
    "inputs and outputs — and free of generic filler ('be helpful', 'follow best "
    "practices') that tells the agent nothing.\n"
    "5. Routing content in the body is a mistake: anything of the form 'use this "
    "when …' belongs in the description, because the agent cannot read the body "
    "until after it has already decided to load the skill.\n"
    "Report ONLY substantive problems. Do NOT comment on writing style, tone, "
    "formatting or markdown taste. Do NOT invent requirements the Agent Skills "
    "format does not have. Do NOT pad the list to look thorough: if the skill is "
    "good, return an empty findings list.\n"
    'Respond with ONLY a JSON object of the form {"findings": [{"severity": '
    '"error" | "warning" | "suggestion", "field": "name" | "description" | "body", '
    '"message": "<what is wrong, one or two sentences>", "fix": "<the concrete '
    'change to make, ideally the rewritten text>"}]}. '
    'Use "error" for something that breaks the skill (e.g. a description that '
    'cannot trigger), "warning" for something likely to hurt it, and "suggestion" '
    "for a genuine improvement. "
    "No prose outside the JSON, no markdown fences."
)


def _llm_settings(organization_id: str | None = None) -> tuple[str, str, str]:
    """Resolve the model/api_key/base_url for the skill-review LLM call.

    Goes through the shared credential resolver so this route reaches the org's
    BYOK credential like every other LLM call, then the same env chain as its
    siblings: ``SKILL_REVIEW_LLM_*`` → generic ``LLM_*`` → the OpenRouter/OpenAI
    default used by ``config_oib_openrouter.yml`` (matching
    ``consistency_check.py`` so all three endpoints degrade identically). Model +
    base URL keep their two-level env fallback; the resolver adds BYOK (org key +
    base, model unchanged) and provider inference on top. Fail-open: a BYOK miss
    falls back to the env chain.
    """
    from aiq_agent.common.credential_resolution import read_api_key_env
    from aiq_agent.common.credential_resolution import resolve_llm_credential

    # `read_api_key_env`, not `os.getenv`: docker compose `env_file` does not
    # interpolate `${VAR}` references, so `OPENROUTER_API_KEY=${OPENROUTER_API_KEY}`
    # arrives as a literal placeholder — truthy, but not a key. Reading it raw
    # selected the OpenRouter endpoint below while the resolver (which normalizes
    # the same way) treated the key as unset and fell back to `LLM_API_KEY`,
    # sending another provider's key to openrouter.ai.
    openrouter_key = read_api_key_env("OPENROUTER_API_KEY")
    # Mirrors the boot floor in config_oib_openrouter.yml. NOTE: this route is
    # not an AgentGroup, so it resolves outside `platform_model_defaults` — the
    # platform default set under Platform → Models does not reach it.
    default_model = "openai/gpt-5.6-luna" if openrouter_key else "gpt-4o-mini"
    default_base = "https://openrouter.ai/api/v1" if openrouter_key else "https://api.openai.com/v1"

    model = os.getenv("SKILL_REVIEW_LLM_MODEL", os.getenv("LLM_MODEL", default_model))
    base_url = os.getenv("SKILL_REVIEW_LLM_BASE_URL", os.getenv("LLM_BASE_URL", default_base))

    cred = resolve_llm_credential(
        primary_env="SKILL_REVIEW_LLM_API_KEY",
        fallback_envs=("LLM_API_KEY", "OPENROUTER_API_KEY"),
        default_base_url=base_url,
        default_model=model,
        organization_id=organization_id,
    )
    if not cred.api_key:
        logger.warning(
            "No API key for skill-review LLM (BYOK / SKILL_REVIEW_LLM_API_KEY / LLM_API_KEY / OPENROUTER_API_KEY)"
        )
    return cred.model, cred.api_key, cred.base_url


def _parse_findings(content: str | None) -> list[SkillReviewFinding] | None:
    """Defensively parse the model's JSON into findings.

    Returns a (possibly empty) list of valid findings, or ``None`` if the payload
    is not the expected object shape. A single malformed entry is skipped rather
    than failing the whole review — losing one suggestion is a far better outcome
    than telling the author their review is broken.

    Unlike ``consistency_check.py``, an unknown ``severity`` is DROPPED rather
    than coerced to a default: severity and field here drive which control the
    editor highlights, so a guessed value would point the author at the wrong
    part of their skill.
    """
    try:
        data = extract_json_object(content)
    except ValueError:
        return None

    raw_findings = data.get("findings")
    if raw_findings is None:
        # A well-formed object without a findings key means "nothing to report".
        return []
    if not isinstance(raw_findings, list):
        return None

    findings: list[SkillReviewFinding] = []
    for entry in raw_findings:
        if len(findings) >= MAX_FINDINGS:
            break
        if not isinstance(entry, dict):
            continue
        if entry.get("severity") not in _VALID_SEVERITIES or entry.get("field") not in _VALID_FIELDS:
            continue
        message = entry.get("message")
        if not isinstance(message, str) or not message.strip():
            continue
        # A finding without a fix is still worth showing; an empty string is the
        # honest rendering of "the model had nothing concrete to propose".
        fix = entry.get("fix")
        fix = fix.strip()[:MAX_FIX_CHARS] if isinstance(fix, str) else ""
        findings.append(
            SkillReviewFinding(
                severity=entry["severity"],
                field=entry["field"],
                message=message.strip()[:MAX_MESSAGE_CHARS],
                fix=fix,
            )
        )
    return findings


def add_skill_review_routes(router: APIRouter) -> None:
    """Register the skill-review endpoint."""

    @router.post(
        "/v1/skills/review",
        response_model=SkillReviewResponse,
        tags=["skills"],
        summary="Critique an Agent Skill (SKILL.md) and suggest improvements",
        description=(
            "Calls an LLM to review a skill's name, description and instructions "
            "as an Agent Skill under progressive disclosure. Best-effort: always "
            "HTTP 200; failures return an error code with findings=null so the "
            "editor can save anyway."
        ),
    )
    async def skill_review(
        request: SkillReviewRequest,
        # Forwarded by the BFF (profile-service) so this route can reach the
        # org's BYOK LLM credential; absent for anonymous/direct callers. The
        # body field wins when both are present — the skills editor posts the
        # org it is editing on behalf of, which is the more specific answer.
        x_grid_organization_id: str | None = Header(default=None),
    ) -> SkillReviewResponse:
        name = request.name.strip()
        description = request.description.strip()
        body = request.body.strip()
        if not (name or description or body):
            # An empty draft has nothing to review; do not spend a call telling
            # the author their blank form is blank.
            return SkillReviewResponse(findings=[])

        organization_id = request.organization_id or x_grid_organization_id
        model, api_key, base_url = _llm_settings(organization_id)
        if not api_key:
            # No credentials — surface a diagnosable code instead of a guaranteed 401.
            return SkillReviewResponse(findings=None, error="llm_not_configured")

        truncated_body = body[:MAX_BODY_CHARS]
        if len(body) > MAX_BODY_CHARS:
            truncated_body += "\n\n[… body truncated for review …]"

        user_content = (
            # The product is German-facing but skills may be authored in either
            # language, and a German critique of an English skill (or the
            # reverse) reads as a bug to the author.
            "Write every `message` and `fix` in the SAME LANGUAGE as the skill "
            "below. If the skill is written in German, answer in German.\n\n"
            f"name: {name}\n\n"
            f"description: {description}\n\n"
            f"body:\n{truncated_body}"
        )

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        payload = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": 1200,
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
                "Skill-review LLM returned an error status: %s (%s)",
                exc.response.status_code if exc.response is not None else "unknown",
                type(exc).__name__,
            )
            return SkillReviewResponse(findings=None, error="llm_request_failed")
        except httpx.RequestError as exc:
            logger.warning("Skill-review LLM request failed: %s", type(exc).__name__)
            return SkillReviewResponse(findings=None, error="llm_request_failed")
        except Exception:
            logger.exception("Unexpected error calling skill-review LLM")
            return SkillReviewResponse(findings=None, error="llm_request_failed")

        try:
            content, finish_reason = message_content(data)
        except ValueError:
            logger.warning("Skill-review LLM response had an unexpected shape")
            return SkillReviewResponse(findings=None, error="llm_response_malformed")

        findings = _parse_findings(content)
        if findings is None:
            logger.warning(
                "Skill-review LLM returned unparseable findings JSON (finish_reason=%s, %d chars)",
                finish_reason,
                len(content or ""),
            )
            return SkillReviewResponse(findings=None, error="llm_response_malformed")

        return SkillReviewResponse(findings=findings)
