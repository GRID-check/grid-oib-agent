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
DNS and, since ADR-0074, Email Routing, and sending to verified destination
addresses is free on every plan
([Email Service](https://developers.cloudflare.com/email-service/)).

* `kontakt@piloti.at` is one literal Email Routing rule on the app zone, which
  forwards to the founders' mailboxes (`contactForwardTo`). The contact
  address adds no catch-all to that zone. *Amended 2026-10-01:* the project
  mail inbox now puts its catch-all on the same zone (ADR-0074, amendment of
  2026-10-01). A literal rule wins over the catch-all, so this address never
  reaches the inbox's Worker, and the Worker refuses every other address
  that is not a project address, as Cloudflare refused it before.
* The form posts to the site's own server (`frontends/web/src/lib/contact.ts`),
  which sends through the Email Service REST API from `kontakt@piloti.at` to
  the same verified addresses, with the enquirer in `reply_to`. It keeps
  nothing and logs only an outcome code.
* Spam protection is local: a honeypot, an HMAC-signed fill time (3 s to 24 h),
  a per-client rate limit keyed by an HMAC of the IP and held in memory, and a
  32 KiB body cap.
* The web pods hold a token with Account · Email Sending · Edit and nothing
  else, in a Secret of their own. They never see the stack's DNS token.

### Consequences

* Good, because the only recipients the site can reach are addresses a founder
  verified by clicking a link. A bug or an abused form cannot mail anyone else.
* Good, because no new vendor, contract or DPA: Cloudflare is already the
  sub-processor ADR-0074 introduced.
* Good, because the page loads nothing from a third party and works without
  JavaScript.
* Bad, because onboarding `piloti.at` for Email Sending is a dashboard step the
  Pulumi provider cannot do, and it adds a second `_dmarc` record that must be
  deleted by hand.
* Bad, because onboarding turns on "Email preview", which keeps every sent
  message at Cloudflare for about seven days. It must be switched off by hand,
  and nothing checks that it stays off.
* Bad, because the per-client limit lives in each pod's memory: two replicas
  allow twice the budget, and a restart forgets it.
* Neutral, because the privacy analysis is section 8 of
  [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md).

### Confirmation

* `frontends/web/src/lib/contact.test.ts` (in `npm run check`): the signed
  timestamp, the rate limit, validation, and that a send goes only to the
  configured recipients.
* `deploy/pulumi/src/platform/contact-mail.spec.ts`: one literal rule and no
  catch-all, one destination address per target, and a provider holding the
  stack's token, not the web pods'. `email-routing.spec.ts`: the apex MX guard
  and the refusal of a second DMARC record. `deploy/pulumi/index-contact-mail.spec.ts`:
  the web pods get the contact form's credentials and nothing of the inbox's.
  `deploy/pulumi/src/app/web-contact.spec.ts`: the token and the form key come
  from the web tier's own Secret, never inline.
* Nothing enforces that Email preview stays off for `piloti.at`, or that each
  founder clicked the verification link. Both are steps in
  `docs/deployment/kubernetes.md` §3d; review is the only gate.

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
