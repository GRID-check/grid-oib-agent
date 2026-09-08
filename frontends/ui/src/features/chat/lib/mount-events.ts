/**
 * The mount the AGENT made, read off `open_project`'s own result.
 *
 * `workspace_open_project` returns one JSON line, a blank line, then the German
 * prose (`aiq_agent/agents/workspace/register.py::_event`). Two readers, one
 * string: the model reads the prose, and this module reads the line — the same
 * split `remember`'s result already uses to drive the memory chip.
 *
 * Why the tool RESULT and not a `status:` turn event: a mount is a fact the
 * tool established, and the tool's own return value is the only place it is
 * stated once. A second copy on the status channel would be a second thing to
 * keep in agreement, and the two would disagree on the first refusal that
 * changed its wording.
 *
 * Three rules, and each is the reason this is a module rather than a `JSON.parse`
 * at the call site:
 *
 * 1. **The first line only.** The prose that follows is German sentences the
 *    model reads; it is never scanned. A tool whose payload arrives truncated
 *    mid-prose still yields its event.
 * 2. **An unknown status says nothing.** `status` is a closed set. A payload
 *    this build cannot phrase produces `null` and the transcript stays silent,
 *    the same rule `turnEventLiveText` applies to an unknown key — a raw token
 *    in a notice is worse than no notice.
 * 3. **A mount with no project id is not a mount.** The whole point of the
 *    event is to name what the conversation may now read; an event that cannot
 *    name it would widen the chip's count against nothing.
 */

import { unescapeStepPayload } from '@/adapters/api/step-event-schemas'

/** Backend name of the mounting tool (`WorkspaceOpenProjectConfig.name`). */
export const OPEN_PROJECT_STEP_NAME = 'workspace_open_project'

/** Why a mount did not happen — `aiq_agent/knowledge/mounts.py`'s REFUSAL_*. */
export type MountRefusalCode = 'cap' | 'no_access' | 'not_found' | 'unavailable'

const REFUSAL_CODES: readonly string[] = ['cap', 'no_access', 'not_found', 'unavailable']

/** A project the agent brought into view mid-turn. */
export interface AgentMountEvent {
  type: 'mount'
  status: 'mounted'
  projectId: string
  projectName: string
  mountedBy: 'agent'
}

/** A mount the office refused. It renders as a sentence and widens nothing. */
export interface AgentMountRefusal {
  type: 'mount'
  status: 'refused'
  code: MountRefusalCode
  /** Null when the refusal never named a project (the model guessed an id). */
  projectId: string | null
  /** Only ever set on `cap`: the ceiling, as the SERVER stated it. */
  cap?: number
}

export type MountEvent = AgentMountEvent | AgentMountRefusal

/** Whether this step is the mounting tool, however NAT dressed its name. */
export const isOpenProjectStepName = (functionName: string): boolean =>
  (functionName || '')
    .trim()
    .replace(/^tool:\s*/i, '')
    .toLowerCase() === OPEN_PROJECT_STEP_NAME

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * The mount event a payload states, or `null`.
 *
 * `unescapeStepPayload` first, for the trap `turn-events.ts` documents: NAT runs
 * `html.escape(…, quote=False)` over the payload, and `&`, `<`, `>` are not
 * JSON-structural — so a project name with an ampersand parses fine and arrives
 * as `Brand &amp; Rauch`. The decode is idempotent for a payload that never went
 * through it.
 */
export const parseMountEvent = (payload: string | undefined | null): MountEvent | null => {
  const first = unescapeStepPayload(payload ?? '')
    .trimStart()
    .split('\n', 1)[0]
    ?.trim()
  if (!first || !first.startsWith('{')) return null

  let body: unknown
  try {
    body = JSON.parse(first)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null

  const record = body as Record<string, unknown>
  if (record.event !== 'mount') return null

  if (record.status === 'mounted') {
    const projectId = text(record.projectId)
    if (!projectId) return null
    return {
      type: 'mount',
      status: 'mounted',
      projectId,
      // A nameless project would put an unlabelled chip in "Im Blick"; the id
      // is a worse name than the name and a better one than nothing.
      projectName: text(record.projectName) ?? projectId,
      mountedBy: 'agent',
    }
  }

  if (record.status === 'refused') {
    const code = text(record.code) ?? ''
    return {
      type: 'mount',
      status: 'refused',
      // An unrecognised refusal still refuses — it just refuses in the words
      // that are true of every refusal.
      code: (REFUSAL_CODES.includes(code) ? code : 'unavailable') as MountRefusalCode,
      projectId: text(record.projectId) ?? null,
      ...(typeof record.cap === 'number' && Number.isFinite(record.cap)
        ? { cap: record.cap }
        : {}),
    }
  }

  return null
}
