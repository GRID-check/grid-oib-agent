'use client'

/**
 * The `@` picker (spec MN-4, MN-5) — the panel that opens above the composer.
 *
 * Shape and behaviour follow the Slack/Linear/GitHub pattern deliberately, because
 * that is the interaction people already know: the panel spans the composer, the
 * whole row highlights, hover and keyboard share ONE selection, and `↵`/`⇥` insert.
 * Three decisions are worth knowing before changing anything here:
 *
 * 1. **This component is the panel, not the popover.** The composer owns the
 *    `Popover`/`PopoverAnchor` (it is the anchor), which keeps the placement
 *    decision — above the composer, spanning its width — where the composer is,
 *    and lets the dev preview and the tests render the real panel without
 *    floating-ui in the loop.
 *
 * 2. **Keyboard navigation is driven from the outside** (`MentionPickerHandle`).
 *    Focus never leaves the textarea while the picker is open — that is the whole
 *    point of an inline mention picker — so cmdk's own key handling (which needs
 *    focus inside the command root) cannot be used. The composer forwards
 *    `↑ ↓ ↵ ⇥ esc`; everything else about selection lives here.
 *
 * 3. **A candidate who needs an invitation the caller may not send is DISABLED,
 *    never hidden** (spec MN-5, SH-19). An invite picker that silently omits a
 *    colleague reads as a bug; the row says who they are and why it is inert.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AtSign, Sparkles, UserPlus } from 'lucide-react'

import { PersonAvatar } from '@/components/ui/avatar-stack'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import type { MentionCandidate } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'

/** What the composer needs to drive the picker from the textarea. */
export interface MentionPickerHandle {
  /** Move the selection by `delta`, wrapping around at both ends. */
  move: (delta: number) => void
  /** Insert the selected candidate. False when there is nothing to insert. */
  selectActive: () => boolean
}

/**
 * The ids the composer's textarea has to point at (`aria-controls`,
 * `aria-activedescendant`). Reported rather than passed in because cmdk mints the
 * LISTBOX id itself (it overrides an `id` prop), so it can only be read back from
 * the rendered panel. Option ids are ours — see `mentionOptionDomId`.
 */
export interface MentionPickerAria {
  listboxId: string | null
  activeOptionId: string | null
}

export interface MentionPickerProps {
  /** The fragment after `@`; drives filtering and the no-results copy. */
  query: string
  candidates: readonly MentionCandidate[]
  /** Whether the caller may invite — decides if `needsInvite` rows are actionable. */
  canInvite: boolean
  loading?: boolean
  onSelect: (candidate: MentionCandidate) => void
  onAriaChange?: (aria: MentionPickerAria) => void
  className?: string
}

/** Grouped, ordered result of filtering — exported so the composer can size itself. */
export interface MentionCandidateGroups {
  /** The assistant, pinned first and in its own group (it is not a person). */
  agent: MentionCandidate[]
  participants: MentionCandidate[]
  others: MentionCandidate[]
  /** Every candidate in visual order, disabled rows included. */
  visible: MentionCandidate[]
  /** The candidates a keypress can actually land on. */
  selectable: MentionCandidate[]
}

/** cmdk compares item values verbatim, so a stable per-candidate key is enough. */
const optionValue = (candidate: MentionCandidate): string => `mention:${candidate.targetId}`

/**
 * The option's DOM id, which the textarea's `aria-activedescendant` points at.
 *
 * Ours, not cmdk's: cmdk mints an id per item and overrides an `id` prop, so each
 * row is rendered through `asChild` onto an element that carries this stable id
 * instead. That keeps the combobox wiring derivable from state (no DOM reading, no
 * dependence on when cmdk's internal store settles) and readable in the inspector.
 */
export const mentionOptionDomId = (candidate: MentionCandidate): string =>
  `mention-option-${candidate.targetId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`

/** A row the caller cannot act on: mentioning them needs an invite they can't send. */
const isBlocked = (candidate: MentionCandidate, canInvite: boolean): boolean =>
  candidate.needsInvite && !canInvite

