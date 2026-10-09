"""
NAT plugin registration for unified AI-Q API.

One plugin, two web roles (``GRID_ROLE``, ``roles.WebRole``, ADR-0082 step B):

* ``chat`` mounts the chat socket, the chat-occupancy route KEDA reads, and
  what is left of NAT's own routes once its HTTP turn routes are off (see
  ``AIQAPIConfig``), and drains running chat turns at shutdown.
* ``api`` mounts the Knowledge API (collections/documents, the LLM utilities,
  admin), the Async Job API (agent jobs, SSE streaming, housekeeping) and the
  debug console, and closes its SSE streams at shutdown.

Both mount ``/health`` and the same auth and context-envelope middleware. A
route belongs to exactly one role; ``frontends/aiq_api/tests/test_roles.py``
holds that.

Knowledge Layer Configuration:
    The Knowledge API uses the same ingestor instance as the knowledge_retrieval tool.
    Configure it via the knowledge_retrieval function in your workflow YAML:

    functions:
      knowledge_search:
        _type: knowledge_retrieval
        collection_name: oib_knowledge

    The backend is llamaindex, the only one (ADR-0072). If no tool is
    configured, the API falls back to KNOWLEDGE_INGESTOR_BACKEND or llamaindex.
"""

import asyncio
import functools
import logging
import os
import signal
from collections.abc import Callable
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter
from fastapi import FastAPI
from pydantic import Field
from pydantic import model_validator
from typing_extensions import override

from aiq_agent.common.log_redaction import install_presigned_url_scrubbing
from aiq_agent.knowledge.leader_lock import require_direct_dsns
from aiq_agent.stages.delivery import register_stage_frame_sink
from aiq_api.auth.middleware import AuthMiddleware
from aiq_api.context_envelope import GridContextEnvelopeMiddleware
from nat.builder.workflow_builder import WorkflowBuilder
from nat.cli.register_workflow import register_front_end  # noqa: TID251
from nat.data_models.config import Config
from nat.data_models.step_adaptor import StepAdaptorConfig
from nat.data_models.step_adaptor import StepAdaptorMode
from nat.front_ends.fastapi.fastapi_front_end_config import FastApiFrontEndConfig
from nat.front_ends.fastapi.fastapi_front_end_plugin import FastApiFrontEndPlugin
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorkerBase
from nat.runtime.session import SessionManager

from .chat_socket import chat_socket_endpoint
from .chat_socket import configure_websocket_auth
from .chat_socket import drain_chat_turns
from .chat_socket import send_stage
from .health import install_health_route
from .inflight import InFlightMiddleware
from .jobs.connection_manager import get_connection_manager
from .jobs.event_store import EventStore
from .roles import WebRole
from .roles import web_role
from .routes.cards import add_card_catalog_routes
from .routes.chat_occupancy import add_chat_occupancy_routes
from .routes.collections import add_collection_routes
from .routes.config_info import add_config_info_routes
from .routes.consistency_check import add_consistency_check_routes
from .routes.dictation import add_dictation_routes
from .routes.document_search import add_document_search_routes
from .routes.documents import add_document_routes
from .routes.drafts import add_draft_routes
from .routes.feedback_digest import add_feedback_digest_routes
from .routes.generate_conversation_title import add_generate_conversation_title_routes
from .routes.generate_summary import add_generate_summary_routes
from .routes.ingest import add_ingest_routes
from .routes.jobs import register_job_routes
from .routes.lesson_distill import add_lesson_distill_routes
from .routes.mail_archive import add_mail_archive_routes
from .routes.maintenance import add_maintenance_routes
from .routes.norms import add_norm_routes
from .routes.note_embeddings import add_note_embedding_routes
from .routes.oib import add_oib_routes
from .routes.ris import add_ris_routes
from .routes.skill_review import add_skill_review_routes
from .routes.skills import add_skill_routes
from .startup_banner import log_boot_line

logger = logging.getLogger(__name__)

#: Where the chat socket is mounted: the path `server.js`, the scope route and
#: conversation affinity already use.
CHAT_SOCKET_PATH = "/websocket"

