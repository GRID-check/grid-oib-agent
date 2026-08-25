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

  const roles = rolesResponse?.ok
    ? (((await rolesResponse.json()) as { roles?: RoleBinding[] }).roles ?? [])
    : []
  const documents = documentsResponse?.ok
    ? (((await documentsResponse.json()) as { documents?: ProjectDocumentOption[] }).documents ??
      [])
    : []

  // Bindings resolve to `[]` rather than staying `null` even when the request
  // failed: a field that shows a spinner forever is worse than one that shows
  // an empty slot the user can still fill.
  publish(projectId, { bindings: roles, documents })
}

/** Refetch, coalescing concurrent callers onto one request. */
export function refreshDocumentRoles(projectId: string): Promise<void> {
  const existing = inFlight.get(projectId)
  if (existing) return existing
  const promise = load(projectId).finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, promise)
  return promise
}

export function useDocumentRoles(projectId: string): DocumentRolesState & {
  refresh: () => Promise<void>
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

  const refresh = useCallback(() => refreshDocumentRoles(projectId), [projectId])
  return { ...state, refresh }
}

/** Test seam: drop everything the store holds. */
export function __resetDocumentRolesStore(): void {
  states.clear()
  listeners.clear()
  inFlight.clear()
}
