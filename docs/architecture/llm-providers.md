# LLM providers — the OpenAI-compatible, agnostic model

> GRID is not tied to any LLM vendor. Any OpenAI-compatible endpoint is a valid
> provider, selected entirely by configuration. See also
> [ADR-0010](../adr/0010-llm-agnostic-openai-compatible.md).

## The principle

No vendor is hard-coded in application logic. The active LLM and embedding
provider is chosen in the **workflow config** (`configs/*.yml`) by setting an
OpenAI-compatible `base_url`, a `model_name`, and an API-key env var. Because the
NeMo Agent Toolkit's LLM/embedder providers speak the OpenAI wire format, this
covers a wide range of backends with **no code change**:

- Managed aggregators (OpenRouter)
- Self-hosted inference (vLLM, Ollama, TGI)
- Cloud vendors' OpenAI-compatible endpoints (Azure OpenAI)
- NVIDIA NIM

## Choosing the active config

`CONFIG_FILE` (env, set in compose) selects the active workflow config. The shipped
**reference config** is `configs/config_oib_openrouter.yml` (DeepSeek + embeddings
via OpenRouter).

```yaml
# configs/config_oib_openrouter.yml (excerpt) — an OpenAI-compatible LLM
llms:
  deepseek_super_llm:
    _type: openai
    base_url: "https://openrouter.ai/api/v1"
    model_name: deepseek/deepseek-v4-flash
    api_key: ${OPENROUTER_API_KEY}
    # max_tokens / max_retries / reasoning_effort tuned per role
```

The config defines several LLM "roles" (intent classification, the main
super-model, the deep-research model, summarization) so different steps can use
different models/parameters. Point them all at your endpoint to switch providers.

## To use a different provider

1. Copy the reference config (or edit it).
2. Set each `llms.*` block's `base_url`, `model_name`, and `api_key` env to your
   endpoint.
3. Set the embedder similarly (embeddings must also be OpenAI-compatible).
4. Set `CONFIG_FILE` to your config and provide the key(s) in `deploy/.env`.

## Caveats

- Prompts are tuned against the reference model; very different models may need
  prompt adjustments.
- A blank or `${VAR}`-literal key (a common `env_file` interpolation mistake) is
  treated as **unset** by the config-validation guard, failing fast rather than
  sending unauthenticated requests.
- The legacy Kimi config (`config_grid_oib.yml`) is **unmaintained/broken** — do
  not use it as a starting point; base new configs on the OpenRouter reference.
