# Cloudflare cutover runbook: piloti.at (apex → dev redirect)

## Diagnosis (verified 2026-09-18, live)

Going to the production site bounces to dev:

- `https://app.piloti.at/` → **307** → `https://piloti.at/`
- `https://piloti.at/` → **302** → `https://dev.piloti.at/`

The 302 is served by Cloudflare (`Server: cloudflare`, `CF-RAY` present), and
it is **not** this repo's doing:

- Hitting the prod origin directly with `Host: piloti.at`
  (`https://45.144.209.196/`, cert check skipped) returns **200, no redirect** —
  the prod Gateway serves the landing site at the apex correctly.
- The repo's Pulumi Cloudflare code manages only the NEW zone
  (`0a7bb49056371812b3cc7b94a9cb294b`, nameservers `gerald`/`mimi`), which is
  still pending and carries no traffic.
- The live redirect comes from the OLD Cloudflare setup currently holding the
  domain (nameservers `aspen`/`tim.ns.cloudflare.com`): a redirect rule / page
  rule there sends the apex to `dev.piloti.at`. No pull request can change a
  rule in that account — the fix below is two dashboard clicks.

## Immediate fix (old Cloudflare account, today)

1. Log into the Cloudflare account that holds `aspen`/`tim` nameservers.
2. Open the piloti.at zone → **Rules** → **Redirect Rules** (and legacy
   **Page Rules**): find the rule matching the apex (`http.host eq piloti.at`
   or `piloti.at/*`) targeting `https://dev.piloti.at`.
3. **Delete it** (or repoint it at the prod origin while the cutover runs).
4. Verify: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' https://piloti.at/`
   must stop returning `302 https://dev.piloti.at/`.

## Cutover to the new zone (registrar)

Cloudflare's checklist maps to these actions:

1. Registrar (find via ICANN Lookup): replace nameservers with
   `gerald.ns.cloudflare.com` + `mimi.ns.cloudflare.com`; delete
   `aspen.ns.cloudflare.com` + `tim.ns.cloudflare.com`.
2. **DNSSEC off** at the registrar before switching (re-enable through
   Cloudflare afterwards).
3. Wait for Cloudflare to verify (1–24 h). Nothing deploys in between.

What the new zone serves after cutover (already declared in Pulumi, no action):

- Apex `piloti.at` → A `45.144.209.196` (grey cloud, managed by the prod
  stack via `managedHosts`, since `webDomain` defaults to the apex). The
  landing site answers from the origin, as the direct-origin check proved.
- `www.piloti.at` → CNAME to apex (owned by the dev stack's `dnsZoneBaseline`;
  exactly one stack owns it by `loadConfig` guard).
- `app.piloti.at` → A `45.144.209.196` (prod). Its `/` answers 307 to
  `https://piloti.at/` by origin design (app hands off to the landing site).
- `*.dev.piloti.at` → `45.144.209.191` (dev stack, untouched).

Do NOT set `grid-oib:dnsApexRedirectTo` while prod serves the apex:
`loadConfig` refuses it (both would write the same record).

## Post-cutover verification

```powershell
# Apex serves the landing, no dev hop anywhere in the chain
(Invoke-WebRequest https://piloti.at/ -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode
# → 200
(Invoke-WebRequest https://app.piloti.at/ -MaximumRedirection 0 -SkipHttpErrorCheck).Headers['Location']
# → https://piloti.at/
Resolve-DnsName piloti.at -Type NS
# → gerald.ns.cloudflare.com, mimi.ns.cloudflare.com
```

If the apex ever needs to move again, keep it a **302**: a 301 is cached by
browsers indefinitely (same reason `dns.ts` hard-codes 302 for the placeholder
redirect) — every visitor would keep bouncing after the next move with no
server-side fix.

## Cleanup (after verification)

- Remove the piloti.at zone from the OLD Cloudflare account so two
  configurations cannot fight over the domain again.
- Prod checklist remainder: `useStagingIssuer` is still `"true"` in
  `Pulumi.prod.yaml` — flip to `"false"` only after DNS resolves and a staging
  cert has issued.
