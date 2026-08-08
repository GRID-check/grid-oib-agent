export const SITE_NAME = 'Piloti'
export const SITE_TAGLINE = 'Die KI-Plattform für Architektur- und Planungsbüros'
export const CONTACT_EMAIL = 'hallo@piloti.eu'
export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? 'https://app.piloti.at'

/**
 * Where the "Anmelden"/"Sign in" link points.
 *
 * The `?sign-in` marker is required. The app's root redirects logged-out
 * visitors back to this landing site, so linking at the bare APP_URL bounces
 * the visitor straight back here and sign-in is unreachable. The marker tells
 * the app the visit is deliberate, and it redirects to WorkOS instead.
 */
export const SIGN_IN_URL = `${APP_URL.replace(/\/$/, '')}/?sign-in`
