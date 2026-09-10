'use client'

/**
 * A correction, said out loud in the transcript, with the way back (ADR-0055).
 *
 * Polarity supersession retires the old note and records `supersedes_id`. Until
 * this existed nothing read that column, so the replaced note simply vanished
 * from the panel: the correction a reader had just asked for looked exactly
 * like one that never happened, and there was nothing to undo it with. It was
 * the quietest event in the system, and it was the one a person most wanted to
 * see.
 *
 * ## The molecule is `NoticeWithUndo`, not a second one
 *
 * A mount and a supersession are the same SHAPE of fact — a durable change to
 * what later turns read, undoable minutes later — so they read in one voice
 * and share the molecule ADR-0054's mounts established. Only the glyph and the
 * sentences differ.
 *
 * ## Undo restores; it does not erase
 *
 * `POST /api/projects/:id/memory/:itemId/restore` reinstates the retired note
 * and retires the replacement, audited. The notice then states that rather than
 * disappearing: the supersession happened, and a transcript that edits its own
 * past is not a record of anything.
 */

import { useCallback, useState, type FC } from 'react'
import { Brain } from 'lucide-react'

import { useTranslations } from '@/i18n'
import { NoticeWithUndo } from './NoticeWithUndo'
import type { TurnMemoryItem } from '../lib/turn-memory'

export interface MemorySupersededNoticeProps {
  /** The note that took the earlier one's place, with what it replaced. */
  item: TurnMemoryItem & { supersedes: { id: string; content: string } }
  /**
   * The project whose memory this happened in. Without one there is no restore
   * route to call, so the notice states the correction and offers no undo —
   * which is still strictly more than the reader had before.
   */
  projectId?: string | null
}

export const MemorySupersededNotice: FC<MemorySupersededNoticeProps> = ({ item, projectId }) => {
  const t = useTranslations('chat')
  const [state, setState] = useState<'idle' | 'pending' | 'undone' | 'failed' | 'stale'>('idle')

  const handleUndo = useCallback(async () => {
    if (!projectId) return
    setState('pending')
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(item.supersedes.id)}/restore`,
        { method: 'POST' }
      )
      // `409` is not a failure of the request, it is a statement about the
      // pair: the note is already back, or another writer moved it between the
      // page load and this press. Saying "that could not be undone" there would
      // invite a second press at a store that is already in the asked-for
      // state, so it gets its own sentence.
      setState(res.ok ? 'undone' : res.status === 409 ? 'stale' : 'failed')
    } catch {
      setState('failed')
    }
  }, [projectId, item.supersedes.id])

  return (
    <NoticeWithUndo
      icon={Brain}
      testId="memory-superseded-notice"
      undoLabel={t('memory.superseded.undo')}
      onUndo={
        projectId && state !== 'undone' && state !== 'stale' ? () => void handleUndo() : undefined
      }
      pending={state === 'pending'}
      failureText={
        state === 'failed'
          ? t('memory.superseded.undoFailed')
          : state === 'stale'
            ? t('memory.superseded.undoStale')
            : undefined
      }
      detail={
        <>
          {/* Both halves, always. "Piloti replaced a note" without the two
              sentences is a report a reader cannot check, and checking it is
              the entire reason the event is stated. */}
          <span className="block">{t('memory.superseded.replaced', { content: item.supersedes.content })}</span>
          <span className="block">{t('memory.superseded.replaces', { content: item.content })}</span>
        </>
      }
    >
      {state === 'undone' ? t('memory.superseded.undone') : t('memory.superseded.notice')}
    </NoticeWithUndo>
  )
}

export interface MemorySupersededNoticesProps {
  /** This turn's memory items; only the ones that replaced something render. */
  items: readonly TurnMemoryItem[]
  projectId?: string | null
}

/** Every supersession this turn produced, in the order it produced them. */
export const MemorySupersededNotices: FC<MemorySupersededNoticesProps> = ({
  items,
  projectId,
}) => {
  const superseding = items.filter(
    (item): item is TurnMemoryItem & { supersedes: { id: string; content: string } } =>
      item.supersedes != null
  )
  if (superseding.length === 0) return null

  return (
    <div className="flex w-full flex-col gap-2" data-testid="memory-superseded-notices">
      {superseding.map((item) => (
        <MemorySupersededNotice key={item.id} item={item} projectId={projectId} />
      ))}
    </div>
  )
}
