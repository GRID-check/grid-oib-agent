export const SITE_NAME = 'Piloti'
export const SITE_TAGLINE = 'Die KI-Plattform für Architektur- und Planungsbüros'
export const CONTACT_EMAIL = 'hallo@piloti.eu'

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
