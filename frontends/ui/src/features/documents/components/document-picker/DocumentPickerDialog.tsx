'use client'

/**
 * The document picker: an open panel over the page, for any surface that
 * needs the reader to name documents — the research plan's Unterlagen, a
 * document added to a running research, and whatever asks next.
 *
 * It is the Files browser in a dialog, not a second one. The listing is
 * `FileBrowserPane` in its selection mode: the same `FileCard`s with their real
 * page thumbnails, the same detail list with its sortable columns, the same
 * folder cards and path row (read-only here — a picker browses the tree, it
 * does not file into it), the same empty states and level motion. What the
 * picker adds is only what a picker is: places on the left (the project, the
 * Büroarchiv, what is already chosen), a checkbox on every document, and the
 * choice at the bottom.
 *
 * The picker knows nothing of what a choice means. The caller names the
 * button, says which documents cannot be chosen and why, and may put its own
 * control beside the selection summary (`footer`).
 */

import { useEffect, useId, useMemo, useState, type FC, type ReactNode } from 'react'
import { Archive, CircleCheck, FolderOpen, LayoutGrid, List, type LucideIcon } from 'lucide-react'
import { AnimatePresence } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import { FileSearchField } from '@/features/documents/components/file-search-bar'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'
import { useFileSearch } from '@/features/documents/hooks/use-file-search'
import type { LibraryDocument } from '@/features/documents/hooks/use-document-library'
import type { FileSelection } from '@/features/documents/lib/file-selection'
import { DEFAULT_FILE_SORT, type FileSort } from '@/features/documents/lib/file-sort'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { foldName } from '@/lib/text/fold'
import {
  PickerBody,
  PickerFooter,
  PickerFooterAction,
  PickerListing,
  PickerPlaceStrip,
  PickerSidebar,
  PickerSidebarItem,
  PickerSummary,
  PickerToolbar,
} from './picker-atoms'

/** A document the picker can offer: its name (the identity it is handed back by), where it sits, and its file row. */
export type PickerDocument = LibraryDocument

type Place = 'project' | 'archiv' | 'selected'

export interface DocumentPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  documents: readonly PickerDocument[]
  /** The project's folders; its documents are browsed by folder. */
  folders?: readonly FolderItem[]
  loading?: boolean
  /** Several documents, or exactly one. */
  multiple?: boolean
  /** Names already chosen when the panel opens. */
  initialSelected?: readonly string[]
  /** Why a document cannot be chosen here, or null when it can. */
  disabledReason?: (doc: PickerDocument) => string | null
  confirmLabel: string
  /**
   * The chosen documents. May be empty when the panel opened with a choice
   * and the reader took it all back: confirming that is how a list is cleared.
   */
  onConfirm: (docs: PickerDocument[]) => void
  /** The caller's own control, beside the selection summary. */
  footer?: ReactNode
}

