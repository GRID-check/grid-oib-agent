/**
 * Which tab of the Automation section is showing.
 *
 * Three now, and they are three different questions: a TASK is a single piece
 * of work somebody handed over and walked away from (ADR-0051), a JOB is the
 * recurring schedule that fires such work on a timer, and a SKILL is a
 * reusable instruction the organization owns. Aufgaben leads because it is the
 * question a person asks first („was läuft gerade für mich"); the Jobs tab is
 * the schedule management behind it.
 *
 * Aufgaben is the default. An unknown value falls back to it rather than
 * 404ing, because the value comes off `?tab=` and a stale bookmark is not an
 * error. `jobs` keeps its id on purpose: every bookmark, inbox row and old
 * link that says `?tab=jobs` must still land on the schedules view.
 */
export const AUTOMATION_TABS = ['tasks', 'jobs', 'skills'] as const
export type AutomationTab = (typeof AUTOMATION_TABS)[number]

export function parseAutomationTab(value: string | undefined): AutomationTab {
  return (AUTOMATION_TABS as readonly string[]).includes(value ?? '')
    ? (value as AutomationTab)
    : 'tasks'
}
