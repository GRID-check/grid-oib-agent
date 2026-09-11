/**
 * Which tab of the Automation section is showing.
 *
 * Three now, and they are three different questions: a JOB is a prompt this
 * project runs on a timer, a SKILL is a reusable instruction the organization
 * owns, and a TASK is a single piece of work somebody handed over and walked
 * away from (ADR-0051). The third arrived last and belongs here rather than in
 * a rail entry of its own — „was läuft gerade für mich" is the same question as
 * „was läuft hier nach Plan", asked about work instead of about a schedule.
 *
 * Jobs stays the default: it is the project-scoped half, and this page lives in
 * a project. An unknown value falls back to it rather than 404ing, because the
 * value comes off `?tab=` and a stale bookmark is not an error.
 */
export const AUTOMATION_TABS = ['jobs', 'skills', 'tasks'] as const
export type AutomationTab = (typeof AUTOMATION_TABS)[number]

export function parseAutomationTab(value: string | undefined): AutomationTab {
  return (AUTOMATION_TABS as readonly string[]).includes(value ?? '')
    ? (value as AutomationTab)
    : 'jobs'
}
