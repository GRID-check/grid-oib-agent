/**
 * What a surface adds to the answer's designed blocks, supplied from outside.
 *
 * The same inversion `InPageAnchorProvider` makes for a citation link: the
 * renderer knows Markdown and the dialect, not the chat. Two things in the
 * dialect's blocks are the chat's to draw:
 *
 *  - **a row action.** An open row of a `:::check` („offen", „zu prüfen")
 *    can be asked about: the chat puts a question built from the row's own
 *    words into the composer („Dazu fragen", `AskAboutChip`). Elsewhere (a
 *    report, the gallery) there is no composer and nothing is drawn.
 *  - **an excerpt's source.** A blockquote that ends in `[N]` is a Fundstelle
 *    excerpt; which document and section `[N]` is, and how to open it, only
 *    the answer's citation model knows. Without a provider the excerpt is drawn
 *    without its margin.
 *
 * Neither reaches copy or export: those read the Markdown, not the page.
 */

'use client'

import { createContext, useContext, type ReactNode } from 'react'

export interface RowActionProps {
  /** What the row is about: its first cell. */
  subject: string
  /** What else the row says (a remark, what is missing), joined. */
  detail: string
}

export type RowActionRenderer = (props: RowActionProps) => ReactNode

export interface ExcerptSourceProps {
  /** The citation number the excerpt ends with. */
  number: number
  /** The in-page href the citation plugin linked it to, when it did. */
  href: string | null
}

export type ExcerptSourceRenderer = (props: ExcerptSourceProps) => ReactNode

const RowActionContext = createContext<RowActionRenderer | null>(null)
const ExcerptSourceContext = createContext<ExcerptSourceRenderer | null>(null)

export const MarkdownRowActionProvider = ({ render, children }: { render: RowActionRenderer; children: ReactNode }) => (
  <RowActionContext.Provider value={render}>{children}</RowActionContext.Provider>
)

export const ExcerptSourceProvider = ({ render, children }: { render: ExcerptSourceRenderer; children: ReactNode }) => (
  <ExcerptSourceContext.Provider value={render}>{children}</ExcerptSourceContext.Provider>
)

/** The supplied row action, or null when rows carry none. */
export const useRowActionRenderer = (): RowActionRenderer | null => useContext(RowActionContext)

/** The supplied excerpt source, or null when excerpts carry no margin. */
export const useExcerptSourceRenderer = (): ExcerptSourceRenderer | null => useContext(ExcerptSourceContext)
