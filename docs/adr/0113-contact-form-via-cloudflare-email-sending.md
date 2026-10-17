---
status: accepted
date: 2026-09-30
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Contact form: send through Cloudflare Email Sending to verified addresses only

## Context and Problem Statement

The public site listed the founders' personal addresses as its contact, and a
buyer read `mail@jonathanuhlemann.de` as a side project. We want one company
address, `kontakt@piloti.at`, and a contact form on the site that reaches the
founders. The site stores nothing and loads no third-party script, and the form
must keep it that way. It is the first thing in the product that sends mail.

## Decision Drivers

* Nothing stored on the site, and no third-party script or cookie on the page.
* Only the founders receive form messages. Nothing on the site should be able
  to send mail to an arbitrary recipient.
* Buy, don't build: no SMTP server of our own.
* Cost at our volume, a handful of messages a week.

## Considered Options

1. A `mailto:` link only.
2. A hosted form service (Formspree and the like), posted to from the page.
3. A transactional mail provider (Postmark, Resend, Mailgun) called from the
   site's server.
4. Cloudflare's Email Service, sending only to verified destination addresses,
   called from the site's server.

## Decision Outcome

Chosen option: 4, because the operator's Cloudflare account already runs the
DNS, its Email Routing is what the project mail inbox uses (ADR-0075), and
sending to verified destination addresses is free on every plan
([Email Service](https://developers.cloudflare.com/email-service/)).

* `kontakt@piloti.at` is one literal Email Routing rule on the app zone, which
  forwards to the founders' mailboxes (`contactForwardTo`). The contact
  address adds no catch-all to that zone. *Amended 2026-10-01:* the project
  mail inbox now puts its catch-all on the same zone (ADR-0075, amendment of
  2026-10-01). A literal rule wins over the catch-all, so this address never
  reaches the inbox's Worker, and the Worker refuses every other address
  that is not a project address, as Cloudflare refused it before.
* One function owns each zone's Email Routing: `installMailZones` in
  `deploy/pulumi/src/platform/email-routing.ts` creates the provider, runs
  the zone, MX and DMARC guards, and enables routing (`EmailRoutingDns`) once
  per zone, so the contact rule (`contact-mail.ts`) and the inbox's catch-all
  (`inbound-mail.ts`) share one enablement on a shared apex. The enablement is
  `retainOnDelete`: turning either feature off leaves routing on for the
  other. The provider and the enablement carry the inbox's earlier names as
  Pulumi aliases, so a stack that ran the inbox first renames them in state
  instead of replacing them.
* The form posts to the site's own server (`frontends/web/src/lib/contact.ts`),
  which sends through the Email Service REST API from `kontakt@piloti.at` to
  the same verified addresses, with the enquirer in `reply_to`. It keeps
  nothing and logs only an outcome code.
* Spam protection is local: a honeypot, an HMAC-signed fill time, a
  per-client rate limit (5 messages per 10 minutes) keyed by an HMAC of the
  IP and held in memory, and a 32 KiB body cap. The signed fill time only
  refuses a message sent sooner than 3 s after the form was handed out, or
  more than 24 h after. Anyone can fetch a fresh one with `GET /api/kontakt`,
  and it is not bound to a client, so it stops a naive bot that posts the
  page's form at once, not a script that fetches a token and waits. Against
  a script the rate limits are the protection.
* The per-client limit drops every expired entry on each call, so no entry
  is counted past its ten minutes, as the privacy notice says. An expired
  entry stays in memory, as an HMAC, until the next submission to that pod
  or a restart, whichever comes first. It picks the client
  out of `X-Forwarded-For` the way Envoy does: the entry
  `CLIENT_IP_TRUSTED_HOPS` places before the last, which Pulumi sets from the
  gateway's `xffNumTrustedHops`. The limiter and the edge count the same
  client.
* At the edge, the submissions share one per-client bucket
  (`rateLimitWebContact`, 10 a minute). Like every edge limit it ships in
  shadow mode (`rateLimitShadowMode`, default true): it counts and refuses
  nothing until shadow mode is switched off. Until then the per-pod limit is
  the one enforced.
* The web pods hold a token with Account · Email Sending · Edit and nothing
  else, in a Secret of their own. They never see the stack's DNS token.

### Consequences

* Good, because, on Workers Free, the only recipients the site can reach are
  addresses a founder verified by clicking a link. A bug or an abused form
  cannot mail anyone else.
* Good, because no new vendor, contract or DPA: Cloudflare is already the
  sub-processor ADR-0075 introduced.
* Good, because the page loads nothing from a third party and works without
  JavaScript.
* Bad, because that limit is the plan's, not the token's. On Workers Paid,
  which the inbox's deploy guide recommends (ADR-0075), a domain onboarded
  for Email Sending can send to any recipient
  ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)).
  The form then reaches only the founders because the site's code sends only
  to `CONTACT_FORWARD_TO`, and the web pods' token can mail anyone, from any
  address on `piloti.at`, signed for `piloti.at`. That includes a project
  address of the inbox: such a mail files as any member whose sign-in address
  is on `piloti.at` (ADR-0075, per-domain sender trust).
