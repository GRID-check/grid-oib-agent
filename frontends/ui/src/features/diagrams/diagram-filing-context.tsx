'use client'

/**
 * Where a diagram in an answer may be filed, if anywhere.
 *
 * `MarkdownRenderer` is generic — it renders answers, saved reports, skill
 * descriptions and platform copy — so it cannot know about projects. The same
 * arrangement `slot-context` and `anchor-context` already use in that folder:
 * the SURFACE supplies the capability through a context, and the renderer
 * offers the affordance only where one was supplied.
 *
 * Absence is a normal answer, not a degraded one. A diagram in a chat outside a
 * project, in a platform page, or in a `/dev` preview simply has no filing
 * button — never a disabled one, and never one that fails when pressed. That is
 * the rule the research banner already follows for its `filed` object: a hedge
 * would be worse than silence and a dead action worse than both.
 */

import { createContext, useContext, type ReactNode } from 'react'

export interface DiagramFilingTarget {
  projectId: string
  /**
   * The identity of the ANSWER the diagram was drawn in — usually the chat
   * message id. Combined with a hash of the diagram source it becomes
   * `authored_by_run_id`, which makes filing idempotent: pressing the button
   * twice on one diagram files nothing twice, and a message holding two
   * diagrams files two.
   */
  answerId: string
  /** A human title for the file, when the surface has a better one than the source. */
  title?: string
}

const DiagramFilingContext = createContext<DiagramFilingTarget | null>(null)

export function DiagramFilingProvider({
  target,
  children,
}: {
  target: DiagramFilingTarget | null
  children: ReactNode
}) {
  return <DiagramFilingContext.Provider value={target}>{children}</DiagramFilingContext.Provider>
}

export function useDiagramFilingTarget(): DiagramFilingTarget | null {
  return useContext(DiagramFilingContext)
}

/**
 * A stable id for one diagram inside one answer.
 *
 * FNV-1a over the source, not a render-time counter: React may render a
 * component twice, out of order, or not at all, and a counter would hand the
 * same diagram a different identity on a re-render — which would file it again
 * under a new run id and produce exactly the duplicate migration 0065's index
 * exists to prevent. Two byte-identical diagrams in one answer collide on
 * purpose; they are the same picture and the office wants one file.
 *
 * Not a cryptographic hash and not pretending to be: nothing here is a
 * security boundary. Collisions across DIFFERENT sources are possible in
 * principle and cost, at worst, a second diagram in one answer refusing to file
 * separately — visible, recoverable, and not a data loss.
 */
export function diagramRunId(answerId: string, source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${answerId}-${hash.toString(16).padStart(8, '0')}`
}
