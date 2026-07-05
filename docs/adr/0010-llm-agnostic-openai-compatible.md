# ADR-0010: LLM-agnostic via OpenAI-compatible endpoints

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [`../architecture/llm-providers.md`](../architecture/llm-providers.md)

## Context

Early configs coupled the system to a specific vendor (Kimi / Moonshot). That
config is not currently maintained, and vendor lock-in is undesirable for a
product that may run on managed APIs, self-hosted models, or a customer's own
inference in different deployments.

The NeMo Agent Toolkit's LLM/embedder providers accept an OpenAI-compatible
`base_url`, `model_name`, and API key.

## Decision

We will treat GRID as **LLM-agnostic**: any **OpenAI-compatible endpoint** is a
valid provider. The active provider is chosen entirely in the workflow config
(`configs/*.yml`) via `base_url` / `model_name` / key-env, selected by
`CONFIG_FILE`. No vendor is hard-coded in application logic.

The shipped **reference config** is `config_oib_openrouter.yml` (DeepSeek +
embeddings via OpenRouter). The legacy Kimi config is deprecated/unmaintained.

## Consequences

### Positive
- Runs against OpenRouter, self-hosted vLLM/Ollama, Azure OpenAI, NVIDIA NIM,
  etc. with a config change — no code change.
- Deployments can meet data-residency / cost constraints by choosing a provider.

### Negative
- Behavior varies by model; prompts are tuned against the reference model and may
  need adjustment for very different models.

### Risks
- A misconfigured/blank key fails silently at some providers — mitigated by the
  config-validation guard that treats `${VAR}`-literals and blanks as unset.

## Alternatives Considered
- **Standardize on one vendor SDK** — rejected; couples the product to a vendor
  and complicates on-prem/self-hosted deployments.

## References
- [`../architecture/llm-providers.md`](../architecture/llm-providers.md)
