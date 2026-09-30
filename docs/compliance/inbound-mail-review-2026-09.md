# Project mail inbox: DSGVO and tenant-isolation review

- **Date:** 2026-09-30 (repo tip `dcc16a58` plus the change that adds the inbox).
- **Scope:** v1 of the project mail inbox, as decided in
  [ADR-0074](../adr/0074-project-mail-inbox-via-cloudflare-email-routing.md).
  Every project gets an address; a project member mails files to it and the
  attachments are filed as if that member had uploaded them.
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
  → Cloudflare MX (Email Routing: SPF/DKIM/DMARC gate, 25 MiB cap)
  → Email Worker (streams the raw bytes, does not parse)
  → BFF webhook  POST /api/internal/inbound-mail
       token → project, sender check, attachment filter (in memory)
  → uploadDocument, once per attachment
  → SeaweedFS (the org's bucket) + ingest
  → OpenRouter, as for any upload
```

1. The sending MTA delivers to Cloudflare's MX for the inbound domain
   (`GRID_INBOUND_MAIL_DOMAIN`). A catch-all rule hands every message to one
   Email Worker.
2. The Worker posts the raw RFC 822 bytes to the BFF with its own token
   (`GRID_INBOUND_MAIL_TOKEN`) and maps the answer to accept, reject or retry.
   It stores nothing.
3. The BFF resolves the address token to one project, verifies the sender,
   checks the sender's membership and permission in that project's
   organization, and parses the MIME in memory within the request.
4. Each attachment that passes the filter goes through the existing
   `uploadDocument` path (`frontends/ui/src/lib/documents/service.ts`), under a
   session pinned to the sending member. Type allowlist, size, quota
   (ADR-0042), versioning, audit and ingest dispatch are the ones every UI
   upload gets.
5. From there the document is an ordinary project document: stored in the
   organization's SeaweedFS bucket (ADR-0043), indexed, and sent in excerpts to
   OpenRouter exactly as documented for uploads.

Not stored anywhere by Piloti: the raw `.eml`, the mail body, inline signature
images, `winmail.dat`. Stored: the attachments as documents, one folder per mail
named `E-Mail-Eingang/<date> <subject> – <sender name>`, one dedupe row per
delivery, and the audit events `uploadDocument` already emits.

Out of scope: sending mail (v1 sends nothing), external senders (v2), and the
product's existing flows, which the July audit covers.

## 2. Roles

| Party | Role | Basis |
|---|---|---|
| Customer organization | Controller for project content, including what its members mail in | As for uploads today; privacy policy section 1 |
| Operator (Piloti) | Processor for the customer (Art. 28) | The customer AVV |
| Cloudflare, Inc. | Sub-processor of the operator for the inbound domain | Cloudflare DPA v6.4 of 2026-04-03, part of the Self-Serve Subscription Agreement |
| Sending member | Data subject and the person acting for the controller | Sends from their own mailbox |
| People in CC, in signatures, named in attachments | Data subjects who are not users | See finding F9 |

## 3. Findings

Status is the state in v1: **done** (the code or configuration does it),
**accepted** (a known limit we ship with, stated here and in the user guide),
**open** (must be closed before go-live or before the named change).

| # | Article | Finding | Status | Evidence |
|---|---|---|---|---|
| F1 | Art. 28 | Cloudflare becomes a new sub-processor. Until now it only served DNS for the deployment: the application hosts are unproxied, and the one proxied record is the apex redirect placeholder, which carries no application traffic. So it processed no user content. With the inbox it carries every inbound mail in transit. Its DPA (v6.4, 2026-04-03) is incorporated into the Self-Serve Subscription Agreement and announces new sub-processors of its own 30 days ahead. The sub-processor page is updated in this change. A customer AVV that promises advance notice of new sub-processors must be honoured before the inbox is switched on for that customer. | open | `deploy/pulumi/src/platform/dns.ts` (`proxied: false` on host records); <https://www.cloudflare.com/trust-hub/gdpr/>; <https://www.cloudflare.com/cloudflare-customer-dpa/>; legal content `subprocessors` |
| F2 | Art. 44 ff. | Transfer to the US rests on Cloudflare's EU-US Data Privacy Framework certification, with the SCCs in the DPA (Module 2/3) as fallback. Same basis as WorkOS and OpenRouter. The DPF is under legal challenge; if it falls, the SCCs carry the transfer and a transfer impact assessment is due. | accepted | <https://www.dataprivacyframework.gov/participant/5666>; DPA "Restricted Transfers" |
| F3 | Art. 44 ff., processing location | Mail is processed in the Cloudflare data centre nearest the sender, with no EU guarantee. The Data Localization Suite is Enterprise-only, and we found no statement that it covers Email Routing. A customer that requires EU-only processing cannot use the v1 inbox; the alternative is Mailgun EU or Amazon SES in eu-central-1 (ADR-0074, considered options). | accepted | ADR-0074 |
| F4 | Art. 5(1)(e) | Cloudflare states that Email Routing does not store or access routed mail. Its activity log keeps per-message metadata (from, to, subject, Message-ID, SPF/DKIM/DMARC verdicts, status), filterable over 30 days in the dashboard and queryable for 31 days. "Email preview" stores message content for about 7 days, but only for mail *sent* from a sending domain, and it is on by default for new sending domains. v1 sends nothing, so the inbound domain must never be added as a sending domain with previews on. Nothing checks this; it is a dashboard setting. | done (manual setting) | <https://developers.cloudflare.com/email-routing/> ("will not store or access the emails"); <https://developers.cloudflare.com/email-service/observability/logs/>; the deploy guide's inbound mail section |
| F5 | Art. 5(1)(c), (e) | v1 parses in memory and stores no raw `.eml` and no mail body. Only attachments become documents. The folder name carries the Date header's day, the subject (truncated to 60 characters) and the sender's name or local part, so a subject that names a third party is stored as a folder name. The dedupe table `inbound_mail_messages` holds a SHA-256 of the Message-ID, the sender's user id, counts, status and timestamps; no content. Both new tables carry `organization_id` and `project_id` and cascade from the project through a foreign key on both columns, so a project purge removes them, and an organization purge, which runs one project purge per project, does too (ADR-0011). | done | `frontends/ui/drizzle/0101_inbound_mail.sql`; `frontends/ui/src/lib/db/schema/inbound-mail.ts` |
| F6 | Art. 5(1)(f), 32 | Misaddressed mail: an unknown or revoked token is rejected before anything is stored. Tokens are 12 base32 characters (about 60 bits) from `crypto.randomBytes`. Only the token resolves; the slug in front of it is decoration and is never looked up. | done | `frontends/ui/src/lib/inbound-mail/address.ts` |
| F7 | Art. 32 | Sender verification. Cloudflare rejects mail that passes neither SPF nor DKIM, or fails an enforcing DMARC policy, but does not pass its verdicts to Workers (workerd#6740, open since 2026-05-07). Piloti therefore verifies again: it accepts a message only with a valid DKIM signature aligned with the From domain, or when the From domain publishes DMARC `p=quarantine` or `p=reject`. A domain with neither is rejected. That includes Microsoft 365 tenants that sign only with `*.onmicrosoft.com` and publish no enforcing DMARC. | accepted | <https://developers.cloudflare.com/email-routing/postmaster/>; <https://github.com/cloudflare/workerd/issues/6740>; `frontends/ui/src/lib/inbound-mail/sender-auth.ts` |
| F8 | Art. 5(1)(b), 25 | v1 accepts mail only from verified members of the target organization who hold `project:documents:write` or `project:edit` on the project. Unknown senders are rejected, not quarantined. Third-party data therefore arrives only through people who could already upload the same file by hand. | done | `frontends/ui/src/lib/inbound-mail/service.ts` |
| F9 | Art. 13, 14 | People in CC and people in signatures are data subjects who are not users. Because the body is not stored, what remains of them is what the attachments contain and, for the subject line, the folder name (F5). The customer as controller informs its own contacts, as it does for any document it uploads. Note it for the terms. | accepted | privacy policy section 2 (updated) |
| F10 | Art. 32 | Inbound TLS is opportunistic: it depends on the sending MTA, as for all SMTP. The Worker-to-BFF hop is HTTPS. The webhook has its own token, `GRID_INBOUND_MAIL_TOKEN`, separate from `GRID_INTERNAL_API_TOKEN`, so the Worker's secret opens one route and nothing else. Rate limits apply per address and per organization. | done | `frontends/ui/src/lib/internal-auth.ts`; `frontends/ui/src/app/api/internal/inbound-mail/route.ts` |
| F11 | Art. 32 | No malware scanning. In v1 that matches the UI upload path, which has none either, because only members who could upload by hand can send. It becomes a precondition before v2 admits external senders. | open (v2 precondition) | none |
| F12 | Art. 28, 44 ff. | Content to AI providers. Attachments are indexed like any upload, so excerpts reach OpenRouter and the org-selected model exactly as documented today. Mail bodies are not indexed, because they are not stored. | done | [`external-dependencies.md`](external-dependencies.md) statement on model switching |
| F13 | none | Sending: v1 sends no mail. The sender's feedback is an in-app notification and, on rejection, Cloudflare's bounce with one fixed text. | done | ADR-0074 |

## 4. Tenant isolation

The inbound domain is shared by every organization, and the webhook runs
before any organization is known. These are the properties that keep one
tenant's mail out of another's projects.

1. **The catch-all is transport only.** Cloudflare routes every address on the
   domain to one Worker. Nothing on Cloudflare's side knows about
   organizations or projects, and the Worker holds no routing table.
2. **Only the token resolves.** The local part is lowercased and the part after
   the last `.` is looked up. The slug is never used, because two organizations
   can both have a project called `wohnbau-hietzing`. The token is unique
   across the whole table, not per organization, so one token can never match
   two tenants' rows.
3. **One platform-scoped lookup, then tenant scope.** The single cross-tenant
   step is `withPlatformAccess('inbound mail: the address token names the
   project before any organization is known', ...)`, which returns only
   `{ addressId, organizationId, projectId }`. Everything after it runs inside
   `withTenant({ organizationId })`, under RLS (ADR-0041).
4. **The sender is resolved inside the target organization only.** The From
   address is looked up in that organization's roster, never globally. A user
   who belongs to organization A and mails an address of organization B is not
   a member there and is rejected.
5. **Permission is project-level** (`userHoldsProjectPermission`, the same
   any-of as `uploadDocument`). Being assigned to something in the project is
   not access (ADR-0059), and the upload itself runs the same authorization
   again (ADR-0038).
6. **Dedupe is keyed by (address, message).** A mail CC'd to projects in two
   organizations is two deliveries, and each is filed in its own tenant. A
   Message-ID seen in one organization says nothing to another.
7. **A leaked address is not a credential.** An address that shows up in a CC
   line or a forwarded thread lets nobody file anything: the sender must still
   be a verified member with write access. The worst case is noise, which the
   rate limits bound, and rotation ends it.
8. **No enumeration.** Unknown address, revoked address, unverifiable sender,
   non-member and missing permission all bounce with the same text. The
   webhook answers 404 or 403 to the Worker, but the Worker maps both to one
   rejection.
9. **Noisy neighbours.** Limits per address (60 mails per hour) and per
   organization (600 per hour) use the ADR-0040 machinery. Over the limit the
   webhook answers 429 and the sending MTA retries later. The gateway's per-IP
   limit is sized for all mail arriving from a few Cloudflare addresses.
10. **The Cloudflare activity log is cross-tenant.** It lists senders,
    recipients and subjects for every organization on one screen. Only the
    operator's Cloudflare account can open it; no customer sees it.
11. **New tables are under RLS.** `inbound_mail_addresses` and
    `inbound_mail_messages` are registered with `grid_secure_table` on
    `organization_id`. `rls-coverage.spec.ts` fails a table that is not, and
    `task db:test:rls` runs the policies against a real PostgreSQL.

Tests that hold these properties, in `frontends/ui/src/lib/inbound-mail/`:
see the list in section 7.

## 5. Residual risks

- **The DPF falls** (F2). The SCCs take over; a transfer impact assessment
  becomes due, and customers with a strict reading may ask for the EU
  alternative.
- **No EU processing guarantee** (F3). An EU-only customer cannot use v1.
- **The preview setting is manual** (F4). Enabling Email Sending on the inbound
  domain later would start storing content unless someone switches previews
  off.
- **Subject lines become folder names** (F5, F9). A subject that names a
  private person is stored until the folder is renamed or the project deleted.
- **DKIM-less senders are rejected** (F7). Some offices on Microsoft 365
  without custom DKIM cannot use the inbox until their admin enables it. This
  is a support cost, not a data risk.
- **A member's compromised mailbox** can file files into every project where
  that member has write access. That is the same exposure as a compromised
  Piloti session, bounded by the rate limits and visible in the audit trail.

## 6. Open items

1. Datenschutzberater review and sign-off of this document.
2. Before go-live for each customer: check the AVV for a sub-processor notice
   period and give the notice (F1).
3. Terms: state that the customer informs its contacts that files mailed to a
   project address are processed in Piloti (F9).
4. Before v2 admits external senders: malware scanning (F11) and a quarantine
   flow.
5. Record the processing in the Art. 30 register and the TOMs once those exist
   (July audit, roadmap item 5).

## 7. Evidence in the repository

| What | Where |
|---|---|
| Worker, Cloudflare resources | `deploy/pulumi/src/platform/inbound-mail-worker.js`, `deploy/pulumi/src/platform/inbound-mail.ts` and their specs |
| Webhook | `frontends/ui/src/app/api/internal/inbound-mail/route.ts` |
| Resolution, sender check, filing | `frontends/ui/src/lib/inbound-mail/` |
| RLS coverage | `frontends/ui/src/lib/db/rls-coverage.spec.ts`, `task db:test:rls` |
| Route authorization coverage | `frontends/ui/src/app/api/authz-coverage.spec.ts` |
