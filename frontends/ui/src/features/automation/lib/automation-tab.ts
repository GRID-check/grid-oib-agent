/**
 * Which tab of the Automation section is showing.
 *
 * Three, because a person arrives at this section with one of three questions
 * and they are not the same shape:
 *
 *   - **Tasks** — „was hat Piloti gemacht, während ich weg war?" A list of
 *     things that HAPPENED, read newest-first, judged and then let go.
 *   - **Zeitplan** — „was wird Piloti tun, und wann?" A commitment, and a
 *     calendar question: the answer is an arrangement (what collides, what
 *     weekend is empty), not a row.
 *   - **Skills** — the reusable instructions the ORGANIZATION owns.
 *
 * They used to be two, with the schedules squeezed in as a group at the top of
 * the task list. That averaged the first two questions into neither: a list of
 * cron strings above a list of results made the reader simulate a calendar in
 * their head, and pushed the results — the reason most people open the
 * section — below the fold.
 *
 * Tasks leads and is the default: it is the question asked most often, and the
 * one an inbox knock lands on. An unknown value falls back to it rather than
 * 404ing, because the value comes off `?tab=` and a stale bookmark is not an
 * error.
 */
export const AUTOMATION_TABS = ['tasks', 'schedule', 'skills'] as const
export type AutomationTab = (typeof AUTOMATION_TABS)[number]

/**
 * Tab ids that moved, so old links keep answering.
 *
 * `jobs` was the retired Jobs tab, which is now Zeitplan — schedules were
 * always the thing it showed, so every bookmark and inbox row that says
 * `?tab=jobs` lands where it meant to. It briefly resolved to `tasks` while the
 * schedules lived inside that list; now that they have a tab of their own it
 * points at the tab, which is what the link always meant.
 */
const LEGACY_TAB_ALIASES: Record<string, AutomationTab> = {
  jobs: 'schedule',
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
 * `?task=` names a run and `?schedule=` names a schedule, and since the split
 * each lives on exactly ONE tab. That is what lets the panel forward a deep
 * link with a single lookup instead of forcing a tab, watching both lists
 * settle, and restoring the tab when neither matched — the machinery the merged
 * list needed and this arrangement deletes.
 */
export function tabForDeepLink(params: URLSearchParams): AutomationTab | null {
  if (params.has('task')) return 'tasks'
  if (params.has('schedule')) return 'schedule'
  return null
}
