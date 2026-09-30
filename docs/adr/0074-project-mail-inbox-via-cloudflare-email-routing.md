---
status: accepted
date: 2026-09-30
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Project mail inbox: receive through Cloudflare Email Routing and file through `uploadDocument`

## Context and Problem Statement

Planning offices get most of their files by email: plans from the engineer,
permits from the authority forwarded by the client, specifications from
manufacturers. Today every one of those is downloaded from the mail client and
uploaded again into the project, by hand. We want each project to have an
address a member can forward mail to, with the attachments filed in the project
as if that member had uploaded them.

Receiving mail needs an MX somewhere. The question is whose, and what sits
between it and the project.

## Decision Drivers

* Buy, don't build. Port 25, spam, TLS and delivery retries are someone else's
  domain.
* One upload path (ADR-0055). Permission, type allowlist, size, quota
  (ADR-0042), versioning, audit and ingest must be the ones a UI upload gets.
* Tenant isolation on a domain every organization shares (ADR-0041).
* Data minimisation: nothing raw stored, no mail body stored.
* Cost at our volume, which is small: a few hundred mails a day at most.

## Considered Options

1. Self-hosted inbound SMTP (Postfix, Haraka or aiosmtpd) in the cluster.
2. Cloudflare Email Routing with an Email Worker.
3. Mailgun inbound routes, EU region.
4. Amazon SES inbound in eu-central-1.

## Decision Outcome

Chosen option: 2, Cloudflare Email Routing with an Email Worker, because
Cloudflare already runs our DNS, receiving is free, and a Worker can hand the
raw message to our own webhook without any storage in between.

* A catch-all on `GRID_INBOUND_MAIL_DOMAIN` routes every mail to one Worker.
  The Worker does not parse. It posts the raw bytes to
  `POST /api/internal/inbound-mail` with its own token
  (`GRID_INBOUND_MAIL_TOKEN`) and maps the answer: 2xx accepts, 403/404/413
  reject with one fixed text, 429 and 5xx make Cloudflare signal a temporary
  failure so the sending MTA retries.
* The address is `<slug>.<token>@<domain>`. Only the 12-character base32
  token resolves; the slug is decoration.
* The BFF resolves the token in one `withPlatformAccess` lookup, then works
  inside `withTenant`. It verifies the sender, looks them up in the target
  organization only, and requires `project:documents:write` or `project:edit`
  on that project. v1 accepts project members only; everyone else is
  rejected, with no quarantine.
* Each attachment goes through `uploadDocument` under a session pinned to that
  member, into `E-Mail-Eingang/<date> <subject> – <sender>`. The mail is
  parsed in memory. No `.eml` and no body is stored.
* Sender verification is ours. Cloudflare rejects mail that passes neither
  SPF nor DKIM, or fails an enforcing DMARC policy, but it does not give a
  Worker its verdicts
  ([workerd#6740](https://github.com/cloudflare/workerd/issues/6740), open
  since 2026-05-07). Without them, a From header is just text. The BFF
  therefore accepts a message only with a valid DKIM signature aligned with
  the From domain, or when the From domain publishes DMARC `p=quarantine` or
  `p=reject`, which Cloudflare has already enforced upstream. `mailauth` does
  the DKIM verification and the DMARC lookup.

### Consequences

* Good, because there is one upload path. Everything a UI upload enforces, an
  emailed attachment gets without a second implementation.
* Good, because nothing runs on port 25 in our cluster and no mail is stored
  on either side.
* Good, because it costs nothing on the free Workers plan, and $5 a month on
  the paid plan if the handler outgrows the free CPU limit.
* Good, because a leaked address alone files nothing: the sender must be a
  verified member with write access.
* Bad, because Cloudflare becomes a sub-processor for mail content in transit,
  under the EU-US Data Privacy Framework, and processes it in the nearest data
  centre with no EU guarantee. A customer that requires EU-only processing
  cannot use this inbox.
* Bad, because senders whose domain has neither aligned DKIM nor an enforcing
  DMARC policy are rejected. That includes Microsoft 365 tenants that sign only
  with `*.onmicrosoft.com`. Their admins must enable custom DKIM, or the member
  uploads by hand.
* Bad, because the sender learns of success only in the app. v1 sends no mail,
  so there is no confirmation reply; a rejection is Cloudflare's bounce with
  our fixed text.
* Bad, because the message size is capped at Cloudflare's 25 MiB, below what a
  plan set sometimes reaches.
* Neutral, because the DSGVO review is
  [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md),
  with the Datenschutzberater sign-off still open.

### Confirmation

* `frontends/ui/src/app/api/authz-coverage.spec.ts`: every handler must come
  from a route factory, so the webhook has to be an `internalApiRoute` behind
  its token, and the two project address routes must state their
  authorization posture.
* `frontends/ui/src/lib/db/rls-coverage.spec.ts`: both new tables must be
  registered with `grid_secure_table`, and `task db:test:rls` runs the
  policies against PostgreSQL.
* The inbound-mail specs in `frontends/ui/src/lib/inbound-mail/` and the
  webhook route spec: token-only resolution, sender verification, the
  org-scoped roster, the attachment filter, dedupe keyed by address.
* `deploy/pulumi/src/platform/inbound-mail-worker.spec.ts` and the Pulumi
  spec cases: the Worker's answer mapping and the single rejection text, and
  that nothing is created when the inbound domain is unset.
* Nothing enforces that Cloudflare's "Email preview" stays off. It applies to
  sending domains only, and v1 adds none, but it is a dashboard setting that
  turns on by default for a new sending domain. The deploy guide says so;
  review is the only gate.

## Pros and Cons of the Options

### Self-hosted inbound SMTP

* Good, because mail never leaves infrastructure we run, which answers the EU
  question outright.
* Bad, because we would own port 25 exposure, spam and abuse filtering, TLS
  certificates for the MX, queueing and retries, and uptime. That is the
  "buy, don't build" case the root guide warns about.
* Bad, because several cloud providers block or throttle port 25, and a new IP
  has no reputation.

### Cloudflare Email Routing with an Email Worker

* Good, because free, and already our DNS provider, so MX records and the
  routing rule live in the same Pulumi stack as the rest of the zone.
* Good, because the Worker streams the raw message to our webhook; there is no
  mailbox or bucket in between.
* Bad, because 25 MiB per message, no EU processing guarantee, and no
  authentication verdicts passed to the Worker.

### Mailgun inbound routes, EU region

* Good, because an EU region with EU processing, and a route that POSTs a
  parsed message to a webhook.
* Neutral, because about 25 MB per message.
* Bad, because a paid plan from about $15 a month, and a new vendor, DPA and
  API key to manage.

### Amazon SES inbound, eu-central-1

* Good, because Frankfurt, a 40 MB limit, and cost in cents at our volume.
* Bad, because inbound SES writes to S3 and notifies through SNS, so we would
  run SES, S3 and SNS plumbing plus a new AWS account and its IAM, for one
  feature.

## More Information

Revisit when:

* a customer requires EU-only processing (switch to Mailgun EU or SES
  Frankfurt; the webhook contract stays);
* workerd#6740 is fixed and a Worker receives Cloudflare's verdicts (the
  own DKIM check could then be relaxed);
* v2 admits external senders, which needs malware scanning and a quarantine
  before it can ship;
* we start sending mail from this domain.

User guide: [`project-mail-inbox.md`](../user-guides/project-mail-inbox.md).
