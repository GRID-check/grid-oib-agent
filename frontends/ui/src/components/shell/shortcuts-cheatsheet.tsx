'use client'

/**
 * The keyboard-shortcuts cheatsheet (`?`).
 *
 * Every row comes from the shortcut registry (`shortcuts.ts`) — including the
 * navigation group, which the registry derives from the same IA the rail and
 * the ⌘K palette render. Nothing here is a hand-maintained list, so the sheet
 * cannot go stale behind the app again: a new project section arrives with its
 * jump key, its label and its icon already correct, and a flag-gated section
 * disappears from the sheet exactly when it disappears from the rail.
 *
 * The layout is a two-column card of grouped rows on desktop (the whole set
 * fits without scrolling), collapsing to one column on mobile. Keycaps are
 * rendered as physical keys — hairline border, raised surface, contact shadow —
 * because a cheatsheet's whole job is to be scanned, and a key that looks like
 * a key is found faster than one that looks like text.
 */

import * as React from 'react'
import { Keyboard } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  MOD,
  modifierLabel,
  shortcutSections,
  type KeySegment,
  type ShortcutFlags,
  type ShortcutRow,
  type ShortcutSection,
} from './shortcuts'

/**
 * `⌘` on Apple platforms, `Ctrl` elsewhere — resolved client-side only, so the
 * server render (which cannot know the platform) never disagrees with the DOM.
 * Prefers `navigator.userAgentData.platform`; the deprecated
 * `navigator.platform` is the fallback that still covers Safari and Firefox.
 */
function useModifierLabel(): string {
  const [label, setLabel] = React.useState('Ctrl')
  React.useEffect(() => {
    const uaPlatform = (
      window.navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData?.platform
    setLabel(modifierLabel(uaPlatform || window.navigator.platform))
  }, [])
  return label
}

/**
 * A physical-feeling keycap: raised surface, hairline edge, and a contact
 * shadow so it sits ON the row rather than in it. `min-w-6` keeps single
 * characters square and the right-hand key column optically aligned.
 */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-[7px] px-1.5',
        'border border-border bg-surface-raised shadow-xs',
        'font-mono text-[11px] leading-none font-medium text-foreground',
      )}
    >
      {children}
    </kbd>
  )
}

/** The quiet connective tissue between keycaps ("then", "or", "–"). */
function Joiner({ children }: { children: React.ReactNode }) {
  return <span className="px-0.5 text-[10.5px] text-muted-foreground">{children}</span>
}

/**
 * Render a shortcut's notation from its segments. One renderer covers chords,
 * leader sequences, alternatives and ranges, so adding a shortcut to the
 * registry never means touching this component.
 */
function KeySegments({ segments, mod }: { segments: readonly KeySegment[]; mod: string }) {
  const t = useTranslations('shortcuts.cheatsheet')
  return (
    <span className="flex shrink-0 items-center gap-1">
      {segments.map((segment, index) => {
        if (segment.kind === 'then') return <Joiner key={index}>{t('thenSeparator')}</Joiner>
        if (segment.kind === 'or') return <Joiner key={index}>{t('orSeparator')}</Joiner>
        if (segment.kind === 'range') return <Joiner key={index}>–</Joiner>
        return (
          <React.Fragment key={index}>
            {segment.caps.map((cap, capIndex) => (
              <Key key={capIndex}>{cap === MOD ? mod : cap}</Key>
            ))}
          </React.Fragment>
        )
      })}
    </span>
  )
}

/**
 * Deal the groups into two columns of roughly equal height, preserving order.
 *
 * Greedy by weight (rows + heading) rather than a fixed "navigation goes
 * right": the navigation group grows and shrinks with the user's feature flags,
 * so any hard-coded placement would be balanced for exactly one org. CSS
 * `columns-2` would balance on its own, but a group taller than the column gets
 * split across the fold — the tall navigation group is precisely the one that
 * must stay whole.
 */
function splitColumns(sections: ShortcutSection[]): [ShortcutSection[], ShortcutSection[]] {
  const columns: [ShortcutSection[], ShortcutSection[]] = [[], []]
  const weights = [0, 0]
  for (const section of sections) {
    const index = weights[0] <= weights[1] ? 0 : 1
    columns[index].push(section)
    weights[index] += section.rows.length + 1
  }
  return columns
}

