"""OpenRouter server-side tool search + deferred tool loading.

WHAT THIS BUYS, AND WHAT IT COSTS
=================================
Every research turn of the shallow agent ships the JSON schema of every bound
tool. On the OIB surface ``ifc_query`` and ``ifc_measure`` alone are ~36 KB of
that payload, and they ride on all five tool iterations whether or not the
question is about the building at all.

OpenRouter's Responses API can hold those schemas SERVER-SIDE: the request
declares the tools as *deferred*, sends a ``tool_search`` tool alongside them,
and the model searches, loads and calls the one it needs **inside a single
response** — no discovery round trip, no extra output item the agent has to
route, no second turn. That last property is the whole reason this is
acceptable here at all: this agent force-synthesizes at
``max_tool_iterations`` (5), so a discovery call would cost 20 % of everything
it will ever do about the question — the same argument that keeps the
client-side BM25 narrowing (``shallow_researcher/tool_search.py``) outside the
tool loop.

It is not free. The tool-search apparatus itself costs input tokens (measured:
~600 on an otherwise empty request), so on a small or cheap tool set deferral
is a LOSS. Turn it on where the withheld schemas are large — that is the
measurement to make per deployment, not an assumption to carry.

THE SHAPE, AND THE GOTCHA THAT DEFINES IT
=========================================
``defer_loading: true`` on a top-level function tool is **silently dropped**:
OpenRouter's ``FunctionTool`` schema has no such field, so the flag never
reaches the provider and the request arrives with a ``tool_search`` tool and
nothing to search. The observable symptom is not a warning — it is a 400 from
the upstream provider::

    Invalid Value: 'tools.tool_search'.
    tools.tool_search requires at least one deferred tool.

Only ``NamespaceFunctionTool`` carries ``defer_loading``. So the tools must be
wrapped in ONE ``namespace`` tool::

    [{"type": "tool_search"},
     {"type": "namespace", "name": "piloti", "description": "…",
      "tools": [{"type": "function", "name": "ifc_measure", "description": "…",
                 "parameters": {…}, "defer_loading": true}, …]}]

Two details that are easy to get wrong and that :func:`build_deferred_tool_payload`
therefore owns:

* ``{"type": "tool_search"}`` is the INPUT spelling. ``openrouter:tool_search``
  is the *output* item type; sending it as input is a 400.
* the functions inside the namespace must already be in the flat Responses
  shape (``{"type": "function", "name": …}``). langchain-openai's
  ``_construct_responses_api_payload`` flattens the chat shape
  (``{"type": "function", "function": {…}}``) only at the TOP level — a nested
  tool is passed through verbatim, so a chat-shaped function inside the
  namespace reaches OpenRouter unflattened.

WHY NOT ``bind_tools``
======================
langchain-openai 1.2.2 has its own ``defer_loading`` support: ``bind_tools``
copies ``tool.extras["defer_loading"]`` onto the formatted tool. That produces
the top-level flat function with ``defer_loading`` — precisely the shape
OpenRouter drops. Using it would look configured and defer nothing, which is
the exact failure this module exists to make impossible. So the conversion
happens here and the finished payload goes through ``llm.bind(tools=…)``.

FAILURE POLICY
==============
Loud where it is free, silent-degrading where a user is waiting:

* BUILD time — :func:`verify_deferred_tool_loading` runs one live capability
  probe and RAISES :class:`DeferredToolLoadingError` if the provider did not
  echo the deferred shape back. A deployment that asked for deferral and did
  not get it fails to start rather than quietly paying for a feature it does
  not have. No user turn exists yet, so nothing is lost.
* REQUEST time — :class:`DeferredToolBinding` falls back to the ordinary
  full-schema binding on any error, logs it at ERROR, and latches the deferred
  path off for the rest of the process so the next four iterations do not each
  pay for the same failing round trip. Degrading to today's behaviour costs
  tokens; failing costs the answer.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from langchain_core.runnables import Runnable
from pydantic import BaseModel
from pydantic import Field

logger = logging.getLogger(__name__)

#: Input spelling of OpenRouter's server-side tool search. NOT
#: ``openrouter:tool_search`` — that is the output item type and 400s as input.
TOOL_SEARCH_TOOL: dict[str, Any] = {"type": "tool_search"}

#: The one namespace-tool type that carries ``defer_loading`` per function.
NAMESPACE_TOOL_TYPE = "namespace"


class DeferredToolLoadingError(RuntimeError):
    """The deferred tool payload was not built, or not accepted, as declared.

    Raised only where raising is free — payload construction and the build-time
    capability probe. Request-time failures degrade instead (see
    :class:`DeferredToolBinding`).
    """


class DeferredToolLoadingSettings(BaseModel):
    """Config for OpenRouter server-side tool search. Off unless asked for.

    Absent from a workflow YAML this validates to ``enabled=False`` and every
    binding path below is byte-identical to the one the agent has always taken.
    The Chat-Completions deployments (``config_grid_oib.yml`` against
    ``api.kimi.com``) have no such capability and must never be handed this.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Declare the agent's tools as deferred and let OpenRouter search and load "
            "them server-side, instead of shipping every schema on every request. "
            "Requires an OpenRouter LLM with `api_type: responses`. Off by default: "
            "the tool-search apparatus costs input tokens of its own, so it only pays "
            "where the withheld schemas are large."
        ),
    )
    namespace: str = Field(
        default="piloti",
        description=(
            "Name of the single namespace tool the function tools are wrapped in. "
            "`defer_loading` is only carried by namespaced functions — a top-level "
            "function tool silently drops it."
        ),
    )
    namespace_description: str = Field(
        default=(
            "Werkzeuge dieses Agenten: IFC-Modellabfragen und -Messungen, "
            "österreichisches Baurecht und OIB-Richtlinien, Wissensbasis, "
            "Websuche, Projektgedächtnis und UI-Karten."
        ),
        description=(
            "Description of the namespace. This is the ONLY tool text sent up front, so "
            "it is what the server-side search matches the user's turn against before "
            "any schema is loaded."
        ),
    )


