"""Conversation naming + topic tagging endpoint.

Calls an OpenAI-compatible chat completions endpoint to turn the opening
exchange of a chat into a concise, human title (ChatGPT-style) plus 0–3 OIB
topic tags from a closed vocabulary. Backs the UI's
``/api/conversations/[id]/generate-title`` BFF route, which persists the
result on the ``conversations`` row so Historie can name and filter chats.

Shares the summary route's LLM-settings resolution so it reaches the org's
BYOK credential through the same env chain and fails open the same way.
"""

import json
import logging

import httpx
from fastapi import APIRouter
from fastapi import Header

from ..models.requests import GenerateConversationTitleRequest
from ..models.requests import GenerateConversationTitleResponse
from .generate_summary import _llm_settings

logger = logging.getLogger(__name__)

# How much of each message we hand the model. The first turn is enough to name
# a chat, and long PDF-paste answers would otherwise blow the token budget for
# a task that only needs the gist.
_MAX_CHARS_PER_MESSAGE = 1200
_MAX_TITLE_CHARS = 80

SYSTEM_PROMPT = (
    "You name chat conversations for an Austrian building-code (OIB Richtlinien) "
    "compliance assistant. Given the opening messages of a conversation, produce "
    "a SHORT, specific title describing what the inquiry was about — like the "
    "auto-generated titles in ChatGPT. Rules for the title: 3 to 6 words, no "
    "trailing punctuation, no surrounding quotes, no markdown, Title Case is not "
    "required. Then choose 0 to 3 topic tags STRICTLY from the provided list that "
    "match the subject; if none clearly fit, return an empty tag list. "
    'Respond with ONLY a JSON object: {"title": string, "tags": string[]}.'
)


def _build_transcript(messages: list, locale_name: str) -> str:
    """Render the opening exchange into a compact prompt block."""
    lines: list[str] = []
    for message in messages:
        content = (message.content or "").strip()
        if not content:
            continue
        if len(content) > _MAX_CHARS_PER_MESSAGE:
            content = content[:_MAX_CHARS_PER_MESSAGE] + "…"
        role = "User" if message.role == "user" else "Assistant"
        lines.append(f"{role}: {content}")
    return "\n\n".join(lines)


def _parse_llm_json(raw: str) -> tuple[str, list[str]]:
    """Extract (title, tags) from the model's reply, tolerating code fences.

    Raises ValueError when no usable object can be recovered so the caller can
    return a diagnosable ``llm_response_malformed`` code.
    """
    text = raw.strip()
    # Strip a ```json … ``` (or bare ```) fence if the model added one.
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    # Fall back to the first {...} span if there is leading/trailing prose.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object in response")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("response JSON is not an object")

    title = data.get("title", "")
    if not isinstance(title, str):
        raise ValueError("title is not a string")

    raw_tags = data.get("tags", [])
    tags = [t for t in raw_tags if isinstance(t, str)] if isinstance(raw_tags, list) else []
    return title, tags


def _clean_title(title: str) -> str:
    cleaned = title.strip().strip("\"'").strip()
    # Drop a trailing period the model sometimes adds despite instructions.
    cleaned = cleaned.rstrip(".")
    if len(cleaned) > _MAX_TITLE_CHARS:
        cleaned = cleaned[: _MAX_TITLE_CHARS - 1].rstrip() + "…"
    return cleaned


def add_generate_conversation_title_routes(router: APIRouter) -> None:
    """Register the generate-conversation-title endpoint."""

    @router.post(
        "/v1/generate-conversation-title",
        response_model=GenerateConversationTitleResponse,
        tags=["conversations"],
        summary="Name a conversation and assign OIB topic tags",
        description=(
            "Calls an LLM to produce a concise conversation title and 0–3 topic "
            "tags (from a closed vocabulary) for the opening exchange of a chat."
        ),
    )
    async def generate_conversation_title(
        request: GenerateConversationTitleRequest,
        # Forwarded by the BFF so this route can reach the org's BYOK LLM
        # credential; absent for anonymous/direct callers.
        x_grid_organization_id: str | None = Header(default=None),
    ) -> GenerateConversationTitleResponse:
        language = "German" if request.locale.lower().startswith("de") else "English"
        transcript = _build_transcript(request.messages, language)
        if not transcript:
            return GenerateConversationTitleResponse(title="", tags=[])

        # Constrain tags to the caller's vocabulary; an empty allow-list means
        # "title only" (the model is told the tag list is empty).
        allowed = [t.strip() for t in request.allowed_tags if isinstance(t, str) and t.strip()]

        model, api_key, base_url = _llm_settings(x_grid_organization_id)
        if not api_key:
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_not_configured")

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

        allowed_line = ", ".join(allowed) if allowed else "(none — return an empty tags list)"
        user_content = f"Write the title in {language}.\nAllowed tags: {allowed_line}\n\nConversation:\n{transcript}"

        payload = {
            "model": model,
            "temperature": 0.3,
            "max_tokens": 120,
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
                "Conversation-title LLM returned an error status: %s (%s)",
                exc.response.status_code if exc.response is not None else "unknown",
                type(exc).__name__,
            )
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_request_failed")
        except httpx.RequestError as exc:
            logger.warning("Conversation-title LLM request failed: %s", type(exc).__name__)
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_request_failed")
        except Exception:
            logger.exception("Unexpected error calling conversation-title LLM")
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_request_failed")

        try:
            raw = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, AttributeError, TypeError):
            logger.warning("Conversation-title LLM response had an unexpected shape")
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_response_malformed")

        try:
            raw_title, raw_tags = _parse_llm_json(raw)
        except (ValueError, json.JSONDecodeError):
            logger.warning("Conversation-title LLM did not return usable JSON")
            return GenerateConversationTitleResponse(title="", tags=[], error="llm_response_malformed")

        title = _clean_title(raw_title)
        # Keep only tags the caller allowed, de-duplicated and capped at 3. The
        # BFF re-validates too, but filtering here keeps the contract honest.
        allowed_set = set(allowed)
        seen: list[str] = []
        for tag in raw_tags:
            key = tag.strip().lower()
            if key in allowed_set and key not in seen:
                seen.append(key)
            if len(seen) >= 3:
                break

        return GenerateConversationTitleResponse(title=title, tags=seen)
