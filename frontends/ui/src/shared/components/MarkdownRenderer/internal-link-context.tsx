/**
 * Who renders an in-app link.
 *
 * Same inversion as `anchor-context`, one level out. Markdown's default for any
 * non-anchor href is `target="_blank" rel="noopener"` — correct for the web,
 * wrong for `/app/projects/…`, which would leave the app to re-enter it in a new
 * tab with a cold store.
 *
 * And a surface that knows what an in-app link MEANS can do better still: a
 * chat answer that links to `/app/projects/:id/model?element=1kTv…` is naming a
 * wall, and rendering it as a chip that opens the viewer on that wall is the
 * difference between an answer you read and one you can walk into.
 *
 * With no provider, internal links fall back to a same-tab anchor — which is
 * what every other markdown surface wants and still better than a new tab.
 */

'use client'

import { createContext, useContext, type ReactNode } from 'react'

export interface InternalLinkProps {
  /** The href exactly as the markdown wrote it — always same-origin/relative. */
  href: string
  children: ReactNode
}

export type InternalLinkRenderer = (props: InternalLinkProps) => ReactNode

const InternalLinkContext = createContext<InternalLinkRenderer | null>(null)

export const InternalLinkProvider = ({
  render,
  children,
}: {
  render: InternalLinkRenderer
  children: ReactNode
}) => <InternalLinkContext.Provider value={render}>{children}</InternalLinkContext.Provider>

/** The supplied renderer, or null when the default same-tab anchor should be used. */
export const useInternalLinkRenderer = (): InternalLinkRenderer | null =>
  useContext(InternalLinkContext)

/**
 * Is this href a link back into this app?
 *
 * Root-relative paths only. A protocol-relative `//evil.example` is NOT
 * internal, which is the whole reason this is a shared helper and not an
 * inline `startsWith('/')` — an answer is model output, and model output is
 * where a link that merely looks internal comes from.
 */
export const isInternalHref = (href: string | undefined): href is string =>
  typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')
