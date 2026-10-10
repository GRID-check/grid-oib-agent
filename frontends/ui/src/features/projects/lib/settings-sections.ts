/**
 * The sections of a project's hub (the sidebar's Overview), and who sees which.
 *
 * The hub opens on a dashboard, not a form: a bento of live tiles, one per
 * section below, each showing the number that section is about and opening it.
 * The sections are where the work behind a tile is done.
 *
 *   - **Overview**: the dashboard. What is this project and where is it in its
 *     life? Name, size, spend, people, memory at a glance; renaming and
 *     deleting sit in the hero's menu, out of the way.
 *   - **Members**: who may work in it, in which role?
 *   - **Memory**: what has Piloti learned here, and is it right?
 *   - **Usage & budget**: what has this project cost, and what stops it?
 *   - **Documents & index**: who brought which files in, can everyone who should
 *     reach them, and is the index behind the answers current?
 *   - **Similar projects**: which closed projects of the office were most like
 *     this one, and what did they decide and get told? Reference reading, so it
 *     is a tile and a section here rather than a rail entry of its own.
 *
 * They were one scrolling Settings page holding all of it beside a placeholder
 * "Insights" card that promised numbers it had none of, and a roster shown to
 * every viewer although its endpoint answers them 404. Each is its own route
 * now, and a section exists for a reader only when its API would serve them.
 *
 * A new block goes in the section whose question it answers, never on a page of
 * its own and never back into one long column.
 *
 * The briefing and the applicable OIB-Richtlinien had a section and two tiles
 * here and were taken out again (2026-10-09): they did not answer a question a
 * person opens the hub with. The briefing is still edited in the intake
 * wizard, which the hero links to.
 *
 * Pure on purpose: the layout decides visibility on the server, the nav draws
 * it in the browser, and both read this one list.
 */

export const PROJECT_SETTINGS_SECTION_KEYS = [
  'overview',
  'members',
  'memory',
  'usage',
  'documents',
  'references',
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

/**
 * The route of a section. The Overview owns the bare `/settings`: the URL kept
 * its name so every link and bookmark into Settings still lands.
 */
export function settingsSectionHref(projectId: string, key: ProjectSettingsSectionKey): string {
  const base = `/app/projects/${encodeURIComponent(projectId)}/settings`
  return key === 'overview' ? base : `${base}/${key}`
}
