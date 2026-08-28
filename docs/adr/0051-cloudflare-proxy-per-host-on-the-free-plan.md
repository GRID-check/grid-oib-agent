---
status: accepted
date: 2026-08-28
decision-makers: Grid engineering
consulted: platform owner
informed: everyone working in this repo
---

# The Cloudflare proxy is applied per host by a rule in code, not by a config key

## Context and Problem Statement

Cloudflare has operated this zone since `platform/dns.ts` was written, but every
record has been grey-clouded — DNS only. The comment explaining why named three
blockers together and concluded that proxying "has to be a deliberate one, made
together with a DNS-01 issuer and a paid upload limit". That reads as one
decision with a price tag on it, so nobody revisited it, and the zone kept
paying for none of the free plan's edge in exchange.

Taking the blockers apart, they are not one decision and only one of them costs
money:

* **ACME.** cert-manager solves HTTP-01 through the Gateway. Behind the proxy
  that depends on four things this program does not own. Cost of fixing it:
  a DNS-01 solver and one Kubernetes Secret, using the token that already writes
  the zone. **Free.**
* **Uploads.** `s3Domain` carries presigned browser uploads. Cloudflare rejects
  a body over 100 MB at the edge on Free and Pro alike, with a 413 the origin
  never sees. `frontends/ui`'s own advertised maximum file size is *also*
  100 MB, so the largest upload the product offers is the first to fail. Cost of
  fixing it: Business, and even that only reaches 200 MB. **Not worth it, and
  not needed — the constraint is on one host.**
* **WebSockets.** Cloudflare closes a proxied socket after 100s with no frame in
  either direction, on every plan below Enterprise. The browser `WebSocket` API
  cannot send a ping frame, and the one place that could inject one — the
  `http-proxy` splice in `frontends/ui/server.js` — pipes raw TCP chunks that
  may carry partial frames, so writing a ping into that stream can desynchronise
  it. Every idle chat would instead reconnect on a ~100s cycle, and the
  reconnect is a WS upgrade: session resolution, an FGA check and a budget read,
  the most expensive request the app serves (ADR-0040 § L2a). **Not worth it,
  and not needed — the constraint is on one host.**

Two of the three are properties of *one host each*. Nothing about them argues
for keeping the landing site off the edge.

## Decision Drivers

* Every remaining win is on the free plan; the decision is about blast radius,
  not budget.
* `xffNumTrustedHops` sits on a `ClientTrafficPolicy` that targets the Gateway,
  so it applies to every listener. There is no per-host form of it.
* Both refusals are silent at deploy time. A 413 at the edge and a closed socket
  produce no failed resource, no Kubernetes event and no entry in any log this
  repo collects.
* The zone is shared by two stacks (`dev`, `prod`), so anything zone-level needs
  the existing at-most-one-owner rule.

## Considered Options

* **Stay entirely grey.** What we had.
* **A per-host `dnsProxiedHosts` list in stack config.**
* **One flag, with the per-host verdict decided in code.**
* **Proxy everything and pay for Enterprise** to lift the WebSocket timeout.

## Decision Outcome

Chosen option: **one flag, with the per-host verdict decided in code**
(`proxyPlan` in `src/platform/dns.ts`), because whether a host can be proxied is
a property of what it *serves*, and the program already knows what each host
serves.

`dnsProxyEnabled` says whether the policy is applied at all — it is off by
default because turning it on moves live traffic through a third party, which is
a deploy to watch rather than something that should arrive with a merge. It does
not say *which* hosts, because that is not an operator preference. Today the
answer is: the landing site, and nothing else.

Every refusal carries its reason as data, surfaced three ways: in the Cloudflare
record comment, in `pulumi stack output dnsProxyPlan`, and in the error text of
the guards. A refusal nobody can read is re-litigated every six months.

### Consequences

* Good, because the landing site gains the free WAF managed ruleset, L7 DDoS
  absorption, edge caching of Astro's hashed output, Brotli, HTTP/3 and an
  origin address absent from its DNS answer — for one config key.
* Good, because the zone gains TLS policy it did not have: Full (strict), a TLS
  1.2 floor, HSTS, and Always Use HTTPS, none of which needed the proxy decision
  to be all-or-nothing.
