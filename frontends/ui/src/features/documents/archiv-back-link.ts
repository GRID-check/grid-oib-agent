/**
 * Back-link resolution for the org-wide Archiv page.
 *
 * The Archiv lives ABOVE projects (ADR-0024), so opening it drops the user out
 * of whatever project they were in — and the only way back used to be the
 * generic "Back to projects" listing, which testers found disorienting (they
 * lost their project context). When we can tell which project the user came
 * from (their active project), we send them straight back to it; otherwise we
 * fail open to the all-projects listing.
 */

/** i18n key under the `archiv` namespace for the back-link label. */
export type ArchivBackLinkLabelKey = 'backToProject' | 'backToApp'

export interface ArchivBackLink {
  href: string
  labelKey: ArchivBackLinkLabelKey
}

/**
 * Resolve the Archiv back-link target from the (already access-checked) active
 * project id. A truthy id returns the user to that specific project (its root
 * redirects to Chat); anything falsy falls back to the projects listing.
 */
export function resolveArchivBackLink(activeProjectId: string | null | undefined): ArchivBackLink {
  if (activeProjectId) {
    return { href: `/app/projects/${activeProjectId}`, labelKey: 'backToProject' }
  }
  return { href: '/app/projects', labelKey: 'backToApp' }
}
