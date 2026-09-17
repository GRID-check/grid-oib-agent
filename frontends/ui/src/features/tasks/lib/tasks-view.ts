/**
 * Which view of the Tasks tab is showing.
 *
 * Liste and Zeitplan are two readings of ONE set of tasks, not two
 * destinations: the list answers "what happened" newest-first (runs) with the
 * standing tasks below it, the timetable answers "what will happen, and when"
 * (the week grid over the scheduled tasks, with their cards beneath it). A
 * reader flips between them mid-thought, so the view rides `?view=` via
 * `history.replaceState` — shareable, but the back button still leaves the
 * section instead of replaying view flips.
 *
 * An unknown value falls back to the list: the value comes off the URL and a
 * stale bookmark is not an error.
 */
export const TASKS_VIEWS = ['list', 'timetable'] as const
export type TasksView = (typeof TASKS_VIEWS)[number]

export function parseTasksView(value: string | undefined): TasksView {
  return (TASKS_VIEWS as readonly string[]).includes(value ?? '')
    ? (value as TasksView)
    : 'list'
}
