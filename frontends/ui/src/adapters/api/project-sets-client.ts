/**
 * Sammlungen — the UI's half of `/api/workspace/project-sets` (ADR-0054, GR-2).
 *
 * A Sammlung is a LABEL over projects and grants nobody access to any of them,
 * so nothing here decides anything: the server filters every set's membership
 * per caller (`filterReadableProjects`), states `projectCount` as the number
 * THIS reader would actually mount, and states `editable` as whether they may
 * change it. This client states an intent and reports what came back.
 *
 * Two consequences of that, both load-bearing:
 *
 *  - **`editable` is never inferred.** "I created it" and "I am an org project
 *    administrator" are both true of sets this reader may edit, and only the
 *    server knows the second. A client-side `createdBy === me` would grey out
 *    the administrator's controls and offer controls that 403.
 *  - **`projectCount` is the readable count.** It is what the cap is measured
 *    against, so a picker comparing it to the cap is comparing the right two
 *    numbers.
 *
 * Refusals are CODES, not sentences: this module is locale-free and the words
 * belong to whichever dictionary is reading.
 */

import { ApiRequestError } from './api-error'

/** One Sammlung, as this caller sees it. */
export interface ProjectSetSummary {
  id: string
  name: string
  description: string | null
  createdBy: string
  /** ISO-8601 instants. */
  createdAt: string
  updatedAt: string
  /** How many of its projects THIS caller may read — the number the Büro mounts. */
  projectCount: number
  /** Whether this caller may rename, edit or delete it. Never inferred here. */
  editable: boolean
}

/** A member of a Sammlung this caller may see. */
export interface ProjectSetMember {
  id: string
  name: string
}

/** One Sammlung with the members this caller may see. */
export interface ProjectSetDetail extends ProjectSetSummary {
  projects: ProjectSetMember[]
}

/** Why a Sammlung call did not happen, in the words the UI has a sentence for. */
export type ProjectSetRefusalCode =
  /** A Sammlung of that name already exists in this organization (409). */
  | 'duplicate_name'
  /** Not the creator, and not an organization project administrator (403). */
  | 'not_editable'
  /** The set, or a project named in the call, is not reachable (404). */
  | 'not_found'
  /** Anything else — a 500, a dropped connection. Not the reader's doing. */
  | 'unavailable'

/**
 * A Sammlung call the server refused.
 *
 * Extends {@link ApiRequestError} so a caller that only cares about "it failed"
 * keeps working, and carries the code for the three refusals that have a
 * different sentence and a different next step.
 */
export class ProjectSetRefusedError extends ApiRequestError {
  readonly code: ProjectSetRefusalCode

  constructor(message: string, status: number, code: ProjectSetRefusalCode) {
    super(message, status)
    this.code = code
  }
}

const BASE = '/api/workspace/project-sets'

const setUrl = (id: string): string => `${BASE}/${encodeURIComponent(id)}`

/**
 * The refusal a response states.
 *
 * The 404 on `POST …/projects` is the deliberate one: adding ids to your own
 * Sammlung must not be a way to discover which project ids this organization
 * holds, so an unreadable member and an imaginary one answer identically.
 */
const refusalFor = (status: number): ProjectSetRefusalCode => {
  if (status === 409) return 'duplicate_name'
  if (status === 403) return 'not_editable'
  if (status === 404) return 'not_found'
  return 'unavailable'
}

