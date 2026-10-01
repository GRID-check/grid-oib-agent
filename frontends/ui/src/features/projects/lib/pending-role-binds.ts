/**
 * Role bindings the intake wizard holds until its save, for buildings not saved yet.
 *
 * Modul I (Projektgrundlagen) comes before the save, so during a first intake
 * every building added in the wizard exists only in the browser's draft. The
 * server accepts a binding only for a building the stored profile names
 * (`projectHasBauwerk`), and refused "Bauwerk 'bw2' does not exist": the plan
 * was uploaded and left unbound. Relaxing the server would bring back the
 * binding to nowhere it exists to refuse, so the wizard keeps such a binding
 * here instead, shows it, keeps it in the draft, drops it with its building,
 * and sends it once the save has made the building real.
 */

import {
  answersFromProfile,
  defaultBauwerke,
  type ProjectIntakeDefinition,
} from '@/lib/project-profile/intake-definition'
import { documentRoleDefinition, type DocumentRole } from '@/lib/project-profile/document-roles'
import type { ProjectProfile } from '@/lib/project-profile/types'

export interface PendingRoleBind {
  documentId: string
  /** What the field shows until the binding is made. */
  filename: string
  role: DocumentRole
  scopeInstanceId: string
}

/** The buildings the server will accept a binding for: the stored profile's, as `projectHasBauwerk` reads them. */
export function persistedBauwerkIds(
  profile: ProjectProfile | null | undefined,
  definition: ProjectIntakeDefinition | null
): ReadonlySet<string> {
  const bauwerke =
    profile && definition ? answersFromProfile(profile, definition).bauwerke : defaultBauwerke()
  return new Set(bauwerke.map((bauwerk) => bauwerk.id))
}

/** Add a pending binding; a single-holder role keeps only the newest for its slot. */
export function withPendingBind(
  pending: readonly PendingRoleBind[],
  next: PendingRoleBind
): PendingRoleBind[] {
  const sameSlot = (bind: PendingRoleBind) =>
    bind.role === next.role && bind.scopeInstanceId === next.scopeInstanceId
  const single = documentRoleDefinition(next.role).cardinality === 'one'
  const kept = pending.filter(
    (bind) => !(sameSlot(bind) && (single || bind.documentId === next.documentId))
  )
  return [...kept, next]
}

/** Without the pending bindings of a building the wizard removed. */
export function withoutBauwerk(
  pending: readonly PendingRoleBind[],
  bauwerkId: string
): PendingRoleBind[] {
  return pending.filter((bind) => bind.scopeInstanceId !== bauwerkId)
}

/** Without one pending binding (the user took it back). */
export function withoutPendingBind(
  pending: readonly PendingRoleBind[],
  removed: PendingRoleBind
): PendingRoleBind[] {
  return pending.filter(
    (bind) =>
      !(
        bind.documentId === removed.documentId &&
        bind.role === removed.role &&
        bind.scopeInstanceId === removed.scopeInstanceId
      )
  )
}

/** Only the entries a stored draft may carry back: the shape, never trusted blindly. */
export function pendingBindsFromDraft(raw: unknown): PendingRoleBind[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is PendingRoleBind =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as PendingRoleBind).documentId === 'string' &&
      typeof (entry as PendingRoleBind).filename === 'string' &&
      typeof (entry as PendingRoleBind).role === 'string' &&
      typeof (entry as PendingRoleBind).scopeInstanceId === 'string'
  )
}

/**
 * Make the held bindings, now that the save created their buildings.
 *
 * One at a time, in the order they were made, so a single-holder slot ends on
 * the last choice. Returns the ones the server refused (a document deleted in
 * the meantime, a building the save did not keep) for the caller to name.
 */
export async function sendPendingBinds(
  projectId: string,
  pending: readonly PendingRoleBind[],
  post: typeof fetch = fetch
): Promise<PendingRoleBind[]> {
  const refused: PendingRoleBind[] = []
  for (const bind of pending) {
    try {
      const response = await post(`/api/projects/${projectId}/document-roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: bind.documentId,
          role: bind.role,
          scopeInstanceId: bind.scopeInstanceId,
        }),
      })
      if (!response.ok) refused.push(bind)
    } catch {
      refused.push(bind)
    }
  }
  return refused
}

/**
 * The deferred uploads still in flight, so the save can wait for them.
 *
 * An upload for a building the wizard has not saved yet records its binding
 * only when the upload answers. A save started before that sent the bindings
 * it had, cleared the draft and left: the file was uploaded and never bound,
 * and nothing said so. `settled` resolves once every tracked upload has,
 * including ones started while it waits.
 */
export function createUploadTracker(): {
  track: (work: Promise<unknown>) => void
  settled: () => Promise<void>
} {
  const inFlight = new Set<Promise<unknown>>()
  return {
    track(work) {
      inFlight.add(work)
      const done = () => {
        inFlight.delete(work)
      }
      work.then(done, done)
    },
    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
}
