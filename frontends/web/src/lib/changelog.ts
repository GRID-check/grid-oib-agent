import changelog from '../data/changelog.json'
import type { Locale } from '../i18n/ui'

/**
 * The changelog shown at /changelog and /en/changelog.
 *
 * `src/data/changelog.json` is GENERATED — `scripts/release_notes.py` reads the
 * reno notes in `releasenotes/notes/`, translates them once, and the
 * release-notes workflow commits the result on every merge to `develop`. Nothing
 * here reads git or calls a translator at build time, which is what lets the web
 * image be built from a plain working tree.
 *
 * See docs/contributing/release-notes.md.
 */

/** One string in both site languages. German falls back to English until translated. */
export interface Bilingual {
  en: string
  de: string
}

export interface ChangelogSection {
  /** Section key from releasenotes/config.yaml — `features`, `fixes`, … */
  key: string
  notes: Bilingual[]
}

export interface ChangelogRelease {
  /** A tag (`v1.2.0`) or, while nothing is tagged, the day the notes shipped. */
  id: string
  kind: 'version' | 'date'
  version: string | null
  date: string | null
  summary: Bilingual | null
  sections: ChangelogSection[]
}

const releases = changelog.releases as ChangelogRelease[]
const sectionTitles = changelog.sectionTitles as Record<string, Bilingual>

export function getReleases(): ChangelogRelease[] {
  return releases
}

/** The display title for a section, e.g. `features` -> "Neue Funktionen". */
export function sectionTitle(key: string, locale: Locale): string {
  const title = sectionTitles[key]
  return title ? title[locale] : key
}

/**
 * The heading for one release: its version if the repo tagged one, otherwise the
 * date the notes shipped. A release with neither is still uncommitted — it can
 * only appear in a local preview — so the caller passes the localized
 * "coming up" label for it.
 */
export function releaseTitle(
  release: ChangelogRelease,
  locale: Locale,
  unreleasedLabel: string
): string {
  if (release.kind === 'version' && release.version) return release.version
  if (!release.date) return unreleasedLabel
  return new Date(`${release.date}T00:00:00Z`).toLocaleDateString(
    locale === 'en' ? 'en-GB' : 'de-AT',
    { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
  )
}

/** `datetime` attribute for the release heading, when there is a real date. */
export function releaseDateTime(release: ChangelogRelease): string | undefined {
  return release.date ?? undefined
}
