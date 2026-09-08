'use client'

/**
 * Every mount this conversation has seen, at the foot of the transcript.
 *
 * The list is a HISTORY and only ever grows within a conversation: undoing a
 * mount flips the notice to "… wieder ausgeblendet." rather than deleting it,
 * because the mount happened and a transcript that edits its own past is not a
 * record of anything (`workspace-chat-ui.md` §4).
 *
 * Bound to the same `mountNotices` the store's mount actions write, so a mount
 * by the agent (`open_project` mid-turn), by the reader (the picker) and by the
 * URL (`?mount=` from a project chat) all arrive here through one path and read
 * in one voice — only the sentence differs, and the sentence is `by`.
 *
 * The refusal is separate and NOT a history: it is a fact about the last
 * attempt, so exactly one is ever on screen, and it is cleared when the reader
 * closes the control that produced it.
 */

import { type FC } from 'react'

import { useLayoutStore } from '@/features/layout/store'
import { useChatStore } from '../store'
import { MountCapNotice, MountNotice, MountRefusedNotice } from './MountNotice'

/**
 * A stable empty list, for a store shape that does not carry the mounts slice.
 *
 * The fakes this app's component tests build are `DeepPartial<ChatStore>`, so a
 * component that reads a slice added after them fails in every one of them at
 * once. Module-level, because a fresh `[]` inside a zustand selector is a new
 * identity on every store write and would re-render this component for changes
 * it does not read.
 */
const NO_NOTICES: never[] = []

export const MountNotices: FC = () => {
  const notices = useChatStore((s) => s.mountNotices ?? NO_NOTICES)
  const refusal = useChatStore((s) => s.mountRefusal)
  const conversationId = useChatStore((s) => s.currentConversation?.id ?? null)
  const unmountProject = useChatStore((s) => s.unmountProject)
  const mountCap = useChatStore((s) => s.mountCap)
  // The offer behind the cap ARMS the existing deep-research path; it never
  // sends. The reader still owns the question, and a control that fired a turn
  // they had not finished writing would be a different promise.
  const setDeepResearchIntent = useLayoutStore((s) => s.setDeepResearchIntent)

  if (notices.length === 0 && !refusal) return null

  return (
    <div className="flex flex-col gap-2" data-testid="mount-notices">
      {notices.map((notice) => (
        <MountNotice
          key={notice.id}
          projectName={notice.projectName}
          by={notice.by}
          undone={notice.undone}
          undoFailed={notice.undoFailed}
          onUndo={
            conversationId && !notice.undone
              ? () => void unmountProject(conversationId, notice.projectId, notice.id)
              : undefined
          }
        />
      ))}
      {/* A mount that did NOT happen. The cap is the one refusal with something
          to do about it, so it keeps its own notice and its offer; the other
          three are a sentence and nothing else.

          It lands here mainly for the mount the AGENT attempted, because a
          refusal the reader caused in the picker is cleared when they close the
          tree — the picker's own footer had already said it, at the row they
          pressed. */}
      {refusal &&
        (refusal.code === 'cap' ? (
          <MountCapNotice
            max={refusal.cap ?? mountCap}
            onDeepResearch={() => setDeepResearchIntent(true)}
          />
        ) : (
          <MountRefusedNotice projectName={refusal.projectName ?? null} code={refusal.code} />
        ))}
    </div>
  )
}
