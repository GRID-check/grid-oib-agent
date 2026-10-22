'use client'

/**
 * The controls of the Dateien header: view, Offene Punkte, E-Mail-Eingang, Papierkorb, filter, search, upload.
 *
 * ONE ROW ON A PHONE. The header used to stack four rows (view and filter,
 * search, upload) and put about 270px of controls between the title and the
 * first document. Search and filter are what is reached for, so they are the
 * row; the view choice, the Papierkorb and whatever a shelf adds fold into one
 * ⋯; and Hochladen leaves the header for the foot of the screen, where the
 * thumb is (the workspace's floating upload). A wide screen keeps the row it
 * always had.
 *
 * The workspace and the `/dev/files-header` preview both render this, so the
 * preview measures the real header and not a lookalike.
 */

import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { LayoutGrid, List, ListTodo, Mail, MoreHorizontal, Trash2 } from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { FileView } from '../hooks/use-view-preference'
import { FileSearchField } from './file-search-bar'

export interface FilesHeaderControlsProps {
  /** The narrow layout: search and filter on one row, the rest behind ⋯. */
  phone: boolean
  view: FileView
  onViewChange: (view: FileView) => void
  /** Where the Papierkorb is; absent where the shelf has none. */
  binHref?: string
  /** Where the shelf's Offene Punkte are, the open Anmerkungen of all its documents; absent where it has none. */
  openPointsHref?: string
  /**
   * The project's E-Mail-Eingang (ADR-0134) and how many mails wait in it for
   * this reader; absent where the reader may not decide held mail. The count
   * is a muted pill: the Postfach's ink pill is the one that asks for
   * attention, and two of them would make neither mean anything.
   */
  inboundMail?: { href: string; waiting: number | null }
  /** The filter menu, told whether the row has room for its word. */
  renderFilter: (compact: boolean) => ReactNode
  search: {
    value: string
    onChange: (value: string) => void
    onSubmit: () => void
    onClear: () => void
  }
  /**
   * The upload control for the WIDE row. Absent on a phone, where the same
   * control floats at the foot of the screen instead.
   */
  upload?: ReactNode
  /** More for the phone's ⋯, after the view choice and the Papierkorb. */
  moreEntries?: readonly ActionMenuEntry[]
  /**
   * The shelf's advanced actions (sort the root into folders). On a phone they
   * follow `moreEntries` in the ⋯; on a wide screen they get a ⋯ of their own.
   */
  advancedEntries?: readonly ActionMenuEntry[]
}

export function FilesHeaderControls({
  phone,
  view,
  onViewChange,
  binHref,
  openPointsHref,
  inboundMail,
  renderFilter,
  search,
  upload,
  moreEntries,
  advancedEntries,
}: FilesHeaderControlsProps): JSX.Element {
  const t = useTranslations('files')
  const choose = (value: string): void => {
    if (value === 'cards' || value === 'list') onViewChange(value)
  }
  const searchField = (className: string): JSX.Element => (
    <FileSearchField
      className={className}
      value={search.value}
      onChange={search.onChange}
      onSubmit={search.onSubmit}
      onClear={search.onClear}
      placeholder={t('browser.searchPlaceholder')}
      searchLabel={t('browser.searchLabel')}
      resetLabel={t('browser.resetSearch')}
    />
  )

  if (phone) {
    const entries: ActionMenuEntry[] = [
      {
        type: 'radio-group',
        value: view,
        onValueChange: choose,
        items: [
          { value: 'cards', label: t('workspace.view.cards'), testId: 'files-view-cards' },
          { value: 'list', label: t('workspace.view.list'), testId: 'files-view-list' },
        ],
      },
      ...(openPointsHref
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              id: 'open-points',
              label: t('openPoints.open'),
              icon: ListTodo,
              href: openPointsHref,
              testId: 'files-open-points',
            },
          ]
        : []),
      ...(inboundMail
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              id: 'inbound-mail',
              label: t('inboundMail.open'),
              hint: inboundMail.waiting ? t('inboundMail.waitingLine', { count: inboundMail.waiting }) : undefined,
              icon: Mail,
              href: inboundMail.href,
              testId: 'files-inbound-mail',
            },
          ]
        : []),
      ...(binHref
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              id: 'bin',
              label: t('workspace.openBin'),
              icon: Trash2,
              href: binHref,
              testId: 'files-open-bin',
            },
          ]
        : []),
      ...(moreEntries && moreEntries.length > 0 ? [{ type: 'separator' as const }, ...moreEntries] : []),
      ...(advancedEntries && advancedEntries.length > 0 ? [{ type: 'separator' as const }, ...advancedEntries] : []),
    ]
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid="files-controls">
        {searchField('flex-1')}
        {renderFilter(true)}
        <ActionMenu
          mode="dropdown"
          entries={entries}
          trigger={
            <Button type="button" variant="outline" size="icon" aria-label={t('workspace.more')} data-testid="files-more">
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" data-testid="files-controls">
      <ToggleGroup
        type="single"
        value={view}
        onValueChange={choose}
        segmented
        size="icon-sm"
        aria-label={t('workspace.view.label')}
      >
        <ToggleGroupItem value="cards" aria-label={t('workspace.view.cards')} title={t('workspace.view.cards')}>
          <LayoutGrid />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t('workspace.view.list')} title={t('workspace.view.list')}>
          <List />
        </ToggleGroupItem>
      </ToggleGroup>
      {/* The open Anmerkungen of every document, for the Jour fixe: a page of its own, as the Papierkorb is. */}
      {openPointsHref && (
        <Button asChild variant="ghost" size="sm">
          <Link href={openPointsHref} data-testid="files-open-points">
            <ListTodo />
            {t('openPoints.open')}
          </Link>
        </Button>
      )}
      {/* Mail sent to the project's address, waiting until a person files it (ADR-0134). */}
      {inboundMail && (
        <Button asChild variant="ghost" size="sm">
          <Link
            href={inboundMail.href}
            data-testid="files-inbound-mail"
            aria-label={
              inboundMail.waiting
                ? `${t('inboundMail.open')}, ${t('inboundMail.waitingAria', { count: inboundMail.waiting })}`
                : undefined
            }
          >
            <Mail />
            {t('inboundMail.open')}
            {inboundMail.waiting ? <CountPill count={inboundMail.waiting} tone="muted" aria-hidden /> : null}
          </Link>
        </Button>
      )}
      {/* The Papierkorb: deleted folders, restorable until their purge (ADR-0088). */}
      {binHref && (
        <Button asChild variant="ghost" size="icon" aria-label={t('workspace.openBin')} title={t('workspace.openBin')}>
          <Link href={binHref} data-testid="files-open-bin">
            <Trash2 />
          </Link>
        </Button>
      )}
      {renderFilter(false)}
      {searchField('w-full sm:w-64 lg:w-72')}
      {upload}
      {advancedEntries && advancedEntries.length > 0 && (
        <ActionMenu
          mode="dropdown"
          entries={advancedEntries}
          trigger={
            <Button type="button" variant="ghost" size="icon" aria-label={t('workspace.more')} data-testid="files-advanced">
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
      )}
    </div>
  )
}
