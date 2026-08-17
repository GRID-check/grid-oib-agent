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
 * fits without scrolling), collapsing to one column on mobile. Keycaps come
 * from the shared {@link ShortcutKeys} renderer so a chord / leader /
 * alternative / range never gets a second homemade `<kbd>`.
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
import { Item, ItemActions, ItemContent, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { ShortcutKeys, useModifierLabel } from './shortcut-keys'
import {
  shortcutSections,
  type ShortcutFlags,
  type ShortcutRow,
  type ShortcutSection,
} from './shortcuts'

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
    <Item data-shortcut={row.id} className="px-3.5 py-2.5">
      <ItemMedia className="size-4">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </ItemMedia>
      <ItemContent>
        {/* Wraps rather than truncates: an abbreviated label in a reference
            sheet defeats the sheet. The keys keep their width (`shrink-0`), so
            a long label costs a second line, never a hidden binding. */}
        <ItemTitle className="overflow-visible whitespace-normal">{label}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <ShortcutKeys segments={row.keys} mod={mod} />
      </ItemActions>
    </Item>
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
  showSkills = false,
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
        showSkills,
        canAccessArchiv,
        canCollaborate,
        canAccessInbox,
      }),
    [canViewOrganization, showKnowledge, showSkills, canAccessArchiv, canCollaborate, canAccessInbox],
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
                    <SectionLabel as="h3" className="mb-2">
                      {tGroups(section.i18nKey)}
                    </SectionLabel>
                    <ItemList className="rounded-xl bg-card">
                      {section.rows.map((row) => (
                        <Row key={row.id} row={row} mod={mod} label={resolveLabel(row.label)} />
                      ))}
                    </ItemList>
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
