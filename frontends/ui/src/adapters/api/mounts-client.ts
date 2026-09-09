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

/**
 * A member of a Sammlung that was NOT mounted, and why.
 *
 * `forbidden` is the only reason that ever appears: a project the reader may
 * view but not chat in. They already know it exists and already know its name,
 * so naming it is the actionable half — "ask for chat access in Nordbahnhof".
 * A member they may not view AT ALL is absent from the answer entirely, not in
 * this list and not counted, because a Sammlung must not be the door through
 * which somebody learns a project they may not read exists (spec AC-3, AC-4).
 */
export interface SkippedMount {
  projectId: string
  projectName: string
  reason: 'forbidden'
}

/** What mounting a Sammlung answers with — a DIFFERENT shape from one mount's. */
export interface MountSetOutcome {
  set: { id: string; name: string }
  /** One entry per project now in view, including any that already were. */
  mounts: Mount[]
  skipped: SkippedMount[]
}

/** Why a mount did not happen, in the words the UI has a sentence for. */
export type MountRefusalCode =
  | 'cap'
  | 'no_access'
  | 'not_found'
  /**
   * The conversation is SHARED with people who may not view this project, and
   * MT-14 makes the mounted set a property of the conversation — so mounting it
   * would answer past them (spec AC-8). Not the cap: nothing is in the way, and
   * unmounting something would not help, which is why it is a separate code
   * with a separate sentence naming the people.
   */
  | 'would_exclude'
  | 'unavailable'

/**
 * The exclusion 409, as the BFF names it. The cap 409 is the other one, and the
 * body's `code` is what tells them apart — the status alone cannot.
 */
const EXCLUSION_CODE = 'WORKSPACE_MOUNT_WOULD_EXCLUDE'

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
  /**
   * Set on `would_exclude`: the participants who would lose this conversation.
   * The names are the actionable half of the refusal — "change the sharing, or
   * ask without this project" needs to say who.
   */
  readonly excluded?: string[]
  /** Set when a SAMMLUNG is what did not fit, so the sentence can name it. */
  readonly set?: { id: string; name: string }

  constructor(
    message: string,
    status: number,
    code: MountRefusalCode,
    extra?: {
      cap?: number
      mounted?: string[]
      excluded?: string[]
      set?: { id: string; name: string }
    }
  ) {
    super(message, status)
    this.code = code
    this.cap = extra?.cap
    this.mounted = extra?.mounted
    this.excluded = extra?.excluded
    this.set = extra?.set
  }
}

const mountsUrl = (conversationId: string): string =>
  `/api/conversations/${encodeURIComponent(conversationId)}/mounts`

const names = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : undefined

/**
 * The 409 this endpoint answered with, as the refusal it is.
 *
 * TWO conflicts share the status and are told apart by the body's `code`, which
 * is why this reads the code rather than assuming the cap: the cap has an offer
 * behind it (deep research) and the exclusion does not — it has people to name
 * — so rendering one as the other would offer a way out that leads nowhere.
 * Read defensively: the shape is a contract, the values are not.
 */
const conflictRefusal = async (res: Response): Promise<MountRefusedError> => {
  let body: Record<string, unknown> = {}
  try {
    body = ((await res.json()) ?? {}) as Record<string, unknown>
  } catch {
    // A conflict with no body is still a conflict. The cap is the older and by
    // far the commoner of the two, so it stays the fallback reading.
  }

  if (body.code === EXCLUSION_CODE) {
    return new MountRefusedError('Mount would exclude a participant', 409, 'would_exclude', {
      excluded: names(body.excluded),
      set: readSet(body.set),
    })
  }
  return new MountRefusedError('Mount cap reached', 409, 'cap', {
    cap: typeof body.cap === 'number' ? body.cap : undefined,
    mounted: names(body.mounted),
    set: readSet(body.set),
  })
}

/** The Sammlung a refusal or an answer names, when it names one. */
const readSet = (value: unknown): { id: string; name: string } | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const { id, name } = value as Record<string, unknown>
  if (typeof id !== 'string' || !id) return undefined
  return { id, name: typeof name === 'string' && name ? name : id }
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

/** Coerce one skipped member; a row that cannot be NAMED says nothing useful. */
const toSkipped = (row: unknown): SkippedMount | null => {
  if (!row || typeof row !== 'object') return null
  const { projectId, projectName } = row as Record<string, unknown>
  if (typeof projectId !== 'string' || !projectId) return null
  return {
    projectId,
    projectName: typeof projectName === 'string' && projectName ? projectName : projectId,
    // The server states one reason and this client renders one sentence; a
    // second reason would arrive as a code with no sentence, so it is not read.
    reason: 'forbidden',
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

    if (res.status === 409) throw await conflictRefusal(res)
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

  /**
   * Show this conversation a whole **Sammlung** (spec GR-2).
   *
   * The same endpoint and the same service as {@link mountsClient.mount}: a set
   * is not a second mechanism, it expands to the same mount rows against the
   * same cap. What differs is that all three refusals are decided over the
   * WHOLE set before any row is written — so this either widens the scope by
   * every readable member at once, or by none of them.
   *
   * `skipped` is not a failure. Some members were mounted and some were not,
   * and the caller has to say both; a throw here would discard the half that
   * worked.
   */
  async mountSet(conversationId: string, projectSetId: string): Promise<MountSetOutcome> {
    const res = await fetch(mountsUrl(conversationId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectSetId }),
    })

    if (res.status === 409) throw await conflictRefusal(res)
    if (res.status === 403) {
      throw new MountRefusedError('No project:chat', 403, 'no_access')
    }
    if (res.status === 404) {
      throw new MountRefusedError('Sammlung or conversation unknown', 404, 'not_found')
    }
    if (!res.ok) {
      throw new MountRefusedError('Mount failed', res.status, 'unavailable')
    }

    const body = (await res.json()) as { set?: unknown; mounts?: unknown; skipped?: unknown }
    const set = readSet(body.set)
    if (!set) {
      throw new MountRefusedError('Mount response named no Sammlung', 200, 'unavailable')
    }
    return {
      set,
      mounts: Array.isArray(body.mounts)
        ? body.mounts
            .map((entry) => toMount((entry as { mount?: unknown })?.mount))
            .filter((mount): mount is Mount => mount !== null)
        : [],
      skipped: Array.isArray(body.skipped)
        ? body.skipped.map(toSkipped).filter((row): row is SkippedMount => row !== null)
        : [],
    }
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