# The post-answer stage channel (docs/architecture/post-answer-stages.md §2.7).
# `aiq_agent` owns the graph and may not import a WebSocket; this tier owns the
# socket and publishes the sink to it, the same inversion
# `register_context_appender` uses in the opposite direction.
#
# Registered at IMPORT of this module, because that is what "the front end
# starts up" means: a process that never loads this front end — a CLI run, a
# research worker — leaves the sink unset, and a `frame` stage there still runs,
# is still bounded and still records its outcome. It simply has nobody to tell.
register_stage_frame_sink(send_stage)


_validators: list = []


def register_validator(validator) -> None:
    """Register a token validator with the API server.

    Call this before the server starts.  Validators are tried in order;
    the first successful result wins.  At least one validator must be
    registered when ``REQUIRE_AUTH=true``.

    Example::

        from aiq_api.plugin import register_validator
        from mypackage.auth import MyCustomValidator
        register_validator(MyCustomValidator(...))
    """
    _validators.append(validator)


def _load_validators_from_entry_points() -> list:
    """Discover validators registered via the ``aiq_api.validators`` entry-point group.

    Any installed package can contribute validators by declaring an entry point
    that returns a list of validator instances::

        # pyproject.toml (in the internal / deployment package)
        [project.entry-points."aiq_api.validators"]
        my_provider = "mypackage.auth:get_validators"

        # mypackage/auth.py
        def get_validators() -> list:
            return [MyValidator(...)]

    This is the recommended way to add validators from a private package that
    has the public aiq-api repo as a git submodule.
    """
    from importlib.metadata import entry_points

    validators = []
    for ep in entry_points(group="aiq_api.validators"):
        try:
            factory = ep.load()
            result = factory()
            validators.extend(result if isinstance(result, list) else [result])
            logger.info(
                "Loaded validators from entry point '%s': %s",
                ep.name,
                [type(v).__name__ for v in (result if isinstance(result, list) else [result])],
            )
        except Exception as e:
            logger.warning("Failed to load validators from entry point '%s': %s", ep.name, e)
    return validators


#: The fields of a NAT endpoint config that each mount a route running the
#: workflow: the HTTP turn routes and NAT's own WebSocket. ``AIQAPIConfig`` leaves
#: every one unset and refuses a config that sets one.
WORKFLOW_ROUTE_FIELDS = (
    "path",
    "legacy_path",
    "openai_api_path",
    "legacy_openai_api_path",
    "openai_api_v1_path",
    "websocket_path",
)


class AIQAPIConfig(FastApiFrontEndConfig, name="aiq_api"):
    """
    Configuration for unified AI-Q API endpoints.

    Knowledge API:
        Automatically enabled when a knowledge_retrieval function is configured.
        Backend settings are inherited from that function's config.

    Async Job API:
        Configure db_url and expiry_seconds for job persistence.
    """

    db_url: str = Field(
        default="sqlite+aiosqlite:///./jobs.db",
        description="Database URL for job store and event store",
    )
    expiry_seconds: int = Field(
        default=86400,
        ge=600,
        le=604800,
        description="Job expiry time in seconds (default: 24 hours)",
    )
    # The chat wire is ours (ADR-0068), and it is the only way in to a turn. NAT
    # mounts no WebSocket route and none of its HTTP turn routes, and its step
    # adaptor, which fed them, is off. Steps still reach the exporters, which
    # subscribe to the step manager and not to the adaptor.
    workflow: FastApiFrontEndConfig.EndpointBase = FastApiFrontEndConfig().workflow.model_copy(
        update=dict.fromkeys(WORKFLOW_ROUTE_FIELDS)
    )
    # `/evaluate` runs the workflow over a dataset; evaluation runs `nat eval`.
    # `/evaluate/item` scores an answer it is given and runs no turn, so it stays.
    evaluate: FastApiFrontEndConfig.EndpointBase = FastApiFrontEndConfig().evaluate.model_copy(update={"path": None})
    step_adaptor: StepAdaptorConfig = StepAdaptorConfig(mode=StepAdaptorMode.OFF)

    @model_validator(mode="after")
    def _the_chat_socket_is_the_only_turn_route(self) -> "AIQAPIConfig":
        """Refuse a config that puts a NAT route in front of the workflow, rather than serve it.

        NAT's defaults put the workflow behind ``/v1/workflow*``, ``/generate*``,
        ``/v1/chat*`` (its OpenAI-compatible completions among them), ``/chat*``
        and ``/websocket``. Each of those skips what the chat socket does per
        turn: admission, the conversation fence, cancel, replay, the persisted
        answer, and the ``finally`` that always sends a terminal. They stream through NAT's
        ``generate_streaming_response``, whose early stop leaves the producer
        running (``workflow_stream`` has the account), and with the step adaptor
        off they carry none of the steps a reader is shown. ``/websocket`` is the
        chat socket's own path. An extra ``endpoints`` entry mounts the same set
        for another function.
        """
        served = [f"workflow.{name}" for name in WORKFLOW_ROUTE_FIELDS if getattr(self.workflow, name)]
        served += ["evaluate.path"] if self.evaluate.path else []
        served += [f"endpoints[{endpoint.function_name}]" for endpoint in self.endpoints]
        if served:
            raise ValueError(
                f"aiq_api serves a turn over its own chat socket only (ADR-0068); leave {', '.join(served)} unset"
            )
        return self