const PLACE_ICON: Record<Place, LucideIcon> = { project: FolderOpen, archiv: Archive, selected: CircleCheck }

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
  const search = useFileSearch({})
  const [place, setPlace] = useState<Place>('project')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [view, setView] = useState<'cards' | 'list'>('cards')
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)
  const [selected, setSelected] = useState<string[]>([])
  const [initial, setInitial] = useState<string[]>([])
  const sidebarPill = useId()
  const stripPill = useId()

  // Each opening starts from the caller's choice, at the project's root.
  useEffect(() => {
    if (!open) return
    const start = initialSelected.map(foldName)
    setSelected(start)
    setInitial(start)
    setPlace('project')
    setFolderId(null)
    search.clear()
    // The caller's list is read at the moment the panel opens, not after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const byFileId = useMemo(() => new Map(documents.map((doc) => [doc.file.id, doc])), [documents])
  const byKey = useMemo(() => new Map(documents.map((doc) => [foldName(doc.name), doc])), [documents])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const projectFiles = useMemo(
    () => documents.filter((doc) => doc.shelf === 'project').map((doc) => doc.file),
    [documents]
  )
  const archivFiles = useMemo(
    () => documents.filter((doc) => doc.shelf === 'archiv').map((doc) => doc.file),
    [documents]
  )
  const chosen = selected.flatMap((key) => {
    const doc = byKey.get(key)
    return doc ? [doc] : []
  })
  const chosenFiles = chosen.map((doc) => doc.file)

  const corpus = place === 'project' ? projectFiles : place === 'archiv' ? archivFiles : chosenFiles
  const level = place === 'project' ? projectFiles.filter((file) => (file.folderId ?? null) === folderId) : corpus

  const reasonOf = (file: FileItem): string | null => {
    const doc = byFileId.get(file.id)
    return doc ? (disabledReason?.(doc) ?? null) : null
  }
  const toggle = (file: FileItem): void => {
    const doc = byFileId.get(file.id)
    if (!doc || reasonOf(file)) return
    const key = foldName(doc.name)
    setSelected((current) =>
      current.includes(key) ? current.filter((name) => name !== key) : multiple ? [...current, key] : [key]
    )
  }
  const selection: FileSelection = {
    isChecked: (file) => {
      const doc = byFileId.get(file.id)
      return doc ? selectedSet.has(foldName(doc.name)) : false
    },
    onToggle: toggle,
    disabledReason: reasonOf,
    label: (file) => t('picker.choose', { name: documentDisplayName(file) }),
  }

  const changed = selected.length !== initial.length || selected.some((key, index) => key !== initial[index])
  // An empty choice confirms only when it is a change: that is how a list is cleared.
  const canConfirm = chosen.length > 0 || (initial.length > 0 && changed)
  const confirm = (): void => {
    if (!canConfirm) return
    onConfirm(chosen)
    onOpenChange(false)
  }

  const go = (next: Place): void => {
    setPlace(next)
    setFolderId(null)
  }
  const places: { place: Place; count: number }[] = [
    { place: 'project', count: projectFiles.length },
    ...(archivFiles.length > 0 ? [{ place: 'archiv' as const, count: archivFiles.length }] : []),
    ...(multiple ? [{ place: 'selected' as const, count: selected.length }] : []),
  ]
  const placeItem = (entry: { place: Place; count: number }, pillId: string, strip = false) => (
    <PickerSidebarItem
      key={entry.place}
      icon={PLACE_ICON[entry.place]}
      label={t(`picker.places.${entry.place}`)}
      count={entry.count}
      active={place === entry.place}
      pillId={pillId}
      onClick={() => go(entry.place)}
      testId={strip ? undefined : `picker-place-${entry.place}`}
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 outline-none sm:max-w-6xl"
        // The panel takes focus, not its search field: a picker is browsed
        // first, and on a phone a focused field raises the keyboard over the
        // very listing the reader came to see.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        data-testid="document-picker"
      >
        <DialogHeader className="border-b px-5 pb-3 pt-4 pr-12">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>

        <PickerBody>
          <PickerSidebar label={t('picker.placesLabel')}>
            {places.map((entry) => placeItem(entry, sidebarPill))}
          </PickerSidebar>

          <PickerListing>
            <PickerToolbar>
              <FileSearchField
                className="min-w-0 flex-1"
                value={search.query}
                onChange={search.setQuery}
                onSubmit={search.run}
                onClear={search.clear}
                placeholder={t('browser.searchPlaceholder')}
                searchLabel={t('browser.searchLabel')}
                resetLabel={t('browser.resetSearch')}
              />
              <ToggleGroup
                type="single"
                value={view}
                onValueChange={(value) => {
                  if (value === 'cards' || value === 'list') setView(value)
                }}
                segmented
                size="icon-sm"
                aria-label={t('workspace.view.label')}
              >
                <ToggleGroupItem
                  value="cards"
                  aria-label={t('workspace.view.cards')}
                  title={t('workspace.view.cards')}
                  data-testid="picker-view-cards"
                >
                  <LayoutGrid />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="list"
                  aria-label={t('workspace.view.list')}
                  title={t('workspace.view.list')}
                  data-testid="picker-view-list"
                >
                  <List />
                </ToggleGroupItem>
              </ToggleGroup>
            </PickerToolbar>
            <PickerPlaceStrip>{places.map((entry) => placeItem(entry, stripPill, true))}</PickerPlaceStrip>
            <FileBrowserPane
              key={place}
              files={level}
              searchFiles={corpus}
              selectedFileId={null}
              onSelectFile={(id) => {
                const doc = id ? byFileId.get(id) : undefined
                if (!doc) return
                if (!multiple && !reasonOf(doc.file)) {
                  onConfirm([doc])
                  onOpenChange(false)
                  return
                }
                toggle(doc.file)
              }}
              isLoading={loading && documents.length === 0}
              folderNav={
                place === 'project' && folders.length > 0
                  ? { folders: [...folders], currentFolderId: folderId, onNavigate: setFolderId }
                  : undefined
              }
              search={search}
              view={view}
              sort={sort}
              onSortChange={setSort}
              selection={selection}
            />
          </PickerListing>
        </PickerBody>

        <PickerFooter
          start={
            <>
              <PickerSummary>
                {selected.length > 0 ? t('picker.selectedCount', { count: selected.length }) : t('picker.nothingSelected')}
              </PickerSummary>
              <AnimatePresence initial={false}>
                {selected.length > 0 && (
                  <PickerFooterAction key="clear" label={t('picker.clear')} onClick={() => setSelected([])} />
                )}
              </AnimatePresence>
              {footer}
            </>
          }
          end={
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t('picker.cancel')}
              </Button>
              <Button size="sm" disabled={!canConfirm} onClick={confirm} data-testid="picker-confirm">
                {confirmLabel}
              </Button>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
