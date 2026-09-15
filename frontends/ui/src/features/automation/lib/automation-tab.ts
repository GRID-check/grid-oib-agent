/**
 * Which tab of the Automation section is showing.
 *
 * Two, because a person arrives at this section with one of two questions:
 *
 *   - **Tasks** — „was hat Piloti gemacht, während ich weg war, und was wird
 *     sie tun?" Every task is one standing arrangement (`task_definitions`)
 *     with its runs; a task MAY be on a schedule, and one that is shows its
 *     cadence and its next run where it stands. There is no separate thing
 *     called a Zeitplan to create — creating a task asks when as one of its
 *     steps, and the week grid is a VIEW of the tasks, not a place.
 *   - **Skills** — the reusable instructions the ORGANIZATION owns.
 *
 * The grid-vs-list question is answered one level down, by the tasks VIEW
 * (`tasks-view.ts`): the timetable shows how the scheduled tasks arrange the
 * week (what collides, what is empty), the list shows what happened newest
 * first. A view is a preference, shareable in the URL, not a destination —
 * which is why it must never have been a tab.
 *
 * Tasks leads and is the default: it is the question asked most often, and the
 * one an inbox knock lands on. An unknown value falls back to it rather than
 * 404ing, because the value comes off `?tab=` and a stale bookmark is not an
 * error.
 */
export const AUTOMATION_TABS = ['tasks', 'skills'] as const
export type AutomationTab = (typeof AUTOMATION_TABS)[number]

/**
 * Tab ids that moved, so old links keep answering.
 *
 * `jobs` was the retired Jobs tab (now Tasks). `schedule` was the retired
 * Zeitplan tab: every such bookmark meant the scheduled tasks, which now live
 * on the Tasks tab — the panel additionally opens the timetable VIEW for it
 * (see `initialView` in `automation-panel.tsx`), which is what the link
 * always meant.
 */
const LEGACY_TAB_ALIASES: Record<string, AutomationTab> = {
  jobs: 'tasks',
  schedule: 'tasks',
}

export function parseAutomationTab(value: string | undefined): AutomationTab {
  const candidate = LEGACY_TAB_ALIASES[value ?? ''] ?? value
  return (AUTOMATION_TABS as readonly string[]).includes(candidate ?? '')
    ? (candidate as AutomationTab)
    : 'tasks'
}

/**
 * The tab a drawer deep link belongs to, or null when the URL carries none.
 *
 * `?task=` names a run and `?schedule=` names a standing task, and both live
 * on the Tasks tab: a task drawer and a schedule drawer are two drawers over
 * one list, not two destinations.
 */
export function tabForDeepLink(params: URLSearchParams): AutomationTab | null {
  if (params.has('task')) return 'tasks'
  if (params.has('schedule')) return 'tasks'
  return null
}
