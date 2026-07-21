# Deploying Grid on Coolify (with per-PR preview environments)

This guide covers deploying the Grid OIB Agent to [Coolify](https://coolify.io)
using its **Docker Compose** build pack, and turning on **per-PR preview
deployments** so every pull request gets its own throwaway environment.

The Coolify-specific compose file lives at
[`deploy/compose/docker-compose.coolify.yaml`](../../deploy/compose/docker-compose.coolify.yaml).
It is a variant of the dev compose, adapted for Coolify's proxy and preview
model. **Use it, not `docker-compose.yaml`, on Coolify.**

---

## 1. What the stack looks like

Seven services build from this repo (no external image pulls required after the
NVIDIA base-image removal — see §2):

| Service | Role | Exposed publicly? |
|---|---|---|
| `frontend` | Next.js UI + BFF gateway (auth, `grid_app` DB, WS proxy) — port 3000 | **Yes** (your domain) |
| `aiq-agent` | Python FastAPI backend (LLM orchestration, embedded Chroma) — port 8000 | No (internal) |
| `seaweedfs` | S3-compatible object storage — port 8333 | **Yes** (presigned PDF URLs) |
| `postgres` | Three logical DBs: `aiq_jobs`, `aiq_checkpoints`, `grid_app` | No (internal) |
| `purger` | Grace-period hard-delete worker | No |
| `seaweedfs-init` | One-shot: creates the `grid-documents` bucket | No |
| `aiq-data-permissions` | One-shot: chowns the shared data volume | No |

Only **frontend** and **seaweedfs** get a public domain. Everything else talks over
the internal Coolify network.

> **Host firewall.** Traefik routing is a *software-layer* control only — it
> does not close host ports. Lock the server's firewall down to **80/443
> inbound** (plus your SSH port) so that even if a service accidentally
> publishes a host port, it is not reachable from the internet. This is why the
> internal services (`aiq-agent`, `postgres`, `dragonfly`) carry a warning
> comment in the compose file: never give them a `ports:` mapping — Coolify
> binds the host port regardless of Traefik, and only the firewall would then
> stop public access.

> **SeaweedFS S3 API is deliberately public.** The browser fetches uploaded/OIB
> PDFs via **presigned** S3 URLs, which must be reachable directly from the
> user's browser — so `seaweedfs:8333` is exposed under its own FQDN. Access is
> still gated: every object URL is a short-TTL signed link (see
> `SEAWEED_PRESIGNED_URL_TTL_SECONDS`), and the bucket denies anonymous listing.
> Routing these downloads through the authenticated frontend proxy instead
> (removing the public SeaweedFS domain entirely) is **future work**.

---

## 2. Prerequisites (already handled in this repo)

The following changes were made so the stack builds on a stock Coolify server:

- **Public base images.** Both Dockerfiles previously built `FROM nvcr.io/nvidia/...`
  images, which need NGC registry credentials and buy nothing here (all LLM work
  is remote via OpenRouter — no GPU). They now build from `debian:bookworm-slim`
  (backend) and `node:22-slim` (frontend). glibc is preserved across build and
  runtime so the standalone Python interpreter and manylinux wheels stay ABI-safe.
  > Alpine is intentionally avoided — it uses musl, and the backend's
  > `python-build-standalone` interpreter + wheels are glibc-only.
- **Env-driven CORS.** `configs/config_oib_openrouter.yml` reads
  `CORS_ALLOW_ORIGIN_REGEX` (defaults to localhost), so a deployed instance can
  allow its own domain.
- **Env-driven SeaweedFS public endpoint.** `SEAWEED_PUBLIC_ENDPOINT` already drove
  presigned-URL signing; the Coolify compose wires it to SeaweedFS's generated FQDN.

You still need, at deploy time:

- A Coolify server (v4+) with a wildcard DNS record pointing at it (needed for
  auto-generated preview subdomains).
- Two API keys total: **`OPENROUTER_API_KEY`** (LLMs, embeddings, and VLM — all
  through OpenRouter) and **`TAVILY_API_KEY`** (web search). See §6.
- A **`GRID_ADMIN_TOKEN`** (any high-entropy string, e.g. `openssl rand -hex 32`)
  gating the admin re-ingestion route — now required (see §4).
- For production auth (default on): **`WORKOS_CLIENT_ID`**, **`WORKOS_API_KEY`**,
  **`WORKOS_COOKIE_PASSWORD`** — see the Auth section in §4.

---

## 3. Coolify magic variables used

The compose file relies on Coolify's [magic env vars](https://coolify.io/docs/knowledge-base/docker/compose),
which are generated per deployment and stay consistent across the stack:

| Variable | Effect |
|---|---|
| `SERVICE_FQDN_FRONTEND_3000` | Exposes `frontend:3000` under a generated https domain; readable as `${SERVICE_FQDN_FRONTEND}` |
| `SERVICE_FQDN_SEAWEEDFS_8333` | Exposes `seaweedfs:8333` (S3 API) under a domain; readable as `${SERVICE_FQDN_SEAWEEDFS}` |
| `SERVICE_PASSWORD_POSTGRES` | Auto-generated Postgres password (embedded in every DB URL) |
| `SERVICE_PASSWORD_SEAWEEDFS` | Auto-generated SeaweedFS secret key |
| `SERVICE_PASSWORD_INTERNALTOKEN` | Auto-generated shared token for the single-writer memory endpoint |

Because these are stable per stack, each preview environment self-configures its
own domains, DB password, and internal token with no manual input.

---

## 4. One-time setup: the production / staging environment

1. **New Resource → Docker Compose**, connect this Git repository, pick your
   branch (e.g. `develop`).
2. **Base Directory**: leave at repo root (`/`). **Compose file path**:
   `deploy/compose/docker-compose.coolify.yaml`.
   > The compose `build:` contexts (`../..`, `../../frontends/ui`) and the
   > Postgres `./init-db.sql` bind mount both resolve relative to the compose
   > file's directory, so they work as-is from the repo checkout.
3. **Environment Variables** — set the required secrets:
   ```
   OPENROUTER_API_KEY=sk-or-...
   TAVILY_API_KEY=tvly-...
   GRID_ADMIN_TOKEN=$(openssl rand -hex 32)
   ```
   The same OpenRouter key drives LLMs, embeddings, and the VLM (§6).
   `GRID_ADMIN_TOKEN` gates the admin re-ingestion route. The `${...:?}` markers
   make all three **required** (the deploy fails fast if missing). Because
   `REQUIRE_AUTH` defaults to `true` (see the Auth section below), a production
   deploy also needs `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and
   `WORKOS_COOKIE_PASSWORD`. All passwords/tokens prefixed `SERVICE_PASSWORD_*`
   are generated by Coolify; you do not set them. The OIB knowledge base is
   volume-based and embedded live on first boot — there is nothing extra to
   configure for it (§7).
4. **Domain**: Coolify assigns the frontend a generated domain from
   `SERVICE_FQDN_FRONTEND_3000`. Optionally override it with your own domain in
   the service's settings. Do the same for SeaweedFS if you want a stable S3 URL.
5. **Deploy.** On first boot: Postgres runs `init-db.sql` (creates the 3 DBs),
   the frontend runs Drizzle migrations for `grid_app`, `seaweedfs-init` creates the
   bucket, and the backend starts + kicks off OIB ingestion in the background.

### WebSockets

The chat stream runs over a WebSocket at `/websocket`, proxied by the frontend
gateway to the backend. Coolify's Traefik proxy passes WebSocket upgrades by
default — no extra config. Verify after deploy by opening a chat and watching
the browser Network tab for a `101 Switching Protocols` on `/websocket`.

### Networking

**The Coolify compose deliberately declares NO custom `networks:`.** Coolify
auto-creates one managed bridge network per compose stack (named after the
resource UUID) and attaches every service to it, so **service-name DNS already
works across the whole stack** — `frontend` reaches the backend at
`http://aiq-agent:8000`, the backend reaches `http://frontend:3000`, and both
reach `postgres:5432`, `seaweedfs:8333`, and `dragonfly:6379` by name. No custom
network is needed to get this.

> **The dual-homed pitfall (why the custom `aiq-network` was removed).** Coolify
> [documents](https://coolify.io/docs/applications/build-packs/docker-compose)
> that defining a custom network in a compose resource makes every container
> **dual-homed** — attached to BOTH your custom bridge and Coolify's managed
> network. Two failures follow:
>
> 1. **Intermittent 504s.** Coolify's Traefik proxy sits only on the managed
>    network and then *non-deterministically* picks which of a container's two
>    IPs to route to. When it picks the custom-network IP it cannot reach the
>    container, so requests hang and Cloudflare surfaces a **504 Gateway
>    Timeout**. It is intermittent by nature — a stack can work after one deploy
>    and break after the next depending on which IP Traefik selected
>    ([coolify#6215](https://github.com/coollabsio/coolify/issues/6215), a known
>    duplicate of #4483; also
>    [discussion#5059](https://github.com/coollabsio/coolify/discussions/5059)).
> 2. **Sporadic name-resolution failures.** A dual-homed container carries two
>    interfaces/resolver entries, which is the source of the intermittent
>    `Temporary failure in name resolution` seen when the backend tries to reach
>    `frontend:3000` at startup.
>
> This matched our production symptoms exactly: intermittent frontend→backend
> fetch hangs ending in Cloudflare 504, backend→frontend name-resolution errors
> at boot, while an already-established WebSocket kept working (it connected
> during a good routing window and stayed up — only *new* connections re-roll
> the dice). Removing the custom network makes every container **single-homed**
> on the managed network and fixes both. This is the Coolify-prescribed pattern:
> rely on the managed network + service-name DNS, and never declare a custom
> `networks:` block in a compose resource.

**Cross-stack access.** To reach a service in a *different* Coolify stack (e.g. an
external managed database), do **not** re-add a custom network — enable the
resource's **Connect To Predefined Network** option instead. It is not needed for
anything in this stack, since all services live in the same compose project.

> The bundled dev compose (`deploy/compose/docker-compose.yaml`) still declares
> its own `aiq-network` — that is correct and unchanged. It runs under plain
> `docker compose` with **no** Coolify-managed network and **no** Traefik, so
> there is nothing to be dual-homed against. The custom-network removal applies
> **only** to the Coolify compose file.

#### Verification runbook (after deploy)

Network changes require container recreation, so **redeploy the stack** (see
below) before probing. Then exec into the containers and confirm both directions
of service-name DNS resolve and connect. Container names are Coolify-namespaced,
so grab them from `docker ps` first (or use the Coolify terminal for each
service).

```bash
# frontend → backend: expect the backend's health JSON, and NO proxy vars set
docker exec <frontend-container> sh -c 'env | grep -i proxy; wget -T 10 -O- http://aiq-agent:8000/health'

# backend → frontend: expect HTTP 200 from the healthz endpoint
docker exec <aiq-agent-container> sh -c 'curl -m 10 http://frontend:3000/api/healthz'
```

- The `env | grep -i proxy` line should print **nothing** — Coolify does not
  inject `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` into app containers, so those
  are ruled out as a cause of the hangs. If your org sets them globally on the
  Docker daemon, add the in-cluster service names to `NO_PROXY`.
- Both probes should return promptly (well under the 10s timeout). A hang or
  timeout here means the container is still dual-homed — re-check that the
  compose has no `networks:` block and that you **redeployed** (a plain restart
  reuses the old network attachments).

> **You must REDEPLOY, not just restart.** Docker network membership is fixed at
> container creation. After pulling this change, trigger a full **Redeploy** in
> Coolify so every container is recreated on the managed network only. A restart
> of the existing containers keeps the old dual-homed attachments and the
> intermittent 504 / DNS failures persist.

### Auth

`REQUIRE_AUTH` defaults to **`true`** in this production compose (both the
frontend and the `aiq-agent` backend) → WorkOS AuthKit is required end-to-end.
Configure it by setting `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and
`WORKOS_COOKIE_PASSWORD` (`openssl rand -hex 32`), and register
`https://<your-frontend-domain>/api/auth/callback` as the redirect URI in WorkOS
(the compose already injects it from the frontend FQDN). Without these the
frontend cannot complete a login.

> **Opting out for a throwaway preview.** To run a preview as a single
> anonymous "Default User" (no WorkOS setup), set `REQUIRE_AUTH=false`
> explicitly in that environment's variables and leave the WorkOS keys empty.
> Do **not** do this for a production/staging environment — it disables login
> and the backend's job-ownership checks.

`REQUIRE_AUTH` only gates *external* requests. Internal frontend→backend calls
over the Coolify network are always classified internal, so setting it `true`
never breaks in-cluster traffic. `AIQ_EXTERNAL_HOSTNAMES` is wired to the
frontend FQDN as defense-in-depth: should the backend's port 8000 ever be
exposed under that domain, requests would be forced through the path allowlist
and auth instead of being trusted as internal.

`GRID_ADMIN_TOKEN` is **required** (`${...:?}`) — it gates the admin
re-ingestion route (`POST /v1/admin/oib/sync`). An empty value made that route
fail *open*, so the deploy now fails fast if it is unset. Generate one with
`openssl rand -hex 32`.

---

## 5. Per-PR preview deployments

Coolify can spin up a full isolated copy of the stack for every pull request.

1. Connect the app to GitHub via a **GitHub App** (Settings → Sources), not a
   deploy key — preview deployments need PR webhooks.
2. In the application's **Preview Deployments** tab, enable them and set the
   preview domain template, e.g. `pr-{{pr_id}}.grid.example.com`. With a wildcard
   DNS record (`*.grid.example.com`) each PR gets a unique subdomain.
3. Open a PR → Coolify builds the compose from the PR branch into a **namespaced
   stack with its own containers and volumes**. The magic FQDN/password vars
   regenerate per preview, so isolation is automatic. Merge/close the PR →
   Coolify tears the environment down.

This is why the Coolify compose **drops `container_name:` and all published host
`ports:`** — fixed names and host-port bindings collide the instant a second
preview exists. Public reachability comes entirely from the proxy + FQDN vars.

### The cost of OIB ingestion per preview

The knowledge base is **purely volume-based** — there is no baked seed. Each
fresh preview starts with an empty Chroma volume, so the backend ingests and
**embeds the repo-shipped OIB corpus (`data/oib/*.pdf`) on first boot** — real
OpenRouter embedding spend and a few minutes of warm-up, once per new volume
(the persistent volume means a redeploy of the *same* environment reuses the
already-embedded corpus and pays nothing).

For a heavy stack like this, previews are not free (each = backend + Postgres +
SeaweedFS + Chroma). Consider **limiting previews to labelled PRs** and a single
always-on **staging** environment for day-to-day demos so the corpus is embedded
once and then reused across redeploys.

---

## 6. Embeddings — everything routes through OpenRouter

There is **no separate embedding provider and no NVIDIA endpoint**. A single
`OPENROUTER_API_KEY` powers the LLMs, the embeddings, and the VLM:

- Embeddings: `openai/text-embedding-3-large` via `https://openrouter.ai/api/v1`.
- LlamaIndex's embedding client happens to read `NVIDIA_API_KEY` as its API key,
  so the compose sets `NVIDIA_API_KEY` to the OpenRouter key. Its `base_url`
  stays on OpenRouter — NVIDIA is never contacted. The compose defaults handle
  all of this; you only supply `OPENROUTER_API_KEY`.

So chat, web search, **and** the knowledge base all work with just
`OPENROUTER_API_KEY` + `TAVILY_API_KEY`.

> **Embedding-model stability rule:** the OIB embeddings are stored as vectors
> from a specific model. Retrieval only returns correct results if
> `AIQ_EMBED_MODEL` + `AIQ_EMBED_BASE_URL` at query time match what embedded the
> corpus on first boot. Keep the compose defaults
> (`openai/text-embedding-3-large` @ OpenRouter); changing the embedder means the
> persisted vectors must be re-generated (`OIB_FORCE_REINGEST=true` once).

---

## 7. The OIB knowledge base is volume-based (no seed)

The OIB knowledge base lives entirely on two persistent volumes and is **not**
baked into the image:

- **Embeddings** — a Chroma directory (`chroma.sqlite3` + per-collection HNSW
  index files) under `AIQ_CHROMA_DIR` (`/app/data/chroma_data`, volume
  `chroma_data`).
- **Source PDFs + registry** — `data/oib/*.pdf` (committed to the repo as normal
  git blobs, ~71 MB, so they ship in every image), admin uploads under
  `data/oib_uploads/`, and `data/oib_registry.json` (a `pdf-path → sha256` map),
  all on the `aiq-data` volume (`/app/data`).

On boot, `oib_sync` compares each PDF's hash to the registry and embeds only what
is new or changed. Because both volumes persist across redeploys of the same
environment, a **redeploy re-uses the already-embedded corpus and pays nothing**.
A brand-new volume (first-ever deploy, or a fresh per-PR preview) has no registry
yet, so the repo-shipped `data/oib/*.pdf` are embedded live on first boot — a
one-time cost per new volume (§5).

> **Why no baked seed?** A previous version fetched a pre-embedded tarball at
> build time (`OIB_SEED_URL` + an `oib-seed` Dockerfile stage) and restored it on
> first boot to skip embedding. That system has been removed in favour of the
> simpler volume-based model above: nothing to generate, host, or keep in sync
> with the corpus. The trade-off is that a *fresh* volume re-embeds the corpus
> once instead of restoring instantly.

---

## 8. Persistent volumes

Coolify creates and persists these named volumes per environment. All survive
redeploys of the same environment; each preview gets its own set.

| Volume | Mount | Contents | Loss on delete |
|---|---|---|---|
| `postgres-data` | `/var/lib/postgresql/data` | All app + job + checkpoint state | **Everything** |
| `seaweedfs-data` | `/data` | Project/Archiv user document uploads (presigned serving) | All files |
| `chroma_data` | `/app/data/chroma_data` | Vector index (incl. the OIB corpus embeddings) | Re-ingest needed |
| `aiq-data` | `/app/data` | Backend working data, ingestion registry, and the **OIB corpus source PDFs** (`oib_uploads/`) | Re-ingest needed |

> **The OIB base corpus is not in SeaweedFS.** Its source PDFs live on `aiq-data`
> (`data/oib/` shipped in the image, `data/oib_uploads/` for admin uploads) and
> its embeddings on `chroma_data`. SeaweedFS holds only project/Archiv user uploads.
> Both OIB volumes persist across redeploys of the same environment, so an
> ingested corpus survives a redeploy — it is lost only if the volumes are
> deleted (or a brand-new preview environment starts with empty volumes, in
> which case the repo-shipped `data/oib/*.pdf` are re-ingested live on first
> boot).

---

## 9. Post-deploy checklist

- [ ] Frontend domain loads the UI over https.
- [ ] Open a chat → WebSocket `/websocket` returns `101` (streaming works).
- [ ] Upload a PDF → it stores and the preview/download link (presigned SeaweedFS
      URL) opens in the browser. If the link 403s, check `SEAWEED_PUBLIC_ENDPOINT`
      resolves to SeaweedFS's public domain and the signature host matches.
- [ ] Ask an OIB question → knowledge results appear (confirms embeddings +
      ingestion). If empty, revisit §6 and §7.
- [ ] (If a managed/external Postgres is used instead of the bundled one) the
      three databases exist — run `deploy/compose/init-db.sql` manually.

---

## 10. Differences from the bundled dev compose — quick reference

| Concern | Dev compose | Coolify compose |
|---|---|---|
| Container names | fixed (`aiq-agent`, …) | none (Coolify namespaces) |
| Docker network | custom `aiq-network` (bridge) | none declared — Coolify's managed per-stack network (avoids dual-homed 504/DNS failures) |
| Host ports | published (3000, 8000, 5432, 8333/8888) | none — proxy + FQDN vars |
| Secrets | `deploy/.env` literals | Coolify UI (`${VAR:?}`) + generated passwords; `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `GRID_ADMIN_TOKEN` all required |
| Auth (`REQUIRE_AUTH`) | `false` (dev convenience) | **`true`** by default (WorkOS required; opt out per-preview) |
| External-host classification | unset | `AIQ_EXTERNAL_HOSTNAMES` = frontend FQDN (defense-in-depth) |
| Frontend/SeaweedFS exposure | `localhost:PORT` | `SERVICE_FQDN_*` https domains |
| CORS / redirect / SeaweedFS public URL | `localhost` defaults | derived from generated FQDNs |
| `configs/` bind mount | mounted read-only | dropped (baked into the image) |
