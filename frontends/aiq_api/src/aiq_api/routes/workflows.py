"""Internal workflows submit endpoint (ADR-0023).

``POST /v1/internal/workflows/submit`` is the single backend entry point for
scheduled and manual workflow runs. The BFF's ``fireWorkflow()`` service calls
it service-to-service; there is no live user JWT, so the workflow creator's
identity (organization, user, project, owner email) is supplied explicitly in
the body and reconstituted into a Principal + usage context here.

The route wraps ``submit_agent_job`` exactly like the public
``/v1/jobs/async/submit`` route, so scheduled runs inherit admission control,
cost tracking, ownership (``job_access``), the ghost reaper, SSE and
cancellation for free (ADR-0023 §4).

Guarded by ``GRID_INTERNAL_API_TOKEN`` (the ``maintenance.py`` pattern) and,
critically, NOT added to ``AuthMiddleware.EXTERNAL_ALLOWED_PATHS`` — so it is
unreachable from outside the compose network.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.auth import Principal
from aiq_agent.common.job_admission import JobAdmissionError

from ..registry import get_agent_config
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)


class WorkflowSubmitRequest(BaseModel):
    """Body of ``POST /v1/internal/workflows/submit`` (ADR-0023 contract).

    Identity fields are supplied explicitly because the caller is the scheduler
    / BFF, not the workflow's creator — there is no request JWT to read them
    from. ``organization_id`` is required so per-org admission counting and cost
    attribution always have a tenant to key on.
    """

    agent_type: str = Field("deep_researcher", description="Agent type; must exist in AGENT_REGISTRY")
    input: str = Field(..., min_length=1, max_length=32000, description="Compiled research brief")
    job_id: str | None = Field(
        None,
        pattern=r"^[a-zA-Z0-9_-]+$",
        max_length=64,
        description="Optional idempotency id (auto-generated if omitted)",
    )
    data_sources: list[str] | None = Field(
        None,
        description="Data source IDs to target; null = all sources available to the agent",
    )
    collection_scope: list[str] | None = Field(
        None,
        description="Collection scope (base + project + scoped collections); the project collection is derived from it",
    )
    project_context: str | None = Field(None, description="Optional project-context prompt block")
    organization_id: str = Field(..., description="WorkOS organization id owning the run (required)")
    user_id: str | None = Field(None, description="Workflow creator's WorkOS user id")
    project_id: str | None = Field(None, description="Project id the workflow is scoped to")
    owner_email: str | None = Field(None, description="Workflow creator's email (job ownership)")
    budget_header: str | None = Field(
        None,
        description="Pass-through X-Grid-Budget header value the BFF builds for interactive submits",
    )
    model_overrides: dict[str, str] | None = Field(
        None,
        description="Per-org runtime model overrides ({agent_group: model})",
    )


class WorkflowSubmitResponse(BaseModel):
    job_id: str = Field(..., description="The submitted async job id")


def add_workflow_routes(router: APIRouter) -> None:
    """Register the internal workflows submit route.

    Wired alongside the maintenance routes (same router, same middleware
    treatment) so it stays internal-only. Heavy job-submission imports are
    deferred to request time, matching the maintenance/jobs modules.
    """

    @router.post(
        "/v1/internal/workflows/submit",
        response_model=WorkflowSubmitResponse,
        tags=["workflows", "internal"],
        summary="Submit a workflow run to the async research pipeline (internal)",
        responses={
            400: {"description": "Unknown agent type"},
            403: {"description": "Missing or invalid internal token"},
            409: {"description": "A job with the supplied job_id already exists"},
            422: {"description": "Invalid payload, or unknown/agent-unavailable data source IDs"},
            429: {"description": "Admission control: active-job cap reached"},
            503: {"description": "Internal API disabled, or Dask scheduler not configured"},
        },
    )
    async def submit_workflow(body: WorkflowSubmitRequest, request: Request) -> WorkflowSubmitResponse:
        _require_internal_token(request)

        # Import the async-job layer lazily (it pulls NAT/Dask) so this module
        # stays cheap to import next to the maintenance routes.
        from ..jobs.submit import DuplicateJobIdError
        from ..jobs.submit import MissingPrincipalError
        from ..jobs.submit import SchedulerNotConfiguredError
        from ..jobs.submit import submit_agent_job as submit_authorized_job
        from .builder_state import get_active_builder

        # Validate agent_type against the registry, like the public submit route.
        try:
            agent_config = get_agent_config(body.agent_type)
        except KeyError as exc:
            raise HTTPException(400, str(exc))

        # Validate data sources the same way the public submit route does. The
        # per-agent availability check needs the builder captured at job-route
        # registration; import the (NAT-pulling) validator only when we have one.
        builder = get_active_builder()
        if builder is not None:
            from .jobs import _validate_data_sources_for_agent

            await _validate_data_sources_for_agent(
                builder=builder,
                agent_type=body.agent_type,
                agent_config_name=agent_config.config_name,
                data_sources=body.data_sources,
            )
        elif body.data_sources:
            # Startup window before register_job_routes publishes the builder:
            # don't silently skip validation — fall back to the registry-level
            # check (unknown IDs still 422; only per-agent availability is
            # unverifiable without the builder).
            from aiq_agent.common.data_source_registry import get_all_sources

            known_ids = {source.id for source in get_all_sources()}
            unknown = sorted(set(body.data_sources) - known_ids)
            if unknown:
                raise HTTPException(422, f"Unknown data source IDs: {', '.join(unknown)}")
            logger.warning(
                "Workflow submit before job routes registered a builder: "
                "validated %d data source(s) against the registry only",
                len(body.data_sources),
            )

        # Reconstitute the workflow creator's identity. The job is owned by the
        # creator (type "jwt" matches the WorkOS-authenticated principal they
        # present when later viewing the run), so existing job-access authz
        # keeps working. Fall back through email/org when the creator id is
        # absent so a Principal can always be built.
        subject = body.user_id or body.owner_email or body.organization_id
        principal = Principal(type="jwt", sub=subject, email=body.owner_email)
        owner = principal.email or principal.sub

        # Identity keys must match cost_tracking._read_identity_from_context so
        # the worker's usage ledger attributes scheduled-run spend correctly.
        usage_context = {
            "identity": {
                "organization_id": body.organization_id,
                "user_id": body.user_id,
                "project_id": body.project_id,
                "conversation_id": None,
            },
            "budget_header": body.budget_header,
        }

        try:
            job_id = await submit_authorized_job(
                agent_type=body.agent_type,
                input_text=body.input,
                owner=owner,
                principal=principal,
                job_id=body.job_id,
                data_sources=body.data_sources,
                collection_scope=body.collection_scope,
                project_context=body.project_context,
                model_overrides=body.model_overrides,
                usage_context=usage_context,
            )
        except JobAdmissionError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after_seconds)})
        except DuplicateJobIdError as exc:
            raise HTTPException(409, str(exc))
        except SchedulerNotConfiguredError as exc:
            raise HTTPException(503, str(exc))
        except MissingPrincipalError as exc:
            raise HTTPException(403, str(exc))
        except RuntimeError:
            logger.exception("Runtime error submitting workflow %s job", body.agent_type)
            raise HTTPException(500, "Failed to submit workflow job")
        except Exception as exc:
            logger.warning("Failed to submit workflow job: %s", exc)
            raise HTTPException(500, "Failed to persist workflow job authorization metadata")

        logger.info(
            "Submitted workflow %s job %s for org %s (owner %s)",
            body.agent_type,
            job_id,
            body.organization_id,
            owner,
        )
        return WorkflowSubmitResponse(job_id=job_id)
