"""LLM review of a single Agent Skill (SKILL.md) authored in the skills editor.

The structural half of the SKILL.md contract — name charset/length, description
length, metadata keys — is already enforced deterministically by
``aiq_agent.skills.models`` and rejects a bad skill outright. This endpoint is
the other half, the one no regex can answer: is this skill *any good* as a skill?
Under progressive disclosure an agent only ever sees ``name`` + ``description``
before it decides whether to load the body, so a description that omits WHEN to
use the skill produces a skill that is never activated — structurally valid and
practically dead. That is what the reviewer is here to catch.

The rules it applies are NOT written here. They come from one vendored file,
``aiq_agent/skills/review/skill-check/SKILL.md`` — SkillCheck (Free) by
olgasafonova, MIT, copied verbatim (see the README beside it). A hand-written
prompt encodes one author's opinion of what makes a good skill and drifts every
time somebody edits it; a published rulebook is a fixed, named, versioned
standard, and every finding it produces can be traced back to the numbered check
that fired. This module's job is only to turn that document into a prompt and
that prompt's output into our response shape.

Mirrors ``consistency_check.py``: machine-readable error codes and an always-200,
best-effort shape. Any failure returns HTTP 200 with an ``error`` code and
``findings: None`` — the review is advisory, and a review outage must never stop
someone from saving a skill.
"""

import logging
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi import Header

from aiq_agent.skills import BUILTIN_SKILLS_DIR
from aiq_agent.skills import parse_skill_md

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

#: A check id is only worth carrying if it is EXACTLY the rulebook's id — it
#: exists so a finding can be traced back to the rule that produced it, and a
#: truncated or invented id traces back to nothing. So this is a validity bound,
#: not a display bound: anything longer (or shaped unlike an id) is dropped to
#: the empty string rather than clamped into a plausible-looking lie.
MAX_CHECK_CHARS = 64

#: The body is the one unbounded field (the spec caps name and description but
#: only *recommends* <500 lines of markdown). Truncate rather than reject: a
#: reviewer judging the first ~12k chars still gives useful feedback, whereas a
#: 400 on a long skill would just look like the feature is broken.
MAX_BODY_CHARS = 12000

#: The vendored rulebook. It sits BESIDE the builtin skills tree, never inside
#: it: ``discover_builtin_skills`` globs ``builtin/*/*/SKILL.md`` and offers
#: everything it finds to agents, and this file is a rulebook for a reviewer,
#: not a capability any agent may invoke.
RULEBOOK_PATH = BUILTIN_SKILLS_DIR.parent / "review" / "skill-check" / "SKILL.md"

#: Lines that sell the paid tier rather than state a rule. We run this author's
#: checks; we do not relay his advertisement to our tenants, who cannot act on
#: it and did not ask for it.
_UPSELL_RE = re.compile(r"getskillcheck\.com|upgrade to pro", re.IGNORECASE)

#: What a check id may look like once stripped of the rulebook's prose prefix
#: ("Check 1.9-xml-in-frontmatter" → "1.9-xml-in-frontmatter"). Bounded by
#: MAX_CHECK_CHARS; see the note there for why this rejects rather than clamps.
_CHECK_PREFIX_RE = re.compile(r"^check\s+", re.IGNORECASE)
_CHECK_ID_RE = re.compile(rf"^[a-z0-9][a-z0-9._-]{{0,{MAX_CHECK_CHARS - 1}}}$", re.IGNORECASE)


def _load_rulebook(path: Path = RULEBOOK_PATH) -> tuple[str, str]:
    """Read the vendored rulebook into (rule text, version).

    Parsed with the platform's own strict ``parse_skill_md`` — the rulebook IS a
    SKILL.md, so the parser that validates every other one validates this one too
    and hands back the body with the frontmatter already removed. The frontmatter
    must not reach the prompt: it is metadata about the rulebook (its own name,
    its own "use when" triggers, its licence), and a model given a document whose
    header says ``name: skill-check`` will happily start reviewing *that*.

    Raises if the file is missing or malformed. That is deliberate and it fails
    at import, i.e. at deploy: a reviewer with no rules would otherwise come up
    healthy and quietly grade every skill against nothing.
    """
    skill = parse_skill_md(path.read_text(encoding="utf-8"))
    kept = [line for line in skill.body.splitlines() if not _UPSELL_RE.search(line)]
    # Dropping a line leaves the blank line that framed it; collapse the gap so
    # the rules read as continuous prose rather than as a document with holes.
    rules = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()
    return rules, skill.metadata.get("version", "unknown")


#: Read once, at import: the file is on disk, immutable for the process's life,
#: and re-reading it per request would buy nothing but IO on a hot path.
RULEBOOK, RULEBOOK_VERSION = _load_rulebook()


