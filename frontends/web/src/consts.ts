export const SITE_NAME = 'Piloti'
/**
 * Where every enquiry goes: the one address the site shows, in running text,
 * the Impressum, the footer and every mailto. Cloudflare Email Routing forwards
 * it to the founders' mailboxes, so a demo request cannot land in one inbox
 * while its owner is away. The contact form sends from it (`CONTACT_FROM`
 * defaults to it) to the same mailboxes.
 */
export const CONTACT_EMAIL = 'kontakt@piloti.at'

/**
 * A `mailto:` to the contact address, with an optional subject line and a
 * prefilled body: the few lines an office needs to write, so nobody faces an
 * empty mail to strangers.
 */
export function mailtoHref(subject?: string, body?: string) {
  const to = CONTACT_EMAIL
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
 * (`mailInboxHelpUrl` in frontends/ui/src/lib/brand.ts) and the Worker's bounce
 * text for a refused mail names it, so every copy of that bounce in a mailbox
 * carries this URL. The path is `paths.mailInbox` in `shared/public-site.json`;
 * the Docker build cannot read that file, so this is a copy, and
 * `scripts/check-public-site.mjs` (`npm run check`) fails when it drifts.
 * Renaming it breaks every link already handed out; do not.
 */
export const MAIL_INBOX_SLUG = 'e-mail-eingang'
export const MAIL_INBOX_PATH = `/${MAIL_INBOX_SLUG}/`
