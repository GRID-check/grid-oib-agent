'use client'

/**
 * The `/` picker — the panel that opens above the composer when a message
 * starts with a slash.
 *
 * Deliberately the same component shape, keyboard contract and visual language
 * as `MentionPicker`: the composer owns the popover and stays focused, this
 * renders the panel, and `↑ ↓ ↵ ⇥ esc` are forwarded in through
 * `SlashCommandPickerHandle`. Two composer affordances that behaved differently
 * would be two things to learn for one idea ("type a character, pick from a
 * list"), so the differences are only the ones that carry meaning.
 *
 * ## What a row shows, and why exactly that
 *
 * Each row is a skill's `name` and its `description` — which is precisely the
 * progressive-disclosure level-1 metadata the agent itself is given at the start
 * of every turn, and nothing more. The instructions (level 2) are not fetched
 * here and are not shown here; they enter the conversation only when the agent
 * calls `use_skill` during the turn. Keeping the menu and the agent's catalogue
 * literally the same text is the point: a description that does not say WHEN the
 * skill applies is equally useless to the person scanning this list and to the
 * model deciding whether to load it, so the menu is honest feedback on how well
 * a skill was written.
 *
 * ## What a row does NOT show
 *
 * There is no per-row icon and no origin badge. Every skill would carry the
 * same glyph, so it distinguished nothing and only pushed the two things that
 * DO distinguish rows — the name and the description — into a narrower column.
 * Provenance (built-in vs. authored here) is a fact about managing a skill, not
 * about invoking one; it belongs in the toolbox, where it is actionable, and
 * carrying it here cost a badge on the line a reader scans first. What is left
 * is the token to type and the sentence that says when to type it.
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
import { Slash } from 'lucide-react'

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
import { cn } from '@/lib/utils'
import { filterSlashCommands } from '../lib/slash-command'

/** One invocable skill — level-1 metadata only (see the module note). */
export interface SlashCommandSkill {
  name: string
  description: string
  origin: 'org' | 'platform-clone' | 'platform'
}

/** What the composer needs to drive the picker from the textarea. */
export interface SlashCommandPickerHandle {
  /** Move the selection by `delta`, wrapping around at both ends. */
  move: (delta: number) => void
  /** Insert the selected skill. False when there is nothing to insert. */
  selectActive: () => boolean
}

/** The ids the composer's textarea points at while the picker is open. */
export interface SlashCommandPickerAria {
  listboxId: string | null
  activeOptionId: string | null
}

export interface SlashCommandPickerProps {
  /** The fragment after `/`; drives filtering and the no-results copy. */
  query: string
  skills: readonly SlashCommandSkill[]
  loading?: boolean
  onSelect: (skill: SlashCommandSkill) => void
  onAriaChange?: (aria: SlashCommandPickerAria) => void
  className?: string
}

const optionValue = (skill: SlashCommandSkill): string => `skill:${skill.name}`

/**
 * The option's DOM id, which the textarea's `aria-activedescendant` points at.
 * Ours rather than cmdk's, for the reason given in `MentionPicker`.
 */
export const slashOptionDomId = (skill: SlashCommandSkill): string =>
  `slash-option-${skill.name.replace(/[^a-zA-Z0-9_-]+/g, '-')}`

/**
 * The matched fragment, emphasised inside the name. Weight, not colour — the
 * row is already tinted when selected.
 *
 * No diacritic folding here (unlike the mention picker, which searches human
 * names): a skill name is `a-z0-9-` by specification, so there is nothing to
 * fold and an offset in the lowercased string maps back one-to-one.
 */
