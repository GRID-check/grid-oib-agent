/**
 * What to CALL an in-app location, given only its path.
 *
 * The return trail ({@link import('./return-trail')}) knows where the reader came
 * from as a pathname; a back control has to name that place ("Back to Dateien",
 * "Back to Postfach"). This module is the one mapping from path to label, so no
 * surface re-derives it — and so the label always comes from the SAME dictionary
 * entry the destination's own nav item uses, rather than a second copy of the
 * word that can drift from it.
 *
 * Pure and DOM-free: a path in, a dictionary coordinate out. An unrecognised
 * path returns `null`, and the caller falls back to a generic "Back" rather than
 * inventing a name for a page it cannot identify.
 */

import type { ProjectSectionKey } from '@/components/shell/project-sections'

/** Where a label lives: a dictionary namespace plus the key inside it. */
export interface PathLabel {
  namespace: 'nav' | 'collaboration'
  key: string
}

/**
 * Project sub-routes that are named by `nav.sections.*` — the same keys the rail
 * and the ⌘K palette label their entries with. Typed against
 * {@link ProjectSectionKey} so a section that is renamed or removed breaks the
 * build here instead of silently falling through to the generic "Back".
 */
const PROJECT_SECTION_SEGMENTS: readonly ProjectSectionKey[] = [
  'chat',
  'files',
  'knowledge',
  'history',
  'skills',
  'jobs',
  'intake',
  'settings',
]

/**
 * Project sub-routes that have no rail entry of their own but are still real
 * destinations a reader can be sent back to.
 */
const EXTRA_PROJECT_SEGMENTS: Record<string, PathLabel> = {
  research: { namespace: 'nav', key: 'sections.research' },
  members: { namespace: 'nav', key: 'returnTargets.members' },
  model: { namespace: 'nav', key: 'returnTargets.model' },
}

/** Org-level routes, matched on their first segment below `/app`. */
const APP_SECTIONS: Record<string, PathLabel> = {
  archiv: { namespace: 'nav', key: 'sections.archiv' },
  // The inbox's copy lives in the collaboration dictionary (ADR-0035); it is
  // read from there rather than copied into nav, exactly as the rail does.
  inbox: { namespace: 'collaboration', key: 'inbox.navLabel' },
  organization: { namespace: 'nav', key: 'returnTargets.organization' },
  platform: { namespace: 'nav', key: 'returnTargets.platform' },
  profile: { namespace: 'nav', key: 'returnTargets.profile' },
  chat: { namespace: 'nav', key: 'sections.chat' },
}

/**
 * Name the location at `path`, or `null` when it is not a page this app can
 * name (an unknown route, or anything outside `/app`).
 */
export function describeAppPath(path: string): PathLabel | null {
  const segments = path.split('?')[0].split('/').filter(Boolean)
  if (segments[0] !== 'app') return null

  if (segments[1] === 'projects') {
    // /app/projects — the listing.
    if (segments.length === 2) return { namespace: 'nav', key: 'projectSwitcher.projects' }
    // /app/projects/<id> — the project root (it redirects to Chat).
    if (segments.length === 3) return { namespace: 'nav', key: 'returnTargets.project' }

    const segment = segments[3]
    if ((PROJECT_SECTION_SEGMENTS as readonly string[]).includes(segment)) {
      return { namespace: 'nav', key: `sections.${segment}` }
    }
    return EXTRA_PROJECT_SEGMENTS[segment] ?? { namespace: 'nav', key: 'returnTargets.project' }
  }

  return APP_SECTIONS[segments[1] ?? ''] ?? null
}
