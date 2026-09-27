/**
 * A message as localStorage keeps it: the citation text capped, everything
 * else as it is. The Herleitung needs no pruning: the fold writes it in its
 * compact stored shape (`StoredThinkingStep`), with no tool input or output.
 */

import type { ChatMessage } from '../types'

const cap = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

/** Max characters of citation `content` kept in storage — a chip needs the
 * locator, and `content` is a locator. */
const MAX_CITATION_CONTENT = 300

/**
 * Max characters of the retrieved PASSAGE kept in storage.
 *
 * This bound is the reason the function exists and it nearly went missing: the
 * passage used to arrive inside `content`, so capping `content` capped it. It
 * has its own wire field now, and until this line the cap was silently defeated
 * — a forty-source deep-research turn went from roughly 12 KB of stored
 * citations to 60 KB, per conversation, against one origin's localStorage
 * budget.
 *
 * Larger than `content` because the two are different things: one labels a
 * chip, the other has to be FOUND in a document, and the matchers anchor on
 * both ends of it. Clipped to 300 the tail anchor is gone, and a reload
 * quietly demotes "the sentence is marked" to "the page is open".
 */
const MAX_CITATION_SNIPPET = 1200

export const pruneMessageForStorage = (message: ChatMessage): ChatMessage => {
  // The provenance chips survive a reload: citations are small metadata, and
  // the two free-text fields are capped so storage stays bounded.
  if (!message.citations?.length) return message
  const citations = message.citations.map((c) => {
    const content = cap(c.content, MAX_CITATION_CONTENT)
    const snippet = c.snippet && cap(c.snippet, MAX_CITATION_SNIPPET)
    return content === c.content && snippet === c.snippet ? c : { ...c, content, snippet }
  })
  return { ...message, citations }
}