* Bad, because onboarding `piloti.at` for Email Sending stays a dashboard
  step, and it adds a second `_dmarc` record that must be deleted by hand.
  `pulumi preview` refuses the zone while both exist (`assertSingleDmarc`).
  `@pulumi/cloudflare` 6.21 has `EmailSendingSubdomain`, but onboarding adds
  its own `_dmarc` record, and whether that resource accepts the zone apex is
  not verified, so the program checks the onboarding rather than owning it.
* Bad, because onboarding turns on "Email preview", which keeps every sent
  message at Cloudflare for about seven days. It must be switched off by hand
  in the dashboard. On the contact zone, `pulumi preview` reads the zone's
  Email Sending domains (`getEmailSendingSubdomains`) and refuses the sender
  domain while its preview is on (`assertNoSendingPreview`); a domain not
  onboarded yet passes. That is a check at each deploy, not a watch: a preview
  switched on between deploys keeps messages until the next one fails.
* Bad, because the per-client limit lives in each pod's memory: two replicas
  allow twice the budget, and a restart forgets it.
* Bad, because the per-client limit is only as good as the client address
  Envoy sees. If the LoadBalancer rewrites source addresses (SNAT), every
  visitor shares one bucket, and one bot locks the form for everyone on that
  pod for ten minutes. Whether it does was never checked on the live cluster
  (`docs/deployment/kubernetes.md` §3d); it must be before the form is
  switched on.
* Neutral, because the privacy analysis is section 8 of
  [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md).

### Confirmation

* `frontends/web/src/lib/contact.test.ts` (in `npm run check`): the signed
  timestamp, the rate limit and that it forgets a client when its window
  ends, the client address picked from `X-Forwarded-For` as Envoy picks it,
  validation, and that a send goes only to the configured recipients.
  `frontends/web/runtime/forwarded-proto.test.mjs`: a request Envoy forwarded
  over https reaches Astro as https, so its origin check accepts the form.
* `deploy/pulumi/src/platform/contact-mail.spec.ts`: one literal rule and no
  catch-all, one destination address per target, the zone's DMARC records
  read before anything is created, and a provider holding the stack's token,
  not the web pods'. `email-routing.spec.ts`: the apex MX guard, the refusal
  of a second DMARC record, the refusal of a sender domain whose Email
  preview is on, and the `retainOnDelete` enablement.
  `deploy/pulumi/src/platform/mail-zones.spec.ts`: one enablement and one
  provider per zone, shared with the inbox on the same apex; the DMARC and
  Email preview lookups on the contact zone only; and the inbox's earlier
  provider and routing names kept as aliases.
  `deploy/pulumi/index-contact-mail.spec.ts`: with the inbox on the same apex,
  routing is enabled once, the contact rule and the catch-all sit side by
  side, the web pods get the contact form's credentials and nothing of the
  inbox's, and the frontend the reverse. `deploy/pulumi/src/app/web-contact.spec.ts`:
  the token and the form key come from the web tier's own Secret, never
  inline. `deploy/pulumi/stack-files.spec.ts`: no stack puts its inbox on
  the zone where another stack routes its contact address.
* Nothing enforces that Email preview stays off for `piloti.at` between
  deploys, that each founder clicked the verification link, which Workers
  plan the account is on, or that the cluster preserves the client address.
  The preview, the click and the client address are steps in
  `docs/deployment/kubernetes.md` §3d, the plan's effect on the token is in
  §3c; review is the only gate.

## Pros and Cons of the Options

### A `mailto:` link only

* Good, because nothing to build or run.
* Bad, because a visitor without a configured mail client has no way to write,
  and there is no form to put at the end of the landing page.

### A hosted form service

* Bad, because the page would post to, and usually load a script from, a
  third party, and that party would store every message.

### A transactional mail provider

* Good, because an EU region is available from some of them.
* Bad, because a new vendor, DPA and API key for a handful of messages a week,
  and most can send to any recipient, which is more power than the form needs.

## More Information

Revisit when the site needs to send to anyone other than the founders (an
auto-reply to the enquirer, a newsletter): that is sending to unverified
addresses, which needs Workers Paid and a new look at the data flow.

Revisit, too, when the account moves to Workers Paid for the inbox. The
token's reach widens then (Consequences). A Worker's `send_email` binding
with `allowed_destination_addresses`
([send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/))
would put the founders-only limit back at Cloudflare, at the cost of a
Worker between the site and the Email Service.