# Track if shutdown signal has been received (for force exit on second Ctrl+C)
_shutdown_signal_received = False


async def drain_owned_work(role: WebRole) -> None:
    """The role's drain at shutdown: let what it holds finish, then close what it opened.

    ``chat`` holds running chat turns, and waits for them: they keep publishing
    to the conversation stream while the pod's grace period runs, which is what
    lets a reader on another replica stream them to the end (ADR-0080). It holds
    no SSE stream, so it closes none. ``api`` is the reverse: its long-lived
    connections are the SSE job streams, closed on a short timeout, and it runs
    no chat turn. Ingestion is claimed by its own tier and is held by neither.
    """
    if role is WebRole.CHAT:
        await drain_chat_turns()
    else:
        logger.info("Shutting down SSE connections...")
        await get_connection_manager().shutdown(timeout=5.0)
    await EventStore.dispose_all_engines_async()
    logger.info("Shutdown complete (%s)", role.value)


def _create_shutdown_signal_handler(
    original_handler: Callable | signal.Handlers | None,
    sig: signal.Signals,
) -> Callable:
    """
    Create a signal handler that signals SSE shutdown before calling the original handler.

    This ensures SSE connections are notified of shutdown before uvicorn cancels tasks.
    On second signal, force exits immediately.
    """

    def handler(signum, frame):
        global _shutdown_signal_received

        if _shutdown_signal_received:
            logger.warning("Second %s received, forcing exit...", sig.name)
            os._exit(1)

        _shutdown_signal_received = True
        logger.info("Signal %s received, signaling SSE shutdown... (press again to force quit)", sig.name)
        connection_manager = get_connection_manager()

        connection_manager.signal_shutdown()

        if original_handler and callable(original_handler):
            original_handler(signum, frame)
        elif original_handler == signal.SIG_DFL:
            signal.signal(sig, signal.SIG_DFL)
            signal.raise_signal(sig)

    return handler


#: The routers the ``chat`` role mounts on its router. The chat socket and what
#: is left of NAT's own routes are the rest of what it serves
#: (``AIQAPIWorker._add_chat_routes``).
CHAT_ROUTERS: tuple[Callable[[APIRouter], None], ...] = (
    # The chat tier's scaling signal, read by KEDA (ADR-0080). Internal-token
    # only, so it stays off the external allowlist like the maintenance routes.
    add_chat_occupancy_routes,
)

#: The app-level registrars the ``api`` role mounts beside its router: they need
#: the app, the workflow builder and the worker, not a router alone.
API_APP_REGISTRARS = (register_job_routes,)


