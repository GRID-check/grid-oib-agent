'use client'

/**
 * The document picker: an open panel over the page, for any surface that
 * needs the reader to name documents — the research plan's Unterlagen, a
 * document added to a running research, and whatever asks next.
 *
 * It reads the way an open panel does, because every reader has used one:
 * places on the left (Zuletzt, the project with its folders, the Büroarchiv,
 * what is already chosen), a toolbar with back and forward, the path, list or
 * symbol view and search, the documents in the middle, a preview of the one
 * in focus on the right, and the choice at the bottom. A click marks, a
 * double click opens a folder (or, choosing one, confirms), the arrow keys
 * walk, the space bar marks, Enter confirms.
 *
 * The picker knows nothing of what a choice means. The caller names the
 * button („Übernehmen", „Hinzufügen"), says which documents cannot be chosen
 * and why, and may put its own control beside the selection summary.
 */

import { useEffect, useMemo, useState, type FC, type KeyboardEvent, type ReactNode } from 'react'
import {
  Archive,
  BookMarked,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Folder,
  FolderOpen,
  LayoutGrid,
  List,
  MessageSquare,
  SearchX,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SearchField } from '@/components/ui/search-field'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { fileExtensionLabel } from '@/features/documents/document-kind'
import { useI18n, useTranslations } from '@/i18n'
import { formatBytes, formatCalendarDate } from '@/lib/format'
import {
  KindGlyph,
  PickerEmpty,
  PickerFacts,
  PickerFooter,
  PickerIconButton,
  PickerItems,
  PickerListHeader,
  PickerPath,
  PickerPlaceStrip,
  PickerPreviewNote,
  PickerPreviewPane,
  PickerPreviewTitle,
  PickerRow,
  PickerSidebar,
  PickerSidebarGroup,
  PickerSidebarItem,
  PickerSummary,
  PickerTile,
  PickerToolbar,
  type PickerColumn,
} from './picker-atoms'
import {
  PICKER_SHELVES,
  contentsAt,
  fold,
  folderCount,
  folderTrail,
  pickerLabel,
  samePlace,
  shelfOf,
  type PickerDocument,
  type PickerPlace,
  type PickerShelf,
  type PickerSort,
  type PickerSortKey,
} from './picker-model'

export type { PickerDocument } from './picker-model'

export interface DocumentPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  documents: readonly PickerDocument[]
  /** The project's folders; documents in them are browsed by folder. */
  folders?: readonly FolderItem[]
  loading?: boolean
  /** Several documents, or exactly one. */
  multiple?: boolean
  /** Names already chosen when the panel opens. */
  initialSelected?: readonly string[]
  /** Why a document cannot be chosen here, or null when it can. */
  disabledReason?: (doc: PickerDocument) => string | null
  confirmLabel: string
  onConfirm: (docs: PickerDocument[]) => void
  /** The caller's own control, beside the selection summary. */
  footer?: ReactNode
}

const SHELF_ICON: Record<PickerShelf, LucideIcon> = {
  project: FolderOpen,
  archiv: Archive,
  session: MessageSquare,
  base: BookMarked,
}

type Item = { type: 'folder'; folder: FolderItem } | { type: 'doc'; doc: PickerDocument }

