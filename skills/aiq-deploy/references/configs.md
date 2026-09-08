# AI-Q Workflow Configs

Use this reference when the user asks which AI-Q config to use, how `BACKEND_CONFIG` or `CONFIG_FILE` works, or whether a non-default config is needed before deployment.

## Boundary

- Explain and select existing config files.
- Do not generate arbitrary custom configs as part of the verified deploy flow.
- Do not write secrets into YAML. Use environment-variable references and `deploy/.env`.
- If the user needs a genuinely custom workflow config, point them to the repo docs and make the smallest change from a known base config in a normal code-editing workflow, not as an automatic deploy step.

## Primary Docs

Use these repository docs as the source of truth:

- `docs/source/customization/configuration-reference.md` for config schema and environment variable substitution.
- `docs/source/examples/index.md` for example configs and use cases.
- `docs/source/deployment/docker-compose.md` for `BACKEND_CONFIG` in Docker Compose.
- `docs/source/deployment/kubernetes.md`, `deploy/helm/README.md`, and `deploy/helm/deployment-k8s/README.md` for Helm and Kubernetes deployment behavior.
- `docs/source/customization/knowledge-layer.md`, `docs/source/customization/mcp-tools.md`, and `docs/source/customization/tools-and-sources.md` for specific customization topics; `docs/architecture/llm-providers.md` for the LLM endpoint contract.

## Config Selection

| Config | Use When | Notes |
|---|---|---|
| `configs/config_oib_openrouter.yml` | Every deployment: browser UI, Skill backend, CLI, Docker Compose, Kubernetes | The one shipped config. API-enabled, LlamaIndex/Chroma knowledge layer, every model, the embeddings, the VLM and the reranker through OpenRouter with `OPENROUTER_API_KEY`. |

There is exactly one config. The Kimi-, NVIDIA- and FRAG-backed variants were
removed; nothing in the repo calls a NVIDIA endpoint. If a request needs a
different config, stop and explain the customization gap instead of inventing
one.

## Deployment Mapping

Docker Compose mounts `configs/` into the backend container at `/app/configs`. Use container paths in `deploy/.env`:

```bash
BACKEND_CONFIG=/app/configs/config_oib_openrouter.yml
```

For local process modes, pass repository-relative paths to the start script:

```bash
./scripts/start_as_skill.sh --config_file configs/config_oib_openrouter.yml --port 8000
./scripts/start_e2e.sh --config_file configs/config_oib_openrouter.yml
```

For Helm, the chart values use `CONFIG_FILE` to select an in-image config path. Do not claim arbitrary external config-file mounting is supported unless the chart values and templates have been inspected for the target release. If the user needs a custom Helm config file, explain that this is the gap tracked by `https://github.com/NVIDIA-AI-Blueprints/aiq/issues/243` and use documented ConfigMap and volume-mount behavior only when it is explicitly available.
