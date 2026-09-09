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
import { FolderKanban, Info, Users } from 'lucide-react'

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

export interface MountExcludedNoticeProps {
  /**
   * The participants who would lose this conversation, as the SERVER named
   * them. May be empty — the office names who it can — and the sentence has a
   * form for that.
   */
  excluded: readonly string[]
}

/**
 * The mount that was refused to protect somebody else (spec AC-8).
 *
 * Its own notice, not a `MountRefusedNotice` with a fourth code, because it is
 * the one refusal that is not about the project or the reader: the conversation
 * is SHARED, the mounted set is a property of the conversation (MT-14), and
 * mounting would answer past people who may not read it. Nothing is in the way
 * and unmounting something would not help, so it carries no offer — it carries
 * NAMES and the two things the reader can actually do.
 *
 * Until phase 5 this arrived as "could not be added right now", which was wrong
 * twice over: it is neither temporary nor about the project.
 */
export const MountExcludedNotice: FC<MountExcludedNoticeProps> = ({ excluded }) => {
  const t = useTranslations('chat')
  const people = excluded.filter((name) => name.trim() !== '')

  return (
    <Alert role="status" aria-live="polite" data-testid="mount-excluded-notice">
      <Users aria-hidden="true" />
      <AlertDescription className="flex w-full flex-col gap-0.5">
        <span className="text-foreground">
          {people.length > 0
            ? t('workspace.mount.wouldExclude', { people: people.join(', ') })
            : t('workspace.mount.wouldExcludeAnyone')}
        </span>
        <span className="text-muted-foreground text-xs">
          {t('workspace.mount.wouldExcludeHint')}
        </span>
      </AlertDescription>
    </Alert>
  )
}

export interface MountSkippedNoticeProps {
  /** Project names the Sammlung could not bring in, as the server named them. */
  names: readonly string[]
}

/**
 * What a Sammlung left behind (spec GR-2, AC-3/AC-4).
 *
 * A set mounts what it may and NAMES the rest, because a partial answer the
 * reader cannot see the edge of is the failure mode the whole scope design
 * exists against. The names here are only projects the reader may already
 * `project:view` — one they may not view at all never reaches this list, and is
 * not counted anywhere, so a Sammlung never becomes the door through which
 * somebody learns a project exists.
 *
 * Not a refusal: the rest of the set IS in view, and each member that arrived
 * has its own undoable {@link MountNotice} above this one.
 */
export const MountSkippedNotice: FC<MountSkippedNoticeProps> = ({ names }) => {
  const t = useTranslations('chat')
  if (names.length === 0) return null

  return (
    <Alert role="status" aria-live="polite" data-testid="mount-skipped-notice">
      <Info aria-hidden="true" />
      <AlertDescription>
        <span className="text-foreground">
          {t('workspace.mount.skipped', { names: names.join(', ') })}
        </span>
      </AlertDescription>
    </Alert>
  )
}

export interface MountCapNoticeProps {
  /** The cap, as the SERVER stated it — never a client constant. */
  max: number
  /** Takes the reader to the one path that reads more than the cap allows. */
  onDeepResearch: () => void
  /**
   * The Sammlung that did not fit, when one is what the reader pressed. The
   * limit is the same; the sentence names the gesture rather than making them
   * work out which of five projects was the one too many.
   */
  setName?: string | null
}

/**
 * The cap, with the offer that makes it bearable.
 *
 * Rendered in the picker's footer and, when the AGENT hits it, in the
 * transcript. One component for both, because a cap that reads differently
 * depending on who ran into it is two rules.
 */
export const MountCapNotice: FC<MountCapNoticeProps> = ({ max, onDeepResearch, setName }) => {
  const t = useTranslations('chat')
  return (
    <Alert data-testid="mount-cap-notice" className="text-xs">
      <AlertDescription className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {setName
            ? t('workspace.cap.noticeForSet', { set: setName, max })
            : t('workspace.cap.notice', { max })}
        </span>
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