* Good, because DNS-01 removes the certificate renewal path's dependency on
  Cloudflare forwarding `/.well-known/acme-challenge/` — a failure that would
  surface up to 90 days late.
* Good, because the two refusals are now testable statements with numbers in
  them rather than a paragraph in a comment, so the day a plan or a client API
  changes, the test names what to re-check.
* Bad, because **the origin address is still public.** `app.` and `s3.` resolve
  to the LoadBalancer directly, so the edge is a cache and a WAF, never a
  perimeter. Hiding the origin needs every host proxied, which needs the
  WebSocket problem solved first.
* Bad, because `xffNumTrustedHops` is now pinned at 0 by a guard. Correct while
  the zone is mixed, but it means the app tier's per-IP limits keep seeing the
  LoadBalancer's view of the client and cannot be improved by proxying alone.
* Bad, because a third party is now in the request path for the landing site. A
  Cloudflare edge incident takes it down; `alwaysOnline` reduces that to a stale
  page rather than an error, which is a mitigation and not a fix.
* Neutral, because zone-level settings are owned by whichever stack holds
  `dnsZoneBaseline`. Correct, and it means the staging stack currently sets TLS
  policy that will govern production the day production turns orange.

### Confirmation

`deploy/pulumi/src/platform/dns.spec.ts` asserts each verdict *and* that its
reason still names the constraint it rests on (`100 MB`, `100s`), so a refusal
cannot quietly outlive its cause. `edge.spec.ts` pins the settings that are
dangerous when wrong — `ssl: strict` rather than `flexible`, HSTS without
`preload`, the never-cache rule ahead of the cache rule.

`index-proxy.spec.ts` constructs the whole program with the proxy on and asserts
the cross-module agreement no unit test can: that the DNS-01 solver's `dnsNames`
equals the set of hosts actually published orange, from the same derivation
rather than a second list.

`loadConfig` refuses `xffNumTrustedHops > 0` while any host is direct, refuses
CAA and DNSSEC from a stack without `dnsZoneBaseline`, and refuses any of the
three flags while `dnsEnabled` is false.

## Pros and Cons of the Options

### A per-host `dnsProxiedHosts` list in stack config

* Good, because it is obvious what is proxied by reading the stack file.
* Bad, because it invites exactly the mistake that has no error: adding
  `s3.<domain>` is accepted by Cloudflare, by Pulumi and by every smoke test,
  and fails on the first upload over 100 MB.
* Bad, because the reason for each exclusion has nowhere to live but a YAML
  comment, which is not checked by anything and does not reach the operator
  reading `pulumi stack output`.

### Proxy everything and pay for Enterprise

* Good, because it is the only option that hides the origin completely.
* Bad, because Enterprise is priced for a company several stages from this one,
  to buy a configurable idle timeout on a socket that a client-side heartbeat
  would also solve.
* Neutral, because the free-plan version of the same fix — a heartbeat under
  100s — stays available and is the thing to build if proxying `app.` ever
  becomes the goal.

## More Information

**Revisit this when** `frontends/ui` grows a WebSocket heartbeat. That single
change removes the only reason `appDomain` is direct, and proxying it is what
makes hiding the origin possible — at which point `xffNumTrustedHops` becomes
raisable and the whole zone can be locked to Cloudflare's ranges. The
server-side alternative (injecting ping frames at the `http-proxy` splice) needs
frame-aware buffering on the origin→client direction, which the existing
client→origin `createFrameObserver` shows the shape of.

Free-plan limits this rests on, all confirmed 2026-08-28: 100 MB request body,
100s WebSocket idle timeout, 10 cache rules, 10 transform rules, 5 custom WAF
rules, 1 rate limiting rule (path + IP, 10s window), and the Cloudflare Free
Managed Ruleset deployed automatically. The rate limiting rule is deliberately
unused — ADR-0040 already limits the app tier at the Gateway, where the windows
are ours to choose, and the only proxied host is static.

Operational detail, including the token scopes and the cutover order:
[`docs/deployment/kubernetes.md`](../deployment/kubernetes.md) §3b–3c.
