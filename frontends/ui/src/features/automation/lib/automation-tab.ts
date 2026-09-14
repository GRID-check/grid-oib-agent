/**
 * Which tab of the Automation section is showing.
 *
 * Two now, and they answer two different questions: a TASK is work somebody
 * handed over — a one-off handover or the recurring schedule that fires it,
 * both rows of `task_definitions` since migration 0086 — and a SKILL is a
 * reusable instruction the organization owns. Aufgaben leads because it is the
 * question a person asks first („was läuft gerade für mich"), and schedules are
 * the group at the top of that same list rather than a second tab.
 *
 * Aufgaben is the default. An unknown value falls back to it rather than
 * 404ing, because the value comes off `?tab=` and a stale bookmark is not an
 * error. `jobs` is the one named alias: the Jobs tab retired INTO Aufgaben
 * (schedules were always the thing it showed), so every bookmark, inbox row and
 * old link that says `?tab=jobs` still lands on the schedules view.
 */
export const AUTOMATION_TABS = ['tasks', 'skills'] as const
export type AutomationTab = (typeof AUTOMATION_TABS)[number]

/** Tab ids that moved, so old links keep answering. */
const LEGACY_TAB_ALIASES: Record<string, AutomationTab> = {
  jobs: 'tasks',
}

export function parseAutomationTab(value: string | undefined): AutomationTab {
  const candidate = LEGACY_TAB_ALIASES[value ?? ''] ?? value
  return (AUTOMATION_TABS as readonly string[]).includes(candidate ?? '')
    ? (candidate as AutomationTab)
    : 'tasks'
}
