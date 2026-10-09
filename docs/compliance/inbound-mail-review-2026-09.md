# Project mail inbox: DSGVO and tenant-isolation review

- **Date:** 2026-09-30, against the code of PR #831 as merged with `develop` that
  day (the hardened version: DKIM-only sender trust, accept-then-file, the
  per-organization switch).
- **Scope:** v1 of the project mail inbox, as decided in
  [ADR-0075](../adr/0075-project-mail-inbox-via-cloudflare-email-routing.md).
  Every project gets an address; a project member mails files to it and the
  attachments are filed as if that member had uploaded them. Section 8 covers
  the contact form on piloti.at, which ships in the same PR and uses the same
  vendor.
- **Amended 2026-10-01** for the decision to put project addresses on
  `piloti.at` itself rather than on a separate inbound domain (ADR-0075,
  amendment of 2026-10-01): sections 1, 2, 4 and 8, and F4, F6, F15.
- **What this is.** An engineering review against the code and the vendor's
  published terms. It is not legal advice. The Datenschutzberater has not signed
  it off yet; that is open item 1.
- **Companions:** [`compliance-audit-2026-07.md`](compliance-audit-2026-07.md),
  [`external-dependencies.md`](external-dependencies.md), the sub-processor
  page in `frontends/ui/src/lib/legal/content/{de,en}.ts`, and the user guide
  [`project-mail-inbox.md`](../user-guides/project-mail-inbox.md).

## 1. Scope and data flow

```
sender MTA
  → Cloudflare MX (Email Routing, 25 MiB cap)
       literal rule (kontakt@)  → forwarded to the founders (section 8)
       catch-all                → Email Worker
  → Email Worker: address not project-shaped → refused ("unknown address")
                  project-shaped → streams the raw bytes, does not parse
  → BFF webhook  POST /api/internal/inbound-mail
       token → project, org switch, DKIM check, roster, permission,
       attachment selection (in memory)
       → stage the selected attachments in the org's bucket, queue a row, 202
       → one `inbound_mail` job on the BFF job queue (bff_job_queue, ADR-0079)
  → bff-jobs worker runs the job, inside the organization
       → uploadDocument, once per attachment, as the sender
  → SeaweedFS (the org's bucket) + ingest
  → OpenRouter, as for any upload
```

1. The sending MTA delivers to Cloudflare's MX for `piloti.at`
   (`GRID_INBOUND_MAIL_DOMAIN`), the product's own domain. Literal rules, such
   as `kontakt@piloti.at` (section 8), are matched first and never reach the
   inbox. The zone's catch-all hands every other message to one Email Worker.