export const DocumentPickerDialog: FC<DocumentPickerDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  documents,
  folders = [],
  loading = false,
  multiple = true,
  initialSelected = [],
  disabledReason,
  confirmLabel,
  onConfirm,
  footer,
}) => {
  const t = useTranslations('files')
  const { locale } = useI18n()
  const shelves = PICKER_SHELVES.filter(
    (shelf) => shelf === 'project' || documents.some((doc) => shelfOf(doc) === shelf)
  )
  const home: PickerPlace = { kind: 'shelf', shelf: 'project', folderId: null }
  const [history, setHistory] = useState<{ stack: PickerPlace[]; index: number }>({ stack: [home], index: 0 })
  const place = history.stack[history.index] ?? home
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PickerSort>({ key: 'name', direction: 'asc' })
  const [selected, setSelected] = useState<string[]>([])
  const [focus, setFocus] = useState(0)

  // Each opening starts from the caller's choice, at the project's root.
  useEffect(() => {
    if (!open) return
    setSelected(initialSelected.map(fold))
    setHistory({ stack: [home], index: 0 })
    setQuery('')
    setFocus(0)
    // The caller's list is read at the moment the panel opens, not after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const byKey = useMemo(() => new Map(documents.map((doc) => [fold(doc.name), doc])), [documents])
  const contents = useMemo(
    () => contentsAt(place, { documents, folders, selected: selectedSet, query, sort, locale }),
    [place, documents, folders, selectedSet, query, sort, locale]
  )
  const items: Item[] = [
    ...contents.folders.map((folder) => ({ type: 'folder' as const, folder })),
    ...contents.documents.map((doc) => ({ type: 'doc' as const, doc })),
  ]
  const focused = items[Math.min(focus, items.length - 1)]

  const go = (next: PickerPlace): void => {
    if (samePlace(next, place)) return
    setHistory(({ stack, index }) => ({ stack: [...stack.slice(0, index + 1), next], index: index + 1 }))
    setFocus(0)
  }
  const up = (): void => {
    if (place.kind !== 'shelf' || !place.folderId) return
    const parent = folders.find((folder) => folder.id === place.folderId)?.parentId ?? null
    go({ ...place, folderId: parent })
  }

  const reasonOf = (doc: PickerDocument): string | null => disabledReason?.(doc) ?? null
  const toggle = (doc: PickerDocument): void => {
    if (reasonOf(doc)) return
    const key = fold(doc.name)
    setSelected((current) =>
      current.includes(key) ? current.filter((name) => name !== key) : multiple ? [...current, key] : [key]
    )
  }
  const chosen = selected.flatMap((key) => {
    const doc = byKey.get(key)
    return doc ? [doc] : []
  })
  const confirm = (docs: PickerDocument[] = chosen): void => {
    if (docs.length === 0) return
    onConfirm(docs)
    onOpenChange(false)
  }

  const activate = (item: Item): void => {
    if (item.type === 'folder') {
      go({ kind: 'shelf', shelf: 'project', folderId: item.folder.id })
      return
    }
    if (!multiple && !reasonOf(item.doc)) confirm([item.doc])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setFocus((index) => Math.min(index + 1, items.length - 1))
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      if (event.metaKey) up()
      else setFocus((index) => Math.max(index - 1, 0))
    } else if (event.key === ' ' && focused?.type === 'doc') {
      event.preventDefault()
      toggle(focused.doc)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (focused?.type === 'folder') activate(focused)
      else confirm()
    } else if (event.key === 'Backspace') {
      up()
    }
  }

  const onSort = (key: string): void =>
    setSort((current) => ({
      key: key as PickerSortKey,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }))

  const columns: PickerColumn[] = [
    { key: 'name', label: t('picker.columns.name'), width: 'minmax(0,1fr)' },
    { key: 'date', label: t('picker.columns.date'), width: '7.5rem', wide: true },
    { key: 'size', label: t('picker.columns.size'), width: '4.5rem', align: 'end', wide: true },
    { key: 'kind', label: t('picker.columns.kind'), width: '3.5rem', wide: true },
  ]

  const placeLabel = (target: PickerPlace): string =>
    target.kind === 'recent'
      ? t('picker.recent')
      : target.kind === 'selected'
        ? t('picker.selected')
        : t(`picker.shelves.${target.shelf}`)
  const path =
    place.kind === 'shelf'
      ? [
          { label: placeLabel({ ...place, folderId: null }), onClick: () => go({ ...place, folderId: null }) },
          ...folderTrail(place.folderId, folders).map((folder) => ({
            label: folder.name,
            onClick: () => go({ kind: 'shelf', shelf: 'project', folderId: folder.id }),
          })),
        ]
      : [{ label: placeLabel(place) }]

  const date = (doc: PickerDocument): string =>
    doc.file?.createdAt ? formatCalendarDate(doc.file.createdAt, locale) : '—'
  const metaOf = (doc: PickerDocument): string | undefined => {
    const where = place.kind !== 'shelf' || query ? t(`picker.shelves.${shelfOf(doc)}`) : undefined
    return [where, doc.title && doc.title !== doc.name ? doc.name : undefined].filter(Boolean).join(' · ') || undefined
  }

  const places: { target: PickerPlace; icon: LucideIcon; count?: number; testId: string }[] = [
    { target: { kind: 'recent' }, icon: Clock, testId: 'picker-place-recent' },
    ...shelves.map((shelf) => ({
      target: { kind: 'shelf' as const, shelf, folderId: null },
      icon: SHELF_ICON[shelf],
      count: documents.filter((doc) => shelfOf(doc) === shelf).length,
      testId: `picker-place-${shelf}`,
    })),
    ...(multiple
      ? [{ target: { kind: 'selected' as const }, icon: CircleCheck, count: selected.length, testId: 'picker-place-selected' }]
      : []),
  ]

  const renderItem = (item: Item, index: number): ReactNode => {
    const isFocused = index === focus
    if (item.type === 'folder') {
      const count = folderCount(item.folder.id, documents, folders)
      const key = `folder-${item.folder.id}`
      const props = {
        name: item.folder.name,
        meta: t('picker.folderCount', { count }),
        folder: true,
        selected: false,
        focused: isFocused,
        onClick: () => setFocus(index),
        onDoubleClick: () => activate(item),
        testId: 'picker-folder',
      }
      return view === 'grid' ? (
        <PickerTile key={key} {...props} glyph={<KindGlyph name={item.folder.name} folder size="lg" />} />
      ) : (
        <PickerRow
          key={key}
          {...props}
          columns={columns}
          glyph={<KindGlyph name={item.folder.name} folder />}
          cells={{ date: '', size: '', kind: '' }}
        />
      )
    }
    const { doc } = item
    const key = `doc-${doc.name}`
    const props = {
      name: pickerLabel(doc),
      meta: metaOf(doc),
      selected: selectedSet.has(fold(doc.name)),
      focused: isFocused,
      disabledReason: reasonOf(doc),
      onClick: () => {
        setFocus(index)
        toggle(doc)
      },
      onDoubleClick: () => activate(item),
      testId: 'picker-doc',
    }
    return view === 'grid' ? (
      <PickerTile
        key={key}
        {...props}
        glyph={<KindGlyph name={doc.name} contentType={doc.file?.contentType} tags={doc.file?.tags} size="lg" />}
      />
    ) : (
      <PickerRow
        key={key}
        {...props}
        columns={columns}
        glyph={<KindGlyph name={doc.name} contentType={doc.file?.contentType} tags={doc.file?.tags} />}
        cells={{
          date: date(doc),
          size: doc.file?.fileSize ? formatBytes(doc.file.fileSize, locale) : '—',
          kind: fileExtensionLabel(doc.name) || '—',
        }}
      />
    )
  }

  const empty = loading
    ? t('picker.loading')
    : query
      ? t('picker.noMatches', { query })
      : place.kind === 'selected'
        ? t('picker.selectedEmpty')
        : t('picker.empty')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        data-testid="document-picker"
      >
        <div className="border-border flex flex-col gap-0.5 border-b px-4 py-3 pr-12">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-xs">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[12.5rem_minmax(0,1fr)] lg:grid-cols-[12.5rem_minmax(0,1fr)_15rem]">
          <PickerSidebar label={t('picker.places')}>
            <PickerSidebarGroup label={t('picker.places')}>
              {places.map(({ target, icon, count, testId }) => (
                <PickerSidebarItem
                  key={testId}
                  icon={icon}
                  label={placeLabel(target)}
                  count={count}
                  active={
                    target.kind === 'shelf'
                      ? place.kind === 'shelf' && place.shelf === target.shelf && !place.folderId
                      : samePlace(target, place)
                  }
                  onClick={() => go(target)}
                  testId={testId}
                />
              ))}
            </PickerSidebarGroup>
            {folders.some((folder) => !folder.parentId) && (
              <PickerSidebarGroup label={t('picker.folders')}>
                {folders
                  .filter((folder) => !folder.parentId)
                  .sort((a, b) => a.name.localeCompare(b.name, locale, { numeric: true }))
                  .map((folder) => (
                    <PickerSidebarItem
                      key={folder.id}
                      icon={Folder}
                      label={folder.name}
                      count={folderCount(folder.id, documents, folders)}
                      active={place.kind === 'shelf' && place.folderId === folder.id}
                      onClick={() => go({ kind: 'shelf', shelf: 'project', folderId: folder.id })}
                    />
                  ))}
              </PickerSidebarGroup>
            )}
          </PickerSidebar>

          <div className="flex min-h-0 min-w-0 flex-col">
            <PickerToolbar>
              <PickerIconButton
                icon={ChevronLeft}
                label={t('picker.back')}
                disabled={history.index === 0}
                onClick={() => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }))}
                testId="picker-back"
              />
              <PickerIconButton
                icon={ChevronRight}
                label={t('picker.forward')}
                disabled={history.index >= history.stack.length - 1}
                onClick={() => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }))}
                testId="picker-forward"
              />
              <PickerPath segments={path} label={t('picker.path')} />
              <span className="flex shrink-0 items-center">
                <PickerIconButton
                  icon={List}
                  label={t('picker.viewList')}
                  pressed={view === 'list'}
                  onClick={() => setView('list')}
                  testId="picker-view-list"
                />
                <PickerIconButton
                  icon={LayoutGrid}
                  label={t('picker.viewGrid')}
                  pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                  testId="picker-view-grid"
                />
              </span>
              <SearchField
                value={query}
                onChange={(value) => {
                  setQuery(value)
                  setFocus(0)
                }}
                placeholder={t('picker.searchPlaceholder', { place: path[path.length - 1]?.label ?? '' })}
                label={t('picker.search')}
                clearLabel={t('picker.clearSearch')}
                className="w-full sm:w-44 lg:w-52"
              />
            </PickerToolbar>
            <PickerPlaceStrip>
              {places.map(({ target, icon, count, testId }) => (
                <PickerSidebarItem
                  key={`strip-${testId}`}
                  icon={icon}
                  label={placeLabel(target)}
                  count={count}
                  active={target.kind === 'shelf' ? place.kind === 'shelf' && place.shelf === target.shelf : samePlace(target, place)}
                  onClick={() => go(target)}
                />
              ))}
            </PickerPlaceStrip>
            <PickerItems
              label={t('picker.items')}
              view={view}
              multiple={multiple}
              onKeyDown={onKeyDown}
              header={
                view === 'list' && items.length > 0 ? (
                  <PickerListHeader columns={columns} sort={sort} onSort={onSort} />
                ) : undefined
              }
            >
              {items.length === 0 ? (
                <PickerEmpty icon={query ? SearchX : FolderOpen}>{empty}</PickerEmpty>
              ) : (
                items.map(renderItem)
              )}
            </PickerItems>
          </div>

          <PickerPreviewPane label={t('picker.preview')}>
            {!focused ? (
              <PickerPreviewNote>{t('picker.previewEmpty')}</PickerPreviewNote>
            ) : focused.type === 'folder' ? (
              <>
                <KindGlyph name={focused.folder.name} folder size="lg" />
                <PickerPreviewTitle title={focused.folder.name} />
                <PickerFacts
                  facts={[
                    { label: t('picker.facts.contains'), value: t('picker.folderCount', { count: folderCount(focused.folder.id, documents, folders) }) },
                  ]}
                />
              </>
            ) : (
              <>
                <KindGlyph
                  name={focused.doc.name}
                  contentType={focused.doc.file?.contentType}
                  tags={focused.doc.file?.tags}
                  size="lg"
                />
                <PickerPreviewTitle
                  title={pickerLabel(focused.doc)}
                  subtitle={focused.doc.title && focused.doc.title !== focused.doc.name ? focused.doc.name : undefined}
                />
                <PickerFacts
                  facts={[
                    { label: t('picker.facts.shelf'), value: t(`picker.shelves.${shelfOf(focused.doc)}`) },
                    { label: t('picker.facts.kind'), value: fileExtensionLabel(focused.doc.name) || '—' },
                    ...(focused.doc.file?.fileSize
                      ? [{ label: t('picker.facts.size'), value: formatBytes(focused.doc.file.fileSize, locale) }]
                      : []),
                    ...(focused.doc.file?.pageCount
                      ? [{ label: t('picker.facts.pages'), value: String(focused.doc.file.pageCount) }]
                      : []),
                    ...(focused.doc.file?.createdAt ? [{ label: t('picker.facts.added'), value: date(focused.doc) }] : []),
                  ]}
                />
                {focused.doc.file?.summary && <PickerPreviewNote>{focused.doc.file.summary}</PickerPreviewNote>}
              </>
            )}
          </PickerPreviewPane>
        </div>

        <PickerFooter
          start={
            <>
              <PickerSummary>
                {selected.length > 0 ? t('picker.selectedCount', { count: selected.length }) : t('picker.nothingSelected')}
              </PickerSummary>
              {selected.length > 0 && (
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setSelected([])}>
                  {t('picker.clear')}
                </Button>
              )}
              {footer}
            </>
          }
          end={
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t('picker.cancel')}
              </Button>
              <Button size="sm" disabled={selected.length === 0} onClick={() => confirm()} data-testid="picker-confirm">
                {confirmLabel}
              </Button>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
