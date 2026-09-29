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
import type { QuoteStamp } from '@/lib/conversations/message-quote-stamps'
import type { ProjectFactResolver } from '@/lib/project-profile/answer-bindings'

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
  /** The server's check of this quote line, when it made one: where „Stelle öffnen" lands. */
  stamp?: QuoteStamp | null
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

// ---------------------------------------------------------------------------
// What the answer knows about itself
// ---------------------------------------------------------------------------

/** One document the turn searched, for „Gesucht in" (`:::not-found`). */
export interface SearchedSource {
  title: string
  /** Where in it (a page, a Punkt), when retrieval said. */
  detail?: string
}

/**
 * What the chat knows about the answer being drawn, for the blocks that draw
 * the project's own values or the server's own record instead of the model's
 * words:
 *
 *  - **project**: `:project[key]`, `:::cases{by=…}` and the threshold ruler
 *    read the profile through it. Absent (a report, the gallery), a binding
 *    prints its fact's name and no case is marked.
 *  - **prefill**: „ergänzen" on a missing fact and „Als Aufgabe" on an action
 *    row put a sentence into the composer; they never write anything
 *    themselves (guardrail 11). Absent, neither is drawn.
 *  - **searched**: the documents the turn's retrieval ledger records, for the
 *    „Gesucht in" pane of `:::not-found`. Never the model's list.
 *  - **quoteStamps**: the server's check of each quote line.
 *  - **notRegulated**: the masthead says „Nicht geregelt"; a `:::not-found` in
 *    an answer that does not is drawn as its plain content. Undefined where
 *    nothing says either way (a preview).
 */
export interface AnswerData {
  project?: ProjectFactResolver
  prefill?: (text: string) => void
  searched?: readonly SearchedSource[]
  quoteStamps?: readonly QuoteStamp[]
  notRegulated?: boolean
}

const NO_DATA: AnswerData = {}
const AnswerDataContext = createContext<AnswerData>(NO_DATA)

/** Memoise `value` at the call site: every block of the answer reads it. */
export const AnswerDataProvider = ({ value, children }: { value: AnswerData; children: ReactNode }) => (
  <AnswerDataContext.Provider value={value}>{children}</AnswerDataContext.Provider>
)

export const useAnswerData = (): AnswerData => useContext(AnswerDataContext)