def tool_payload_name(tool: object) -> str | None:
    """Return a tool's name across the several shapes LangChain passes around.

    Shared with :class:`~aiq_agent.agents.deep_researcher.custom_middleware.ToolVisibilityMiddleware`,
    which filters model-request tools by name: a request's ``tools`` list may
    hold ``BaseTool`` objects, chat-shaped dicts (``{"function": {"name": …}}``)
    or already-flat Responses dicts, and every caller that reasons about tool
    identity needs all three.
    """
    name = getattr(tool, "name", None)
    if isinstance(name, str):
        return name
    if isinstance(tool, dict):
        dict_name = tool.get("name")
        if isinstance(dict_name, str):
            return dict_name
        function = tool.get("function")
        if isinstance(function, dict):
            function_name = function.get("name")
            if isinstance(function_name, str):
                return function_name
    return None


def _llm_base_url(llm: Any) -> str:
    from aiq_agent.common.llm_factory import _llm_base_url as base_url

    return base_url(llm)


def supports_deferred_tool_loading(llm: Any) -> bool:
    """True when this chat model can carry the deferred shape at all.

    Two conditions, both structural rather than advisory: the traffic has to go
    to OpenRouter (nothing else implements ``tool_search``), and the client has
    to be on the Responses API (``api_type: responses`` in the NAT LLM config —
    the Chat Completions payload has no place to put a namespace tool).

    Checked per LLM INSTANCE, not once per deployment, because the per-org
    override seam (``model_overrides``) can hand a research turn a different
    model than the one the workflow was built against.
    """
    from aiq_agent.common.llm_factory import llm_targets_openrouter

    return bool(llm_targets_openrouter(llm)) and bool(getattr(llm, "use_responses_api", False))


def _flatten_function_tool(tool: object) -> dict[str, Any]:
    """Return one tool as a flat Responses-API function dict.

    Accepts what the agent actually holds — ``BaseTool`` instances — as well as
    the two dict shapes a tool list can already be in. The flat shape is
    produced HERE rather than left to langchain-openai because that flattening
    only runs on top-level tools and these end up nested in a namespace.
    """
    if isinstance(tool, dict) and tool.get("type") == "function" and "function" not in tool:
        # Already flat (Responses shape); copy so the caller's dict is untouched.
        flat = dict(tool)
    else:
        from langchain_core.utils.function_calling import convert_to_openai_tool

        converted = tool if (isinstance(tool, dict) and "function" in tool) else convert_to_openai_tool(tool)
        function = converted.get("function") if isinstance(converted, dict) else None
        if not isinstance(function, dict):
            raise DeferredToolLoadingError(f"Cannot express tool {tool_payload_name(tool)!r} as a function tool")
        flat = {"type": "function", **function}
        flat.update({k: v for k, v in converted.items() if k not in ("type", "function")})

    if not isinstance(flat.get("name"), str) or not flat["name"]:
        raise DeferredToolLoadingError(f"Tool {tool!r} has no usable name")
    flat.setdefault("description", "")
    flat.setdefault("parameters", {"type": "object", "properties": {}})
    return flat


