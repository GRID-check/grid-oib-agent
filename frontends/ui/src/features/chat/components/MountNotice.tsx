'use client'

/**
 * A mount, said out loud in the transcript (`workspace-chat-ui.md` §4).
 *
 * Not a `sonner` toast. The design language reserves toasts for transient
 * action failures; a mount is a durable change to what every LATER turn may
 * read, and its undo is something a reader may reach for three turns later. A
 * record belongs in the record — the same visual class as `DeepResearchBanner`
 * and `NoSourcesBanner`, with the chat-turn entrance.
 *
 * `role="status"` (polite): it reports something that already happened and must
 * not interrupt a streaming answer.
 *
 * Undo does not delete the notice. The mount HAPPENED and the transcript is a
 * history, so the notice stays and its control is replaced by the sentence
 * "… wieder ausgeblendet."
 */

import { type FC } from 'react'
import { FolderKanban, Info } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

/** Why this project is in view — the sentence changes with the answer. */
export type MountNoticeReason = 'agent' | 'user' | 'fromProject'

export interface MountNoticeProps {
  projectName: string
  by: MountNoticeReason
  /** Absent when there is nothing to undo (the mount came from the URL). */
  onUndo?: () => void
  /** The reader already undid it — the notice states that instead. */
  undone?: boolean
  /** The undo itself failed — the control stays, so a retry is one press away. */
  undoFailed?: boolean
}

const REASON_KEY: Record<MountNoticeReason, string> = {
  agent: 'workspace.mount.byAgent',
  user: 'workspace.mount.byUser',
  fromProject: 'workspace.mount.fromProject',
}

export const MountNotice: FC<MountNoticeProps> = ({
  projectName,
  by,
  onUndo,
  undone,
  undoFailed,
}) => {
  const t = useTranslations('chat')

  return (
    <Alert
      role="status"
      aria-live="polite"
      data-testid="mount-notice"
      className="animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance motion-reduce:animate-none"
    >
      <FolderKanban aria-hidden="true" />
      <AlertDescription className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground">
          {undone
            ? t('workspace.mount.undone', { project: projectName })
            : t(REASON_KEY[by], { project: projectName })}
        </span>
        {!undone && onUndo && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onUndo}
            className="h-auto p-0 text-xs"
          >
            {t('workspace.mount.undo')}
          </Button>
        )}
        {undoFailed && (
          <span className="text-muted-foreground text-xs">
            {t('workspace.mount.unavailable')}
          </span>
        )}
      </AlertDescription>
    </Alert>
  )
}

export interface MountRefusedNoticeProps {
  /** Null when the refusal never named a project (the agent guessed an id). */
  projectName?: string | null
  /** The sentence to show: no access, unknown project, or simply unavailable. */
  code: 'no_access' | 'not_found' | 'unavailable'
}

/**
 * A mount that did NOT happen. It renders exactly the three signals a mount
 * would have produced minus all of them — no chip, no tree row — plus the one
 * sentence that says why, because "the agent tried and could not" is a fact the
 * reader has to have before they trust the answer around it (§7, flow d.6).
 */
export const MountRefusedNotice: FC<MountRefusedNoticeProps> = ({ projectName, code }) => {
  const t = useTranslations('chat')
  const reason =
    code === 'no_access'
      ? t('workspace.mount.noAccess')
      : code === 'not_found'
        ? t('workspace.mount.notFound')
        : t('workspace.mount.unavailable')

  return (
    <Alert role="status" aria-live="polite" data-testid="mount-refused-notice">
      <Info aria-hidden="true" />
      <AlertDescription className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground">
          {projectName
            ? t('workspace.mount.failed', { project: projectName })
            : t('workspace.mount.unavailable')}
        </span>
        {projectName && <span className="text-muted-foreground text-xs">{reason}</span>}
      </AlertDescription>
    </Alert>
  )
}

export interface MountCapNoticeProps {
  /** The cap, as the SERVER stated it — never a client constant. */
  max: number
  /** Takes the reader to the one path that reads more than the cap allows. */
  onDeepResearch: () => void
}

/**
 * The cap, with the offer that makes it bearable.
 *
 * Rendered in the picker's footer and, when the AGENT hits it, in the
 * transcript. One component for both, because a cap that reads differently
 * depending on who ran into it is two rules.
 */
export const MountCapNotice: FC<MountCapNoticeProps> = ({ max, onDeepResearch }) => {
  const t = useTranslations('chat')
  return (
    <Alert data-testid="mount-cap-notice" className="text-xs">
      <AlertDescription className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <span>{t('workspace.cap.notice', { max })}</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onDeepResearch}
          className="h-auto p-0 text-xs"
        >
          {t('workspace.cap.deepResearch')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
