export const SITE_NAME = 'Piloti'
export const SITE_TAGLINE = 'Die KI-Plattform für Architektur- und Planungsbüros'
/**
 * Where every enquiry goes. Piloti has no mailbox of its own yet, so mail
 * reaches two founders directly. `CONTACT_EMAIL` is the one address shown in
 * running text; `mailtoHref` addresses both, so a demo request cannot land in
 * one inbox while its owner is away.
 */
export const CONTACT_EMAILS = ['mail@jonathanuhlemann.de', 'mail@bigls.net'] as const
export const CONTACT_EMAIL = CONTACT_EMAILS[0]

/** A `mailto:` to every contact address, with an optional subject line. */
export function mailtoHref(subject?: string) {
  const to = CONTACT_EMAILS.join(',')
  return subject ? `mailto:${to}?subject=${encodeURIComponent(subject)}` : `mailto:${to}`
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