def build_deferred_tool_payload(
    tools: Sequence[Any],
    *,
    settings: DeferredToolLoadingSettings,
) -> list[dict[str, Any]]:
    """Build the ``[tool_search, namespace]`` request payload for ``tools``.

    Every function goes inside the single namespace and carries
    ``defer_loading: True``; nothing is left at the top level beside the
    ``tool_search`` tool. The result is asserted before it is returned
    (:func:`assert_deferred_payload`), so a payload that would defer nothing
    can never leave this function.

    Raises:
        DeferredToolLoadingError: on an empty tool set, or if any tool cannot be
            expressed as a deferred function.
    """
    if not tools:
        raise DeferredToolLoadingError("Deferred tool loading needs at least one tool to defer")

    functions = []
    for tool in tools:
        flat = _flatten_function_tool(tool)
        flat["defer_loading"] = True
        functions.append(flat)

    payload = [
        dict(TOOL_SEARCH_TOOL),
        {
            "type": NAMESPACE_TOOL_TYPE,
            "name": settings.namespace,
            "description": settings.namespace_description,
            "tools": functions,
        },
    ]
    assert_deferred_payload(payload)
    return payload


def assert_deferred_payload(payload: Any) -> None:
    """Raise unless ``payload`` is a shape that actually defers something.

    This is the client-side half of "a silent strip must not be possible". It
    is run on the payload we build AND, via :func:`assert_request_defers_tools`,
    on the finished wire payload — the point past which langchain-openai can no
    longer rewrite anything.

    Raises:
        DeferredToolLoadingError: if the ``tool_search`` tool is missing, if
            there is not exactly one namespace, if the namespace is empty, if
            any function inside it lacks ``defer_loading``, or if a function
            tool escaped to the top level (where the flag is dropped).
    """
    if not isinstance(payload, list):
        raise DeferredToolLoadingError(f"Tool payload is {type(payload).__name__}, not a list")

    types = [t.get("type") for t in payload if isinstance(t, dict)]
    if TOOL_SEARCH_TOOL["type"] not in types:
        raise DeferredToolLoadingError(f"Tool payload carries no {TOOL_SEARCH_TOOL['type']!r} tool: types={types}")

    namespaces = [t for t in payload if isinstance(t, dict) and t.get("type") == NAMESPACE_TOOL_TYPE]
    if len(namespaces) != 1:
        raise DeferredToolLoadingError(f"Expected exactly one {NAMESPACE_TOOL_TYPE!r} tool, found {len(namespaces)}")

    stray = [tool_payload_name(t) for t in payload if isinstance(t, dict) and t.get("type") == "function"]
    if stray:
        raise DeferredToolLoadingError(
            f"Function tools outside the namespace cannot be deferred (OpenRouter drops "
            f"`defer_loading` on a top-level function): {stray}"
        )

    nested = namespaces[0].get("tools")
    if not isinstance(nested, list) or not nested:
        raise DeferredToolLoadingError("The namespace tool holds no functions to defer")
    undeferred = [tool_payload_name(f) for f in nested if not (isinstance(f, dict) and f.get("defer_loading") is True)]
    if undeferred:
        raise DeferredToolLoadingError(f"Namespaced functions are not marked deferred: {undeferred}")


def assert_request_defers_tools(llm: Any, payload: list[dict[str, Any]]) -> dict[str, Any]:
    """Assert the FINISHED wire payload still defers, and return it.

    ``build_deferred_tool_payload`` proves what we hand to ``bind``;
    langchain-openai builds what actually goes over the wire
    (``_get_request_payload`` — the same method ``ainvoke`` uses). Between the
    two sits every rewrite this module does not control: the chat-shape
    flattening, a future version's own ``defer_loading`` handling, and the
    Chat-Completions path, which would drop the namespace entirely. Checking
    the wire payload is what makes a client-side strip impossible rather than
    merely unlikely.
    """
    from langchain_core.messages import HumanMessage

    wire = llm._get_request_payload([HumanMessage(content="ping")], stop=None, tools=payload)
    assert_deferred_payload(wire.get("tools"))
    return wire


