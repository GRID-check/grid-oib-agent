/**
 * Who fills a slot a remark plugin left in the document.
 *
 * The same inversion `InPageAnchorProvider` makes for a link, made for a BLOCK:
 * a plugin can decide that a run of the source stands for something the
 * renderer must not learn about — the chat's `[[card:2]]`, which stands for a
 * stair diagram — and mark that position with a slot. What actually gets drawn
 * there is supplied by the surface, so markdown keeps knowing only markdown.
 *
 * A slot is identified by an INDEX into whatever list the surface is placing;
 * with no provider (or no element at that index) it renders nothing, which is
 * the streaming case: the marker for a card can arrive several frames before
 * the card does.
 */

'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * The hast tag name a slot node becomes (`data.hName` on the mdast node).
 *
 * Deliberately a custom element name: it can never collide with a tag the
 * markdown itself produced, so a slot in the tree is always one a plugin put
 * there. Nothing reaches the DOM under this name — the component below always
 * intercepts it.
 */
export const MARKDOWN_SLOT_TAG = 'markdown-slot'

export type MarkdownSlotRenderer = (index: number) => ReactNode

const MarkdownSlotContext = createContext<MarkdownSlotRenderer | null>(null)

export const MarkdownSlotProvider = ({
  render,
  children,
}: {
  render: MarkdownSlotRenderer
  children: ReactNode
}) => <MarkdownSlotContext.Provider value={render}>{children}</MarkdownSlotContext.Provider>

/** The supplied renderer, or null when slots should render nothing. */
export const useMarkdownSlotRenderer = (): MarkdownSlotRenderer | null =>
  useContext(MarkdownSlotContext)
