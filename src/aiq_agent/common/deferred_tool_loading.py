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

WHICH MODELS — PER MODEL ID, NEVER PER VENDOR
=============================================
OpenRouter + Responses is necessary and NOT sufficient: the capability is a
property of the model (really of the endpoint serving it), and the org override
seam (``model_overrides``) can hand a single research turn a model the workflow
was never built against. Measured live, same payload, same key::

    openai/gpt-5.6-luna                 200, defers        in_tokens  396
    anthropic/claude-sonnet-4.5         200, defers        in_tokens  642
    openai/gpt-4o-mini                  400  "Invalid value: 'tool_search'.
                                              Supported values are: 'function'
                                              and 'custom'."

Two things follow, and both constrain the gate below:

* **A vendor prefix is the wrong key.** Claude Sonnet 4.5 carries the shape and
  ``gpt-4o-mini`` does not, so an ``openai/gpt-5.*`` allowlist would exclude a
  working model and a ``not anthropic/*`` denylist would exclude another. The
  capability cuts ACROSS vendors; only the full model id identifies it.
* **Model metadata cannot answer it.** ``GET /api/v1/models`` exposes
  ``supported_parameters``, and across all 411 models that vocabulary has no
  ``tool_search``, no ``defer_loading`` and no ``namespace`` token. All four
  models above advertise ``tools`` — including the one that 400s — so metadata
  does not separate a single observed case and is not consulted.

And one thing that is not a per-model property at all. ``meta-llama/
llama-3.3-70b-instruct`` was measured at **5 × 200-and-defers, 1 × 422** over
six identical requests: OpenRouter load-balances that model across provider
endpoints and they do not agree, so its "capability" is decided per request,
after our gate has already run. No static verdict is correct for such a model.
That is why the request-time fallback stays the last line and why a probe's
verdict is treated as weaker than an operator's (see below).

THE GATE, IN THE ORDER IT DECIDES
=================================
:func:`model_supports_deferred_tool_loading`, consulted synchronously at bind
time and costing nothing. TWO INDEPENDENT CONDITIONS, both of which must hold —
the model can carry the shape, AND it clears the configured intelligence floor.
Neither implies the other: ``x-ai/grok-4.6`` scores 60.9 and cannot defer;
``anthropic/claude-sonnet-4.6`` defers and scores 48.4.

Capability is decided first:

1. **Config** (:class:`DeferredToolLoadingModels`) — ``deny``, then ``allow``,
   then ``provisional``; exact ids or explicit globs. Operator-controlled, no
   network. A deny also covers the model's ``:variant`` suffixes; an allow does
   not, because a variant selects different routing and the safe direction
   differs per side. ``allow`` asserts a measurement and outranks observation;
   ``provisional`` states an intent and yields to it.
2. **Probe verdict**, cached per model id. An unknown model is probed ONCE, off
   the request path, and the answer reused; until it lands the model is treated
   as unsupported, so an unknown model never pays the wasted round trip this
   gate exists to prevent.
3. **The request-time fallback**, unchanged — full schemas, ERROR log, latch.

Then the floor (:func:`meets_intelligence_floor`), on Artificial Analysis's
``intelligence_index``. An unscored model FAILS it rather than slipping under.

FALSE IS NOT A REFUSAL, AND THIS IS NOT A MODEL POLICY
======================================================
Every "no" above means one thing: bind the full schemas — exactly what this
agent did before any of this existed. No path here can fail a request or a
build over the floor, because the floor answers "is deferring worth it for this
model", not "may this model be used". A sub-floor model runs normally and
simply pays today's token cost.

The whole mechanism is scoped to the agent that has something to defer.
``deferred_tool_loading`` sits under ``shallow_research_agent`` in the YAML,
``api_type: responses`` is on ``shallow_llm`` alone, and this module is imported
only by that agent — so ``intent_classifier``, ``clarifier_llm``, ``summary_llm``
and the ``deep_*`` roles never reach it. Keep it that way. Deferral pays only
where a large tool surface meets a tight turn budget (~60 KB of BIM schemas on a
5-iteration budget); an intent classifier has nothing worth deferring and would
pay the ~620-token apparatus for nothing — and a cheap sub-50 model is the RIGHT
choice for classification, so a floor applied there would be actively wrong.

Structurally: the lists, the scores and the floor all live on the per-agent
:class:`DeferredToolLoadingSettings`, never in module scope, so two agents can
hold different policies at once. The one thing that IS process-wide is the probe
verdict cache — deliberately, because "does this model accept the shape" is an
observed fact about the provider, not a policy, and it is the same answer for
whoever asks.

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

A transient error is never evidence about a model. Only a status the provider
uses to reject the request SHAPE (400/422) writes a durable "unsupported";
5xx, 408, 429, auth and transport failures leave the model unknown, because
caching a timeout as a capability verdict would disable the feature for the
life of the process over a blip.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
from collections import OrderedDict
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

#: Models measured live to accept the namespace AND echo ``defer_loading`` back
#: on every function. Full ids, not vendor prefixes — the capability cuts across
#: vendors (see the module docstring), so ``anthropic/*``, ``openai/*``,
#: ``google/*`` and ``z-ai/*`` all appear.
#:
#: "Verified" here means exactly one thing: the provider accepted the deferred
#: shape and returned it intact. It does NOT mean the model was watched calling
#: a tool through it. Acceptance is the right criterion for a capability gate —
#: it is the condition that decides whether the request succeeds — but only
#: ``openai/gpt-5.6-{luna,sol,terra}``, ``anthropic/claude-opus-4.8``,
#: ``anthropic/claude-sonnet-4.6`` and ``anthropic/claude-fable-5`` were also
#: seen emitting a ``function_call`` end to end.
#:
#: Refresh with ``scripts``-free curl if this list ages::
#:
#:     POST https://openrouter.ai/api/v1/responses
#:     {"model": "<id>", "input": "ping", "max_output_tokens": 16,
#:      "tools": [{"type":"tool_search"}, {"type":"namespace", …}]}
#:
#: and require ``defer_loading: true`` on every function of the echoed
#: ``tools`` — a bare HTTP 200 is NOT sufficient, because a provider that
#: accepts the request and normalizes the deferral away is the silent failure
#: this whole module exists to prevent.
KNOWN_DEFERRING_MODELS: tuple[str, ...] = (
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.5",
    "openai/gpt-5.4",
    "google/gemini-3.7-flash",
    "google/gemini-3.6-flash",
    "google/gemini-3.5-flash",
    "z-ai/glm-5.2",
)

#: Permitted on the operator's instruction, capability NOT established.
#:
#: ``meta/muse-spark-1.1`` never reached a capability verdict: OpenRouter
#: answered 403 "requires 18+ age confirmation" — an ACCOUNT gate that fires
#: before the payload is looked at — so nobody knows whether it takes the
#: namespace. The account is being cleared separately and the model is wanted
#: now, so it is permitted PROVISIONALLY: the config states the intent, and the
#: runtime is still allowed to learn otherwise (unlike :data:`KNOWN_DEFERRING_MODELS`,
#: a provisional entry yields to a negative verdict the probe or a real request
#: produces).
#:
#: Safe because the cost of being wrong is bounded and self-correcting: a
#: 400/422 lands on the full-schema fallback, logs at ERROR and latches, so it
#: costs one wasted round trip per distinct tool subset and then never again.
#:
#: This is a deliberate, informed exception — not an oversight to tidy away, and
#: not a precedent for listing unverified models in general. Anything else
#: belongs in :data:`KNOWN_DEFERRING_MODELS` only with an echoed ``defer_loading``
#: behind it, or nowhere at all (the probe will classify it).
PROVISIONAL_DEFERRING_MODELS: tuple[str, ...] = ("meta/muse-spark-1.1",)

#: Models that must not be sent a deferred payload. Two different reasons, and
#: the distinction matters to whoever edits this list:
#:
#: * ``x-ai/grok-4.5``/``4.6`` (422 "Failed to deserialize"),
#:   ``deepseek/deepseek-v4-pro-0813`` and ``moonshotai/kimi-k3`` (400) reject
#:   the shape outright. They simply cannot do this. Grok 4.6 is worth noting
#:   twice: it scores 60.9, higher than every model on the allowlist bar two,
#:   and still cannot defer. Capability does not track quality.
#: * ``deepseek/deepseek-v4-flash-0731`` is denied for being UNRELIABLE rather
#:   than incapable — two sweeps of the identical payload disagreed (400 in one,
#:   200-and-defers in the other). ``meta-llama/llama-3.3-70b-instruct`` is the
#:   same story with the rate measured: 5 of 6 identical requests returned 200
#:   and deferred, the sixth returned 422. OpenRouter spreads both models over
#:   provider endpoints that disagree, so the capability is decided per request,
#:   after this gate has run. No static verdict is correct for such a model, and
#:   deferring to one buys a wasted round trip at a rate nothing can predict.
KNOWN_NON_DEFERRING_MODELS: tuple[str, ...] = (
    "x-ai/grok-4.6",
    "x-ai/grok-4.5",
    "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-flash-0731",
    "moonshotai/kimi-k3",
    "meta-llama/llama-3.3-70b-instruct",
    "openai/gpt-4o-mini",
)

#: Artificial Analysis ``intelligence_index`` per model, as served inline by
#: ``GET /api/v1/models?supported_parameters=tools&min_intelligence_index=1``
#: under ``benchmarks.artificial_analysis``. Read live and pinned here.
#:
#: STATIC on purpose. The alternative — fetching at build time — was rejected
#: because it is this table PLUS a network dependency: a fetch that may fail
#: must fall back to hardcoded scores anyway, so the live path cannot remove the
#: table, only add a failure mode to startup. Worse, it would let the set of
#: deferring models change under a running deployment with no config change,
#: which is the same class of surprise (the model moved without anyone saying
#: so) that this entire gate exists to eliminate. Scores drift over weeks; a
#: config edit is the right cadence for that, and
#: ``models.intelligence_index`` overrides any entry here without a release.
MODEL_INTELLIGENCE_INDEX: dict[str, float] = {
    "anthropic/claude-opus-5": 63.1,
    "anthropic/claude-fable-5": 62.1,
    "openai/gpt-5.6-sol": 60.9,
    "anthropic/claude-opus-4.8": 57.3,
    "openai/gpt-5.6-terra": 56.6,
    "openai/gpt-5.5": 56.3,
    "google/gemini-3.7-flash": 56.0,
    "anthropic/claude-sonnet-5": 55.3,
    "openai/gpt-5.4": 53.1,
    "meta/muse-spark-1.1": 53.2,
    "z-ai/glm-5.2": 52.6,
    "openai/gpt-5.6-luna": 52.3,
    "google/gemini-3.5-flash": 52.0,
    "google/gemini-3.6-flash": 51.6,
    # Deferred-capable and above the floor, but denied above for being
    # routing-flaky. Recorded so the floor is not mistaken for the reason.
    "deepseek/deepseek-v4-flash-0731": 51.8,
    # Deferred-capable and BELOW the floor. Listed so their absence from the
    # allowlist reads as a threshold decision rather than a missing measurement:
    # claude-sonnet-4.6 was one of the six models seen emitting a real
    # function_call, and is excluded on SCORE alone. Do not re-add either to the
    # allowlist without moving `min_intelligence_index`.
    "anthropic/claude-sonnet-4.6": 48.4,
    "minimax/minimax-m3": 45.4,
}

#: HTTP statuses with which a provider rejects the request SHAPE. Only these
#: write a durable "this model cannot defer"; everything else (5xx, 408, 429,
#: 401/403, transport) leaves the model unknown and re-probable.
_SHAPE_REJECTION_STATUSES = frozenset({400, 422})

#: Bound on the verdict cache. Model ids come from an operator-controlled
#: override header, so this is an untrusted key space and must not grow freely.
_MAX_CACHED_MODEL_VERDICTS = 64

#: Give up probing a model after this many inconclusive attempts, so an
#: endpoint that is merely unreachable does not attract a probe per binding.
_MAX_PROBE_ATTEMPTS = 3

#: model id -> can it carry the deferred shape. Durable verdicts only.
_MODEL_VERDICTS: OrderedDict[str, bool] = OrderedDict()

#: model id -> inconclusive probe attempts so far (transport failures).
_PROBE_ATTEMPTS: OrderedDict[str, int] = OrderedDict()

#: Model ids with a probe in flight, so N concurrent bindings cost one probe.
_PROBES_IN_FLIGHT: set[str] = set()

#: Strong refs to background probe tasks — asyncio only holds weak ones, and a
#: garbage-collected probe would leave the model unknown forever.
_BACKGROUND_PROBES: set[asyncio.Task] = set()


class DeferredToolLoadingError(RuntimeError):
    """The deferred tool payload was not built, or not accepted, as declared.

    Raised only where raising is free — payload construction and the build-time
    capability probe. Request-time failures degrade instead (see
    :class:`DeferredToolBinding`).
    """


class DeferredToolLoadingModels(BaseModel):
    """Which MODELS may be sent a deferred payload. Operator's word, first.

    OpenRouter + Responses says the *client* can express the shape; it says
    nothing about whether the model on the other end accepts it, and the org
    override seam can swap that model per request. This is the layer that knows
    the difference, and it answers without a network call.

    Entries are full model ids (``openai/gpt-5.6-luna``) or explicit globs
    (``openai/gpt-5.6-*``). Never vendor prefixes as a proxy for capability —
    ``anthropic/claude-sonnet-4.5`` defers and ``openai/gpt-4o-mini`` does not,
    so vendor predicts nothing.
    """

    deny: list[str] = Field(
        default_factory=lambda: list(KNOWN_NON_DEFERRING_MODELS),
        description=(
            "Model ids or globs that must never receive a deferred payload. Checked "
            "FIRST — a deny beats an allow, beats a probe verdict, and is the only way "
            "to keep a model off the deferred path permanently. A deny also covers the "
            "model's `:variant` suffixes (`:free`, `:nitro`), because a variant is a "
            "routing choice and an operator denying a model means the model."
        ),
    )
    allow: list[str] = Field(
        default_factory=lambda: list(KNOWN_DEFERRING_MODELS),
        description=(
            "Model ids or globs verified to accept the namespace and echo `defer_loading` "
            "back. Matched EXACTLY (a `:variant` suffix does not inherit an allow — it "
            "routes elsewhere and was not the thing measured); write `model*` to include "
            "variants deliberately. A model here is never probed, and a runtime failure "
            "does not unlist it: this is an assertion, and the operator outranks a probe."
        ),
    )
    provisional: list[str] = Field(
        default_factory=lambda: list(PROVISIONAL_DEFERRING_MODELS),
        description=(
            "Permitted, but NOT asserted capable — for a model an operator wants deferred "
            "before anyone has an echoed `defer_loading` for it. Deferred like an `allow` "
            "entry until the runtime learns otherwise, and unlike `allow` it YIELDS to a "
            "negative verdict from the probe or from a real request. Being wrong costs one "
            "wasted round trip per tool subset, then the fallback latches."
        ),
    )
    intelligence_index: dict[str, float] = Field(
        default_factory=lambda: dict(MODEL_INTELLIGENCE_INDEX),
        description=(
            "Artificial Analysis intelligence_index per model, seeded from "
            "MODEL_INTELLIGENCE_INDEX. Setting this in YAML REPLACES the table rather "
            "than merging into it, so a partial map means every unlisted model becomes "
            "unscored — and unscored fails the floor. Copy the defaults you still want. "
            "The scores live on this settings object, not in module scope, so two agents "
            "can hold different tables at once."
        ),
    )
    probe_unknown: bool = Field(
        default=True,
        description=(
            "For a model in neither list, spend one live capability probe — off the "
            "request path — and cache the verdict per model id. Until it lands the model "
            "is treated as unsupported, so an unknown model gets full schemas rather "
            "than a wasted round trip. Set false to run allowlist-only with no probing "
            "traffic at all."
        ),
    )


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
    min_intelligence_index: float = Field(
        default=50.0,
        description=(
            "Floor on Artificial Analysis intelligence_index. A model must be BOTH "
            "deferred-capable AND score at least this to receive a deferred payload — two "
            "independent conditions. A model with no score available FAILS this floor "
            "rather than passing it: over-hedging costs tokens, and an operator who set a "
            "floor did not ask for unscored models to slip under it. Set 0 to disable the "
            "floor entirely and gate on capability alone."
        ),
    )
    models: DeferredToolLoadingModels = Field(
        default_factory=DeferredToolLoadingModels,
        description=(
            "Per-model capability gate. The provider+API check says the client can "
            "express the deferred shape; this says the model on the other end accepts "
            "it. Without it an org model override sends a deferred payload to a model "
            "that rejects it — one wasted round trip per tool subset, an ERROR that "
            "reads like a bug, and latency on a live turn."
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

    This is the PRECONDITION, not the whole gate: it establishes that the client
    can express the shape, not that the model accepts it. That second question
    is :func:`model_supports_deferred_tool_loading`, and the same override seam
    is why it exists — an override to ``openai/gpt-4o-mini`` passes both
    conditions here and is still a 400.
    """
    from aiq_agent.common.llm_factory import llm_targets_openrouter

    return bool(llm_targets_openrouter(llm)) and bool(getattr(llm, "use_responses_api", False))


def llm_model_id(llm: Any) -> str:
    """Best-effort OpenRouter model id for a LangChain chat model.

    ``model_name`` is what ``ChatOpenAI`` carries and what an override writes;
    ``model`` is the alias other chat classes use. Empty when neither is
    readable, which the gate treats as unknown rather than guessing.
    """
    for attr in ("model_name", "model"):
        value = getattr(llm, attr, None)
        if isinstance(value, str) and value:
            return value
    return ""


def _base_model_id(model_id: str) -> str:
    """Strip OpenRouter's ``:variant`` routing suffix (``:free``, ``:nitro``)."""
    return model_id.split(":", 1)[0]


def _matches_any(model_id: str, patterns: Sequence[str]) -> bool:
    """True when ``model_id`` equals or globs against any entry.

    ``fnmatch`` rather than a prefix test so an operator writes what they mean:
    a bare id matches only itself, and reaching a family takes an explicit ``*``.
    Case-folded because model ids are handed in by an override header.
    """
    lowered = model_id.lower()
    return any(fnmatch.fnmatchcase(lowered, str(p).lower()) for p in patterns if p)


def model_is_denied(model_id: str, models: DeferredToolLoadingModels) -> bool:
    """True when the operator has ruled this model out outright.

    Checked before everything and asymmetrically: a deny also matches the
    model's ``:variant`` suffixes, while an allow does not. Both directions err
    the same way — towards NOT deferring — because a variant routes to endpoints
    that were never the ones measured, and full schemas are always correct.
    """
    if not model_id:
        return False
    return _matches_any(model_id, models.deny) or _matches_any(_base_model_id(model_id), models.deny)


def capability_verdict(model_id: str, models: DeferredToolLoadingModels) -> bool | None:
    """Can this model carry the deferred shape? True / False / None if unknown.

    Config outranks observation, with one deliberate exception. The four tiers:

    * ``deny``      → False. Operator's word, final.
    * ``allow``     → True. Operator's assertion, final; a probe does not
                      overturn it (the per-binding latch still protects a turn).
    * ``provisional`` → True *until* a verdict says otherwise. This is the
                      exception: it states an intent, not a measurement, so it
                      yields to what the runtime actually observes.
    * unlisted      → whatever the probe cached, or None if nobody has asked.

    Reads the score-free half of the gate only. The intelligence floor is a
    separate, independent condition — see :func:`meets_intelligence_floor`.
    """
    if not model_id:
        return None
    if model_is_denied(model_id, models):
        return False
    if _matches_any(model_id, models.allow):
        return True
    cached = cached_model_verdict(model_id)
    if _matches_any(model_id, models.provisional):
        return True if cached is None else cached
    return cached


def _needs_probe(model_id: str, models: DeferredToolLoadingModels) -> bool:
    """True when a live probe would tell us something we do not already know.

    The single place that decides "is this model worth a probe", so the sync
    gate and the async entry point cannot disagree about it. False for a model
    the operator asserted either way (``deny``/``allow`` are measurements, not
    guesses) and for one already classified.

    Notably TRUE for a ``provisional`` model: that tier permits deferral without
    claiming capability, so it is precisely the case where a probe is worth
    spending — better to learn off the request path than to let a live turn
    discover it.
    """
    if not model_id:
        return False
    if model_is_denied(model_id, models) or _matches_any(model_id, models.allow):
        return False
    return cached_model_verdict(model_id) is None


def meets_intelligence_floor(model_id: str, settings: DeferredToolLoadingSettings) -> bool:
    """True when ``model_id`` scores at or above the configured floor.

    Wholly independent of capability: a model can carry the deferred shape and
    still sit below the floor (``anthropic/claude-sonnet-4.6`` at 48.4 does
    exactly that, and was one of the six seen emitting a real ``function_call``).
    Both conditions must hold, and neither implies the other — ``x-ai/grok-4.6``
    scores 60.9 and cannot defer at all.

    An UNKNOWN score fails. That is the asked-for direction: an operator who set
    a floor did not ask for unscored models to slip under it, and the cost of
    over-hedging is tokens, never an error.

    A floor of 0 (or less) disables the check, capability alone deciding.
    """
    if settings.min_intelligence_index <= 0:
        return True
    scores = settings.models.intelligence_index
    score = scores.get(model_id)
    if score is None:
        score = scores.get(_base_model_id(model_id))
    if score is None:
        return False
    return float(score) >= float(settings.min_intelligence_index)


def cached_model_verdict(model_id: str) -> bool | None:
    """The probe's verdict for ``model_id``, or None if it has not been asked."""
    return _MODEL_VERDICTS.get(model_id)


def record_model_verdict(model_id: str, supported: bool, *, source: str) -> None:
    """Cache a DURABLE verdict for ``model_id``, evicting oldest first.

    Only ever called with evidence the provider itself produced: an echoed
    ``defer_loading``, or a 400/422 rejection of the shape. A transport failure
    must not reach here — see :func:`_is_shape_rejection`.
    """
    if not model_id:
        return
    previous = _MODEL_VERDICTS.get(model_id)
    _MODEL_VERDICTS[model_id] = supported
    _MODEL_VERDICTS.move_to_end(model_id)
    while len(_MODEL_VERDICTS) > _MAX_CACHED_MODEL_VERDICTS:
        _MODEL_VERDICTS.popitem(last=False)
    _PROBE_ATTEMPTS.pop(model_id, None)
    if previous != supported:
        logger.info(
            "[DeferredToolLoading] model %r %s deferral (%s)",
            model_id,
            "supports" if supported else "does NOT support",
            source,
        )


def reset_model_capability_cache() -> None:
    """Forget every probe verdict, attempt count and in-flight marker.

    For tests and for an operator reloading config at runtime. The CONFIG layer
    is not touched — it is not state, it is the answer.
    """
    _MODEL_VERDICTS.clear()
    _PROBE_ATTEMPTS.clear()
    _PROBES_IN_FLIGHT.clear()


def model_supports_deferred_tool_loading(llm: Any, settings: DeferredToolLoadingSettings) -> bool:
    """True when THIS model may be sent a deferred payload. Never blocks, never raises.

    Two independent conditions, both of which must hold: the model can carry the
    deferred shape (:func:`capability_verdict`) and it clears the configured
    intelligence floor (:func:`meets_intelligence_floor`).

    Answering False for a model nobody has classified yet is the deliberate
    direction: full schemas cost tokens, a rejected deferred payload costs a
    wasted round trip on a turn a user is waiting for — and this agent
    force-synthesizes at five iterations, so latency there is the scarcer loss.
    An unlisted, unprobed model also SCHEDULES its probe here (off the request
    path, at most once per model) so the next binding has a real answer.

    False is never a refusal. It means "bind the full schemas", which is what
    this agent did before any of this existed — so a model below the floor runs
    exactly as it always has, one config layer having decided only that
    DEFERRING is not worth it for that model. Nothing here can fail a request or
    a build.

    Every input is read from ``settings``, which is per agent. There is no
    module-level policy: a second agent enabling this feature carries its own
    lists, its own scores and its own floor.
    """
    model_id = llm_model_id(llm)
    # Off the request path, at most once per model, and a no-op for anything
    # already classified — including a provisional model, whose whole point is
    # that the runtime is still allowed to learn the truth.
    _schedule_model_probe(llm, settings)

    capable = capability_verdict(model_id, settings.models)
    if not capable:
        return False
    return meets_intelligence_floor(model_id, settings)


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
    flattening and a future version's own ``defer_loading`` handling. Checking
    the wire payload is what makes a client-side strip impossible rather than
    merely unlikely.

    What this does NOT cover: the Chat-Completions path. Chat Completions
    forwards ``tools`` verbatim, so a namespace handed to it arrives here
    unmodified and the assertion passes — while the provider, which only reads
    ``defer_loading`` on the Responses API, silently ignores the deferral. That
    case is caught EARLIER and elsewhere: :func:`bind_tools_deferred` consults
    :func:`supports_deferred_tool_loading` — which requires ``use_responses_api``
    — and returns the full-schema binding before this function is ever reached,
    and :func:`verify_deferred_tool_loading` raises at workflow build time. So
    this is one of three checks and not three-of-three: delete the capability
    gate and no error appears HERE, which is the opposite of what the module
    docstring's "a silent strip must be impossible" would lead you to expect.
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


def _error_status_code(exc: BaseException) -> int | None:
    """HTTP status behind an exception, across the shapes our clients raise.

    ``openai``'s ``APIStatusError`` carries ``status_code``; ``httpx`` and
    ``urllib`` errors carry it on a nested response or as ``code``. None when
    no status is readable — which is itself the signature of a transport
    failure rather than a provider verdict.
    """
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def _looks_like_a_rejected_shape(exc: BaseException) -> bool:
    """True for the 400 OpenRouter returns when nothing was actually deferred."""
    text = str(exc).lower()
    return TOOL_SEARCH_TOOL["type"] in text and "deferred" in text


def _is_shape_rejection(exc: BaseException) -> bool:
    """True when the provider durably rejected the request SHAPE.

    The probe controls its ENTIRE payload — two empty canary functions and a
    one-word input — so a 400 or a 422 back from it can only be about the shape
    we are asking about. That is what makes a status alone safe to cache here,
    and it is the primary signal because the provider's PROSE is not stable:
    the same rejection reads "Invalid value: 'tool_search'" from one upstream
    and ``loc: ["body","tools",0,"type"]`` from another.

    Everything else is inconclusive on purpose. A 5xx, a 408, a 429, a dropped
    connection — and, importantly, a 401/403 — say nothing about whether the
    model can defer. The 403 matters concretely: ``meta/muse-spark-1.1`` answers
    "requires 18+ age confirmation", an ACCOUNT gate. Caching that as a
    capability verdict would leave the model permanently on full schemas even
    after the account is cleared.

    The text signature is kept only for the statusless case — a client that
    wraps the 400 in a plain exception still must not be read as a timeout.
    """
    status = _error_status_code(exc)
    if status is not None:
        return status in _SHAPE_REJECTION_STATUSES
    return _looks_like_a_rejected_shape(exc)


def _rejects_our_tool_payload(exc: BaseException) -> bool:
    """True when a REQUEST-time failure is a verdict about the deferred payload.

    Stricter than :func:`_is_shape_rejection` because a real request carries the
    user's messages too, so a bare 400 there could be about context length, an
    attachment, or content policy. A model verdict is only written when the
    status says "bad shape" AND the provider's text points at the part of the
    payload this module builds. When in doubt the binding just latches, exactly
    as it did before this gate existed.
    """
    if not _is_shape_rejection(exc):
        return False
    text = str(exc).lower()
    if TOOL_SEARCH_TOOL["type"] in text or "defer_loading" in text or NAMESPACE_TOOL_TYPE in text:
        return True
    # OpenRouter forwards some upstream validators verbatim, and llama's names
    # neither field — it reports `loc: ["body","tools",0,"type"]` instead.
    return "tools" in text and ("should be 'function'" in text or "literal_error" in text)


async def _run_capability_probe(llm: Any, settings: DeferredToolLoadingSettings) -> tuple[str, str]:
    """Issue ONE canary request and classify what came back.

    The single live check both layers share — the build-time verification and
    the per-model gate — so the two can never drift into disagreeing about what
    "supported" means.

    Returns:
        ``(outcome, detail)`` where outcome is one of ``"deferred"`` (accepted
        and echoed back intact), ``"stripped"`` (accepted but the deferral was
        normalized away — the silent failure), ``"rejected"`` (400/422: the
        model cannot carry the shape) or ``"unreachable"`` (no verdict; the
        endpoint, not the capability, is what failed).
    """
    payload = build_deferred_tool_payload(_PROBE_TOOLS, settings=settings)
    wire = assert_request_defers_tools(llm, payload)

    client = getattr(llm, "root_async_client", None)
    if client is None:
        return "unreachable", "chat model exposes no async OpenAI client to probe with"

    try:
        raw = await client.responses.with_raw_response.create(
            model=wire.get("model") or llm_model_id(llm),
            input="ping",
            tools=payload,
            max_output_tokens=16,
        )
        body = json.loads(raw.text)
    except Exception as exc:  # noqa: BLE001 - classified, not swallowed
        if _is_shape_rejection(exc):
            return "rejected", str(exc)
        return "unreachable", str(exc)

    if not _echoed_tools_defer(body.get("tools")):
        return "stripped", json.dumps(body.get("tools"))[:400]
    return "deferred", str((body.get("usage") or {}).get("input_tokens"))


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

    Whatever it learns about the BUILD-TIME model is recorded as that model's
    verdict, so the workflow's own model is never re-probed at request time.

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

    model_id = llm_model_id(llm)
    if model_is_denied(model_id, settings.models):
        raise DeferredToolLoadingError(
            f"deferred_tool_loading is enabled but its own model {model_id!r} is denied by "
            "`deferred_tool_loading.models.deny`. Every request would bind the full "
            "schemas, so the feature is configured and dead. Remove the deny entry or "
            "turn the feature off."
        )

    # The FLOOR, by contrast, only ever warns. It answers "is deferring worth it
    # for this model", not "may this model be used" — a build that fails because
    # a score is low would turn a token optimisation into an outage, and the
    # deployment runs correctly either way.
    if not meets_intelligence_floor(model_id, settings):
        logger.warning(
            "[DeferredToolLoading] %r scores below min_intelligence_index=%s (or has no "
            "score); the feature is enabled but every request will bind full schemas. "
            "Lower the floor or pick another model if deferral was the point.",
            model_id,
            settings.min_intelligence_index,
        )

    outcome, detail = await _run_capability_probe(llm, settings)

    if outcome == "rejected":
        record_model_verdict(model_id, False, source="build-time probe")
        raise DeferredToolLoadingError(
            f"OpenRouter rejected the deferred tool shape for {model_id!r}: {detail}. "
            "Either the model cannot carry a tool_search namespace, or `defer_loading` "
            "was stripped before it reached the provider — the request arrives with a "
            "tool_search tool and nothing deferred."
        )

    if outcome == "stripped":
        record_model_verdict(model_id, False, source="build-time probe")
        raise DeferredToolLoadingError(
            f"OpenRouter accepted the request but did NOT echo the deferred shape back "
            f"(tools={detail}). The tool schemas would be sent in full on every turn "
            "while the config claims otherwise."
        )

    if outcome == "unreachable":
        logger.warning(
            "[DeferredToolLoading] capability probe could not reach the endpoint (%s); "
            "leaving the feature enabled to be judged at request time",
            detail,
        )
        return

    record_model_verdict(model_id, True, source="build-time probe")
    logger.info(
        "[DeferredToolLoading] verified: namespace %r accepted with defer_loading on "
        "every function (probe input_tokens=%s)",
        settings.namespace,
        detail,
    )


async def ensure_model_verdict(llm: Any, *, settings: DeferredToolLoadingSettings) -> bool | None:
    """Probe ``llm``'s model once if nobody has classified it, and cache that.

    The async half of the gate. Idempotent and self-limiting: a model with a
    config entry is never probed, a model with a cached verdict is never
    re-probed, and a model whose probe keeps failing to REACH the endpoint is
    given up on after :data:`_MAX_PROBE_ATTEMPTS` so an outage cannot turn into
    a probe per binding.

    Never raises — a probe is diagnosis, and failing to diagnose a model is not
    a reason to fail the turn that asked.

    Returns:
        The verdict now known for the model, or None if it is still unknown.
    """
    if not settings.enabled or not settings.models.probe_unknown:
        return None
    if not supports_deferred_tool_loading(llm):
        return None

    model_id = llm_model_id(llm)
    if not model_id:
        return None
    if not _needs_probe(model_id, settings.models):
        return capability_verdict(model_id, settings.models)
    if _PROBE_ATTEMPTS.get(model_id, 0) >= _MAX_PROBE_ATTEMPTS:
        return None

    try:
        outcome, detail = await _run_capability_probe(llm, settings)
    except Exception:  # noqa: BLE001 - a failed diagnosis is not a failed turn
        logger.warning("[DeferredToolLoading] capability probe for %r raised", model_id, exc_info=True)
        _PROBE_ATTEMPTS[model_id] = _PROBE_ATTEMPTS.get(model_id, 0) + 1
        return None

    if outcome == "deferred":
        record_model_verdict(model_id, True, source="capability probe")
        return True
    if outcome in ("rejected", "stripped"):
        record_model_verdict(model_id, False, source=f"capability probe ({outcome}: {detail[:160]})")
        return False

    # Unreachable: NOT evidence. Count the attempt and leave the model unknown,
    # which the gate reads as "send full schemas" — correct, just not cheap.
    _PROBE_ATTEMPTS[model_id] = _PROBE_ATTEMPTS.get(model_id, 0) + 1
    while len(_PROBE_ATTEMPTS) > _MAX_CACHED_MODEL_VERDICTS:
        _PROBE_ATTEMPTS.popitem(last=False)
    logger.info(
        "[DeferredToolLoading] capability probe for %r was inconclusive (%s); model stays unclassified",
        model_id,
        detail[:200],
    )
    return None


async def _probe_and_release(llm: Any, settings: DeferredToolLoadingSettings, model_id: str) -> None:
    """Background body of a scheduled probe; always clears the in-flight mark."""
    try:
        await ensure_model_verdict(llm, settings=settings)
    finally:
        _PROBES_IN_FLIGHT.discard(model_id)


def _schedule_model_probe(llm: Any, settings: DeferredToolLoadingSettings) -> None:
    """Kick off one background probe for an unclassified model.

    Deliberately fire-and-forget rather than awaited. The alternative — probing
    inline before binding — would put a live HTTP round trip in front of a user
    turn to find out whether a DIFFERENT round trip is worth making, which is
    the same latency this gate exists to remove, just moved. So the turn that
    discovers an unknown model pays nothing and gets full schemas; the next one
    has an answer.

    A no-op without a running loop (the sync build path, most tests), and
    at most one probe per model at a time.
    """
    if not settings.enabled or not settings.models.probe_unknown:
        return
    model_id = llm_model_id(llm)
    if model_id in _PROBES_IN_FLIGHT or not _needs_probe(model_id, settings.models):
        return
    if _PROBE_ATTEMPTS.get(model_id, 0) >= _MAX_PROBE_ATTEMPTS:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    _PROBES_IN_FLIGHT.add(model_id)
    task = loop.create_task(_probe_and_release(llm, settings, model_id))
    _BACKGROUND_PROBES.add(task)
    task.add_done_callback(_BACKGROUND_PROBES.discard)


class DeferredToolBinding(Runnable):
    """A deferred-tools binding that degrades to the full-schema one on failure.

    The agent holds this where it used to hold ``llm.bind_tools(...)`` and calls
    it the same way. On any error from the deferred path it logs at ERROR, drops
    to the ordinary binding, and LATCHES: the remaining tool iterations of this
    process do not each re-pay for the same failing round trip.

    The latch is per instance and the instance is per bound tool SET, which is
    the right scope — a shape the endpoint rejects will be rejected again, and
    a different tool set gets its own verdict.

    Only ``invoke``/``ainvoke`` are overridden, on purpose. ``Runnable``'s
    default ``astream`` yields one chunk from ``ainvoke``, so a caller that
    streams through this gets a correct answer delivered in a single chunk —
    degraded latency, never wrong output. The shallow agent is ``ainvoke``-only,
    so nothing streams through it today. A real ``astream`` is not a delegation
    one-liner and is deliberately not guessed at here: the fallback cannot be
    decided until the deferred stream has already failed, by which point chunks
    may have been emitted, and re-running the prompt on the full schemas would
    replay them. Whoever needs streaming here owes that question an answer
    first — start by deciding whether a mid-stream failure degrades or raises.
    """

    def __init__(
        self,
        deferred: Runnable,
        fallback: Runnable,
        *,
        description: str = "",
        model_id: str = "",
    ) -> None:
        self.deferred = deferred
        self.fallback = fallback
        self.description = description
        self.model_id = model_id
        self.degraded = False

    def _degrade(self, exc: BaseException) -> None:
        """Latch this binding onto the full schemas, and demote the MODEL if earned.

        The latch is per bound tool SET, which left one hole the model gate can
        close: a model that rejects the shape costs a wasted round trip once per
        distinct tool subset, and a narrowed binding is a new subset. When the
        provider's answer is unambiguously about the deferred payload (400/422
        naming it), the verdict is recorded against the model instead, so every
        later binding in this process skips the deferred path outright.

        Deliberately narrow: any other failure — a 5xx, a timeout, a content
        400 — latches this binding and nothing more, because the model is not
        what went wrong and a cached "unsupported" would outlive the incident.
        """
        self.degraded = True
        if self.model_id and _rejects_our_tool_payload(exc):
            record_model_verdict(self.model_id, False, source="request-time rejection")
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
    * a model not cleared for deferral → the same. This is the per-model gate,
      and it is why an org override to ``openai/gpt-4o-mini`` costs nothing
      rather than a 400 the user waits for;
    * shape unbuildable or the wire payload does not defer → the same, with a
      loud ERROR (this is a bug in us, not a provider decision);
    * otherwise → a :class:`DeferredToolBinding` over both, so a request-time
      failure still lands on the full binding.

    Never raises, and never blocks. Request-time is where a user is waiting, and
    there is always a correct thing to do here: send the schemas.
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
    if not model_supports_deferred_tool_loading(llm, settings):
        # Same seam, one layer in: the endpoint speaks Responses, this MODEL
        # does not carry a tool_search namespace (or nobody has established that
        # it does yet). Sending anyway is the wasted round trip this gate exists
        # to prevent, and it would be paid on a live turn.
        logger.info(
            "[DeferredToolLoading] model %r is not cleared for deferral; binding tool schemas in full",
            llm_model_id(llm) or type(llm).__name__,
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
    return DeferredToolBinding(deferred, fallback, description=names, model_id=llm_model_id(llm))