def _echoed_tools_defer(echoed: Any) -> bool:
    """True when OpenRouter echoed our namespace back with the deferral intact.

    The Responses payload echoes the tools the provider actually accepted, which
    is the one direct piece of evidence available that ``defer_loading`` was not
    normalized away upstream. (The ``tool_search`` entry itself is not echoed —
    only the namespace is, so its presence is not part of the assertion.)
    """
    if not isinstance(echoed, list):
        return False
    namespaces = [t for t in echoed if isinstance(t, dict) and t.get("type") == NAMESPACE_TOOL_TYPE]
    if len(namespaces) != 1:
        return False
    nested = namespaces[0].get("tools")
    if not isinstance(nested, list) or not nested:
        return False
    return all(isinstance(f, dict) and f.get("defer_loading") is True for f in nested)


#: The capability probe's canary tools. Deliberately tiny — the probe is
#: checking whether the SHAPE survives the provider, not whether our real
#: schemas fit, so it must not cost what a real request costs.
_PROBE_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "grid_probe_alpha",
        "description": "Capability probe. Never called.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "grid_probe_beta",
        "description": "Capability probe. Never called.",
        "parameters": {"type": "object", "properties": {}},
    },
]


async def verify_deferred_tool_loading(llm: Any, *, settings: DeferredToolLoadingSettings) -> None:
    """Prove, against the live endpoint, that deferral is actually in effect.

    Called ONCE at workflow build time, before any user turn exists, so raising
    here costs nothing but a failed startup — which is the point. The whole
    failure mode this guards is a request that looks configured and defers
    nothing, and that failure is invisible from the inside: the model still
    answers, the agent still runs, and the only symptom is the token bill.

    Three things are checked, in the order they can go wrong:

    1. the LLM can carry the shape at all (OpenRouter + Responses API);
    2. langchain-openai's finished wire payload still defers;
    3. the provider echoes the namespace back with ``defer_loading`` intact.

    Raises:
        DeferredToolLoadingError: on any of the three. Never on a transport
            error alone — an unreachable endpoint at build time is not evidence
            about the feature, so it is logged and the deferred path is left
            enabled to be judged at request time (where it degrades).
    """
    if not settings.enabled:
        return

    if not supports_deferred_tool_loading(llm):
        raise DeferredToolLoadingError(
            "deferred_tool_loading is enabled but this LLM cannot carry it: "
            f"base_url={_llm_base_url(llm)!r}, use_responses_api="
            f"{getattr(llm, 'use_responses_api', False)!r}. It needs an OpenRouter "
            "endpoint with `api_type: responses` in the NAT LLM config."
        )

    payload = build_deferred_tool_payload(_PROBE_TOOLS, settings=settings)
    wire = assert_request_defers_tools(llm, payload)

    client = getattr(llm, "root_async_client", None)
    if client is None:
        raise DeferredToolLoadingError("Chat model exposes no async OpenAI client to probe with")

    try:
        raw = await client.responses.with_raw_response.create(
            model=wire["model"],
            input="ping",
            tools=payload,
            max_output_tokens=16,
        )
        body = json.loads(raw.text)
    except Exception as exc:  # noqa: BLE001 - classified below
        if _looks_like_a_rejected_shape(exc):
            raise DeferredToolLoadingError(
                f"OpenRouter rejected the deferred tool shape: {exc}. This is the "
                "signature of `defer_loading` being stripped before it reached the "
                "provider — the request arrives with a tool_search tool and nothing "
                "deferred."
            ) from exc
        logger.warning(
            "[DeferredToolLoading] capability probe could not reach the endpoint; "
            "leaving the feature enabled to be judged at request time",
            exc_info=True,
        )
        return

    if not _echoed_tools_defer(body.get("tools")):
        raise DeferredToolLoadingError(
            "OpenRouter accepted the request but did NOT echo the deferred shape back "
            f"(tools={json.dumps(body.get('tools'))[:400]}). The tool schemas would be "
            "sent in full on every turn while the config claims otherwise."
        )

    logger.info(
        "[DeferredToolLoading] verified: namespace %r accepted with defer_loading on "
        "every function (probe input_tokens=%s)",
        settings.namespace,
        (body.get("usage") or {}).get("input_tokens"),
    )