def api_routers(llm_configs: Mapping[str, Any]) -> tuple[Callable[[APIRouter], None], ...]:
    """The routers the ``api`` role mounts on its router.

    A function and not a constant because one of them reads the loaded
    workflow's ``llms`` (the org model-config UI's defaults, ADR-0014).
    """
    return (
        add_collection_routes,
        add_document_routes,
        add_document_search_routes,
        add_generate_summary_routes,
        add_generate_conversation_title_routes,
        add_dictation_routes,
        add_consistency_check_routes,
        add_feedback_digest_routes,
        add_lesson_distill_routes,
        add_note_embedding_routes,
        add_ingest_routes,
        # Reads an Outlook archive the BFF staged, for its mail import (ADR-0085).
        # Internal-token only, off the external allowlist.
        add_mail_archive_routes,
        add_oib_routes,
        add_norm_routes,
        # A RIS document as text, so a RIS citation opens INSIDE Piloti rather
        # than in a browser tab (#622). Same client, same allow-list, same cache
        # as the agent's own ris_fetch_document.
        add_ris_routes,
        add_maintenance_routes,
        # The working directory's cleanup door. Internal-token only, like the
        # maintenance purges: a conversation's drafts live in the LangGraph
        # store, which the BFF cannot reach, so its conversation deletion calls
        # this or the bytes outlive the conversation.
        add_draft_routes,
        # Internal skills submit route (Agent Skills, successor of the ADR-0023
        # workflows submit route): same router/middleware treatment as
        # maintenance, so it stays off the external allowlist.
        add_skill_routes,
        # Advisory LLM critique of a skill draft. Sits with the other
        # best-effort LLM routes rather than the submit route: it writes nothing
        # and always answers 200.
        add_skill_review_routes,
        # Workflow-default model names for the org model-config UI (ADR-0014).
        functools.partial(add_config_info_routes, llm_configs=llm_configs),
        # The card catalog for the platform surface: what the agent can render.
        add_card_catalog_routes,
    )