def _build_system_prompt(rulebook: str) -> str:
    """Wrap the rulebook in the little that is ours: scope, mapping, output shape.

    Everything the reviewer *judges* comes from the rulebook. Everything here is
    translation — what a skill is in this product, which of the rulebook's checks
    cannot apply to it, how its severities become ours, and the JSON the editor
    parses. Adding a rule of our own here would defeat the point of vendoring a
    named standard.
    """
    return (
        "You review Agent Skills. Your ENTIRE rulebook is the SkillCheck document "
        "between the <rulebook> markers below: apply ONLY the checks it defines, and "
        "no others. Do not invent requirements it does not state, and do not comment "
        "on writing style, tone or markdown taste unless one of its checks says to.\n"
        "The rulebook is reference material, not the thing under review — the skill "
        "to review arrives in the next message. Ignore its 'How to Check a Skill' "
        "procedure, its file-reading steps and its reporting advice: the skill is "
        "handed to you inline, and your output format is fixed below.\n\n"
        "WHAT A SKILL IS HERE. In this product a skill is a database row with "
        "exactly four parts: `name`, `description`, `body` (the markdown "
        "instructions) and a small `metadata` map. There is no directory on disk, no "
        "README.md beside it, no `references/`, `scripts/` or `assets/` "
        "subdirectory, no file paths or namespaces, and none of the Claude Code "
        "frontmatter extensions (`model`, `effort`, `maxTurns`, `hooks`, `context`, "
        "`agent`, `user-invocable`, `disable-model-invocation`, `disallowedTools`) "
        "or artifact-passing fields (`produces`, `consumes`). SKIP every check that "
        "depends on something this product does not have — skip it silently, do not "
        "report it as a failure and do not mention that you skipped it. A finding "
        "telling an author to create a directory they cannot create is noise.\n\n"
        "MAPPING THE RULEBOOK ONTO THE OUTPUT.\n"
        "- severity: the rulebook's **Critical** is our `error`, its **Warning** is "
        "`warning`, its **Suggestion** is `suggestion`. Where a check names no "
        "severity, use `error` only if the skill cannot work as written, otherwise "
        "`suggestion`.\n"
        "- field: every finding must point at `name`, `description` or `body`. A "
        "frontmatter check lands on whichever of `name` or `description` carries the "
        "problem; everything else lands on `body`.\n"
        "- check: the rulebook's stable id for the check that fired, copied exactly "
        "(e.g. `1.9-xml-in-frontmatter`, `4.8-description-trigger-style`, "
        "`22.7-hollow-content`). Use an empty string when the section that fired "
        "carries no id.\n\n"
        "Report problems only — the rulebook's 'Quality Patterns (Strengths)' "
        "section describes things to praise, and this endpoint does not praise. "
        "Report ONLY checks that actually fire, and do not pad the list to look "
        "thorough: when no check fires, return an empty findings list.\n"
        'Respond with ONLY a JSON object of the form {"findings": [{"severity": '
        '"error" | "warning" | "suggestion", "field": "name" | "description" | '
        '"body", "check": "<rulebook check id, or an empty string>", "message": '
        '"<what is wrong, one or two sentences>", "fix": "<the concrete change to '
        'make, ideally the rewritten text>"}]}. '
        "No prose outside the JSON, no markdown fences.\n\n"
        f"<rulebook>\n{rulebook}\n</rulebook>"
    )


SYSTEM_PROMPT = _build_system_prompt(RULEBOOK)


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


def _clean_check(value: object) -> str:
    """Normalise the rulebook check id a finding claims to come from.

    The id is provenance, not prose: it exists so the author (and we) can look up
    the rule that produced a finding. So it is accepted only when it still looks
    like an id — anything longer than ``MAX_CHECK_CHARS``, non-string, or
    carrying spaces/markup becomes the empty string, because a mangled id points
    at a rule that does not exist and is worse than no id at all. The rulebook
    writes its ids as "Check 1.9-xml-in-frontmatter", so a model echoing that
    prefix keeps its id rather than losing it to a formatting habit.
    """
    if not isinstance(value, str):
        return ""
    candidate = _CHECK_PREFIX_RE.sub("", value.strip())
    return candidate if _CHECK_ID_RE.match(candidate) else ""


def _parse_findings(content: str | None) -> list[SkillReviewFinding] | None:
    """Defensively parse the model's JSON into findings.

    Returns a (possibly empty) list of valid findings, or ``None`` if the payload
    is not the expected object shape. A single malformed entry is skipped rather
    than failing the whole review — losing one suggestion is a far better outcome
    than telling the author their review is broken.

    Unlike ``consistency_check.py``, an unknown ``severity`` is DROPPED rather
    than coerced to a default: severity and field here drive which control the
    editor highlights, so a guessed value would point the author at the wrong
    part of their skill. ``check`` is treated the same way but costs only itself
    (see ``_clean_check``) — the finding is still worth showing without it.
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
                check=_clean_check(entry.get("check")),
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