def _looks_like_a_rejected_shape(exc: BaseException) -> bool:
    """True for the 400 OpenRouter returns when nothing was actually deferred."""
    text = str(exc).lower()
    return "tool_search" in text and "deferred" in text


class DeferredToolBinding(Runnable):
    """A deferred-tools binding that degrades to the full-schema one on failure.

    The agent holds this where it used to hold ``llm.bind_tools(...)`` and calls
    it the same way. On any error from the deferred path it logs at ERROR, drops
    to the ordinary binding, and LATCHES: the remaining tool iterations of this
    process do not each re-pay for the same failing round trip.

    The latch is per instance and the instance is per bound tool SET, which is
    the right scope — a shape the endpoint rejects will be rejected again, and
    a different tool set gets its own verdict.
    """

    def __init__(self, deferred: Runnable, fallback: Runnable, *, description: str = "") -> None:
        self.deferred = deferred
        self.fallback = fallback
        self.description = description
        self.degraded = False

    def _degrade(self, exc: BaseException) -> None:
        self.degraded = True
        logger.error(
            "[DeferredToolLoading] deferred tool request failed (%s); falling back to the "
            "full tool schemas for the rest of this process%s",
            type(exc).__name__,
            f" [{self.description}]" if self.description else "",
            exc_info=True,
        )

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:  # noqa: A002 - Runnable's signature
        """Invoke the deferred binding, degrading to the full one on failure."""
        if self.degraded:
            return self.fallback.invoke(input, config, **kwargs)
        try:
            return self.deferred.invoke(input, config, **kwargs)
        except Exception as exc:  # noqa: BLE001 - the whole point is to degrade, not raise
            self._degrade(exc)
            return self.fallback.invoke(input, config, **kwargs)

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:  # noqa: A002
        """Async mirror of :meth:`invoke`."""
        if self.degraded:
            return await self.fallback.ainvoke(input, config, **kwargs)
        try:
            return await self.deferred.ainvoke(input, config, **kwargs)
        except Exception as exc:  # noqa: BLE001 - the whole point is to degrade, not raise
            self._degrade(exc)
            return await self.fallback.ainvoke(input, config, **kwargs)


def bind_tools_deferred(
    llm: Any,
    tools: Sequence[Any],
    *,
    settings: DeferredToolLoadingSettings | None,
    **bind_kwargs: Any,
) -> Runnable:
    """Bind ``tools`` to ``llm``, deferring their schemas when that is available.

    The single seam every caller uses. It always returns something bound to the
    full tool set in one form or another:

    * feature off, or an LLM that cannot carry the shape → ``llm.bind_tools``,
      byte-identical to what the caller did before;
    * shape unbuildable or the wire payload does not defer → the same, with a
      loud ERROR (this is a bug in us, not a provider decision);
    * otherwise → a :class:`DeferredToolBinding` over both, so a request-time
      failure still lands on the full binding.

    Never raises. Request-time is where a user is waiting, and there is always a
    correct thing to do here: send the schemas.
    """
    fallback = llm.bind_tools(tools, **bind_kwargs)
    if settings is None or not settings.enabled or not tools:
        return fallback
    if not supports_deferred_tool_loading(llm):
        # Not an error: the per-org override seam legitimately swaps in a model
        # on another endpoint. Build-time verification is what catches a
        # deployment that asked for deferral it can never get.
        logger.info(
            "[DeferredToolLoading] %s is not an OpenRouter Responses-API model; binding tool schemas in full",
            type(llm).__name__,
        )
        return fallback

    try:
        payload = build_deferred_tool_payload(tools, settings=settings)
        assert_request_defers_tools(llm, payload)
    except Exception as exc:  # noqa: BLE001 - degrade, but never quietly
        logger.error(
            "[DeferredToolLoading] could not build a deferring request for %d tool(s): %s. "
            "Binding the full tool schemas instead.",
            len(tools),
            exc,
            exc_info=True,
        )
        return fallback

    logger.info(
        "[DeferredToolLoading] deferring %d tool schema(s) into namespace %r (%d chars withheld from every request)",
        len(payload[1]["tools"]),
        settings.namespace,
        len(json.dumps(payload[1]["tools"])),
    )
    deferred = llm.bind(tools=payload, **bind_kwargs)
    names = ", ".join(sorted(n for n in (tool_payload_name(t) for t in tools) if n))
    return DeferredToolBinding(deferred, fallback, description=names)
