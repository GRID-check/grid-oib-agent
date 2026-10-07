"""„Ausmisten" at a project's close: which documents could go (ADR-0084).

The BFF (``lib/projects/cleanup-service.ts``) sends what the index already
holds about the documents the person closing may read and write: names, folder
paths, types, tags, the summary ingestion wrote, the editorial state. No
document content, so nothing reaches the model that ingestion did not already
send. The model proposes working copies, superseded drafts, duplicates,
temporary files and never-published drafts; the BFF merges its answer with the
rule-based candidates, and a person decides about every item.

Fails soft: no credential, an upstream error or an answer that does not parse
returns an empty proposal with ``error`` set, and the BFF falls back to its
rules. An id the model invents is dropped.
"""

import asyncio
import json
import logging

import httpx
from fastapi import APIRouter
from fastapi import Header

from ..models.requests import CleanupCandidate
from ..models.requests import CleanupDocumentFacts
from ..models.requests import CleanupProposalRequest
from ..models.requests import CleanupProposalResponse
from .generate_summary import _llm_settings

logger = logging.getLogger(__name__)

CATEGORIES = ("working_copy", "superseded", "duplicate", "temporary", "unpublished_draft", "other")

SYSTEM_PROMPT = (
    "You help an architecture office close a finished building project. You see only the "
    "metadata of the project's documents: file name, folder path, type, tags, a one-line "
    "summary, the editorial state, who authored it. Propose which documents are no longer "
    "useful once the project is archived: working copies, superseded drafts or versions "
    "(an older version when a newer one of the same document exists), duplicates, "
    "temporary or lock files, and drafts that were never published. Keep anything that "
    "records the project: approved plans, permits (Bescheide), contracts, correspondence, "
    "protocols, invoices, the final versions. When unsure, do not propose it.\n"
    'Answer with JSON only: {"candidates": [{"id": "<document id>", "category": '
    '"working_copy|superseded|duplicate|temporary|unpublished_draft|other", "reason": '
    '"<one short sentence>"}]}. Use only ids from the input.'
)


def _document_line(document: CleanupDocumentFacts) -> dict[str, object]:
    """One document as the model sees it: only the keys that carry something."""
    fields: dict[str, object] = {
        "id": document.id,
        "file": document.filename,
        "folder": document.folder_path,
        "type": document.content_type,
        "tags": document.tags or None,
        "summary": document.summary,
        "state": document.version_state,
        "author": document.authored_by,
        "uploaded": document.uploaded_at,
    }
    return {key: value for key, value in fields.items() if value not in (None, "", [])}


def parse_candidates(content: str, known_ids: set[str]) -> list[CleanupCandidate] | None:
    """The model's candidates, or None when the answer is not the JSON asked for.

    Tolerates a fenced block; drops an id the input did not name, a duplicate id,
    and an empty reason, and maps an unknown category to ``other``.
    """
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :] if "{" in text else text
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("candidates"), list):
        return None
    found: list[CleanupCandidate] = []
    seen: set[str] = set()
    for item in data["candidates"]:
        if not isinstance(item, dict):
            continue
        document_id = str(item.get("id", ""))
        reason = str(item.get("reason", "")).strip()
        if document_id not in known_ids or document_id in seen or not reason:
            continue
        category = str(item.get("category", "other"))
        seen.add(document_id)
        found.append(
            CleanupCandidate(
                id=document_id,
                category=category if category in CATEGORIES else "other",
                reason=reason[:300],
            )
        )
    return found


def add_cleanup_proposal_routes(router: APIRouter) -> None:
    """Register the cleanup-proposal endpoint."""

    @router.post(
        "/v1/cleanup-proposal",
        response_model=CleanupProposalResponse,
        tags=["projects"],
        summary="Propose which documents a closing project no longer needs",
        description="Reads document metadata only and proposes candidates; a person decides.",
    )
    async def cleanup_proposal(
        request: CleanupProposalRequest,
        x_grid_organization_id: str | None = Header(default=None),
    ) -> CleanupProposalResponse:
        if not request.documents:
            return CleanupProposalResponse()

        cred = await asyncio.to_thread(_llm_settings, x_grid_organization_id)
        if not cred.api_key:
            return CleanupProposalResponse(error="llm_not_configured")

        language = "German" if request.locale.lower().startswith("de") else "English"
        user_content = f"Write each reason in {language}.\n\n" + "\n".join(
            json.dumps(_document_line(document), ensure_ascii=False) for document in request.documents
        )
        payload = cred.request_body(
            {
                "model": cred.model,
                "temperature": 0,
                "max_tokens": 4000,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
            }
        )
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {cred.api_key}"}

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(f"{cred.base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
            content = data["choices"][0]["message"]["content"]
        except httpx.HTTPError as exc:
            logger.warning("Cleanup proposal LLM call failed: %s", type(exc).__name__)
            return CleanupProposalResponse(error="llm_request_failed")
        except (KeyError, IndexError, TypeError, ValueError):
            logger.warning("Cleanup proposal LLM response had an unexpected shape")
            return CleanupProposalResponse(error="llm_response_malformed")

        candidates = parse_candidates(content or "", {document.id for document in request.documents})
        if candidates is None:
            return CleanupProposalResponse(error="llm_response_malformed")
        return CleanupProposalResponse(candidates=candidates, model=cred.model)