2. The Worker reads only the envelope recipient and checks its shape (the rule
   the BFF's parser applies, `shared/inbound-address.json`). An address that
   is not project-shaped (a typo, `info@` with no rule, spam to a guessed
   name) is refused there with a fixed "unknown address" bounce; the Worker
   does not call the BFF and does not forward or store the message. For a
   project-shaped address, the Worker posts the raw RFC 822 bytes to the BFF with its own token
   (`GRID_INBOUND_MAIL_TOKEN`) and turns the answer into accept, bounce or
   retry. It stores nothing and logs nothing.
3. **Accepted.** The webhook resolves the address token to one project, checks
   the organization's switch, verifies the sender (section 3, F7), finds them in
   that organization's roster, checks their permission in the project, and
   parses the MIME in memory. It keeps only the attachments it selected.
4. **Staged.** Those attachments are written to the organization's bucket under
   the project's own prefix,
   `org/<org>/project/<project>/inbound-mail/<row>/<n>`. The `.eml` and the body
   are never written.
5. **Queued.** One row in `inbound_mail_messages` names the staged objects, and
   the webhook answers 202. From here the sending server is done.
6. **Filed by a job.** The webhook enqueued one `inbound_mail` job on the BFF's
   job queue (ADR-0079); a `bff-jobs` worker runs it inside the delivery's
   organization. The job files each staged object through the existing
   `uploadDocument` path (`frontends/ui/src/lib/documents/service.ts`) under a
   session pinned to the sending member, deletes the staged objects, and leaves
   the sender an inbox notification. Type allowlist, size, quota (ADR-0042),
   the office's name screening (ADR-0086), versioning, audit and ingest
   dispatch are the ones every UI upload gets. A
   failed attempt is retried by a fresh job after a backoff; after eight
   attempts (about 22.6 hours) the row is `failed`, its staging deleted and
   the sender told. The background-work sweep gives a queued delivery whose
   job is gone a new one, and runs the retention below.
7. From there the document is an ordinary project document: stored in the
   organization's SeaweedFS bucket (ADR-0043), indexed, and sent in excerpts to
   OpenRouter exactly as documented for uploads.

### What is kept, where, and for how long

| Data | Where | Kept until |
|---|---|---|
| Raw `.eml`, mail body, embedded images, `winmail.dat`, signatures, encrypted parts, calendar invites | Nowhere at Piloti | Not stored |
| Selected attachments, staged | The org's bucket, under the project's prefix | Deleted when the job files them or gives up; at most **7 days** (the sweep's staging backstop, `STAGING_RETENTION_DAYS`), after which a still-queued mail fails and the sender is told |
| Filed attachments | Project documents in `E-Mail-Eingang/<YYYY-MM-DD HH.mm> – <sender>` | As any upload: until deleted, or the project is purged |
| Delivery row (`inbound_mail_messages`) | Postgres | Deleted **30 days** after receipt (`DELIVERY_RETENTION_DAYS`). While queued it holds the subject and the names of skipped parts; once `filed` or `failed` the subject is nulled and the skipped entries keep only their reason code. It keeps the folder name (time and sender name), the delivery key (a SHA-256), the sender's user id, counts, status and timestamps |
| The sender's notification (`inbound_mail.filed` / `inbound_mail.failed`) | `inbox_items`, visible only to the sender | **30 days** (the inbox type's retention). It quotes the subject and up to ten skipped filenames with their reasons |
| Audit event per filed file (`document.uploaded`) | WorkOS audit log | As every audit event. It carries `channel: inbound-mail` and the delivery row id; no IP and no user agent (section 3, F14) |
| One log line per delivery and per filing attempt | Container logs | The log collector's retention. Outcome, address id, row id, counts, duration and an error class; no address, name, subject or filename |
| Cloudflare's Email Routing activity log | Cloudflare, operator account only | About 30 days (F4) |

## 2. Roles

| Party | Role | Basis |
|---|---|---|
| Customer organization | Controller for project content, including what its members mail in | As for uploads today; privacy policy section 1 |
| Operator (Piloti) | Processor for the customer (Art. 28) for accepted mail. **Controller** for mail it refuses or cannot match to a customer, including mail to unknown `piloti.at` addresses that the Worker refuses (F15) | The customer AVV; Art. 6(1)(f) for refused mail |
| Cloudflare, Inc. | Sub-processor of the operator for `piloti.at`'s mail routing | Cloudflare DPA v6.4 of 2026-04-03, part of the Self-Serve Subscription Agreement |
| Sending member | Data subject and the person acting for the controller | Sends from their own mailbox |
| People in CC, in signatures, named in attachments | Data subjects who are not users | See F9 |

## 3. Findings

Status is the state in v1: **done** (the code or configuration does it),
**accepted** (a known limit we ship with, stated here and in the user guide),
**open** (must be closed before go-live or before the named change).

| # | Article | Finding | Status | Evidence |
|---|---|---|---|---|
| F1 | Art. 28 | Cloudflare becomes a new sub-processor. Until now it only served DNS for the deployment: the application hosts are unproxied, and the one proxied record is the apex redirect placeholder, which carries no application traffic. With the inbox it carries every inbound mail in transit. Its DPA (v6.4, 2026-04-03) is incorporated into the Self-Serve Subscription Agreement and announces new sub-processors of its own 30 days ahead. The sub-processor page is updated in this change. **The feature is off for every organization until its WorkOS flag `project-mail-inbox` is enabled** (F16), so the operator can give each customer the notice its AVV promises before that customer's mail ever reaches Cloudflare. | open (per customer, before the flag is set) | `deploy/pulumi/src/platform/dns.ts` (`proxied: false` on host records); <https://www.cloudflare.com/trust-hub/gdpr/>; <https://www.cloudflare.com/cloudflare-customer-dpa/>; legal content `subprocessors` |
| F2 | Art. 44 ff. | Transfer to the US rests on Cloudflare's EU-US Data Privacy Framework certification, with the SCCs in the DPA (Module 2/3) as fallback. Same basis as WorkOS and OpenRouter. The DPF list showed Cloudflare as **"Active – re-certification under review"** when checked on 2026-09-30. The DPF is also under legal challenge; if it falls, or the re-certification lapses, the SCCs carry the transfer and a transfer impact assessment is due. | accepted | <https://www.dataprivacyframework.gov/participant/5666> (checked 2026-09-30); DPA "Restricted Transfers" |
| F3 | Art. 44 ff., processing location | Mail is processed in the Cloudflare data centre nearest the sender, with no EU guarantee. The Data Localization Suite is Enterprise-only, and we found no statement that it covers Email Routing. A customer that requires EU-only processing cannot use the v1 inbox; the alternative is Mailgun EU or Amazon SES in eu-central-1 (ADR-0075, considered options). | accepted | ADR-0075 |
| F4 | Art. 5(1)(e) | Cloudflare states that Email Routing does not store or access routed mail. Its activity log keeps per-message metadata (from, to, subject, Message-ID, SPF/DKIM/DMARC verdicts, status), filterable over 30 days in the dashboard and queryable for 31 days. "Email preview" is an Email Sending setting: "Previews cover messages sent while the setting is turned on and are retained for about seven days", on by default for sending domains onboarded on or after 2026-07-02. `piloti.at` is onboarded for sending for the contact form (section 8), so its preview must be off. Cloudflare does not describe it as covering mail received through Email Routing, which is how project mail arrives. Nothing checks the setting; it is in the dashboard. | done (manual setting) | <https://developers.cloudflare.com/email-routing/> ("will not store or access the emails"); <https://developers.cloudflare.com/email-service/observability/logs/>; <https://developers.cloudflare.com/changelog/post/2026-07-17-email-message-preview/>; `docs/deployment/kubernetes.md` §3c and §3d |
| F5 | Art. 5(1)(c), (e) | The webhook stores no `.eml` and no body, and keeps only the attachments it selected, staged for at most 7 days. The folder name is `<YYYY-MM-DD HH.mm> – <sender name or local part>`, in Europe/Vienna time from the moment of receipt; **the subject is not in it**, so it does not reach folder names, storage keys or the assistant's grounding block, which names folders. The subject lives only on the queued row (nulled once the row is terminal) and in the sender's own notification (30 days). The delivery row is deleted after 30 days (section 1 table). Both new tables carry `organization_id` and `project_id` and cascade from the project through a foreign key on both columns, and the staged objects sit under the project's storage prefix, so the project purge removes all three (`purger/purge-project.js`). There is no organization purge today; an organization's projects are purged one by one. | done | `frontends/ui/drizzle/0115_inbound_mail.sql`; `frontends/ui/src/lib/inbound-mail/{staging,repository,job}.ts`; the folder name `frontends/ui/src/lib/mail-import/naming.ts` |
| F6 | Art. 5(1)(f), 32 | Misaddressed mail: an address that is not project-shaped is refused by the Worker without reaching Piloti's servers; an unknown or revoked token is refused by the BFF before the body is read. Nothing is stored in either case. Tokens are 12 base32 characters (about 60 bits) from `crypto.randomBytes`. Only the token resolves; the slug in front of it is decoration and is never looked up. `+detail` and surrounding quotes are stripped before the token is read. | done | `frontends/ui/src/lib/inbound-mail/address.ts`, `receive.ts`; `inbound-mail-worker.js`; the shape contract `shared/inbound-address.json` |
| F7 | Art. 32 | **Sender trust is DKIM only.** Cloudflare does not pass its SPF, DKIM or DMARC verdicts to Workers (workerd#6740, open since 2026-05-07), so Piloti decides from the raw bytes and DNS. A mail is accepted only when one DKIM signature on it verifies, is aligned (relaxed, organizational domain) with the single From domain, covers the whole body (no `l=` tag), signs From, Subject and To or Cc, and uses neither rsa-sha1 nor a key in testing mode (`t=y`). The raw header block may hold only one of each field RFC 5322 §3.6 allows once, so an unsigned duplicate cannot change what the signature covers. A From address that is not plain ASCII is refused. **The earlier rule that admitted any From domain publishing DMARC `p=quarantine` or `p=reject` was removed**: an unsigned spoof passed it whenever the policy was not enforced (`pct`, `t=y`, quarantine), and whenever someone holding the Worker's token posted to the webhook directly, past Cloudflare's own checks. Consequence: Microsoft 365 and Google Workspace domains without custom DKIM are refused, whatever their DMARC says. A DNS failure or timeout is a `temperror` and the sender's server retries; only a definite failure bounces. | done | `frontends/ui/src/lib/inbound-mail/sender-auth.ts`; <https://github.com/cloudflare/workerd/issues/6740> |
| F8 | Art. 5(1)(b), 25 | **Anti-replay.** The admitting signature must cover a To or Cc header that names this project's address. A genuine signed mail a member sent to someone else cannot be re-sent into a project, and a **Bcc to the project address is refused**, because no signed header says the member meant the project. v1 accepts mail only from verified members of the target organization who hold `project:documents:write` or `project:edit` on the project, checked with the same `requireProjectAccess` call `uploadDocument` makes. Unknown senders are refused, not quarantined. Third-party data therefore arrives only through people who could already upload the same file by hand. | done | `frontends/ui/src/lib/inbound-mail/sender-auth.ts`, `receive.ts` |
| F9 | Art. 13, 14 | People in CC and people in signatures are data subjects who are not users. Because the body is not stored and the subject is not in the folder name, what remains of them is what the attachments contain, and the subject in the sender's own notification for 30 days. The customer as controller informs its own contacts, as it does for any document it uploads. The user guide tells members not to CC the project address to people outside the office: the address would then sit in the recipients' address books and reply-all threads. | accepted | privacy policy section 2 (updated); user guide |
| F10 | Art. 32 | Inbound SMTP TLS is opportunistic: it depends on the sending MTA, as for all SMTP, and Piloti cannot require it. The Worker-to-BFF hop is HTTPS. The webhook has its own token, `GRID_INBOUND_MAIL_TOKEN`, separate from `GRID_INTERNAL_API_TOKEN`, so the Worker's secret opens one route and nothing else. Rate limits apply per address (60 mails an hour) and per organization (600), and each filed file charges the sender's upload limit as a UI upload does. | done | `frontends/ui/src/lib/internal-auth.ts`; `frontends/ui/src/lib/limits/rules.js`; `job.ts` |
| F11 | Art. 32 | No malware scanning. In v1 that matches the UI upload path, which has none either, because only members who could upload by hand can send. It becomes a precondition before v2 admits external senders. | open (v2 precondition) | none |
| F12 | Art. 28, 44 ff. | Content to AI providers. Attachments are indexed like any upload, so excerpts reach OpenRouter and the org-selected model exactly as documented today. Mail bodies are not indexed, because they are not stored, and subjects are not either, because they are not in folder names. | done | [`external-dependencies.md`](external-dependencies.md) statement on model switching |
| F13 | none | v1 sends no mail to senders. Feedback is an in-app notification (filed, or failed after all retries) and, on a permanent refusal, Cloudflare's bounce with one fixed ASCII text that links the help page and the privacy page. | done | `deploy/pulumi/src/platform/inbound-mail-worker.js` (`REJECT_TEXT`) |
| F14 | Art. 5(1)(c), 30 | **Audit.** Each filed file emits the ordinary `document.uploaded` event, marked `channel: inbound-mail` with the delivery row id as `channelRef`, so a mailed file can be told from one uploaded at a screen. No Cloudflare IP is recorded: the job passes a request of its own, with no IP and the user agent `piloti-inbound-mail`, and the webhook's request (which would carry a Cloudflare address) never reaches `uploadDocument`. | done | `frontends/ui/src/lib/documents/shelf-upload.ts` (`UploadAuditChannel`); `job.ts` |
| F15 | Art. 6(1)(f), 13 | **Refused and unmatched mail.** A mail to an unknown or revoked address, from an unverifiable sender, from a non-member or from a member without write access, is processed only far enough to refuse it: Cloudflare carries it, the BFF reads its headers and checks DKIM, and nothing is stored. A mail to a `piloti.at` address that has no literal rule and is not project-shaped is processed less: Cloudflare carries it to the Worker, which reads the envelope recipient and refuses it with a fixed "unknown address" text, without forwarding it to the BFF and without storing it. Before the catch-all, Cloudflare refused such mail itself. No customer is the controller of that processing, because the mail cannot be attributed to a customer's instruction. The operator is, on its legitimate interest in running and protecting the service. The project-address bounce text links `https://piloti.at/datenschutz/`, whose app section names Cloudflare's role for project mail; the unknown-address text links nothing. | done (notice on the website) | `inbound-mail-worker.js` (`REJECT_TEXT`, `UNKNOWN_ADDRESS_TEXT`); `frontends/web/src/i18n/ui.ts` (`datenschutz`) |
| F16 | Art. 25, 28 | **The per-organization switch.** The WorkOS feature flag `project-mail-inbox` is off by default. With it off, the address card is hidden, `GET /api/projects/[id]/inbound-address` answers `enabled: false`, the webhook refuses (a bounce that reads as an unknown address), and the filing job holds already-queued mail without filing it. A flag lookup that fails is a retry, never a refusal. Without flag enforcement (a local run), `GRID_PROJECT_MAIL_INBOX_ENABLED=true` switches it on for the whole deployment. | done | `frontends/ui/src/lib/authz/feature-flags.ts` (`projectMailInbox`); `frontends/ui/src/lib/workos/feature-flags.ts` (`isProjectMailInboxEnabledForOrg`) |

## 4. Tenant isolation

The inbox's domain, `piloti.at`, is shared by every organization, and the
webhook runs before any organization is known. These are the properties that keep one
tenant's mail out of another's projects.

1. **The catch-all is transport only.** Cloudflare routes every address on the
   domain that no literal rule claims to one Worker. Nothing on Cloudflare's
   side knows about organizations or projects, and the Worker holds no routing
   table: it checks only whether the address has a project address's shape,
   which is public.
2. **Only the token resolves.** The local part is lowercased (ASCII only), and
   the part after the last `.` is looked up. The slug is never used, because two
   organizations can both have a project called `wohnbau-hietzing`. The token is
   unique across the whole table, not per organization, so one token can never
   match two tenants' rows.
3. **One platform-scoped lookup, then tenant scope.** The single cross-tenant
   step in the webhook is `withPlatformAccess('inbound mail: the address token
   names the project before any organization is known', ...)`, which returns
   only `{ addressId, organizationId, projectId }`. Everything after it runs
   inside `withTenant({ organizationId })`, under RLS (ADR-0041).
4. **The queue claims across tenants and files inside one.** The job queue's
   claim, the sweep's search for deliveries without a job and the retention
   run under the platform role; every job runs inside `withTenant` for its
   lane, the delivery's organization, so folder, document, row and inbox
   writes are subject to RLS. Each write of an attempt is conditional on the
   row still being `queued`.
5. **The sender is resolved inside the target organization only.** The From
   address is looked up in that organization's roster, never globally, with
   ASCII-only lowercasing so no Unicode case fold can make two addresses meet. A
   user who belongs to organization A and mails an address of organization B is
   not a member there and is refused.
6. **Permission is project-level.** The webhook asks `requireProjectAccess` for
   `project:documents:write` or `project:edit`, the same call `uploadDocument`
   makes, so the two cannot disagree. Being assigned to something in the
   project is not access (ADR-0059), and the upload runs the same authorization
   again when the job files (ADR-0038), as the sender is at that moment.
7. **Dedupe is keyed by (address, delivery key).** The delivery key is a SHA-256
   of the normalized Message-ID and the sorted attachment digests. A mail CC'd
   to projects in two organizations is two deliveries, and each is filed in its
   own tenant.
8. **A leaked address is not a credential.** An address that shows up in a CC
   line or a forwarded thread lets nobody file anything: the sender must still
   be a verified member with write access, and the signed To or Cc must name
   the address. The worst case is noise, which the rate limits bound, and
   rotation ends it.
9. **No enumeration.** Unknown address, revoked address, switched-off
   organization, unverifiable sender, non-member and missing permission all
   bounce with the same text. An address that is not project-shaped gets a
   different text from the Worker, but the shape rule is public, so that tells
   a prober nothing about which project addresses exist. The webhook marks each with
   `x-inbound-verdict: reject`; the Worker bounces only on that header.
10. **Nothing but a verdict bounces.** A 401, 403, 404 or 5xx without the
    header, a 409, a 429, a redirect or a network error makes the Worker throw,
    and the sending server retries. So a rotated Worker token, a misrouted
    `BFF_URL` or a proxy's error page can never bounce a member's mail.
11. **Noisy neighbours.** Limits per address (60 mails an hour) and per
    organization (600 an hour) use the ADR-0040 machinery, applied after the
    dedupe so a redelivery is never refused. Over the limit the webhook answers
    429 and the sending server retries later. At most two large messages are
    parsed at once per BFF process; a third is a retry. The gateway's per-IP
    limit is sized for mail arriving from a few Cloudflare addresses.
12. **The Cloudflare activity log is cross-tenant.** It lists senders,
    recipients and subjects for every organization on one screen. Only the
    operator's Cloudflare account can open it; no customer sees it.
13. **New tables are under RLS.** `inbound_mail_addresses` and
    `inbound_mail_messages` are registered with `grid_secure_table` on
    `organization_id`, and every foreign key carries the organization, so a row
    cannot name this tenant while pointing at another's project or address.
    `rls-coverage.spec.ts` fails a table that is not secured, and
    `task db:test:rls` runs the policies against a real PostgreSQL.

## 5. Residual risks

- **The DPF falls, or Cloudflare's re-certification lapses** (F2). The SCCs take
  over; a transfer impact assessment becomes due, and customers with a strict
  reading may ask for the EU alternative.
- **No EU processing guarantee** (F3). An EU-only customer cannot use v1.
- **The preview setting is manual** (F4). Turning Email preview back on for
  `piloti.at` would start storing the contact form's messages, and nothing
  would notice. If Cloudflare ever extends it, or any other content retention,
  to mail received through Email Routing, project mail would be affected too.
- **`piloti.at`'s mail is tied to Cloudflare Email Routing.** Moving it to
  another mail provider means moving the inbox to a domain of its own first,
  and giving every project a new address (ADR-0075, amendment of 2026-10-01).
- **The subject is still held for 30 days** in the sender's own notification
  (F5, F9). Only the sender sees it, and the purge of the project removes it.
- **DKIM-less senders are refused** (F7). Offices on Microsoft 365 or Google
  Workspace without custom DKIM cannot use the inbox until their admin enables
  it. This is a support cost, not a data risk.
- **uuencoded attachments** (very old clients) are neither filed nor listed as
  skipped. A known gap, rare in practice.
- **A member's compromised mailbox** can file files into every project where
  that member has write access. That is the same exposure as a compromised
  Piloti session, bounded by the rate limits and visible in the audit trail
  (F14).

## 6. Open items

1. Datenschutzberater review and sign-off of this document.
2. Before enabling the `project-mail-inbox` flag for a customer: check the AVV
   for a sub-processor notice period and give the notice (F1, F16).
3. Terms: state that the customer informs its contacts that files mailed to a
   project address are processed in Piloti (F9).
4. **Art. 30 before go-live.** Record the inbox, the refused-mail processing
   (F15) and the contact form (section 8) in the register of processing
   activities, and the TOMs, once the register exists (July audit, roadmap
   item 5).
5. **Launch gates**, neither of which the repository can prove:
   - a delivery to a staging project address showing that the
     `DKIM-Signature` header survives into the Worker's `message.raw`. If
     Cloudflare strips or rewrites it, every mail fails F7 and bounces;
   - a live test that a Worker that throws makes Cloudflare answer the sending
     server with an SMTP 4xx, not a 5xx. If it is a 5xx, every retry path in
     section 4 item 10 is a bounce instead.
6. Before v2 admits external senders: malware scanning (F11) and a quarantine
   flow.

## 7. Evidence in the repository

| What | Where |
|---|---|
| Worker, its address-shape filter and its verdict contract | `deploy/pulumi/src/platform/inbound-mail-worker.js`, `inbound-mail-worker.spec.ts`; the shape contract `shared/inbound-address.json`, also checked by `frontends/ui/src/lib/inbound-mail/address.spec.ts` |
| Cloudflare resources, apex check, one stack per zone | `deploy/pulumi/src/platform/inbound-mail.ts`, `inbound-mail.spec.ts`, `deploy/pulumi/index-inbound-mail.spec.ts` |
| Apex MX guard, shared with the contact address | `deploy/pulumi/src/platform/email-routing.ts`, `email-routing.spec.ts` |
| Webhook route, and the sweep | `frontends/ui/src/app/api/internal/inbound-mail/route.ts` (spec `route.spec.ts`); `frontends/ui/src/app/api/internal/maintenance/reconcile-background-work/route.ts` |
| Accept, verify, stage, queue | `frontends/ui/src/lib/inbound-mail/receive.ts`, `sender-auth.ts`, `mime.ts`, `staging.ts`, with `receive.spec.ts`, `sender-auth.spec.ts`, `mime.spec.ts`, `staging.spec.ts` |
| Filing job, folder, notification | `frontends/ui/src/lib/inbound-mail/job.ts`, `notify.ts`, with `job.spec.ts`, `notify.spec.ts`; the shared mail filer `frontends/ui/src/lib/mail-import/filing.ts` and `naming.ts`, with `filing.spec.ts`, `naming.spec.ts` |
| Addresses, rotation, the switch | `frontends/ui/src/lib/inbound-mail/address.ts`, `service.ts`, `contract.ts`, with `address.spec.ts`, `service.spec.ts`; `frontends/ui/src/app/api/projects/[id]/inbound-address/route.spec.ts` |
| Fence, stalled deliveries, retention against PostgreSQL | `frontends/ui/src/lib/inbound-mail/repository.ts`, `repository.integration.spec.ts` |
| The sender's pinned session (flags, permissions, lookup errors) | `frontends/ui/src/lib/auth/pinned-session.ts`, `pinned-session.spec.ts` |
| Schema | `frontends/ui/drizzle/0115_inbound_mail.sql`, `frontends/ui/src/lib/db/schema/inbound-mail.ts` |
| RLS coverage | `frontends/ui/src/lib/db/rls-coverage.spec.ts`, `task db:test:rls` |
| Route authorization coverage | `frontends/ui/src/app/api/authz-coverage.spec.ts` |
| The settings card | `frontends/ui/src/features/projects/components/project-inbound-mail-card.tsx`, `project-inbound-mail-card.spec.tsx` |
| Contact address and form (section 8) | `deploy/pulumi/src/platform/contact-mail.ts`, `contact-mail.spec.ts`, `deploy/pulumi/index-contact-mail.spec.ts`, `deploy/pulumi/src/app/web-contact.spec.ts`, `frontends/web/src/lib/contact.ts`, `contact.test.ts` |

## 8. The contact form on piloti.at

The landing site has a contact form, and the company address
`kontakt@piloti.at` replaces the founders' personal addresses. Here the
operator is the **controller**: the people who write are prospective
customers, not a customer's staff.

- **Transport.** Mail to `kontakt@piloti.at` is forwarded by Cloudflare Email
  Routing (one literal rule on the app zone) to the founders' own mailboxes.
  The project inbox's catch-all on the same zone never sees it, because a
  literal rule is matched first. The form sends through Cloudflare's Email Service REST API, only to
  those same addresses, which Cloudflare requires to be verified destination
  addresses. The submitter's address goes into `reply_to`, so the founders
  answer from their own mail client. Cloudflare is the same sub-processor as in
  F1 to F3.
- **No storage on the site.** `frontends/web/src/lib/contact.ts` sends a valid
  message once and keeps nothing. Its log lines carry an outcome code only, no
  field, address or IP.
- **The IP stays in memory.** The per-client rate limit (5 messages per
  10 minutes, per pod) is keyed by an HMAC of the IP, held in the pod's memory
  and forgotten when the window ends. The IP is never written and never sent
  with the message.
- **Retention is in the founders' mailboxes.** The website's privacy notice
  says a message is deleted once the enquiry is handled, at the latest after
  twelve months unless a contract follows. Nothing enforces that; it is the
  founders' practice, and those mailbox providers belong in the Art. 30 record
  (open item 4).
- **Email preview must be off** for `piloti.at`. It is on by default for a
  domain onboarded for Email Sending on or after 2026-07-02 and would keep
  every form message for about seven days at Cloudflare. It is a dashboard setting nothing checks
  (F4; `docs/deployment/kubernetes.md` §3d, step 3).
- **Legal basis.** Art. 6(1)(b) where the enquiry concerns a contract or its
  preparation, otherwise Art. 6(1)(f). Stated in the website's privacy notice,
  section "Kontaktformular und E-Mail".
