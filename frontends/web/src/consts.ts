export const SITE_NAME = 'Piloti'
/**
 * Where every enquiry goes. Piloti has no mailbox of its own yet, so mail
 * reaches two founders directly. `CONTACT_EMAIL` is the one address shown in
 * running text; `mailtoHref` addresses both, so a demo request cannot land in
 * one inbox while its owner is away.
 */
export const CONTACT_EMAILS = ['mail@jonathanuhlemann.de', 'mail@bigls.net'] as const
export const CONTACT_EMAIL = CONTACT_EMAILS[0]

/**
 * A `mailto:` to every contact address, with an optional subject line and a
 * prefilled body: the few lines an office needs to write, so nobody faces an
 * empty mail to two strangers.
 */
export function mailtoHref(subject?: string, body?: string) {
  const to = CONTACT_EMAILS.join(',')
  const query = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`]
    .filter(Boolean)
    .join('&')
  return query ? `mailto:${to}?${query}` : `mailto:${to}`
}

/**
 * Where the "Anmelden"/"Sign in" link points.
 *
 * Relative ON PURPOSE. The app host is deployment configuration, resolved at
 * request time by the `/sign-in` endpoint from `PUBLIC_APP_URL` (injected per
 * stack by the Kubernetes deployment). Baking an absolute host into this
 * prerendered HTML is how the production site once linked at the dev app -
 * one image must serve every host, so nothing environment-specific may be
 * decided at build time here.
 */
export const SIGN_IN_HREF = '/sign-in'

/**
 * The public page on the project mail inbox: `/e-mail-eingang/` and
 * `/en/e-mail-eingang/`, prerendered by `pages/[mailInbox].astro` and
 * `pages/en/[mailInbox].astro` from this slug alone.
 *
 * Stable ON PURPOSE, and pure ASCII: the app's settings card links it
 * (`MAIL_INBOX_HELP_PATH` in frontends/ui/src/lib/brand.ts) and the text a
 * refused mail bounces with names it, so every copy of that bounce in a
 * mailbox carries this URL. Renaming it breaks those links; do not.
 */
export const MAIL_INBOX_SLUG = 'e-mail-eingang'
export const MAIL_INBOX_PATH = `/${MAIL_INBOX_SLUG}/`
