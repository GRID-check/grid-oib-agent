/**
 * Back-link FALLBACK resolution for the org-wide Archiv page.
 *
 * The Archiv lives ABOVE projects (ADR-0024), so opening it drops the user out
 * of whatever project they were in. The control itself
 * ({@link import('@/components/shell/back-link').BackLink}) returns them to the
 * page they actually came from, read from the tab's return trail; this module
 * answers the case where there is no trail to read — a link opened in a new tab,
 * a restored session, the Archiv entered directly.
 *
 * The fallback is the reader's active project, NAMED when we know its name
 * ("Zurück zu Stadthaus Wien"), because "back to projects" was the disorienting
 * part: testers lost their project context and were handed a listing. Anything
 * we cannot resolve fails open to the all-projects listing, so it never
 * dead-ends.
 */

/** i18n key under the `archiv` namespace for the back-link label. */
export type ArchivBackLinkLabelKey = 'backToProject' | 'backToNamedProject' | 'backToApp'

export interface ArchivBackLink {
  href: string
  labelKey: ArchivBackLinkLabelKey
  /** Interpolated into `backToNamedProject`; absent for the other two labels. */
  name?: string
}

/** The (already access-checked) active project, as much of it as we could read. */
export interface ActiveProject {
  id: string
  /** The project's name, when the lookup produced one. */
  name?: string | null
}

/**
 * Resolve the Archiv back-link fallback from the active project.
 *
 * A project with a name returns the reader to it BY NAME; a project we could
 * only identify still returns them to it, labelled generically; anything falsy
 * falls back to the projects listing.
 */
export function resolveArchivBackLink(
  activeProject: ActiveProject | string | null | undefined
): ArchivBackLink {
  const project = typeof activeProject === 'string' ? { id: activeProject } : activeProject
  if (project?.id) {
    const name = project.name?.trim()
    return name
      ? { href: `/app/projects/${project.id}`, labelKey: 'backToNamedProject', name }
      : { href: `/app/projects/${project.id}`, labelKey: 'backToProject' }
  }
  return { href: '/app/projects', labelKey: 'backToApp' }
}