function HighlightedName({ name, query }: { name: string; query: string }): JSX.Element {
  const needle = query.trim().toLowerCase()
  const at = needle ? name.toLowerCase().indexOf(needle) : -1
  if (at < 0) return <>{name}</>
  return (
    <>
      {name.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground">
        {name.slice(at, at + needle.length)}
      </mark>
      {name.slice(at + needle.length)}
    </>
  )
}

export const SlashCommandPicker = forwardRef<SlashCommandPickerHandle, SlashCommandPickerProps>(
  function SlashCommandPicker(
    { query, skills, loading = false, onSelect, onAriaChange, className },
    ref,
  ) {
    const t = useTranslations('skills')
    const resultsAria = t('composer.picker.resultsAria')

    const visible = useMemo(() => filterSlashCommands(skills, query), [skills, query])

    const [activeIndex, setActiveIndex] = useState(0)
    const rootRef = useRef<HTMLDivElement>(null)

    // Reset to the top when the result SET changes, never merely on re-render —
    // the latter would fight the user's arrow keys.
    const visibleKey = visible.map((skill) => skill.name).join('|')
    useEffect(() => {
      setActiveIndex(0)
    }, [visibleKey])

    const active = visible[Math.min(activeIndex, Math.max(visible.length - 1, 0))]

    useImperativeHandle(
      ref,
      () => ({
        move: (delta: number) => {
          if (visible.length === 0) return
          setActiveIndex((current) => {
            const next = (current + delta) % visible.length
            return next < 0 ? next + visible.length : next
          })
        },
        selectActive: () => {
          if (!active) return false
          onSelect(active)
          return true
        },
      }),
      [active, onSelect, visible.length],
    )

    // Hover moves the selection, so mouse and keyboard never disagree about
    // which row `↵` would insert.
    const handleValueChange = useCallback(
      (value: string) => {
        const index = visible.findIndex((skill) => optionValue(skill) === value)
        if (index >= 0) setActiveIndex(index)
      },
      [visible],
    )

    // Keep the highlighted row on screen: the panel is bounded and the list
    // scrolls, so arrowing past the last visible row must bring it into view or
    // `↵` inserts something the user cannot see. `nearest` leaves an
    // already-visible row exactly where it is; layout effect so the scroll lands
    // in the same frame as the highlight.
    useLayoutEffect(() => {
      if (!active) return
      rootRef.current
        ?.querySelector(`#${CSS.escape(slashOptionDomId(active))}`)
        ?.scrollIntoView({ block: 'nearest' })
    }, [active])

    const reportedRef = useRef<SlashCommandPickerAria>({ listboxId: null, activeOptionId: null })
    useEffect(() => {
      if (!onAriaChange) return
      const next: SlashCommandPickerAria = {
        listboxId: rootRef.current?.querySelector('[cmdk-list]')?.id ?? null,
        activeOptionId: active ? slashOptionDomId(active) : null,
      }
      const previous = reportedRef.current
      if (previous.listboxId === next.listboxId && previous.activeOptionId === next.activeOptionId) {
        return
      }
      reportedRef.current = next
      onAriaChange(next)
    })

    const renderRow = (skill: SlashCommandSkill): JSX.Element => (
      <CommandItem
        asChild
        key={skill.name}
        value={optionValue(skill)}
        onSelect={() => onSelect(skill)}
        className={cn(
          'flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 transition-colors duration-150 ease-out',
          'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
        )}
      >
        {/* `asChild` so the row carries OUR stable id (see slashOptionDomId). */}
        <div id={slashOptionDomId(skill)} data-testid="slash-option" data-skill-name={skill.name}>
          {/* Monospace: this is a literal token the user types, not a title. */}
          <span className="block truncate font-mono text-[13px] leading-tight text-foreground/90">
            /<HighlightedName name={skill.name} query={query} />
          </span>
          {/* Two lines, not one and not three. One would cut a spec-conformant
              description in half — losing exactly the "when to use it" clause
              that decides whether this is the row you want. Three made rows so
              tall the panel could not show a whole one at its bottom edge, and a
              menu you scan is worse for a ragged edge than for a clamp. The full
              text is one selection away, on the chip. */}
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {skill.description}
          </span>
        </div>
      </CommandItem>
    )

    return (
      <div
        ref={rootRef}
        data-testid="slash-command-picker"
        className={cn(
          // 360px, not the mention picker's 320: these rows are taller (a name
        // line plus two description lines), and at 320 the fourth row was cut
        // through the middle of its own sentence. The fade softened it but the
        // slice still read as a rendering fault rather than as "scroll for more".
        'bg-popover text-popover-foreground flex max-h-[360px] w-full flex-col overflow-hidden rounded-xl border shadow-lg',
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
          <CommandList
            label={resultsAria}
            className="scroll-fade-bottom max-h-none min-h-0 flex-1 p-1.5"
          >
            {loading ? (
              // Skeletons shaped like the real rows, never a spinner: the panel
              // keeps its height and does not jump when the list arrives.
              <div className="flex flex-col gap-1" aria-busy="true">
                <span className="sr-only">{t('composer.picker.loading')}</span>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex flex-col gap-1.5 px-2.5 py-1.5">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-2.5 w-52" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className="px-4 py-8 text-center">
                  <Slash className="mx-auto size-7 text-muted-foreground/50" aria-hidden />
                  <p className="mt-2.5 text-sm font-medium text-foreground">
                    {query
                      ? t('composer.picker.noResults', { query })
                      : t('composer.picker.empty')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {query ? t('composer.picker.noResultsHint') : t('composer.picker.emptyHint')}
                  </p>
                </CommandEmpty>

                {visible.length > 0 && (
                  <CommandGroup className="p-0" aria-label={resultsAria}>
                    {visible.map(renderRow)}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>

        {/* Outside the scroll region, so the hint stays put while the list moves. */}
        <div
          className="flex shrink-0 items-center gap-2 border-t bg-muted/40 px-3 py-2"
          aria-label={t('composer.picker.keyboardHint')}
        >
          <Slash className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
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
