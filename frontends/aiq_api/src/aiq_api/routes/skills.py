"""Internal skills submit endpoint (Agent Skills, replaces ADR-0023 workflows).

``POST /v1/internal/skills/submit`` is the single backend entry point for
scheduled and manual skill runs (the successor of ``/v1/internal/workflows/
submit``). The BFF's fire path calls it service-to-service; there is no live
user JWT, so the skill run's identity (organization, user, project, owner
email) is supplied explicitly in the body and reconstituted into a Principal +
usage context here.

The route wraps ``submit_agent_job`` exactly like the public
``/v1/jobs/async/submit`` route, so scheduled runs inherit admission control,
cost tracking, ownership (``job_access``), the ghost reaper, SSE and
cancellation for free.

Agent selection is DETERMINISTIC and derived from the JOB's chosen output kind.
A skill no longer declares how it runs — scheduling is a property of the job (a
prompt on a timer), and the output kind is the user's choice on that job:

* ``output='chat'``          → ``shallow_researcher`` (quick single-turn job)
* ``output='deep-research'`` → ``deep_researcher`` (the deep research agent)

``agent_type`` is an explicit escape hatch for future output kinds; when
omitted the table above decides. The submitted job carries the skill names in
``force_skills`` so the worker force-activates them (the agent-side consumer
lives in ``src/aiq_agent``); a job may legitimately attach NO skill at all, in
which case the list is empty and the run is the prompt alone.

Guarded by ``GRID_INTERNAL_API_TOKEN`` (the ``maintenance.py`` pattern) and,
critically, NOT added to ``AuthMiddleware.EXTERNAL_ALLOWED_PATHS`` — so it is
unreachable from outside the compose network. (The signed X-Grid-Request-Context
envelope middleware enforces this path too, but internal-token calls are
exempt there by design — see ``context_envelope.py``.)
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel
from pydantic import Field
from pydantic import model_validator

from aiq_agent.auth import Principal
from aiq_agent.common.job_admission import JobAdmissionError

from ..registry import get_agent_config
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

# The JOB's chosen output kind maps onto exactly one async-job-capable agent
# type. Both entries are registered in AGENT_REGISTRY at import time
# (deep_researcher, shallow_researcher). Deterministic by construction: there is
# no path from an output kind to "some other agent".
#
# The mapping itself is unchanged; only where the value comes from moved. It
# used to be read off the skill's ``grid-execution`` metadata, which made a
# skill declare how it ran. It is now a column on the job row, chosen by the
# user, and a skill is merely attached on top.
_OUTPUT_AGENT_TYPES: dict[str, str] = {
    "chat": "shallow_researcher",
    "deep-research": "deep_researcher",
}


class SkillSubmitPayload(BaseModel):
    """Body of ``POST /v1/internal/skills/submit`` (Agent Skills contract).

    Identity fields are supplied explicitly because the caller is the scheduler
    / BFF, not the skill's owner — there is no request JWT to read them from.
    ``organization_id`` is required so per-org admission counting and cost
    attribution always have a tenant to key on. ``input`` is the deterministic
    prompt built BFF-side.
    """

    # `input` is a COMPOSED prompt: the job's own prompt, plus the full body of
    # the attached skill when there is one. Either part alone fits inside the
    # 32000-char skill-body limit (MAX_SKILL_BODY_LENGTH), but their sum need
    # not, so the ceiling is 48000 here. It is a ceiling, not a target: an
    # over-long prompt is rejected with a 422 and never silently truncated,
    # because a run that quietly drops half its instructions is worse than one
    # that refuses to start.
    input: str = Field(
        ...,
        min_length=1,
        max_length=48000,
        description="Composed job prompt (job prompt + the attached skill's body, when a skill is attached)",
    )
    skills: list[str] = Field(
        default_factory=list,
        description="Skill names to force-activate for this run; empty = no skill attached, the prompt runs alone",
    )
    # The wire field is `output`; `execution` is the pre-rename spelling, kept
    # readable for ONE release. The BFF and this service deploy separately, and
    # a hard rename would fail every scheduled run in the window between the two
    # deploys — precisely the window nobody is watching. Delete `execution`
    # (and `_resolved_output`'s fallback) once the BFF that sends `output` is
    # deployed everywhere.
    output: Literal["chat", "deep-research"] | None = Field(
        None,
        description="The job's chosen output kind; decides the agent",
    )
    execution: Literal["chat", "deep-research"] | None = Field(
        None,
        description="Deprecated pre-rename alias for `output`; used only when `output` is absent",
    )
    agent_type: str | None = Field(
        None,
        description="Explicit agent type override; defaults to the output-kind agent",
    )
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
    user_id: str | None = Field(None, description="Skill owner's WorkOS user id")
    project_id: str | None = Field(None, description="Project id the skill run is scoped to")
    conversation_id: str | None = Field(
        None,
        description=(
            "Conversation the BFF created for this run to land in (output='chat' jobs only). "
            "Absent for deep-research jobs, and for any run whose conversation could not be created."
        ),
    )
    owner_email: str | None = Field(None, description="Skill owner's email (job ownership)")
    budget_header: str | None = Field(
        None,
        description="Pass-through X-Grid-Budget header value the BFF builds for interactive submits",
    )
    model_overrides: dict[str, str] | None = Field(
        None,
        description="Per-org runtime model overrides ({agent_group: model})",
    )

    @model_validator(mode="after")
    def _require_an_output_kind(self) -> SkillSubmitPayload:
        """One of ``output`` / ``execution`` must be present.

        Both are Optional so either spelling satisfies the schema during the
        rename window, which leaves "neither" structurally legal — and reading
        an absent key straight out of the agent table would be a KeyError, i.e.
        a 500 on a payload the caller got wrong. Rejecting it here makes it the
        422 it always was.
        """
        if self.output is None and self.execution is None:
            raise ValueError("one of 'output' or 'execution' is required")
        return self

    @property
    def resolved_output(self) -> str:
        """The output kind to run: ``output`` when sent, else ``execution``.

        The validator guarantees at least one is set. When a caller sends both
        (it should not), ``output`` wins — it is the field that survives the
        rename — and a disagreement is logged rather than guessed at silently.
        """
        if self.output is not None:
            if self.execution is not None and self.execution != self.output:
                logger.warning(
                    "Skill submit sent conflicting output=%s and execution=%s; using output",
                    self.output,
                    self.execution,
                )
            return self.output
        assert self.execution is not None  # noqa: S101 - guaranteed by _require_an_output_kind
        return self.execution


class SkillSubmitResponse(BaseModel):
    job_id: str = Field(..., description="The submitted async job id")


def add_skill_routes(router: APIRouter) -> None:
    """Register the internal skills submit route.

    Wired alongside the maintenance routes (same router, same middleware
    treatment) so it stays internal-only. Heavy job-submission imports are
    deferred to request time, matching the maintenance/jobs modules.
    """

    @router.post(
        "/v1/internal/skills/submit",
        response_model=SkillSubmitResponse,
        tags=["skills", "internal"],
        summary="Submit a skill run to the async research pipeline (internal)",
        responses={
            400: {"description": "Unknown agent type"},
            403: {"description": "Missing or invalid internal token"},
            409: {"description": "A job with the supplied job_id already exists"},
            422: {"description": "Invalid payload, or unknown/agent-unavailable data source IDs"},
            429: {"description": "Admission control: active-job cap reached"},
            503: {"description": "Internal API disabled, or Dask scheduler not configured"},
        },
    )
    async def submit_skill(body: SkillSubmitPayload, request: Request) -> SkillSubmitResponse:
        _require_internal_token(request)

        # Import the async-job layer lazily (it pulls NAT/Dask) so this module
        # stays cheap to import next to the maintenance routes.
        from ..jobs.submit import DuplicateJobIdError
        from ..jobs.submit import MissingPrincipalError
        from ..jobs.submit import SchedulerNotConfiguredError
        from ..jobs.submit import submit_agent_job as submit_authorized_job
        from .builder_state import get_active_builder

        # Deterministic agent selection (see module docstring): the job's chosen
        # output kind decides the agent, unless an explicit override arrived.
        # Never substitutes one output kind for another.
        output = body.resolved_output
        agent_type = body.agent_type or _OUTPUT_AGENT_TYPES[output]

        # Validate agent_type against the registry, like the public submit route.
        try:
            agent_config = get_agent_config(agent_type)
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
                agent_type=agent_type,
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
                "Skill submit before job routes registered a builder: "
                "validated %d data source(s) against the registry only",
                len(body.data_sources),
            )

        # Reconstitute the skill owner's identity. The job is owned by the
        # owner (type "jwt" matches the WorkOS-authenticated principal they
        # present when later viewing the run), so existing job-access authz
        # keeps working. Fall back through email/org when the owner id is
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
                "conversation_id": body.conversation_id,
            },
            "budget_header": body.budget_header,
        }

        try:
            job_id = await submit_authorized_job(
                agent_type=agent_type,
                input_text=body.input,
                owner=owner,
                principal=principal,
                job_id=body.job_id,
                data_sources=body.data_sources,
                collection_scope=body.collection_scope,
                project_context=body.project_context,
                model_overrides=body.model_overrides,
                usage_context=usage_context,
                force_skills=body.skills,
                # Explicit, because a scheduled run has no request context to
                # inherit one from. This is what lets the worker write the
                # answer into a thread a human can open and continue.
                conversation_id=body.conversation_id,
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
            logger.exception("Runtime error submitting skill %s job", agent_type)
            raise HTTPException(500, "Failed to submit skill job")
        except Exception as exc:
            logger.warning("Failed to submit skill job: %s", exc)
            raise HTTPException(500, "Failed to persist skill job authorization metadata")

        logger.info(
            "Submitted skill %s job %s for org %s (owner %s, output %s, %d forced skill(s))",
            agent_type,
            job_id,
            body.organization_id,
            owner,
            output,
            len(body.skills),
        )
        return SkillSubmitResponse(job_id=job_id)
