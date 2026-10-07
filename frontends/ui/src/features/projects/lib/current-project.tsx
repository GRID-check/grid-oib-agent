'use client'

/**
 * The project a page is inside, as every surface below the project layout may
 * need it: its name and whether it is closed (ADR-0082). Provided once by the
 * project layout, from the server's own read, so a file list, a preview or a
 * chat source chip can say „abgeschlossen" without asking again.
 *
 * Null outside a project (the Archiv, the organization pages): a surface there
 * that shows project files carries the status on each row instead.
 */

import { createContext, useContext, type JSX, type ReactNode } from 'react'
import type { ProjectStatus } from '@/lib/projects/project-status'

export interface CurrentProject {
  id: string
  name: string
  status: ProjectStatus
  /** ISO timestamp; set when closed. */
  closedAt: string | null
  /** The reader holds no grant on the project and reads it only because it is closed. */
  readsBecauseClosed: boolean
}

const CurrentProjectContext = createContext<CurrentProject | null>(null)

export function CurrentProjectProvider({ value, children }: { value: CurrentProject; children: ReactNode }): JSX.Element {
  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>
}

export function useCurrentProject(): CurrentProject | null {
  return useContext(CurrentProjectContext)
}
