'use client'

/**
 * The open project's profile, as the answers in the thread bind it
 * (`:project[key]`, `:::cases{by=…}`, the Projektbezug strip).
 *
 * One fetch per project for the whole thread, not one per answer: this hook
 * renders once per message, so the profile is held in a module-level cache the
 * answers share (`useSyncExternalStore`). A profile patch the reader accepts in
 * this thread ({@link invalidateProjectFacts}) refetches it, so a value the
 * answer asked for („fehlt · ergänzen") appears in every answer at once.
 *
 * Fail-soft: without a project, or when the profile cannot be read, the
 * resolver is null and a binding prints its fact's name, never a guessed value.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { projectFactResolver, type ProjectFactResolver } from '@/lib/project-profile/answer-bindings'

type Entry = { state: 'loading' } | { state: 'ready'; resolve: ProjectFactResolver } | { state: 'failed' }

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((listener) => listener())

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function load(projectId: string): Promise<void> {
  entries.set(projectId, { state: 'loading' })
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/profile`)
    if (!response.ok) throw new Error(String(response.status))
    const data = (await response.json()) as { profile?: unknown }
    entries.set(projectId, { state: 'ready', resolve: projectFactResolver(data?.profile) })
  } catch {
    entries.set(projectId, { state: 'failed' })
  }
  notify()
}

/** Drop the cached profile, so the next render of an answer reads the new one. */
export function invalidateProjectFacts(projectId: string): void {
  if (!entries.has(projectId)) return
  void load(projectId)
}

/** Test seam: forget every cached profile. */
export const resetProjectFactsCache = (): void => {
  entries.clear()
  notify()
}

/**
 * The resolver for `projectId`'s profile, or null while it loads, when it
 * failed, or without a project. `profile`, when given, is used as is and
 * nothing is fetched (a preview, a spec).
 */
export function useProjectFacts(projectId: string | null | undefined, profile?: unknown): ProjectFactResolver | null {
  const entry = useSyncExternalStore(
    subscribe,
    () => (projectId ? entries.get(projectId) : undefined),
    () => undefined
  )
  const fetchNeeded = profile === undefined && Boolean(projectId) && entry === undefined
  useEffect(() => {
    if (fetchNeeded && projectId && !entries.has(projectId)) void load(projectId)
  }, [fetchNeeded, projectId])
  if (profile !== undefined) return fixedResolver(profile)
  return entry?.state === 'ready' ? entry.resolve : null
}

/** One resolver per given profile object, so a fixed profile keeps its identity across renders. */
const fixed = new WeakMap<object, ProjectFactResolver>()
function fixedResolver(profile: unknown): ProjectFactResolver {
  if (typeof profile !== 'object' || profile === null) return projectFactResolver(profile)
  const known = fixed.get(profile)
  if (known) return known
  const resolve = projectFactResolver(profile)
  fixed.set(profile, resolve)
  return resolve
}