/**
 * Lower-case and strip diacritics, so the search works in the language the
 * product is actually used in. Without the folding, `@muller` never found
 * "Müller" and `@jurgen` never found "Jürgen" — and typing the umlaut is exactly
 * what somebody reaching for a picker is trying to avoid.
 *
 * NFD splits a letter from its combining mark; the mark is then dropped.
 * Deliberately not `localeCompare`-based: this must produce an INDEX that maps
 * back onto the original string for the highlight below, so it has to be a
 * character-for-character transform.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()
}

function matches(candidate: MentionCandidate, query: string, agentLabel: string): boolean {
  if (!query) return true
  const needle = fold(query)
  const haystacks = [
    candidate.person.name,
    candidate.person.email ?? '',
    candidate.isAgent ? agentLabel : '',
  ]
  return haystacks.some((value) => fold(value).includes(needle))
}

/**
 * Filter and group candidates: the assistant first, then the people already in
 * the conversation, then everyone else in the project. The server's order inside
 * each group is preserved — it knows about recency, this component does not.
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  canInvite: boolean,
  agentLabel: string,
): MentionCandidateGroups {
  const hits = candidates.filter((candidate) => matches(candidate, query, agentLabel))
  const agent = hits.filter((candidate) => candidate.isAgent)
  const participants = hits.filter((candidate) => !candidate.isAgent && candidate.isParticipant)
  const others = hits.filter((candidate) => !candidate.isAgent && !candidate.isParticipant)
  const visible = [...agent, ...participants, ...others]
  return {
    agent,
    participants,
    others,
    visible,
    selectable: visible.filter((candidate) => !isBlocked(candidate, canInvite)),
  }
}

/**
 * The matched fragment, emphasised inside the name. Weight, not colour: the row is
 * already tinted when selected, and a second colour would fight it.
 */
function HighlightedName({ name, query }: { name: string; query: string }): JSX.Element {
  // Folding can change a string's LENGTH (a decomposed umlaut loses its mark, ß
  // and ﬁ do not map one-to-one), so an offset found in the folded string cannot
  // be used to slice the original — that emphasised the wrong characters. Fold
  // character by character and keep a map back to the source offsets.
  const { folded, offsets } = foldWithOffsets(name)
  const needle = fold(query)
  const at = needle ? folded.indexOf(needle) : -1
  if (at < 0) return <>{name}</>
  const from = offsets[at]
  const to = offsets[at + needle.length]
  return (
    <>
      {name.slice(0, from)}
      <mark className="bg-transparent font-semibold text-foreground">{name.slice(from, to)}</mark>
      {name.slice(to)}
    </>
  )
}

/** The folded string plus, per folded character, the offset it came from. */
function foldWithOffsets(value: string): { folded: string; offsets: number[] } {
  let folded = ''
  const offsets: number[] = []
  let offset = 0
  for (const character of value) {
    const piece = fold(character)
    for (let index = 0; index < piece.length; index += 1) offsets.push(offset)
    folded += piece
    offset += character.length
  }
  offsets.push(offset)
  return { folded, offsets }
}

