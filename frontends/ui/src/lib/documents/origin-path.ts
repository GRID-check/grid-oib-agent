/** Longest origin path recorded. Deep office trees exist; unbounded text does not belong in a row. */
const ORIGIN_PATH_MAX_CHARS = 1024

/**
 * A browser-reported origin path, made safe to store and to show.
 *
 * This string is USER-CONTROLLED — it is whatever the operating system had in
 * a folder name — and it is rendered back to other people in the same
 * organization, so it is treated the way every other piece of uploaded text is:
 * bounded, normalised, and stripped of the characters that would let it
 * pretend to be something else.
 *
 * Backslashes become forward slashes so a Windows tree and a macOS one read
 * alike. Leading slashes, `.` and `..` segments are dropped: this is a label,
 * never a path anything resolves, and an absolute or climbing path in a label
 * is only ever a way to mislead a reader about where a file came from. Control
 * characters go for the same reason a filename's do.
 */
export function sanitizeOriginPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const segments = raw
    .replace(/\\/g, '/')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (segments.length === 0) return null
  const joined = segments.join('/')
  return joined.slice(0, ORIGIN_PATH_MAX_CHARS) || null
}
