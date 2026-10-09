/**
 * The sections of a project's Settings, and who sees which.
 *
 * Each section answers one question a person brings to project settings:
 *
 *   - **General**: what is this project, and where is it in its life? Its name,
 *     its size, its record (period, people), closing and reopening it, and, at
 *     the bottom where a destructive control belongs, deleting it.
 *   - **Project profile**: what does Piloti assume about this project in every
 *     answer, and which OIB-Richtlinien follow from that?
 *   - **Members**: who may work in it, in which role?
 *   - **Memory**: what has Piloti learned here, and is it right?
 *   - **Usage & budget**: what has this project cost, and what stops it?
 *   - **Documents & index**: who brought which files in, can everyone who should
 *     reach them, and is the index behind the answers current?
 *
 * They used to be one scrolling page holding all of it beside a placeholder
 * "Insights" card that promised numbers it had none of, and a roster shown to
 * every viewer although its endpoint answers them 404. Each is its own route
 * now, and a section exists for a reader only when its API would serve them.
 *
 * A new block goes in the section whose question it answers, never on a page of
 * its own and never back into one long column.
 *
 * Pure on purpose: the layout decides visibility on the server, the nav draws
 * it in the browser, and both read this one list.
 */

export const PROJECT_SETTINGS_SECTION_KEYS = [
  'general',
  'profile',
  'members',
  'memory',
  'usage',
  'documents',
] as const

export type ProjectSettingsSectionKey = (typeof PROJECT_SETTINGS_SECTION_KEYS)[number]

/** The capabilities that decide which sections exist for a reader. */
export interface ProjectSettingsVisibility {
  manageMembers: boolean
  manageBudget: boolean
}

/** The sections this reader may open, in reading order. */
export function visibleSettingsSections(
  access: ProjectSettingsVisibility
): ProjectSettingsSectionKey[] {
  return PROJECT_SETTINGS_SECTION_KEYS.filter((key) => {
    if (key === 'members') return access.manageMembers
    if (key === 'usage') return access.manageBudget
    return true
  })
}

/** The route of a section. General owns the bare `/settings`. */
export function settingsSectionHref(projectId: string, key: ProjectSettingsSectionKey): string {
  const base = `/app/projects/${encodeURIComponent(projectId)}/settings`
  return key === 'general' ? base : `${base}/${key}`
}