function CandidateAvatar({
  candidate,
  agentLabel,
}: {
  candidate: MentionCandidate
  agentLabel: string
}): JSX.Element {
  // The assistant is not a person: a squared, ink-filled glyph rather than a
  // round portrait, so it never reads as one more colleague in the list.
  if (candidate.isAgent) {
    return (
      <span
        aria-hidden
        className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg"
        title={agentLabel}
      >
        <Sparkles className="size-4" />
      </span>
    )
  }

  /*
    The SHARED avatar primitive, not a local disc: the same person must look the
    same in the picker, the participant strip and their message bubbles. A
    per-component palette makes recognising a colleague harder in exactly the
    surface whose job is identifying them.
  */
  return <PersonAvatar person={candidate.person} size="md" />
}

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  function MentionPicker(
    { query, candidates, canInvite, loading = false, onSelect, onAriaChange, className },
    ref,
  ) {
    const t = useTranslations('collaboration')
    const agentLabel = t('mentions.picker.agentName')
    const resultsAria = t('mentions.picker.resultsAria')

    const groups = useMemo(
      () => filterMentionCandidates(candidates, query, canInvite, agentLabel),
      [candidates, query, canInvite, agentLabel],
    )
    const { selectable } = groups

    const [activeIndex, setActiveIndex] = useState(0)
    const rootRef = useRef<HTMLDivElement>(null)

    // Reset to the top whenever the result SET changes (a new query, freshly
    // loaded candidates) — but never merely because the component re-rendered,
    // which would fight the user's arrow keys.
    const selectableKey = selectable.map((candidate) => candidate.targetId).join('|')
    useEffect(() => {
      setActiveIndex(0)
    }, [selectableKey])

    const active = selectable[Math.min(activeIndex, Math.max(selectable.length - 1, 0))]

    useImperativeHandle(
      ref,
      () => ({
        move: (delta: number) => {
          if (selectable.length === 0) return
          setActiveIndex((current) => {
            const next = (current + delta) % selectable.length
            return next < 0 ? next + selectable.length : next
          })
        },
        selectActive: () => {
          if (!active) return false
          onSelect(active)
          return true
        },
      }),
      [active, onSelect, selectable.length],
    )

    // Hover moves the selection, so mouse and keyboard can never disagree about
    // which row `↵` would insert. cmdk fires this on pointer move over a row.
    const handleValueChange = useCallback(
      (value: string) => {
        const index = selectable.findIndex((candidate) => optionValue(candidate) === value)
        if (index >= 0) setActiveIndex(index)
      },
      [selectable],
    )

    /*
      Keep the highlighted row on screen.

      The panel is bounded (`max-h-[320px]`) and the list scrolls, but nothing
      scrolled it: arrowing past the fifth candidate moved the highlight onto a
      row the user could not see, and `↵` then inserted somebody they had never
      laid eyes on. The bottom fade said "more below" and the keyboard could not
      reach it — the worst combination, because `@` is a keyboard surface first.

      `block: 'nearest'` so a row already visible is left exactly where it is;
      only a row past an edge moves, and only by as much as it must. Layout
      effect, so the scroll lands in the same frame as the highlight rather than
      one frame behind it.
    */
    useLayoutEffect(() => {
      if (!active) return
      rootRef.current
        ?.querySelector(`#${CSS.escape(mentionOptionDomId(active))}`)
        ?.scrollIntoView({ block: 'nearest' })
    }, [active])

    // Publish the ids the composer's textarea has to reference. A passive effect
    // (not layout) because React attaches THIS component's ref only after its
    // children's layout effects have run; and deduped, because a fresh object on
    // every render would bounce off the composer's state.
    const reportedRef = useRef<MentionPickerAria>({ listboxId: null, activeOptionId: null })
    useEffect(() => {
      if (!onAriaChange) return
      const next: MentionPickerAria = {
        listboxId: rootRef.current?.querySelector('[cmdk-list]')?.id ?? null,
        activeOptionId: active ? mentionOptionDomId(active) : null,
      }
      const previous = reportedRef.current
      if (previous.listboxId === next.listboxId && previous.activeOptionId === next.activeOptionId) {
        return
      }
      reportedRef.current = next
      onAriaChange(next)
    })

    const renderRow = (candidate: MentionCandidate): JSX.Element => {
      const blocked = isBlocked(candidate, canInvite)
      const name = candidate.isAgent ? agentLabel : candidate.person.name
      const secondary = candidate.isAgent
        ? t('mentions.picker.agentHint')
        : blocked
          ? t('mentions.picker.cannotInvite')
          : candidate.needsInvite
            ? t('mentions.picker.needsInviteHintShort')
            : (candidate.person.email ?? '')

      return (
        <CommandItem
          asChild
          key={candidate.targetId}
          value={optionValue(candidate)}
          disabled={blocked}
          onSelect={() => {
            if (!blocked) onSelect(candidate)
          }}
          className={cn(
            // The WHOLE row is the highlight — 12px radius, full-bleed inside the
            // list padding — which is what makes selection legible at a glance.
            'items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150 ease-out motion-reduce:transition-none',
            'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
            blocked && 'opacity-55',
          )}
        >
          {/* `asChild` so the row carries OUR stable id (see mentionOptionDomId). */}
          <div
            id={mentionOptionDomId(candidate)}
            data-testid="mention-option"
            data-target-id={candidate.targetId}
          >
            <CandidateAvatar candidate={candidate} agentLabel={agentLabel} />

            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm leading-tight text-foreground/85">
                <HighlightedName name={name} query={query} />
              </span>
              {secondary && (
                <span className="truncate text-xs leading-tight text-muted-foreground">
                  {secondary}
                </span>
              )}
            </span>

            {candidate.isAgent ? (
              <Badge variant="secondary" className="shrink-0 gap-1">
                <Sparkles aria-hidden />
                {t('mentions.picker.badgeAgent')}
              </Badge>
            ) : candidate.needsInvite && !blocked ? (
              // Only when the caller CAN invite. On a blocked row the badge said
              // "Wird eingeladen" while the subtitle directly beneath it said only an
              // owner may bring people in — two statements about one row that
              // contradict each other. The subtitle is the true one, so the badge
              // steps aside.
              <Badge variant="warning" className="shrink-0 gap-1">
                <UserPlus aria-hidden />
                {t('mentions.picker.needsInvite')}
              </Badge>
            ) : null}
            {/* No badge for an ordinary participant. `badgeInChat` said "In diesem
                Chat" on every row of the group headed "IN DIESEM CHAT" — the
                participants group is the only place those rows are ever rendered,
                so the badge restated its own heading once per row and could never
                say anything else. Worse, it competed for attention with the two
                badges that DO carry information: "Assistent", and "Wird
                eingeladen", which warns that picking this row also invites someone.
                A badge now means the row is not ordinary. */}
          </div>
        </CommandItem>
      )
    }

    return (
      <div
        ref={rootRef}
        data-testid="mention-picker"
        className={cn(
          'bg-popover text-popover-foreground flex max-h-[320px] w-full flex-col overflow-hidden rounded-xl border shadow-lg',
          'animate-in fade-in-0 slide-in-from-bottom-1 duration-150 ease-out motion-reduce:animate-none',
          className,
        )}
      >
        <Command
          shouldFilter={false}
          loop
          label={resultsAria}
          value={active ? optionValue(active) : ''}
          onValueChange={handleValueChange}
          className="min-h-0 flex-1 bg-transparent"
        >
          {/* `scroll-fade-bottom`: with more candidates than fit, the panel used to
              cut the next row through its own text, which reads as a rendering bug
              rather than as an invitation to scroll. The footer below stays sharp —
              it is outside this scroll region. */}
          <CommandList
            label={resultsAria}
            className="scroll-fade-bottom max-h-none min-h-[10rem] flex-1 p-1.5"
          >
            {loading ? (
              // Skeletons shaped like the real rows (avatar + two lines), never a
              // spinner: the panel keeps its height and does not jump on arrival.
              <div className="flex flex-col gap-1" aria-busy="true">
                <span className="sr-only">{t('mentions.picker.loading')}</span>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-3 px-2.5 py-2">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-2.5 w-44" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className="px-4 py-8 text-center">
                  <AtSign className="mx-auto size-7 text-muted-foreground/50" aria-hidden />
                  <p className="mt-2.5 text-sm font-medium text-foreground">
                    {query
                      ? t('mentions.picker.noResults', { query })
                      : t('mentions.picker.empty')}
                  </p>
                  {query && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('mentions.picker.placeholder')}
                    </p>
                  )}
                </CommandEmpty>

                {groups.agent.length > 0 && (
                  <CommandGroup
                    className="p-0 [&:not(:last-child)]:mb-1 [&:not(:last-child)]:border-b [&:not(:last-child)]:pb-1"
                    aria-label={t('mentions.picker.badgeAgent')}
                  >
                    {groups.agent.map(renderRow)}
                  </CommandGroup>
                )}

                {groups.participants.length > 0 && (
                  <CommandGroup
                    heading={t('mentions.picker.participantsHeading')}
                    className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {groups.participants.map(renderRow)}
                  </CommandGroup>
                )}

                {groups.others.length > 0 && (
                  <CommandGroup
                    heading={t('mentions.picker.othersHeading')}
                    className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {groups.others.map(renderRow)}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>

        {/* Footer: outside the scroll container on purpose — the hint has to stay
            visible while the list scrolls. */}
        <div
          className="flex shrink-0 items-center gap-2 border-t bg-muted/40 px-3 py-2"
          aria-label={t('mentions.picker.keyboardHint')}
        >
          <AtSign className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
          <KbdGroup>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </KbdGroup>
          <Kbd>↵</Kbd>
          <Kbd>Esc</Kbd>
        </div>
      </div>
    )
  },
)
