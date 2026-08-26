"""
NAT plugin registration for unified AI-Q API.

Combines Knowledge API (collections/documents) and Async Job API (agent jobs/SSE streaming).

Knowledge Layer Configuration:
    The Knowledge API uses the same ingestor instance as the knowledge_retrieval tool.
    Configure the backend via the knowledge_retrieval function in your workflow YAML:

    functions:
      knowledge_search:
        _type: knowledge_retrieval
        backend: foundational_rag
        rag_url: http://localhost:8081/v1
        ingest_url: http://localhost:8082/v1

    The API plugin will automatically use the configured backend. If no tool is
    configured, it falls back to environment variables (KNOWLEDGE_INGESTOR_BACKEND)
    or the default backend (llamaindex).
"""

import asyncio
import logging
import os
import signal
from collections.abc import Callable

from fastapi import APIRouter
from fastapi import FastAPI
from pydantic import Field
from typing_extensions import override

from aiq_agent.common.log_redaction import install_presigned_url_scrubbing
from aiq_agent.stages.delivery import register_stage_frame_sink
from aiq_api.auth.middleware import AuthMiddleware
from aiq_api.context_envelope import GridContextEnvelopeMiddleware
from nat.builder.workflow_builder import WorkflowBuilder
from nat.cli.register_workflow import register_front_end
from nat.data_models.config import Config
from nat.front_ends.fastapi.fastapi_front_end_config import FastApiFrontEndConfig
from nat.front_ends.fastapi.fastapi_front_end_plugin import FastApiFrontEndPlugin
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorkerBase

from .jobs.connection_manager import get_connection_manager
from .jobs.event_store import EventStore
from .routes.cards import add_card_catalog_routes
from .routes.collections import add_collection_routes
from .routes.config_info import add_config_info_routes
from .routes.consistency_check import add_consistency_check_routes
from .routes.document_search import add_document_search_routes
from .routes.documents import add_document_routes
from .routes.feedback_digest import add_feedback_digest_routes
from .routes.generate_conversation_title import add_generate_conversation_title_routes
from .routes.generate_summary import add_generate_summary_routes
from .routes.ingest import add_ingest_routes
from .routes.jobs import register_job_routes
from .routes.lesson_distill import add_lesson_distill_routes
from .routes.maintenance import add_maintenance_routes
from .routes.norms import add_norm_routes
from .routes.oib import add_oib_routes
from .routes.skill_review import add_skill_review_routes
from .routes.skills import add_skill_routes
from .websocket_reconnect import configure_websocket_auth
from .websocket_reconnect import install_reconnectable_handler
from .websocket_reconnect import send_stage_frame

logger = logging.getLogger(__name__)

install_reconnectable_handler()

# The post-answer stage frame channel (docs/architecture/post-answer-stages.md
# §2.7). `aiq_agent` owns the graph and may not import a WebSocket; this tier
# owns the socket and publishes the sink to it, the same inversion
# `register_context_appender` uses in the opposite direction.
#
# Registered at IMPORT of this module, next to the handler patch, because that is
# what "the front end starts up" means: a process that never loads this front end
# — a CLI run, a Dask job worker — leaves the sink unset, and a `frame` stage
# there still runs, is still bounded and still records its outcome. It simply has
# nobody to tell.
register_stage_frame_sink(send_stage_frame)


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


# Track if shutdown signal has been received (for force exit on second Ctrl+C)
_shutdown_signal_received = False


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


class AIQAPIWorker(FastApiFrontEndPluginWorker):
    """
    Worker that adds unified AI-Q API routes to the FastAPI app.

    Combines:
    - Knowledge API routes (collections, documents) - uses factory singleton
    - Async Job API routes (agent jobs, SSE streaming)
    """

    _original_sigint_handler: Callable | signal.Handlers | None = None
    _original_sigterm_handler: Callable | signal.Handlers | None = None

    @override
    def build_app(self) -> FastAPI:
        from aiq_agent.common.logging_utils import suppress_noisy_dependency_logs

        suppress_noisy_dependency_logs()

        app = super().build_app()

        app.title = "AI-Q API"
        app.description = "Async research jobs, knowledge management, and agent orchestration."
        app.version = "1.0.0"

        knowledge_router = APIRouter()
        add_collection_routes(knowledge_router)
        add_document_routes(knowledge_router)
        add_document_search_routes(knowledge_router)
        add_generate_summary_routes(knowledge_router)
        add_generate_conversation_title_routes(knowledge_router)
        add_consistency_check_routes(knowledge_router)
        add_feedback_digest_routes(knowledge_router)
        add_lesson_distill_routes(knowledge_router)
        add_ingest_routes(knowledge_router)
        add_oib_routes(knowledge_router)
        add_norm_routes(knowledge_router)
        add_maintenance_routes(knowledge_router)
        # Internal skills submit route (Agent Skills, successor of the ADR-0023
        # workflows submit route): same router/middleware treatment as
        # maintenance, so it stays off the external allowlist.
        add_skill_routes(knowledge_router)
        # Advisory LLM critique of a skill draft. Sits with the other
        # best-effort LLM routes rather than the submit route: it writes nothing
        # and always answers 200.
        add_skill_review_routes(knowledge_router)
        # Workflow-default model names for the org model-config UI (ADR-0014).
        add_config_info_routes(knowledge_router, self.config.llms)
        # The card catalog for the platform surface: what the agent can render.
        add_card_catalog_routes(knowledge_router)
        app.include_router(knowledge_router)
        logger.info("Knowledge API routes registered")

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
        configure_websocket_auth(validators=validators, require_auth=require_auth)
        logger.info(
            "AuthMiddleware registered (require_auth=%s, validators=%s)",
            require_auth,
            [type(v).__name__ for v in validators],
        )

        return app

    @override
    async def add_routes(self, app: FastAPI, builder: WorkflowBuilder):
        await super().add_routes(app, builder)

        # Presigned URLs are live bearer credentials to a tenant's objects, and
        # this tier handles them on every ingest. Scrubbing is installed on the
        # HANDLERS, once, rather than relied on at each call site: the leaks that
        # actually happened came through exception strings
        # (`str(httpx.HTTPStatusError)` embeds the request URL) and tracebacks,
        # i.e. from code that never mentioned a URL. Installed after
        # `super().add_routes` so the host's own handlers are in place first.
        install_presigned_url_scrubbing()

        # =====================================================================
        # Async Job API routes
        # =====================================================================
        await register_job_routes(app, builder, self)
        logger.info("Async Job API routes registered")

        # Non-blocking startup handshake against the frontend's internal API:
        # surfaces a GRID_INTERNAL_API_TOKEN mismatch / unreachable BFF at deploy
        # time instead of only when the first `remember` tool call fails. Fire-
        # and-forget (never awaited, never fatal) — add_routes has no clean
        # "after everything is up" hook and blocking here would delay serving,
        # so we schedule it on the running loop and let it log its own outcome.
        self._schedule_internal_api_check()

        self._install_signal_handlers()

        @app.on_event("shutdown")
        async def shutdown_sse_connections():
            """Gracefully close all active SSE connections and background tasks on shutdown."""
            logger.info("Shutting down SSE connections...")
            connection_manager = get_connection_manager()
            await connection_manager.shutdown(timeout=5.0)

            from .routes.jobs import stop_periodic_cleanup

            await stop_periodic_cleanup()

            await EventStore.dispose_all_engines_async()
            logger.info("SSE shutdown complete")

            self._restore_signal_handlers()

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
