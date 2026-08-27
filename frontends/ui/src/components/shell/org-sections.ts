/**
 * Scope detection for the app chrome.
 *
 * The org-scope rail IA that used to live here is gone: above a project the
 * chrome is a slim header (`OrgHeader`) rather than a rail, and the org-wide
 * destinations live in the header (Archiv, Postfach) and the avatar menu
 * (Profil, Organisation, Plattform). What remains is the one function both
 * `AppShellChrome` and the palette-adjacent code need: deciding whether a
 * pathname is inside a project at all.
 */

/**
 * Whether `pathname` is inside a project — i.e. whether the chrome should show
 * the project rail. `/app/projects` (the listing) is deliberately NOT a
 * project: it is the org-scope home, and a switcher naming a project while the
 * reader looks at all of them is the single most false claim the frame can
 * make.
 */
export function projectIdFromPathname(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('/').filter(Boolean)
  if (segments[0] !== 'app' || segments[1] !== 'projects') return null
  return segments[2] ? decodeURIComponent(segments[2]) : null
}
