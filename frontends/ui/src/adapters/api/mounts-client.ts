/**
 * Mounted projects — the Büro's only write to what a turn may read (ADR-0054).
 *
 * A mount is a durable fact about a conversation, not a client-side filter: the
 * BFF re-authorizes `project:chat` on every mount and mints the grant the agent
 * verifies, so this client never decides anything. It states the reader's
 * intent and reports what came back.
 *
 * The refusals are typed rather than left as strings, because each one is a
 * different sentence on screen: the cap offers deep research, a denial says the
 * project cannot be read, and a 404 is deliberately indistinguishable from a
 * denial on the server (denial ≡ non-existence, ADR-0038).
 */

import { ApiRequestError } from './api-error'

/** One project this conversation may read, as the server records it. */
export interface Mount {
  projectId: string
  projectName: string
  /** Who widened the scope — the reader, or Piloti mid-turn. */
  mountedBy: 'user' | 'agent'
  /** ISO timestamp. */
  mountedAt: string
}

/** What `GET …/mounts` answers: the list AND the cap that bounds it. */
export interface MountList {
  mounts: Mount[]
  /**
   * How many projects one conversation may read at once. Read from the server,
   * never from a client constant: the cap has exactly one implementation
   * (`maxMountedProjects()` in the mounts service) and a second copy here would
   * disagree with it the first time it moves.
   */
  cap: number
}

/** Why a mount did not happen, in the words the UI has a sentence for. */
export type MountRefusalCode = 'cap' | 'no_access' | 'not_found' | 'unavailable'

/**
 * A mount the server refused.
 *
 * Extends {@link ApiRequestError} so a caller that only cares about "it failed"
 * keeps working, and carries the cap payload for the one refusal that has an
 * offer behind it.
 */
export class MountRefusedError extends ApiRequestError {
  readonly code: MountRefusalCode
  /** Set on `cap`: the ceiling the conversation is standing on. */
  readonly cap?: number
  /** Set on `cap`: the project names already in view, as the server named them. */
  readonly mounted?: string[]

  constructor(
    message: string,
    status: number,
    code: MountRefusalCode,
    extra?: { cap?: number; mounted?: string[] }
  ) {
    super(message, status)
    this.code = code
    this.cap = extra?.cap
    this.mounted = extra?.mounted
  }
}

const mountsUrl = (conversationId: string): string =>
  `/api/conversations/${encodeURIComponent(conversationId)}/mounts`

/** A refusal body, read defensively: the shape is a contract, the values are not. */
const readCapBody = async (res: Response): Promise<{ cap?: number; mounted?: string[] }> => {
  try {
    const body = (await res.json()) as { cap?: unknown; mounted?: unknown }
    return {
      cap: typeof body.cap === 'number' ? body.cap : undefined,
      mounted: Array.isArray(body.mounted)
        ? body.mounted.filter((name): name is string => typeof name === 'string')
        : undefined,
    }
  } catch {
    return {}
  }
}

/** Coerce one row; a row missing its identity is dropped rather than rendered nameless. */
const toMount = (row: unknown): Mount | null => {
  if (!row || typeof row !== 'object') return null
  const { projectId, projectName, mountedBy, mountedAt } = row as Record<string, unknown>
  if (typeof projectId !== 'string' || !projectId) return null
  return {
    projectId,
    projectName: typeof projectName === 'string' ? projectName : projectId,
    mountedBy: mountedBy === 'agent' ? 'agent' : 'user',
    mountedAt: typeof mountedAt === 'string' ? mountedAt : new Date(0).toISOString(),
  }
}

export const mountsClient = {
  /** Every project this conversation may read, plus the cap. */
  async list(conversationId: string): Promise<MountList> {
    const res = await fetch(mountsUrl(conversationId))
    if (!res.ok) throw new ApiRequestError('Failed to fetch mounts', res.status)
    const body = (await res.json()) as { mounts?: unknown; cap?: unknown }
    return {
      mounts: Array.isArray(body.mounts)
        ? body.mounts.map(toMount).filter((m): m is Mount => m !== null)
        : [],
      cap: typeof body.cap === 'number' ? body.cap : 0,
    }
  },

  /**
   * Show this conversation one more project.
   *
   * Idempotent by contract — re-mounting an already-mounted project answers
   * `200` with the same body — so a double press is not an error state.
   */
  async mount(conversationId: string, projectId: string): Promise<Mount> {
    const res = await fetch(mountsUrl(conversationId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })

    if (res.status === 409) {
      const { cap, mounted } = await readCapBody(res)
      throw new MountRefusedError('Mount cap reached', 409, 'cap', { cap, mounted })
    }
    if (res.status === 403) {
      throw new MountRefusedError('No project:chat', 403, 'no_access')
    }
    if (res.status === 404) {
      throw new MountRefusedError('Project or conversation unknown', 404, 'not_found')
    }
    if (!res.ok) {
      throw new MountRefusedError('Mount failed', res.status, 'unavailable')
    }

    const body = (await res.json()) as { mount?: unknown }
    const mount = toMount(body.mount)
    if (!mount) throw new MountRefusedError('Mount response carried no project', 200, 'unavailable')
    return mount
  },

  /** Take a project back out of view. */
  async unmount(conversationId: string, projectId: string): Promise<void> {
    const res = await fetch(
      `${mountsUrl(conversationId)}/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' }
    )
    // 404 is already the desired end state: the project is not in view.
    if (!res.ok && res.status !== 404) {
      throw new ApiRequestError('Failed to remove the mount', res.status)
    }
  },
}
