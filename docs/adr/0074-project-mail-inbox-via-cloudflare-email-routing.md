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
receiving is free, the operator already has a Cloudflare account and Pulumi
provider for DNS, and a Worker can hand the raw message to our own webhook
without any storage in between. The inbound domain is the apex of a Cloudflare
zone of its own (Email Routing's catch-all exists only for a zone apex), so it
is a second zone in the same account, not a record in the app's zone.

* **Transport.** A catch-all on `GRID_INBOUND_MAIL_DOMAIN` routes every mail to
  one Worker. The Worker does not parse. It streams the raw bytes to
  `POST /api/internal/inbound-mail` with its own token
  (`GRID_INBOUND_MAIL_TOKEN`), the envelope recipient in `x-envelope-to` and
  the size in `x-inbound-raw-size`.
* **The verdict contract.** The Worker bounces a mail only when the BFF answers
  a 4xx carrying `x-inbound-verdict: reject`, and the BFF sets that header only
  on a permanent refusal: an unknown or revoked address in our domain, the
  organization's switch off, a sender that fails verification, is not a member
  or may not write documents, or a message over 26 MiB. A 2xx accepts. Every
  other answer (401, 403, 404 or 5xx without the header, 409, 429, a redirect,
  a network error) makes the Worker throw, so Cloudflare answers the sending
  server with a temporary failure and it retries. A status alone never bounces:
  a rotated Worker token or a misrouted `BFF_URL` delays mail, it does not lose
  it.
* **Addresses.** An address is `<slug>.<token>@<domain>`. Only the 12-character
  base32 token resolves; the slug is decoration.
* **Accept, then drain.** The webhook resolves the token in one
  `withPlatformAccess` lookup before reading the body, then works inside
  `withTenant`. It checks the switch, verifies the sender, looks them up in the
  target organization only, requires `project:documents:write` or
  `project:edit` on that project (the same `requireProjectAccess` call
  `uploadDocument` makes), selects the attachments in memory, stages them in
  the organization's bucket under the project's prefix, queues one row in
  `inbound_mail_messages`, and answers 202. It never stores the `.eml` or the
  body. The scheduler container POSTs `/api/internal/inbound-mail/drain` every
  tick; the drain claims rows with `FOR UPDATE SKIP LOCKED` and a fencing
  `claim_token`, files each staged object through `uploadDocument` as the
  pinned sender with `onNameTaken: 'suffix'` into one folder per mail
  (`E-Mail-Eingang/<YYYY-MM-DD HH.mm> – <sender>`, no subject), deletes the
  staging and notifies the sender in the app. A failed attempt backs off; after
  eight the row is `failed` and the sender told. Staging lives at most 7 days
  and rows 30.
* **Sender trust is DKIM only.** Cloudflare does not give a Worker its SPF, DKIM
  or DMARC verdicts
  ([workerd#6740](https://github.com/cloudflare/workerd/issues/6740), open
  since 2026-05-07), so the BFF decides from the raw bytes. A mail is authentic
  only when one DKIM signature on it verifies (`mailauth`), is aligned with the
  single From domain, has no `l=` tag, signs From, Subject and To or Cc, and
  signs a To or Cc that names this project's address. That last rule stops a
  signed mail from being replayed into another project, and it refuses a Bcc.
  There is no rule admitting a domain for its DMARC policy: "the domain
  publishes `p=reject`, so Cloudflare already enforced it" admitted unsigned
  spoofs whenever the policy was not enforced and whenever someone posted to
  the webhook past Cloudflare. A DNS failure is a `temperror` and a retry,
  never a bounce.
* **Per-organization switch.** The WorkOS feature flag `project-mail-inbox` is
  off by default. Until it is enabled for an organization, that organization
  sees no address, the webhook refuses its mail and the drain holds what was
  already queued. An organization gets the inbox after it has been told about
  the new sub-processor, never by default.

### Consequences

* Good, because there is one upload path. Everything a UI upload enforces, an
  emailed attachment gets without a second implementation.
* Good, because nothing runs on port 25 in our cluster, and the only mail data
  we hold is the selected attachments for the minutes between accept and
  filing (7 days at most).
* Good, because filing happens outside the sender's SMTP transaction: a mail of
  a hundred files, or a WorkOS or storage outage of most of a day, does not
  turn into a bounce.
* Good, because it costs nothing on the free Workers plan, and $5 a month on
  the paid plan if the handler outgrows the free CPU limit.
* Good, because a leaked address alone files nothing: the sender must be a
  verified member with write access, and the signed To or Cc must name the
  address.
* Bad, because Cloudflare becomes a sub-processor for mail content in transit,
  under the EU-US Data Privacy Framework, and processes it in the nearest data
  centre with no EU guarantee. A customer that requires EU-only processing
  cannot use this inbox.
* Bad, because senders without an aligned DKIM signature are refused, whatever
  their DMARC policy says. That includes Microsoft 365 and Google Workspace
  domains without custom DKIM. Their admins must enable it, or the member
  uploads by hand.
* Bad, because a Bcc to the project address bounces; members must put it in To
  or Cc.
* Bad, because the sender learns of success only in the app. v1 sends no mail,
  so there is no confirmation reply; a refusal is Cloudflare's bounce with our
  fixed text, which links the help and privacy pages.
* Bad, because the message size is capped at Cloudflare's 25 MiB, which after
  MIME encoding leaves about 18 MB of attachments, below what a plan set
  sometimes reaches.
* Bad, because two runtime facts the design relies on cannot be proven from the
  repository: that `DKIM-Signature` survives into the Worker's `message.raw`,
  and that a thrown Worker becomes an SMTP 4xx. Both are launch gates in the
  deploy guide.
* Neutral, because the DSGVO review is
  [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md),
  with the Datenschutzberater sign-off still open.

### Confirmation

* `frontends/ui/src/app/api/authz-coverage.spec.ts`: every handler must come
  from a route factory, so the webhook and the drain have to be
  `internalApiRoute`s behind their tokens, and the two project address routes
  must state their authorization posture.
* `frontends/ui/src/lib/db/rls-coverage.spec.ts`: both new tables must be
  registered with `grid_secure_table`, and `task db:test:rls` runs the
  policies against PostgreSQL.
* `frontends/ui/src/lib/inbound-mail/repository.integration.spec.ts` (claim,
  fence, reaper, retention against PostgreSQL) and
  `frontends/ui/src/lib/documents/upload-name-taken.integration.spec.ts`
  (`onNameTaken: 'suffix'` and `unchanged` on a re-run).
* The unit specs beside the code: `sender-auth.spec.ts` (DKIM-only trust,
  alignment, `l=`, signed headers, the signed recipient, duplicate headers,
  `temperror`), `mime.spec.ts` (which parts are files, the skip reasons, the
  delivery key), `receive.spec.ts` and
  `frontends/ui/src/app/api/internal/inbound-mail/route.spec.ts` (the order of
  work, the verdict header on exactly the permanent refusals), `drain.spec.ts`,
  `staging.spec.ts`, `filing-folder.spec.ts`, `folder-name.spec.ts`,
  `notify.spec.ts`, `address.spec.ts`, `service.spec.ts`, and
  `frontends/ui/src/lib/auth/pinned-session.spec.ts` (the sender's flags and
  permissions).
* `frontends/ui/bunfig.toml`: `minimumReleaseAge = 604800` makes `bun add`
  refuse a version younger than 7 days, so `mailauth`, `postal-mime` and
  `file-type` cannot be bumped to a release hours old.
* `deploy/pulumi/src/platform/inbound-mail-worker.spec.ts`: the Worker bounces
  only on the verdict header and throws on everything else.
  `inbound-mail.spec.ts` and `email-routing.spec.ts`: the zone must be the
  inbound domain's apex, and `pulumi preview` refuses an apex whose MX records
  point anywhere but `*.mx.cloudflare.net`. `index-inbound-mail.spec.ts`:
  nothing is created when the domain is unset, and no edge buffer limit caps
  the body. `stack-files.spec.ts`: one stack per inbound zone.
* Nothing enforces that Cloudflare's "Email preview" stays off. It applies only
  to a domain onboarded for Email Sending, which the inbound domain must never
  be; it is a dashboard setting. The deploy guide says so; review is the only
  gate.
* Nothing enforces the two launch gates (`DKIM-Signature` in `message.raw`, a
  thrown Worker as an SMTP 4xx). They are manual steps in
  `docs/deployment/kubernetes.md` §3c.

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

* Good, because free, and the operator's Cloudflare account and Pulumi
  provider already exist for DNS. The inbound domain is a zone of its own in
  that account, managed by the same stack.
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
  own DKIM check still stays: the signed-recipient rule is ours, not
  Cloudflare's);
* v2 admits external senders, which needs malware scanning and a quarantine
  before it can ship;
* we start sending mail from this domain.

User guide: [`project-mail-inbox.md`](../user-guides/project-mail-inbox.md).
