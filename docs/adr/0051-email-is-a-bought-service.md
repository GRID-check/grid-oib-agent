---
status: proposed
date: 2026-08-28
decision-makers: platform owner
consulted: Grid engineering
informed: everyone working in this repo
---

# Email is a bought service: routed inbound, relayed outbound, never an MTA on our cluster

## Context and Problem Statement

The question that produced this record: could we run our own mail server on the
Docker/Kubernetes cluster, behind Cloudflare, and send and receive mail from the
website reliably?

What is true today, measured on 2026-08-28 against Cloudflare's resolver:

| Name | Record | Value |
|---|---|---|
| `piloti.at` | MX | **none** |
| `piloti.at` | TXT | **none** — so no SPF |
| `_dmarc.piloti.at` | TXT | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` |
| `piloti.at` | NS | `aspen.ns.cloudflare.com`, `tim.ns.cloudflare.com` |

So no address `@piloti.at` receives anything: with no MX, a sender falls back to
the apex A record (RFC 5321 §5.1), which is Cloudflare's proxy — it does not
answer on port 25, and the mail bounces. Nothing is authorised to send as the
domain either. The DMARC record is the one GoDaddy left behind, carried across
the nameserver move verbatim (`deploy/pulumi/Pulumi.dev.yaml`), and its
aggregate reports go to a GoDaddy collector nobody here reads.

On the application side there is no send path at all. The website's only contact
channel is a `mailto:` link (`frontends/web/src/consts.ts`, used by `Cta.astro`,
`Footer.astro`, `Wertrechner.astro`, `data/legal.ts`). No SMTP client, no
transactional-mail SDK, and no queue for one exists in either frontend or the
agent. The mail our users actually receive today — sign-in, invitations — is
sent by WorkOS from WorkOS's own infrastructure (ADR-0009), which is why nobody
has noticed the domain cannot send.

The decision, then, is not "which mail server" but "who runs the mail", and it
is worth writing down because the answer is load-bearing for a customer-facing
channel and expensive to reverse once addresses are printed on invoices.

## Decision Drivers

* **Deliverability is reputation, not software.** Getting an MTA to accept a
  message is an afternoon. Getting Google and Microsoft to put it in an inbox is
  a property of the sending IP's history, and ours has none.
* **The edge cannot cover it.** Cloudflare's proxy supports HTTP/S ports only
  (80/443 and the alternates); SMTP and IMAP are not on the list, and arbitrary
  TCP means Spectrum, which is Enterprise-plan. A self-hosted MX therefore
  publishes the cluster's real address in public DNS and opens port 25 on it —
  the one thing in this deployment that would sit outside the Gateway every
  other listener goes through (`deploy/pulumi/src/platform/gateway.ts`).
* **Cloudflare Email Routing cannot front our own server.** It forwards inbound
  mail only to *verified destination addresses* on the account (200 per account,
  200 rules per domain, 25 MiB per message). There is no mode where Cloudflare
  receives on our behalf and hands the message to an MTA we run. "Cloudflare in
  front of our mail server" is not a configuration that exists.
* **The cluster's operating profile is hostile to a mailbox host.** The managed
  provider upgrades Kubernetes and replaces worker nodes on *its* schedule
  (`docs/deployment/kubernetes.md` §2b), so a singleton with a ReadWriteOnce PVC
  is drained routinely. Inbound SMTP tolerates that (senders retry for days);
  IMAP clients do not. And there is no automated backup in this stack yet —
  managed Velero is a paid add-on we have not bought, and the interim is a
  *manual* VolumeSnapshot (§2b). A mailbox is the one datastore here that cannot
  be rebuilt from a re-index or a re-crawl.
* **Outbound identity is not ours to set.** The Envoy LoadBalancer address
  (`45.144.209.196`, pinned as `grid-oib:loadBalancerIp`) has **no PTR record**,
  and its reverse zone `209.144.45.in-addr.arpa` is delegated to `ns1.ipax.at` —
  the provider's, not ours. Egress also leaves through the provider's shared NAT
  unless the dedicated outbound NAT IP is bought as a Control-Center setting, so
  by default the address we would be sending from is neither the address we
  publish nor an address whose reputation we control. Whether the provider even
  permits outbound port 25 is unanswered and has to be asked before any of this
  is costed; most providers block it by default, precisely because rented
  compute is the cheapest way to send spam.
* **Buy, don't build** (`AGENTS.md`). Mail is somebody else's domain in exactly
  the sense that identity, object storage and LLM tracing were: spam filtering,
  abuse handling, feedback loops, TLS reporting, MTA-STS, and the operational
  duty of being reachable at 3am because a queue filled up.
* **Mailbox content is the most sensitive personal data we would hold**, with a
  longer retention than anything else in the stack, for an Austrian operator
  under the GDPR. Self-hosting moves that risk onto a cluster whose backup story
  is a follow-up.

## Considered Options

* **A. Self-hosted MTA + mailboxes on the cluster** — Stalwart, Mailcow,
  `docker-mailserver` or Maddy as a StatefulSet, a second `LoadBalancer` Service
  for 25/465/587/993, TCP listeners on the Gateway, a PVC for the queue and the
  maildir.
* **B. Cloudflare Email Routing inbound + a transactional API outbound**
  (Resend, Postmark, Mailgun, SES). Free inbound forwarding to an existing
  mailbox; outbound over HTTPS from the BFF, with SPF/DKIM published by us.
* **C. A hosted mailbox provider** (Migadu, Fastmail, mailbox.org, Microsoft
  365) for human mail, plus B's transactional API for application mail.
* **D. Do nothing** — keep the `mailto:` link and let WorkOS keep sending the
  auth mail.

## Decision Outcome

Chosen option: **B, growing into C when real mailboxes are needed** — because it
buys the only two things that are actually hard (inbound spam handling and
outbound reputation) for roughly a day of work, while A buys a permanent
operational duty in exchange for control we have no use for.

Concretely:

1. **Inbound.** Cloudflare Email Routing on `piloti.at`, configured through the
   same Pulumi DNS module that already owns the zone
   (`deploy/pulumi/src/platform/dns.ts`) — MX records plus the routing rules,
   forwarding `hallo@`, `office@`, `datenschutz@` to a verified destination.
2. **Outbound.** One transactional provider, called over HTTPS from the BFF. No
   SMTP egress from the cluster at all, which keeps working whatever the
   provider's port-25 policy turns out to be.
3. **DNS as code.** SPF, the provider's DKIM selector, and a DMARC record that
   is ours rather than GoDaddy's, all added to `dns.ts` with cases in
   `dns.spec.ts`, so the mail policy is reviewed like the rest of the edge.
4. **Until (1) ships**, `piloti.at` should say so honestly in DNS: `v=spf1 -all`
   on the apex and `p=reject` in DMARC state that the domain sends no mail,
   which is both true and the strongest anti-spoofing posture available. The
   current `p=quarantine` with no SPF is the weakest of the three.

Option A is rejected for the *sending* half without qualification. Receiving
alone (an MX and a mailbox, no outbound) is the genuinely cheap half of
self-hosting and could be revisited if a product feature ever needs to *parse*
inbound mail — the point at which forwarding stops being enough.

### Consequences

* Good, because the deliverability problem is bought rather than solved: the
  provider owns the sending IPs' reputation, the feedback loops and the
  suppression lists, and a new domain warms up on their pool rather than on a
  cold /22 in Vienna.
* Good, because nothing new listens on the public internet. The cluster keeps
  exactly one ingress path, through the Gateway, and the NetworkPolicy story
  (`deploy/pulumi/src/platform/network-policies.ts`) is unchanged.
* Good, because it survives node drains. Both halves are stateless from our
  side; there is no queue of ours to lose and no maildir to snapshot.
* Good, because it is reversible. Mail identity lives in DNS records we own; a
  move to another provider, or to option A in five years, is a DKIM selector and
  an MX change.
* Bad, because outbound mail becomes a paid dependency with a rate limit and a
  terms-of-service, and a provider outage is our outage.
* Bad, because message content transits a third party. For contact-form and
  transactional mail that is the same trust boundary as WorkOS already holds;
  it would need revisiting before anything confidential is mailed.
* Bad, because Email Routing forwards rather than hosts: replies come *from* the
  destination mailbox, so a real `@piloti.at` reply-from address means option C,
  not a workaround.
* Neutral, because the effort not spent is the point. The comparison is below.

### What option A would actually cost

Recorded because "how hard would it be" was the question, and the honest answer
is not that it is technically difficult:

| Phase | Work | Where the time goes |
|---|---|---|
| Prerequisite | Ask the provider whether outbound 25 is permitted, and whether a dedicated egress IP with a PTR we choose is purchasable | **Blocks everything.** A "no" ends option A outright, and it is a support ticket, not a config field |
| Manifests | StatefulSet + PVC, a second `LoadBalancer` Service for 25/465/587/993, Gateway TCP listeners, secrets, and the *same* service added to `deploy/compose/docker-compose.yaml` and to `index*.spec.ts` per `deploy/AGENTS.md` | 1–2 days, and the least interesting part |
| DNS + identity | MX, SPF, DKIM keypair and selector, DMARC, PTR request, MTA-STS policy host, TLS-RPT | A day, plus the provider's turnaround on the PTR |
| Getting delivered | Warm-up, seed-list testing, Google Postmaster and Microsoft SNDS enrolment, the first "why did Outlook silently drop it" week | **Weeks of calendar time, unbounded.** This is the actual cost, and no amount of engineering shortens it |
| Forever | Patching an internet-facing MTA, watching the queue, handling blocklist entries, backups the cluster does not yet do, and being on call for a channel customers judge us by | Ongoing, and it never becomes someone else's job |

Option B is a Cloudflare dashboard section, one API key, one HTTPS call site, and
four DNS records in `dns.ts`. Half a day, most of it the spec cases.

### Confirmation

Nothing enforces this yet. What would, and belongs in the change that implements
it:

* The DNS records land in `dns.ts` with cases in `dns.spec.ts`, so SPF/DKIM/DMARC
  drift fails `task infra:test` rather than being discovered by a bounce.
* `loadConfig` already refuses hosts outside the zone; the mail hostnames go
  through the same validation.
* A Gateway with no non-HTTP listener is the invariant that keeps port 25 off
  this cluster. It is currently true by construction and untested; a spec case
  asserting the listener protocols would ratchet it.

## More Information

* Inbound limits: [Cloudflare Email Routing limits](https://developers.cloudflare.com/email-routing/limits/).
* Why the edge cannot carry SMTP: [Cloudflare network ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/).
* Cluster operating profile, node drains, backups, egress:
  [`../deployment/kubernetes.md`](../deployment/kubernetes.md) §2b.
* Zone ownership, the grey-cloud decision and the DMARC record's provenance:
  [`../../deploy/pulumi/src/platform/dns.ts`](../../deploy/pulumi/src/platform/dns.ts),
  [`../../deploy/pulumi/Pulumi.dev.yaml`](../../deploy/pulumi/Pulumi.dev.yaml).
