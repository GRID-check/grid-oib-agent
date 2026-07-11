'use client'

/**
 * "Resume where you left off" — per-project last-visited section memory.
 *
 * Opening a project should land the user in the section they last used for
 * THAT project (yesterday's context), like a native app restoring workspace
 * state, instead of always dumping them on Overview.
 *
 * The app has no per-user preferences backend for this ephemeral UI state, so
 * the map lives in localStorage, keyed by project id. SSR-safe: the server
 * snapshot is always the Overview root (reads only touch `window` on the
 * client), so resume is a post-mount enhancement that never causes a
 * hydration mismatch and never hijacks a direct deep link.
 */

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

/** localStorage key holding the `{ [projectId]: section }` map. */
export const LAST_SECTION_STORAGE_KEY = 'grid.project.last-section'

/**
 * Sections we are willing to remember. `overview` is the project root; the
 * rest are real path segments. Anything outside this set (unknown/renamed
 * routes) is ignored so we never store — or resume into — a garbage segment.
 */
export const KNOWN_PROJECT_SECTIONS = [
  'overview',
  'chat',
  'files',
  'research',
  'members',
  'intake',
] as const

export type ProjectSection = (typeof KNOWN_PROJECT_SECTIONS)[number]

function isKnownSection(value: string): value is ProjectSection {
  return (KNOWN_PROJECT_SECTIONS as readonly string[]).includes(value)
}

/**
 * Derive the current project section from a pathname, or `null` if the
 * pathname is not under this project (so we never record cross-project noise).
 * Query strings are irrelevant — `usePathname` already excludes them.
 */
export function sectionFromPathname(pathname: string, projectId: string): ProjectSection | null {
  const base = `/app/projects/${projectId}`
  if (pathname === base || pathname === `${base}/`) return 'overview'
  if (!pathname.startsWith(`${base}/`)) return null
  const segment = pathname.slice(base.length + 1).split('/')[0]
  return isKnownSection(segment) ? segment : null
}

/**
 * Build the destination href for a project. Overview (or no memory) resolves
 * to the bare project root — the current default behavior.
 */
export function buildProjectHref(projectId: string, section: ProjectSection | null): string {
  const base = `/app/projects/${projectId}`
  return section && section !== 'overview' ? `${base}/${section}` : base
}

type SectionMap = Record<string, string>

function readMap(): SectionMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(LAST_SECTION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SectionMap) : {}
  } catch {
    // Storage unavailable (privacy mode) or corrupt JSON — behave as if empty.
    return {}
  }
}

function writeMap(map: SectionMap): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_SECTION_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable — fail soft; resume simply won't persist.
  }
}

/** Read the remembered section for a project, or `null` if none/invalid. */
export function readLastProjectSection(projectId: string): ProjectSection | null {
  const value = readMap()[projectId]
  return typeof value === 'string' && isKnownSection(value) ? value : null
}

/** Remember the section the user is currently on for this project. */
export function writeLastProjectSection(projectId: string, section: ProjectSection): void {
  const map = readMap()
  if (map[projectId] === section) return
  map[projectId] = section
  writeMap(map)
}

/**
 * Drop remembered sections for projects that no longer exist, so stale entries
 * for deleted projects don't accumulate. Given the set of currently-valid
 * project ids; a no-op when nothing needs removing.
 */
export function pruneProjectSections(validProjectIds: readonly string[]): void {
  const map = readMap()
  const valid = new Set(validProjectIds)
  let changed = false
  for (const id of Object.keys(map)) {
    if (!valid.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) writeMap(map)
}

/**
 * Record the current project section as navigation happens. Mount this once in
 * the project shell (the sidebar) — it derives the section from the pathname
 * and persists it, including an explicit Overview visit (so resume never traps
 * the user fighting to reach Overview).
 */
export function useRecordProjectSection(projectId: string): void {
  const pathname = usePathname() ?? ''
  useEffect(() => {
    const section = sectionFromPathname(pathname, projectId)
    if (section) writeLastProjectSection(projectId, section)
  }, [pathname, projectId])
}

/**
 * Resolve the project href for an entry point (project card / switcher) that
 * should honor "resume where you left off".
 *
 * Starts at the bare project root — matching the server render, so there is no
 * hydration mismatch — and, after mount, upgrades to the remembered section if
 * one exists. Because it stays a real anchor href, prefetch and modifier-click
 * (open-in-new-tab) keep working, and direct deep links are untouched since
 * they never pass through this hook.
 */
export function useResumeProjectHref(projectId: string): string {
  const [href, setHref] = useState(() => buildProjectHref(projectId, null))
  useEffect(() => {
    setHref(buildProjectHref(projectId, readLastProjectSection(projectId)))
  }, [projectId])
  return href
}
