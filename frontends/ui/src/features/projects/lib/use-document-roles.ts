'use client'

/**
 * One source of role bindings per project, shared by every field on screen.
 *
 * Each field fetching for itself was wrong twice over. It opened a request per
 * field for the same two payloads — Modul I can show several at once — and,
 * worse, it let two fields for the SAME role hold different answers: binding
 * the Bebauungsplan in the wizard question left the Modul I slot still showing
 * the old document until something remounted it.
 *
 * So the bindings live in a module-scope store keyed by project, fields
 * subscribe, and a write refreshes every subscriber at once. Small enough to
 * not want a library: one map, one set of listeners, no cache invalidation
 * policy beyond "refetch after a write".
 */

import { useCallback, useEffect, useState } from 'react'
import type { DocumentRole } from '@/lib/project-profile/document-roles'

export interface RoleBinding {
  id: string
  documentId: string
  role: DocumentRole
  scopeInstanceId: string | null
  confidence: 'declared' | 'suggested'
  filename: string
  displayName: string | null
}

export interface ProjectDocumentOption {
  id: string
  filename: string
  displayName?: string | null
}

export interface DocumentRolesState {
  /** `null` until the first load resolves, so a field can tell empty from unknown. */
  bindings: RoleBinding[] | null
  documents: ProjectDocumentOption[]
}

type Listener = (state: DocumentRolesState) => void

const EMPTY: DocumentRolesState = { bindings: null, documents: [] }

const states = new Map<string, DocumentRolesState>()
const listeners = new Map<string, Set<Listener>>()
const inFlight = new Map<string, Promise<void>>()

function publish(projectId: string, next: DocumentRolesState): void {
  states.set(projectId, next)
  for (const listener of listeners.get(projectId) ?? []) listener(next)
}

async function load(projectId: string): Promise<void> {
  const [rolesResponse, documentsResponse] = await Promise.all([
    fetch(`/api/projects/${projectId}/document-roles`).catch(() => null),
    fetch(`/api/documents?projectId=${encodeURIComponent(projectId)}`).catch(() => null),
  ])

  // `.json()` on an OK response still rejects on a truncated or non-JSON body,
  // and a body of literal `null` type-checks but has no `.roles`. Either used to
  // reject `load` before `publish`, leaving `bindings` at `null` — which every
  // subscribed field renders as a spinner that never stops.
  const readList = async <T>(
    response: Response | null,
    key: 'roles' | 'documents'
  ): Promise<T[]> => {
    if (!response?.ok) return []
    const parsed: unknown = await response.json().catch(() => null)
    if (!parsed || typeof parsed !== 'object') return []
    const value = (parsed as Record<string, unknown>)[key]
    return Array.isArray(value) ? (value as T[]) : []
  }
  const roles = await readList<RoleBinding>(rolesResponse, 'roles')
  const documents = await readList<ProjectDocumentOption>(documentsResponse, 'documents')

  // Bindings resolve to `[]` rather than staying `null` even when the request
  // failed: a field that shows a spinner forever is worse than one that shows
  // an empty slot the user can still fill.
  //
  // Only while someone is still listening, though. Publishing after the last
  // subscriber unmounted re-created the cache entry that cleanup had just
  // deleted, so reopening the project saw `states.has(projectId)` and skipped
  // the refetch — serving a snapshot from before whatever happened in between.
  if (listeners.has(projectId)) publish(projectId, { bindings: roles, documents })
}

/**
 * Refetch, coalescing concurrent callers onto one request.
 *
 * A post-write refresh may NOT coalesce onto an in-flight read: that request was
 * issued before the write landed, so joining it returns pre-write data and no
 * later request is ever made — every field then shows the old binding until
 * something else refetches. Such a caller waits for the in-flight read, then
 * starts its own.
 */
export function refreshDocumentRoles(
  projectId: string,
  options?: { afterWrite?: boolean }
): Promise<void> {
  const existing = inFlight.get(projectId)
  if (existing && !options?.afterWrite) return existing

  const start = (): Promise<void> => {
    const promise = load(projectId).finally(() => {
      if (inFlight.get(projectId) === promise) inFlight.delete(projectId)
    })
    inFlight.set(projectId, promise)
    return promise
  }

  return existing ? existing.then(start, start) : start()
}

export function useDocumentRoles(projectId: string): DocumentRolesState & {
  refresh: (options?: { afterWrite?: boolean }) => Promise<void>
} {
  const [state, setState] = useState<DocumentRolesState>(() => states.get(projectId) ?? EMPTY)

  useEffect(() => {
    let listenerSet = listeners.get(projectId)
    if (!listenerSet) {
      listenerSet = new Set()
      listeners.set(projectId, listenerSet)
    }
    const listener: Listener = (next) => setState(next)
    listenerSet.add(listener)
    setState(states.get(projectId) ?? EMPTY)

    // Load once per project rather than once per field. A later mount reuses
    // what the first one fetched.
    if (!states.has(projectId)) void refreshDocumentRoles(projectId)

    return () => {
      listenerSet.delete(listener)
      if (listenerSet.size === 0) {
        listeners.delete(projectId)
        // Drop the cache with the last subscriber so a project reopened after an
        // upload elsewhere does not start from a stale list.
        states.delete(projectId)
      }
    }
  }, [projectId])

  const refresh = useCallback(
    (options?: { afterWrite?: boolean }) => refreshDocumentRoles(projectId, options),
    [projectId]
  )
  return { ...state, refresh }
}

/** Test seam: drop everything the store holds. */
export function __resetDocumentRolesStore(): void {
  states.clear()
  listeners.clear()
  inFlight.clear()
}