const refuse = async (res: Response): Promise<never> => {
  let message = `project-sets ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) message = body.error
  } catch {
    // A refusal with no body is still a refusal; the code carries the sentence.
  }
  throw new ProjectSetRefusedError(message, res.status, refusalFor(res.status))
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

/**
 * Coerce one summary row.
 *
 * A row missing its identity is dropped rather than rendered nameless — the
 * same rule the mounts client applies, and for the same reason: a row with no
 * id is a control that cannot act.
 */
const toSummary = (row: unknown): ProjectSetSummary | null => {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const id = text(record.id)
  const name = text(record.name)
  if (!id || !name) return null
  return {
    id,
    name,
    description: text(record.description),
    createdBy: text(record.createdBy) ?? '',
    createdAt: text(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: text(record.updatedAt) ?? new Date(0).toISOString(),
    // `Number(x) || 0` would turn a legitimate 0 into 0 by accident and NaN into
    // 0 by luck; the type check says which of the two happened.
    projectCount: typeof record.projectCount === 'number' ? record.projectCount : 0,
    // Absent means NOT editable. The safe default is the one that offers no
    // control, because a control that 403s is worse than one that is not there.
    editable: record.editable === true,
  }
}

const toMember = (row: unknown): ProjectSetMember | null => {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const id = text(record.id)
  if (!id) return null
  return { id, name: text(record.name) ?? id }
}

const toDetail = (row: unknown): ProjectSetDetail | null => {
  const summary = toSummary(row)
  if (!summary) return null
  const projects = (row as { projects?: unknown }).projects
  return {
    ...summary,
    projects: Array.isArray(projects)
      ? projects.map(toMember).filter((member): member is ProjectSetMember => member !== null)
      : [],
  }
}

/** Read one `{ set }` answer, or refuse — a body with no set is not a success. */
const readSet = async (res: Response): Promise<ProjectSetDetail> => {
  const body = (await res.json()) as { set?: unknown }
  const set = toDetail(body.set)
  if (!set) throw new ProjectSetRefusedError('Answer carried no Sammlung', res.status, 'unavailable')
  return set
}

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const projectSetsClient = {
  /** Every Sammlung of the organization, each measured by what this caller reads. */
  async list(): Promise<ProjectSetSummary[]> {
    const res = await fetch(BASE)
    if (!res.ok) throw new ApiRequestError('Failed to fetch Sammlungen', res.status)
    const body = (await res.json()) as { sets?: unknown }
    return Array.isArray(body.sets)
      ? body.sets.map(toSummary).filter((set): set is ProjectSetSummary => set !== null)
      : []
  },

  /** Name a new Sammlung. A name already in use is `duplicate_name`, not a crash. */
  async create(input: { name: string; description?: string | null }): Promise<ProjectSetDetail> {
    const res = await fetch(
      BASE,
      jsonRequest('POST', {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
    )
    if (!res.ok) await refuse(res)
    return readSet(res)
  },

  /** One Sammlung with the members this caller may see. */
  async get(id: string): Promise<ProjectSetDetail> {
    const res = await fetch(setUrl(id))
    if (!res.ok) await refuse(res)
    return readSet(res)
  },

  /** Rename or re-describe. `description: null` clears it. */
  async update(
    id: string,
    changes: { name?: string; description?: string | null }
  ): Promise<ProjectSetDetail> {
    const res = await fetch(setUrl(id), jsonRequest('PATCH', changes))
    if (!res.ok) await refuse(res)
    return readSet(res)
  },

  /**
   * Delete the Sammlung.
   *
   * Its memberships go and NOTHING else: a conversation that mounted it holds
   * ordinary mount rows from the moment they were written (spec MT-14), so the
   * label going away never changes what a thread reads.
   */
  async remove(id: string): Promise<void> {
    const res = await fetch(setUrl(id), { method: 'DELETE' })
    // 204 is the answer; a 404 is already the desired end state.
    if (!res.ok && res.status !== 404) await refuse(res)
  },

  /**
   * Add projects. All of them, or none — a half-applied add would leave the
   * reader believing the set holds seven projects when it holds five.
   */
  async addProjects(id: string, projectIds: readonly string[]): Promise<ProjectSetDetail> {
    const res = await fetch(
      `${setUrl(id)}/projects`,
      jsonRequest('POST', { projectIds: [...projectIds] })
    )
    if (!res.ok) await refuse(res)
    return readSet(res)
  },

  /**
   * Take projects out. No project permission is asked, because narrowing a set
   * edits the LABEL rather than the project — somebody who has since lost
   * `project:view` on something in their own Sammlung must still be able to
   * remove it.
   */
  async removeProjects(id: string, projectIds: readonly string[]): Promise<ProjectSetDetail> {
    const res = await fetch(
      `${setUrl(id)}/projects`,
      jsonRequest('DELETE', { projectIds: [...projectIds] })
    )
    if (!res.ok) await refuse(res)
    return readSet(res)
  },
}