class AIQAPIWorker(FastApiFrontEndPluginWorker):
    """
    Worker that adds the AI-Q routes of one web role to the FastAPI app.

    ``api``:
    - Knowledge API routes (collections, documents) - uses factory singleton
    - Async Job API routes (agent jobs, SSE streaming, housekeeping)

    ``chat``:
    - The chat socket (ADR-0068), the one route a turn runs through
    - NAT's own routes that run no turn (the OAuth callback, its execution
      store, ``/evaluate/item``, the MCP tool list)
    """

    _original_sigint_handler: Callable | signal.Handlers | None = None
    _original_sigterm_handler: Callable | signal.Handlers | None = None

    def __init__(self, config: Config):
        # Before anything connects to anything: a process that does not know its
        # role stops here, with the one variable to set in the message.
        self._role = web_role()
        super().__init__(config)

    @override
    def build_app(self) -> FastAPI:
        from aiq_agent.common.logging_utils import suppress_noisy_dependency_logs

        suppress_noisy_dependency_logs()

        # What this process is, before it registers a single route (ledger item
        # 1): the deployed commit and the effective value of the four gates, on
        # one greppable line. A pilot report that arrives a week later is
        # otherwise unanswerable — nobody could say which build ran, and three
        # of the four gates default off, so "broken" and "never enabled" look
        # the same from outside. Same line shape as the BFF's, deliberately;
        # see startup_banner's module docstring, including why the flags this
        # tier reports are its own rather than the frontend's.
        log_boot_line()
        logger.info("Web role: %s", self._role.value)

        # A web process on Postgres needs the direct lock DSN (session advisory
        # locks), and the api role also the direct LISTEN DSN, because it serves
        # the job SSE streams. The chat role serves none: its stream is the
        # socket, over Dragonfly. Fail the boot, not every request (ADR-0083).
        require_direct_dsns(listen=self._role is WebRole.API)

        app = super().build_app()

        if self._role is WebRole.API:
            app.title = "AI-Q API"
            app.description = "Async research jobs, knowledge management, and agent orchestration."
        else:
            app.title = "AI-Q Chat"
            app.description = "The chat socket and the answers running on it."
        app.version = "1.0.0"

        router = APIRouter()
        for add_router_routes in api_routers(self.config.llms) if self._role is WebRole.API else CHAT_ROUTERS:
            add_router_routes(router)
        app.include_router(router)
        logger.info("%s routes registered", self._role.value)

        require_auth = os.getenv("REQUIRE_AUTH", "false").lower() == "true"
        validators = _validators + _load_validators_from_entry_points()
        if require_auth and not validators:
            raise RuntimeError(
                "REQUIRE_AUTH=true but no validators have been registered. "
                "Either call aiq_api.plugin.register_validator() before starting the server, "
                "or declare an 'aiq_api.validators' entry point in your package."
            )
        # NOTE on ordering: Starlette's add_middleware() makes each newly
        # added middleware the new OUTERMOST layer, so whichever is added
        # LAST runs FIRST on the way in. GridContextEnvelopeMiddleware is
        # added BEFORE AuthMiddleware here so that AuthMiddleware (added,
        # and therefore outer, second) always resolves scope["state"]["user"]
        # before the envelope-enforcement middleware reads it for HTTP
        # requests. See aiq_api.context_envelope's module docstring for the
        # full enforcement design (matrix, WebSocket handling, exemptions).
        app.add_middleware(GridContextEnvelopeMiddleware, require_auth=require_auth, validators=validators)
        app.add_middleware(AuthMiddleware, validators=validators, require_auth=require_auth)
        # Added last, so outermost: it counts every HTTP request this process
        # takes, the ones auth refuses included, which is the load the scaling
        # signal must see. See aiq_api.inflight.
        app.add_middleware(InFlightMiddleware, role=self._role.value)
        if self._role is WebRole.CHAT:
            configure_websocket_auth(validators=validators, require_auth=require_auth)
        logger.info(
            "AuthMiddleware registered (require_auth=%s, validators=%s)",
            require_auth,
            [type(v).__name__ for v in validators],
        )

        return app

    @override
    async def add_default_route(self, app: FastAPI, session_manager: SessionManager):
        """Nothing: a turn's one route is the chat socket, which ``_add_chat_routes`` mounts.

        NAT's version mounts the generate, chat and socket routes the
        ``workflow`` config names, which ``AIQAPIConfig`` leaves unset. It also
        mounts the async generate route whenever a Dask scheduler is reachable,
        whatever the config says, as ``None/async`` when ``workflow.path`` is
        unset. So the routes are left out here, not by the config alone.
        """

    @override
    async def add_routes(self, app: FastAPI, builder: WorkflowBuilder):
        if self._role is WebRole.CHAT:
            await self._add_chat_routes(app, builder)
        else:
            await self._add_api_routes(app, builder)

        # One /health for both roles, ours and not NAT's: the sha and the role,
        # no database ping (aiq_api.health). Last, so it replaces the NAT route
        # `super().add_routes` mounted on chat.
        install_health_route(app, self._role)

        # Presigned URLs are live bearer credentials to a tenant's objects, and
        # this tier handles them on every ingest. Scrubbing is installed on the
        # HANDLERS, once, rather than relied on at each call site: the leaks that
        # actually happened came through exception strings
        # (`str(httpx.HTTPStatusError)` embeds the request URL) and tracebacks,
        # i.e. from code that never mentioned a URL. Installed after the routes
        # so the host's own handlers are in place first.
        install_presigned_url_scrubbing()

        # The workflow is built and every route registered: this replica serves
        # from here, and the meter provider exists to take the boot readings.
        # Both roles, so the chat tier's cold start is a series too.
        from aiq_agent.observability import boot_timing

        boot_timing.BootClock(self._role.value).ready()
        boot_timing.flush()

        # Non-blocking startup handshake against the frontend's internal API:
        # surfaces a GRID_INTERNAL_API_TOKEN mismatch / unreachable BFF at deploy
        # time instead of only when the first `remember` tool call fails. Fire-
        # and-forget (never awaited, never fatal) — add_routes has no clean
        # "after everything is up" hook and blocking here would delay serving,
        # so we schedule it on the running loop and let it log its own outcome.
        self._schedule_internal_api_check()

        self._install_signal_handlers()

        @app.on_event("shutdown")
        async def drain_role():
            """Let this role's work finish, then close what it opened (``drain_owned_work``)."""
            await drain_owned_work(self._role)
            self._restore_signal_handlers()

    async def _add_chat_routes(self, app: FastAPI, builder: WorkflowBuilder) -> None:
        """What only ``chat`` serves: the chat socket, and NAT's own routes that run no turn."""
        await super().add_routes(app, builder)

        # The chat socket (ADR-0068), on the worker's own session manager so
        # NAT shuts it down with the others.
        session_manager = await self._create_chat_session_manager(builder)
        app.add_api_websocket_route(CHAT_SOCKET_PATH, chat_socket_endpoint(session_manager))

    async def _add_api_routes(self, app: FastAPI, builder: WorkflowBuilder) -> None:
        """What only ``api`` serves beside its router: the job routes and the debug console.

        NAT's own routes (execution, the OAuth callback, evaluate item, monitor,
        static, MCP) belong to ``chat`` alone: nothing calls them on this tier.
        """
        for register in API_APP_REGISTRARS:
            await register(app, builder, self)
        logger.info("Async Job API routes registered")

        enable_debug = os.environ.get("AIQ_ENABLE_DEBUG", "true").lower() not in {"0", "false", "no", "off"}
        if enable_debug:
            try:
                from aiq_debug import register_debug_routes

                await register_debug_routes(app)
                logger.info("Debug console registered at /debug")
            except ImportError:
                pass
        else:
            logger.info("Debug console disabled by AIQ_ENABLE_DEBUG")

    async def _create_chat_session_manager(self, builder: WorkflowBuilder) -> SessionManager:
        """The chat socket's session manager, with NAT's concurrency gate off (``max_concurrency=0``).

        NAT's default gate (8) is an ``asyncio.Semaphore`` held for the whole
        ``Session.run``: a turn waiting on a person's answer kept its place for
        up to ``GRID_HITL_RESPONSE_TIMEOUT_SECONDS``, and the ninth turn queued
        behind them unseen, after ``RUN_STARTED``, while its heartbeat kept the
        reader's spinner alive. Nobody chose that number. The chosen gate is
        ADR-0040's admission (``aiq_agent.common.turn_admission``,
        ``GRID_MAX_ACTIVE_TURNS``), held around every chat turn, which refuses
        a turn it has no slot for at once with a retry hint instead of queueing
        it. Registered with the worker's others so NAT shuts it down with them.
        """
        session_manager = await SessionManager.create(config=self._config, shared_builder=builder, max_concurrency=0)
        self._session_managers.append(session_manager)
        return session_manager

    def _schedule_internal_api_check(self):
        """Fire-and-forget the internal-API startup handshake (never fatal).

        Runs the blocking urllib probe in a worker thread so it cannot stall the
        event loop, and swallows/logs any failure — a broken or not-yet-up
        frontend must never prevent the backend from serving.
        """

        async def _run() -> None:
            try:
                from aiq_agent.knowledge.project_memory import check_internal_api

                await asyncio.to_thread(check_internal_api)
            except Exception as e:  # noqa: BLE001 — diagnostic only, must not crash startup
                logger.warning("Internal API startup handshake could not run: %s", e)

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            # No running loop (unexpected here) — skip the diagnostic silently.
            logger.debug("No running loop for the internal API handshake; skipping")

    def _install_signal_handlers(self):
        """Install signal handlers to notify SSE connections on shutdown."""
        try:
            self._original_sigint_handler = signal.getsignal(signal.SIGINT)
            self._original_sigterm_handler = signal.getsignal(signal.SIGTERM)

            signal.signal(
                signal.SIGINT,
                _create_shutdown_signal_handler(self._original_sigint_handler, signal.SIGINT),
            )
            signal.signal(
                signal.SIGTERM,
                _create_shutdown_signal_handler(self._original_sigterm_handler, signal.SIGTERM),
            )
            logger.debug("Installed SSE shutdown signal handlers")
        except Exception as e:
            logger.warning("Failed to install signal handlers: %s", e)

    def _restore_signal_handlers(self):
        """Restore original signal handlers."""
        try:
            if self._original_sigint_handler is not None:
                signal.signal(signal.SIGINT, self._original_sigint_handler)
            if self._original_sigterm_handler is not None:
                signal.signal(signal.SIGTERM, self._original_sigterm_handler)
            logger.debug("Restored original signal handlers")
        except Exception as e:
            logger.warning("Failed to restore signal handlers: %s", e)


class AIQAPIPlugin(FastApiFrontEndPlugin):
    """Plugin that adds unified AI-Q API endpoints to the FastAPI server."""

    def __init__(self, full_config: Config, config: AIQAPIConfig):
        super().__init__(full_config=full_config)
        self.config = config

    @override
    def get_worker_class(self) -> type[FastApiFrontEndPluginWorkerBase]:
        return AIQAPIWorker


@register_front_end(config_type=AIQAPIConfig)
async def register_aiq_api(config: AIQAPIConfig, full_config: Config):
    """Register unified AI-Q API with NAT framework."""
    yield AIQAPIPlugin(full_config=full_config, config=config)
