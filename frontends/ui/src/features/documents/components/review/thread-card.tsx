'use client'

import { forwardRef, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  ArrowUp,
  CalendarClock,
  Check,
  CircleHelp,
  History,
  Link2,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  Scale,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldError } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import {
  ANNOTATION_KINDS,
  isLive,
  MAX_ANNOTATION_BODY,
  type AnnotationKind,
  type AnnotationView,
  type PilotiWakeTrigger,
} from '@/lib/annotations/types'
import { wakeTurnId } from '@/lib/annotations/wake-ids'
import { cn } from '@/lib/utils'
import { liveLine } from '@/features/chat/lib/turn-events'
import type { FileAssignee } from '../../file-types'
import { askRegionOf, stepsOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import { answerAsBody } from '../../lib/piloti-answer-text'
import type { DocumentReview, ReviewDraft } from '../../hooks/use-document-review'
import { AssignPopover } from '../assign-popover'
import { usePilotiByline } from './piloti-attribution'
import type { CardSide } from './review-page-layer'

export const KIND_ICONS: Record<AnnotationKind, typeof TriangleAlert> = {
  hint: MessageSquareText,
  question: CircleHelp,
  defect: TriangleAlert,
}

const day = (value: string, locale: string) => formatDayRange(value, value, locale)

/** One message in a thread: who, when, what. Piloti speaks with its glyph, never a person's face. */
function Message({
  authorKind,
  name,
  userId,
  at,
  body,
  proposal,
  woken,
}: {
  authorKind: 'person' | 'piloti'
  name: string | null
  userId: string
  at: string
  body: string
  /** Piloti's finding nobody has taken over: it says so in its byline. */
  proposal?: boolean
  /** The reply was written by a turn an event woke, and where (`number` of the Anmerkung). */
  woken?: { trigger: PilotiWakeTrigger; number: number } | null
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const byline = usePilotiByline()
  const wokenTitle = woken
    ? name
      ? t('review.attribution.wokenTitle', { name, number: woken.number })
      : t('review.attribution.wokenTitleNameless', { number: woken.number })
    : undefined
  return (
    <div className="flex gap-2.5">
      {authorKind === 'piloti' ? (
        <PilotiGlyph />
      ) : (
        <PersonAvatar
          size="sm"
          className="size-6 text-[10px]"
          person={{ userId, name: name ?? t('review.someone'), profilePictureUrl: null }}
        />
      )}
      <div className="min-w-0 flex-1">
        {/* The name gives way, the time never wraps: „2 hours ago" on two lines reads as two facts. */}
        <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
          <span
            className="text-foreground min-w-0 truncate font-semibold"
            data-testid={authorKind === 'piloti' ? 'thread-byline' : undefined}
            title={authorKind === 'piloti' ? byline(name, { proposal }) : (name ?? undefined)}
          >
            {authorKind === 'piloti' ? byline(name, { proposal }) : (name ?? t('review.someone'))}
          </span>
          <TimeAgo date={at} locale={locale} className="text-muted-foreground shrink-0 whitespace-nowrap" />
        </p>
        {woken && (
          <p className="text-muted-foreground text-[11px] leading-4" title={wokenTitle} data-testid="thread-woken">
            {t(`review.attribution.woken.${woken.trigger}`)}
          </p>
        )}
        <p className="text-foreground mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap">{body}</p>
      </div>
    </div>
  )
}

/** Whether the text before the caret ends in an „@" word that could still become „@Piloti". */
function mentionQuery(text: string, caret: number): { start: number } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null
  const query = before.slice(at + 1)
  return /^\p{L}*$/u.test(query) && 'piloti'.startsWith(query.toLowerCase()) ? { start: at } : null
}

/**
 * The reply box and the draft box: Enter sends, Shift+Enter breaks the line,
 * Escape lets go.
 *
 * `onAskPiloti`: a second way out, the text handed to Piloti instead
 * (⌘/Ctrl+Enter, or the spark beside Send). `mentionPiloti`: Piloti can be
 * brought into the thread. Typing „@" offers it, and taking the offer (or the
 * spark) puts a chip in the box: the mention is that chip, a fact the box
 * holds, never a pattern read out of the text.
 */
export function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onEscape,
  onAskPiloti,
  mentionPiloti,
  maxLength = MAX_ANNOTATION_BODY,
  testId,
}: {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (body: string, options: { piloti: boolean }) => Promise<unknown>
  onEscape?: () => void
  onAskPiloti?: (body: string) => void
  mentionPiloti?: boolean
  maxLength?: number
  testId: string
}): JSX.Element {
  const t = useTranslations('files')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [mentioned, setMentioned] = useState(false)
  const [suggest, setSuggest] = useState<{ start: number } | null>(null)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // Grow with the text, up to a handful of lines, then scroll.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`
  }, [body])

  const submit = async () => {
    if (!body.trim() || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit(body, { piloti: mentioned })
      setBody('')
      setMentioned(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  /** Take the „@…" offer: the typed word goes, the chip comes. */
  const takeMention = () => {
    const node = ref.current
    if (suggest && node) {
      const caret = node.selectionStart ?? body.length
      setBody(body.slice(0, suggest.start) + body.slice(caret))
    }
    setSuggest(null)
    setMentioned(true)
    node?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (suggest && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault()
      takeMention()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onAskPiloti) {
      event.preventDefault()
      onAskPiloti(body.trim())
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape') {
      if (suggest) {
        event.stopPropagation()
        setSuggest(null)
        return
      }
      if (onEscape) {
        event.stopPropagation()
        onEscape()
      }
    }
  }

  const pilotiButton = onAskPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 rounded-full [&_svg]:size-3.5"
      aria-label={t('review.piloti.ask')}
      title={`${t('review.piloti.ask')} (⌘↵)`}
      data-testid={`${testId}-piloti`}
      onClick={() => onAskPiloti(body.trim())}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : mentionPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-6 shrink-0 rounded-full [&_svg]:size-3.5', mentioned && 'bg-accent text-foreground')}
      aria-label={t('review.piloti.mention')}
      aria-pressed={mentioned}
      title={t('review.piloti.mentionHint')}
      data-testid={`${testId}-mention`}
      onClick={() => setMentioned((on) => !on)}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : null

  return (
    <div className="relative">
      <div className="bg-input-background focus-within:border-foreground/40 rounded-lg border px-2.5 py-1.5 transition-colors duration-quick ease-out">
        {mentioned && (
          <Chip size="sm" variant="secondary" className="mb-1 gap-1 pr-1" data-testid={`${testId}-mention-chip`}>
            <Sparkles aria-hidden />
            @Piloti
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground rounded-sm"
              aria-label={t('review.piloti.mentionRemove')}
              onClick={() => setMentioned(false)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </Chip>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={ref}
            data-testid={testId}
            aria-label={placeholder}
            aria-autocomplete={mentionPiloti ? 'list' : undefined}
            rows={1}
            value={body}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => {
              setBody(event.target.value)
              if (mentionPiloti && !mentioned) {
                setSuggest(mentionQuery(event.target.value, event.target.selectionStart ?? event.target.value.length))
              }
            }}
            onBlur={() => setSuggest(null)}
            onKeyDown={onKeyDown}
            className="placeholder:text-muted-foreground min-h-6 flex-1 resize-none border-0 bg-transparent py-0.5 text-[13px] leading-5 shadow-none outline-none! ring-0 focus-visible:ring-0"
          />
          {pilotiButton}
          <Button
            type="button"
            size="icon"
            className="size-6 shrink-0 rounded-full [&_svg]:size-3.5"
            disabled={!body.trim() || busy}
            aria-label={submitLabel}
            title={`${submitLabel} (Enter)`}
            data-testid={`${testId}-send`}
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </div>
      {suggest && (
        <div
          role="listbox"
          aria-label={t('review.piloti.mention')}
          className="bg-popover border-border/70 absolute top-full left-0 z-10 mt-1 w-56 rounded-lg border p-1 shadow-md"
        >
          <button
            type="button"
            role="option"
            aria-selected
            data-testid={`${testId}-mention-option`}
            // Before the textarea's blur closes the offer.
            onPointerDown={(event) => {
              event.preventDefault()
              takeMention()
            }}
            className="bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
          >
            <PilotiGlyph size="xs" />
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-semibold">Piloti</span>
              <span className="text-muted-foreground block text-[11px] leading-4">{t('review.piloti.mentionHint')}</span>
            </span>
          </button>
        </div>
      )}
      {failed && <FieldError className="mt-1">{t('review.sendFailed')}</FieldError>}
    </div>
  )
}

/**
 * A chip for who is on it and by when: quiet (dashed, muted) until set, then
 * the fact itself in ink on a solid edge. `onClear` puts the way to unset it
 * INSIDE the chip, so the × reads as part of the fact it removes.
 */
const MetaChip = forwardRef<
  HTMLButtonElement,
  {
    icon: typeof UserRound
    tone?: 'urgent'
    set?: boolean
    onClear?: () => void
    clearLabel?: string
    children: React.ReactNode
  } & React.ComponentProps<'button'>
>(function MetaChip({ icon: Icon, children, tone, set, onClear, clearLabel, ...props }, ref) {
  return (
    <span
      data-set={set || undefined}
      className={cn(
        'border-border/80 text-muted-foreground inline-flex h-6 max-w-full items-center rounded-full border text-[11px] font-medium transition-colors duration-quick ease-out',
        !set && 'border-dashed',
        set && 'bg-secondary text-foreground border-transparent',
        // Overdue is ink and weight, not gold: gold is the Büroablage's colour.
        tone === 'urgent' && 'text-foreground border-foreground/50 border-solid font-semibold'
      )}
    >
      <button
        ref={ref}
        type="button"
        className={cn(
          'hover:text-foreground inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none',
          onClear ? 'pr-1' : 'pr-2'
        )}
        {...props}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{children}</span>
      </button>
      {onClear && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={clearLabel}
          onClick={onClear}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  )
})

/** Who is on it and by when, editable while the reader may write. */
function ResponsibilityRow({
  documentId,
  assigneeName,
  dueOn,
  editable,
  canPickAssignee,
  onAssignee,
  onDueOn,
}: {
  documentId: string
  assigneeName: string | null
  dueOn: string | null
  editable: boolean
  canPickAssignee: boolean
  onAssignee: (person: FileAssignee | null) => void
  onDueOn: (day: string | null) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const dateRef = useRef<HTMLInputElement | null>(null)
  const overdue = dueOn !== null && dueOn < localCalendarDay()
  if (!editable && !assigneeName && !dueOn) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canPickAssignee && editable ? (
        <AssignPopover
          documentId={documentId}
          assignees={[]}
          pickOnly
          onPick={onAssignee}
          onChanged={() => undefined}
          trigger={
            <MetaChip
              icon={UserRound}
              data-testid="thread-assignee"
              set={Boolean(assigneeName)}
              onClear={assigneeName ? () => onAssignee(null) : undefined}
              clearLabel={t('review.unassign')}
            >
              {assigneeName ?? t('review.assign')}
            </MetaChip>
          }
        />
      ) : (
        assigneeName && (
          <MetaChip
            icon={UserRound}
            disabled={!editable}
            set
            onClear={editable ? () => onAssignee(null) : undefined}
            clearLabel={t('review.unassign')}
          >
            {assigneeName}
          </MetaChip>
        )
      )}
      <span className="relative inline-flex">
        <MetaChip
          icon={CalendarClock}
          set={dueOn !== null}
          tone={overdue ? 'urgent' : undefined}
          disabled={!editable}
          onClick={() => dateRef.current?.showPicker?.()}
        >
          {dueOn ? `${t('review.due')} ${day(dueOn, locale)}${overdue ? ` · ${t('review.overdue')}` : ''}` : t('review.setDue')}
        </MetaChip>
        {editable && (
          <input
            ref={dateRef}
            type="date"
            aria-label={t('review.due')}
            value={dueOn ?? ''}
            onChange={(event) => onDueOn(event.target.value || null)}
            className="pointer-events-none absolute inset-0 opacity-0"
            tabIndex={-1}
          />
        )}
      </span>
    </div>
  )
}

/**
 * The three kinds as one quiet segmented row: three buttons, the one in force
 * pressed, each reached by Tab (a radio group would owe arrow keys).
 */
function KindPicker({ value, onChange }: { value: AnnotationKind; onChange: (kind: AnnotationKind) => void }) {
  const t = useTranslations('files')
  return (
    <div role="group" aria-label={t('annotations.kind')} className="bg-muted inline-flex rounded-md p-0.5">
      {ANNOTATION_KINDS.map((kind) => {
        const Icon = KIND_ICONS[kind]
        const on = kind === value
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            data-testid={`thread-kind-${kind}`}
            onClick={() => onChange(kind)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-[5px] px-2 text-[11px] font-medium transition-colors duration-quick ease-out',
              on ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3" aria-hidden />
            {t(`annotations.kinds.${kind}`)}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Where a card is shown: beside or under its mark on the sheet
 * ({@link CardSide}, decided by `placeCard`), `detached` from the sheet (a
 * mark of an earlier Fassung, which is not drawn), or `docked` in the phone's
 * bottom sheet, which is its frame.
 */
export type CardPlacement = CardSide | 'detached' | 'docked'

const PLACEMENT_CLASSES: Record<Exclude<CardPlacement, 'docked'>, string> = {
  right: 'absolute top-0 left-4 origin-top-left',
  left: 'absolute top-0 right-4 origin-top-right',
  below: 'absolute top-3 left-0 origin-top-left',
  detached: 'relative origin-top',
}

/** The hairline from the mark's edge to its card: which mark this is about, without the card sitting on it. */
const HAIRLINE_CLASSES: Partial<Record<CardPlacement, string>> = {
  right: 'top-3.5 -left-4 h-px w-4',
  left: 'top-3.5 -right-4 h-px w-4',
  below: '-top-3 left-3.5 h-3 w-px',
}

/**
 * The card's frame: a floating sheet beside its mark, on the side with room; or
 * the content of the phone's sheet. A dialog named by its own header
 * (`labelledBy`, the id of the line that says what it is about) or, where it
 * has none, by `label`. `data-review-card` is how the review finds it, and it
 * takes the focus itself (`tabIndex={-1}`) when the keyboard opened it.
 */
export function ReviewCard({
  placement,
  children,
  testId,
  labelledBy,
  label,
}: {
  placement: CardPlacement
  children: React.ReactNode
  testId: string
  labelledBy?: string
  label?: string
}) {
  if (placement === 'docked') {
    return (
      <div
        data-testid={testId}
        data-placement="docked"
        data-review-card
        tabIndex={-1}
        className="text-popover-foreground w-full outline-none"
      >
        {children}
      </div>
    )
  }
  const hairline = HAIRLINE_CLASSES[placement]
  return (
    <div
      data-testid={testId}
      data-placement={placement}
      data-review-card
      role="dialog"
      tabIndex={-1}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={cn(
        'focus-visible:ring-ring/60 outline-none focus-visible:ring-2',
        'bg-popover text-popover-foreground border-border/70 animate-in fade-in-0 zoom-in-95 duration-base ease-entrance motion-reduce:animate-none w-[20rem] rounded-xl border shadow-xl',
        PLACEMENT_CLASSES[placement]
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {hairline && <span aria-hidden className={cn('bg-foreground/40 absolute', hairline)} />}
      {children}
    </div>
  )
}

/**
 * Piloti, brought into a thread by a question this tab asked it itself (the
 * organization lets no events wake it): answering, or not able to, with a way
 * to ask again. An answer whose thread target never reached the server stays
 * here, to be added to the thread by hand.
 */
function PilotiThreadRow({ ask, review }: { ask: CanvasAsk; review: DocumentReview }): JSX.Element {
  const t = useTranslations('files')
  const tChat = useTranslations('chat')
  const [adopting, setAdopting] = useState(false)
  const [adoptFailed, setAdoptFailed] = useState(false)
  const line = liveLine(stepsOf(ask.view), tChat) ?? t('review.piloti.replying')
  const close = (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground ml-auto shrink-0 self-start rounded p-0.5"
      aria-label={t('review.piloti.close')}
      onClick={() => review.piloti.dismiss(ask.id)}
    >
      <X className="size-3" aria-hidden />
    </button>
  )
  if (ask.status === 'answered' && ask.annotationId && ask.view?.text) {
    const annotationId = ask.annotationId
    const body = answerAsBody(ask.view.text)
    return (
      <div className="flex gap-2.5" data-testid="thread-piloti-unposted" role="status">
        <PilotiGlyph />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-muted-foreground text-[11px] leading-4">{t('review.piloti.degradedThread')}</p>
          <p className="text-foreground text-sm leading-5 break-words whitespace-pre-line">{body}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={adopting}
            onClick={async () => {
              setAdopting(true)
              setAdoptFailed(false)
              try {
                await review.reply(annotationId, body)
                review.piloti.dismiss(ask.id)
              } catch {
                // A full thread, a conflict or the network: the answer stays here to add again.
                setAdoptFailed(true)
              } finally {
                setAdopting(false)
              }
            }}
          >
            {t('review.piloti.adoptReply')}
          </Button>
          {adoptFailed && <FieldError>{t('review.actionFailed')}</FieldError>}
        </div>
        {close}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5" data-testid="thread-piloti-pending" role="status">
      <PilotiGlyph working={ask.status === 'thinking'} />
      {ask.status === 'thinking' ? (
        <ShimmerText className="min-w-0 flex-1 text-xs">{line}</ShimmerText>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('review.piloti.replyFailed')}</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => review.piloti.retry(ask.id)}>
            {t('review.piloti.retry')}
          </Button>
          {close}
        </span>
      )}
    </div>
  )
}

/**
 * Piloti at work in this thread as the SERVER knows it (`pilotiWork`, read off
 * the mark's wake): the same line for everyone in the room, after a reload too.
 * A delegation already says „Piloti arbeitet daran" in its chip, so only how it
 * ended is said here.
 */
function PilotiWorkRow({ annotation }: { annotation: AnnotationView }): JSX.Element | null {
  const t = useTranslations('files')
  const work = annotation.pilotiWork
  if (!work) return null
  const delegated = work.trigger === 'assigned'
  if (delegated && (work.state === 'queued' || work.state === 'working')) return null
  const name = work.forName ?? t('review.someone')
  if (work.state === 'failed') {
    return (
      <div className="flex items-start gap-2.5" data-testid="thread-piloti-work" data-state={work.state} role="status">
        <PilotiGlyph />
        <span className="text-muted-foreground min-w-0 flex-1 text-xs leading-5">
          {t(`review.piloti.workFailed.${work.reasonKind ?? 'error'}`, { name })}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5" data-testid="thread-piloti-work" data-state={work.state} role="status">
      <PilotiGlyph working={work.state !== 'held'} />
      {work.state === 'held' ? (
        <span className="text-muted-foreground min-w-0 flex-1 text-xs">{t('review.piloti.wakeHeld')}</span>
      ) : (
        <ShimmerText className="min-w-0 flex-1 text-xs">
          {t(work.state === 'queued' ? 'review.piloti.workQueued' : 'review.piloti.replyingFor', { name })}
        </ShimmerText>
      )}
    </div>
  )
}

/** Setting a new mark: what kind, what is there, optionally who and by when. */
export function DraftCard({
  review,
  draft,
  placement,
  canPickAssignee,
}: {
  review: DocumentReview
  draft: ReviewDraft
  placement: CardPlacement
  canPickAssignee: boolean
}): JSX.Element {
  const t = useTranslations('files')
  const [kind, setKind] = useState<AnnotationKind>('hint')
  const [assignee, setAssignee] = useState<FileAssignee | null>(null)
  const [dueOn, setDueOn] = useState<string | null>(null)
  const { piloti } = review
  /** The draft's place handed to Piloti: asked at once with what was typed, or a card waiting for the question. */
  const askPiloti = piloti.available
    ? (body: string) => {
        const region = askRegionOf(draft)
        if (body) piloti.ask({ text: body, region })
        else piloti.compose(region)
      }
    : undefined
  return (
    <ReviewCard placement={placement} testId="review-draft" label={t('review.draftCard')}>
      <div className="space-y-3 p-3">
        <KindPicker value={kind} onChange={setKind} />
        <Composer
          autoFocus
          testId="review-draft-body"
          placeholder={t('review.draftPlaceholder')}
          submitLabel={t('review.set')}
          onEscape={() => review.setDraft(null)}
          onAskPiloti={askPiloti}
          onSubmit={(body) =>
            review.create({ kind, body, assigneeUserId: assignee?.userId ?? null, dueOn })
          }
        />
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeName={assignee ? assignee.name || assignee.email || assignee.userId : null}
          dueOn={dueOn}
          editable
          canPickAssignee={canPickAssignee}
          onAssignee={setAssignee}
          onDueOn={setDueOn}
        />
      </div>
    </ReviewCard>
  )
}

/** One mark's thread: the finding, the conversation, the decision, and who is on it. */
export function ThreadCard({
  review,
  annotation,
  placement,
  canPickAssignee,
  onCopyLink,
  walk,
}: {
  review: DocumentReview
  annotation: AnnotationView
  placement: CardPlacement
  canPickAssignee: boolean
  onCopyLink?: (annotation: AnnotationView) => void
  /** Going through Piloti's proposals: where this one stands among them, and the way to the next. */
  walk?: { index: number; total: number; onNext: () => void } | null
}): JSX.Element {
  const t = useTranslations('files')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const headerId = useId()
  const KindIcon = KIND_ICONS[annotation.kind]
  const proposed = annotation.status === 'proposed'
  const live = isLive(annotation)
  const { piloti } = review
  const pilotiReplies = annotation.replies.filter((reply) => reply.authorKind === 'piloti').length
  // Piloti was brought into this thread by this tab and has not answered in it yet,
  // or answered without the thread target reaching it (its answer is only here).
  const threadAsk = piloti.asks.find(
    (ask) =>
      ask.replyInThread &&
      ask.annotationId === annotation.id &&
      (ask.status === 'failed' ||
        ask.status === 'declined' ||
        (ask.status === 'answered' && ask.degraded.includes('thread')) ||
        (ask.status === 'thinking' && pilotiReplies <= ask.baseline))
  )

  /**
   * The reply goes in as the person's own. With @Piloti it says so (a flag,
   * never the text), and the server answers whether it wakes Piloti itself
   * (`queued`, or `suppressed` when a cap held it): then the mark's own view
   * says how Piloti's work stands (`pilotiWork`), for everyone. With the
   * organization's switch off, this tab asks Piloti as before, under the turn
   * id a server wake of the same reply would use, so the two never both run.
   */
  const sendReply = async (body: string, { piloti: mentioned }: { piloti: boolean }) => {
    const { wake, replyId } = await review.reply(annotation.id, body, { addressesPiloti: mentioned })
    if (!mentioned || wake === 'queued' || wake === 'suppressed' || !piloti.available) return
    piloti.ask({
      text: body.trim(),
      region: askRegionOf(annotation),
      annotationId: annotation.id,
      replyInThread: true,
      baseline: pilotiReplies,
      ...(replyId ? { turnId: wakeTurnId(replyId) } : {}),
    })
  }

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setFailed(false)
    try {
      await run()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  // The status this card shows goes with the move: a tab that missed a colleague's
  // move gets a 409 and the fresh list, never an act on a state it did not see.
  const move = (status: 'open' | 'resolved' | 'dismissed') =>
    act(() => review.update(annotation.id, { status, expectedStatus: annotation.status }))

  const menu: ActionMenuEntry[] = [
    ...ANNOTATION_KINDS.filter((kind) => kind !== annotation.kind && annotation.canEdit).map((kind) => ({
      type: 'item' as const,
      id: `kind-${kind}`,
      label: t('review.makeKind', { kind: t(`annotations.kinds.${kind}`) }),
      icon: KIND_ICONS[kind],
      onSelect: () => void act(() => review.update(annotation.id, { kind })),
    })),
    ...(piloti.available && annotation.onCurrentFassung
      ? [
          {
            type: 'item' as const,
            id: 'ask',
            label: t('review.askPiloti'),
            icon: Sparkles,
            onSelect: () => void piloti.compose(askRegionOf(annotation), { annotationId: annotation.id }),
          },
        ]
      : []),
    // Piloti as the delegate (ADR-0105): the mark keeps its assignee, Piloti
    // works it for this person, woken by the server. Only an open mark.
    ...(review.pilotiWakes && annotation.canEdit && annotation.status === 'open'
      ? [
          {
            type: 'item' as const,
            id: 'delegate',
            label: annotation.delegatedBy ? t('review.takeBackFromPiloti') : t('review.delegateToPiloti'),
            icon: annotation.delegatedBy ? Undo2 : Sparkles,
            onSelect: () =>
              void act(() => review.update(annotation.id, { delegateToPiloti: !annotation.delegatedBy })),
          },
        ]
      : []),
    ...(onCopyLink
      ? [{ type: 'item' as const, id: 'link', label: t('review.copyLink'), icon: Link2, onSelect: () => onCopyLink(annotation) }]
      : []),
    ...(annotation.canDelete
      ? [
          { type: 'separator' as const },
          {
            type: 'item' as const,
            id: 'delete',
            label: t('review.delete'),
            icon: Trash2,
            variant: 'destructive' as const,
            onSelect: () => setConfirmDelete(true),
          },
        ]
      : []),
  ]

  return (
    <ReviewCard placement={placement} testId="review-thread" labelledBy={headerId}>
      {!annotation.onCurrentFassung && (
        // Said inside the card, as its first line: the card is all the reader looks at.
        <p className="text-muted-foreground bg-muted/40 flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px] leading-4" data-testid="thread-earlier">
          <History className="mt-px size-3 shrink-0" aria-hidden />
          {annotation.fassungNumber
            ? t('review.earlierFassung', { number: annotation.fassungNumber })
            : t('annotations.earlierFassungUnnumbered')}
        </p>
      )}
      {walk && proposed && (
        <div className="bg-muted/40 flex items-center gap-2 border-b py-1 pr-1.5 pl-3" data-testid="thread-walk">
          <span className="text-muted-foreground text-[11px] font-medium tabular-nums">
            {t('review.walkPosition', { index: walk.index, total: walk.total })}
          </span>
          {walk.total > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 gap-1.5 px-2 text-xs"
              aria-keyshortcuts="J"
              data-testid="thread-walk-next"
              onClick={walk.onNext}
            >
              {t('review.walkNext')}
              <Kbd className="h-4 min-w-4 px-1 text-[10px]">J</Kbd>
            </Button>
          )}
        </div>
      )}
      <div className={cn('flex items-center gap-1.5 border-b px-3 py-2', placement === 'docked' && 'pr-12')}>
        <KindIcon className="text-muted-foreground size-3.5" aria-hidden />
        {/* What the card is about, which names it as a dialog: the kind, the number, its state. */}
        <span id={headerId} className="flex min-w-0 items-center gap-1.5">
          <span className="text-foreground text-xs font-semibold">{t(`annotations.kinds.${annotation.kind}`)}</span>{' '}
          <span className="text-muted-foreground font-mono text-[11px]">#{annotation.number}</span>
          {proposed && (
            <span className="text-muted-foreground border-foreground/50 ml-1 rounded-full border border-dashed px-1.5 text-[10px] font-medium">
              {t('review.proposal')}
            </span>
          )}
          {!live && (
            <span className="text-muted-foreground bg-muted ml-1 rounded-full px-1.5 text-[10px] font-medium">
              {annotation.status === 'resolved' ? t('review.resolved') : t('review.dismissed')}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center">
          {annotation.canEdit && annotation.status === 'open' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              disabled={busy}
              aria-label={t('review.resolve')}
              title={`${t('review.resolve')} (E)`}
              data-testid="thread-resolve"
              onClick={() => void move('resolved')}
            >
              <Check aria-hidden />
            </Button>
          )}
          {annotation.canEdit && !live && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              disabled={busy}
              aria-label={t('review.reopen')}
              title={t('review.reopen')}
              onClick={() => void move('open')}
            >
              <RotateCcw aria-hidden />
            </Button>
          )}
          {menu.length > 0 && (
            <ActionMenu
              mode="dropdown"
              entries={menu}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 [&_svg]:size-3.5"
                  aria-label={t('review.more')}
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
          )}
          {/* Docked in the phone's sheet, the sheet's own × closes it. */}
          {placement !== 'docked' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              aria-label={t('review.closeThread')}
              onClick={() => review.select(null)}
            >
              <X aria-hidden />
            </Button>
          )}
        </span>
      </div>

      {annotation.delegatedBy && (
        <div className="border-b px-3 py-1.5" data-testid="thread-delegate">
          <Chip size="sm" variant="secondary" className="gap-1">
            <PilotiGlyph size="xs" />
            {t('review.piloti.delegateChip', { name: annotation.delegatedByName ?? t('review.someone') })}
          </Chip>
        </div>
      )}

      <div className="max-h-[min(22rem,50svh)] space-y-3 overflow-y-auto px-3 py-3">
        <Message
          authorKind={annotation.authorKind}
          name={annotation.createdByName}
          userId={annotation.createdBy}
          at={annotation.createdAt}
          body={annotation.body}
          proposal={proposed}
        />
        {annotation.basis && (
          <p className="border-l-source-law/40 text-muted-foreground ml-8.5 flex items-center gap-1.5 border-l-2 pl-2 text-[11px]">
            <Scale className="size-3 shrink-0" aria-hidden />
            <span className="font-mono">{annotation.basis}</span>
          </p>
        )}
        {annotation.replies.map((reply) => (
          <Message
            key={reply.id}
            authorKind={reply.authorKind}
            name={reply.createdByName}
            userId={reply.createdBy}
            at={reply.createdAt}
            body={reply.body}
            woken={reply.wokenBy ? { trigger: reply.wokenBy, number: annotation.number } : null}
          />
        ))}
        <PilotiWorkRow annotation={annotation} />
        {threadAsk && <PilotiThreadRow ask={threadAsk} review={review} />}
      </div>

      {proposed && annotation.canEdit && (
        <div className="bg-muted/40 space-y-2 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-[11px] leading-4">{t('review.proposalHint')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 justify-between text-xs"
              disabled={busy}
              data-testid="thread-dismiss"
              onClick={() => void move('dismissed')}
            >
              {t('review.dismiss')}
              <Kbd className="ml-2 pointer-coarse:hidden">{t('review.dismissKey')}</Kbd>
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 justify-between text-xs"
              disabled={busy}
              data-testid="thread-accept"
              onClick={() => void move('open')}
            >
              {t('review.accept')}
              <Kbd className="bg-background/15 text-background ml-2 border-transparent pointer-coarse:hidden">E</Kbd>
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t px-3 py-2.5">
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeName={annotation.assigneeUserId ? (annotation.assigneeName ?? t('review.someone')) : null}
          dueOn={annotation.dueOn}
          editable={annotation.canEdit && live}
          canPickAssignee={canPickAssignee}
          onAssignee={(person) => void act(() => review.update(annotation.id, { assigneeUserId: person?.userId ?? null }))}
          onDueOn={(dueOn) => void act(() => review.update(annotation.id, { dueOn }))}
        />
        {annotation.canEdit && (
          <Composer
            testId="thread-reply"
            placeholder={t('review.replyPlaceholder')}
            submitLabel={t('review.send')}
            mentionPiloti={piloti.available}
            onSubmit={sendReply}
            // Esc steps out of the field, keeping what is typed; the next Esc closes the thread.
            onEscape={() => {
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            }}
          />
        )}
        {failed && <FieldError>{t('review.actionFailed')}</FieldError>}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('review.deleteConfirm', { number: annotation.number })}
        confirmLabel={t('review.delete')}
        cancelLabel={t('annotations.cancel')}
        onConfirm={() => act(() => review.remove(annotation.id))}
      />
    </ReviewCard>
  )
}