/**
 * Resolve a row's label from whichever dictionary owns it. Built once in the
 * sheet and passed down, so a row does not construct three translators of
 * which two go unused.
 */
function useLabelResolver(): (label: ShortcutRow['label']) => string {
  const tNav = useTranslations('nav')
  const tCollab = useTranslations('collaboration')
  const tItems = useTranslations('shortcuts.cheatsheet.items')

  return React.useCallback(
    (label) => {
      if (label.namespace === 'nav') return tNav(label.key)
      if (label.namespace === 'collaboration') return tCollab(label.key)
      return tItems(label.key)
    },
    [tNav, tCollab, tItems],
  )
}

/** One shortcut: icon + what it does on the left, the keys on the right. */
function Row({ row, mod, label }: { row: ShortcutRow; mod: string; label: string }) {
  const Icon = row.icon

  return (
    <div
      data-shortcut={row.id}
      className="flex items-center justify-between gap-4 px-3.5 py-2.5"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {/* Wraps rather than truncates: an abbreviated label in a reference
            sheet defeats the sheet. The keys keep their width (`shrink-0`), so
            a long label costs a second line, never a hidden binding. */}
        <span className="text-sm">{label}</span>
      </span>
      <KeySegments segments={row.keys} mod={mod} />
    </div>
  )
}

export interface ShortcutsCheatsheetProps extends ShortcutFlags {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutsCheatsheet({
  open,
  onOpenChange,
  canViewOrganization = false,
  showKnowledge = false,
  showWorkflows = false,
  canAccessArchiv = false,
  canCollaborate = false,
  canAccessInbox = false,
}: ShortcutsCheatsheetProps) {
  const t = useTranslations('shortcuts.cheatsheet')
  const tGroups = useTranslations('shortcuts.cheatsheet.groups')
  const resolveLabel = useLabelResolver()
  const mod = useModifierLabel()

  // Recomputed only when the capability flags change — the registry is pure.
  const sections = React.useMemo(
    () =>
      shortcutSections({
        canViewOrganization,
        showKnowledge,
        showWorkflows,
        canAccessArchiv,
        canCollaborate,
        canAccessInbox,
      }),
    [canViewOrganization, showKnowledge, showWorkflows, canAccessArchiv, canCollaborate, canAccessInbox],
  )
  const columns = React.useMemo(() => splitColumns(sections), [sections])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {/* Header band — the raised icon disc is the house treatment for a
            surface that opens on its own (see EmptyState). */}
        <DialogHeader className="flex-row items-start gap-3.5 space-y-0 px-6 pt-6 pb-5 text-left">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-raised shadow-xs"
            aria-hidden
          >
            <Keyboard className="size-4.5 text-muted-foreground" />
          </span>
          <div className="min-w-0 space-y-1">
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </div>
        </DialogHeader>

        {/* Body — two balanced columns on desktop, one stack on mobile. The
            whole set fits without scrolling at normal window heights; the
            scroll fade is there for short viewports only. */}
        <div className="scroll-fade-bottom max-h-[min(70vh,38rem)] overflow-y-auto px-6 pb-6">
          <div className="grid items-start gap-x-5 gap-y-5 sm:grid-cols-2">
            {columns.map((column, index) => (
              <div key={index} className="space-y-5">
                {column.map((section) => (
                  <section key={section.id} data-shortcut-group={section.id}>
                    <h3 className="mb-2 text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase">
                      {tGroups(section.i18nKey)}
                    </h3>
                    <div className="divide-y divide-border rounded-xl border border-border bg-card">
                      {section.rows.map((row) => (
                        <Row key={row.id} row={row} mod={mod} label={resolveLabel(row.label)} />
                      ))}
                    </div>
                    {section.note && (
                      <p className="mt-2 px-0.5 text-xs text-muted-foreground">
                        {t('projectScopeNote')}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Footer band — sits OUTSIDE the faded scroll region so the way to
            turn the feature off never dissolves into the edge. */}
        <div className="border-t border-border bg-surface-sunken px-6 py-3.5">
          <p className="text-xs text-muted-foreground">{t('disableHint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
