/**
 * The readable project list, fetched once and shared by the two surfaces that
 * offer projects by name (`workspace-chat-ui.md` §4).
 *
 * `GET /api/projects` is already FGA-filtered — a project the reader cannot
 * open is never a row — which is the property that lets these surfaces render
 * names at all (ADR-0038). Extracted from `ProjectMountPicker` when the
 * Sammlungen manager needed the SAME list to say which projects a set may
 * contain: two copies of this fetch would be two answers to "which projects may
 * I name", and the drift between them would be invisible because each copy
 * looks locally correct.
 */

/** The two fields these surfaces need; `/api/projects` carries many more. */
export interface ReadableProject {
  id: string
  name: string
}

/** Rows from the same endpoint the palette and the switcher read. */
export const fetchReadableProjects = async (): Promise<ReadableProject[]> => {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error(`projects ${res.status}`)
  const rows = (await res.json()) as unknown
  if (!Array.isArray(rows)) return []
  return rows
    .filter(
      (row): row is ReadableProject =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as { id?: unknown }).id === 'string' &&
        typeof (row as { name?: unknown }).name === 'string'
    )
    .map((row) => ({ id: row.id, name: row.name }))
}
