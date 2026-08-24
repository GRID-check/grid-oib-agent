/**
 * Who renders an in-page anchor.
 *
 * The renderer's job is markdown, not domain knowledge: it must not learn what
 * a citation is. But an in-page `[3]` in a chat answer IS a citation, and the
 * chat feature knows how to make it one — a hover preview, a target highlight,
 * a way into the document.
 *
 * So the dependency is inverted: markdown emits in-page anchors through this
 * context, and a feature that has something better to render supplies it. With
 * no provider the anchor keeps its default behaviour (scroll to the id), which
 * is what every other markdown surface in the app wants.
 */

'use client'

import { createContext, useContext, type ReactNode } from 'react'

export interface InPageAnchorProps {
  /** The `#…` href exactly as the markdown wrote it. */
  href: string
  children: ReactNode
}

export type InPageAnchorRenderer = (props: InPageAnchorProps) => ReactNode

const InPageAnchorContext = createContext<InPageAnchorRenderer | null>(null)

export const InPageAnchorProvider = ({
  render,
  children,
}: {
  render: InPageAnchorRenderer
  children: ReactNode
}) => <InPageAnchorContext.Provider value={render}>{children}</InPageAnchorContext.Provider>

/** The supplied renderer, or null when the default anchor should be used. */
export const useInPageAnchorRenderer = (): InPageAnchorRenderer | null =>
  useContext(InPageAnchorContext)

/** Scroll to an id, honouring the reader's motion preference. */
export const scrollToAnchor = (id: string): void => {
  const element = document.getElementById(id)
  if (!element) return
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'start',
  })
}
