/**
 * Which OTHER projects a chat's answers drew on (ADR-0085): the projects named
 * by the sources of its messages. What the cross-project notice lists, so the
 * reader sees the chat left its project before it tries to share it.
 *
 * Read off the sources the reader can see, not off the BFF's record: the record
 * also holds projects a listing only named, and the share refusal is where that
 * part is said.
 */

import type { ChatMessage, CitationProject } from '../types'

/** The distinct other projects named by these messages' sources, in order of first appearance. */
export const otherProjectsOf = (messages: readonly ChatMessage[]): CitationProject[] => {
  const seen = new Map<string, CitationProject>()
  for (const message of messages) {
    for (const citation of message.citations ?? []) {
      const project = citation.project
      if (project && !seen.has(project.id)) seen.set(project.id, project)
    }
  }
  return [...seen.values()]
}
