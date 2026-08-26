/**
 * Which projects fill the projects-home "continue" rail, and in what order the
 * rest of them fall through to the list below it.
 *
 * A pure module rather than logic inside `ProjectsGrid`: the rules here — whose
 * activity counts, what happens when the viewer has none, how a partially
 * filled rail is topped up — are the part worth testing, and testing them
 * through a mounted React tree costs ~130x per assertion for no added coverage
 * (AGENTS.md §"fix causes, not symptoms"). `src/features/layout/lib/` is the
 * established shape; this follows it.
 *
 * The rail answers "what do I open now?", so it is ordered by the VIEWER'S own
 * activity — messages they wrote, in conversations belonging to the project.
 * Everything else in the product that says "last activity" means the project's
 * profile write, which is a different question and is kept as the fallback
 * ordering, never mixed into the same number.
 */

/** How many projects the resume rail holds. */
export const RESUME_SLOTS = 3

/**
 * The project fields the split reads. Deliberately narrower than `Project` so a
 * spec fixture is three fields rather than a whole row, and so the module has
 * no reason to reach for anything else.
 */
export interface ResumeCandidate {
  id: string
  /** Most recent profile write, when the project has one. */
  profileUpdatedAt: Date | string | null
  createdAt: Date | string
}

export interface ResumeSplit<T extends ResumeCandidate> {
  /** Rail entries, most recently touched first. Up to `slots`, may be shorter. */
  resume: T[]
  /** Everything else, most recently touched first. */
  rest: T[]
  /**
   * `activity` when at least one rail slot is backed by the viewer's own
   * activity; `fallback` when the rail is filled purely by project recency
   * because the viewer has not worked in any of them yet. The heading above
   * the rail changes with it — a rail labelled "continue" over projects nobody
   * has opened would be a claim the data does not support.
   */
  basis: 'activity' | 'fallback'
}

/** Milliseconds since the epoch, or null when the value is absent/unparseable. */
function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

/**
 * The best "this project moved" timestamp available without the viewer: the
 * profile write, falling back to creation. Same rule the project card has always
 * used for its footer, exported so the two cannot drift apart.
 */
export function projectTouchedAt(project: ResumeCandidate): number {
  return toMillis(project.profileUpdatedAt) ?? toMillis(project.createdAt) ?? 0
}

/**
 * Split projects into the rail and the list.
 *
 * @param projects           Projects the viewer may see, in any order.
 * @param viewerActivity     Per-project ISO timestamp of the viewer's own last
 *                           activity. Projects absent from the map (or carrying
 *                           an unparseable value) simply have none.
 * @param slots              Rail size; defaults to {@link RESUME_SLOTS}.
 *
 * Ordering rule, in one sentence: projects the viewer has worked in come first,
 * newest first; the rail is topped up from the remainder by project recency so
 * it is never a ragged one-card row; the list keeps the same recency order.
 */
export function splitForResume<T extends ResumeCandidate>(
  projects: readonly T[],
  viewerActivity: Readonly<Record<string, string | undefined>> = {},
  slots: number = RESUME_SLOTS
): ResumeSplit<T> {
  const railSize = Math.max(0, Math.trunc(slots))

  const active: Array<{ project: T; at: number }> = []
  const untouched: Array<{ project: T; at: number }> = []

  for (const project of projects) {
    const at = toMillis(viewerActivity[project.id])
    if (at === null) untouched.push({ project, at: projectTouchedAt(project) })
    else active.push({ project, at })
  }

  const byRecency = (a: { at: number }, b: { at: number }): number => b.at - a.at
  active.sort(byRecency)
  untouched.sort(byRecency)

  // The viewer's own activity always outranks project recency, so the two lists
  // are concatenated rather than merged on their timestamps: a project someone
  // else edited yesterday must not outrank the one this person was writing in
  // last week.
  const ordered = [...active, ...untouched].map((entry) => entry.project)

  return {
    resume: ordered.slice(0, railSize),
    rest: ordered.slice(railSize),
    basis: active.length > 0 ? 'activity' : 'fallback',
  }
}
