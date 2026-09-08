/**
 * Right-click on empty canvas in the file listing: New folder / Upload, then
 * View and Sort — the Finder/Explorer empty-space menu, mapped onto operations
 * this workspace already has.
 */

import { FolderPlus, FolderUp, Upload } from 'lucide-react'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import type { FileSort, FileSortKey } from '../lib/file-sort'

export interface ListingActionLabels {
  newFolder: string
  uploadFiles: string
  uploadFolder: string
  viewCards: string
  viewList: string
  sortName: string
  sortStatus: string
  sortSize: string
  sortAdded: string
}

export interface ListingActionEntriesInput {
  labels: ListingActionLabels
  view: 'cards' | 'list'
  sort: FileSort
  onNewFolder?: () => void
  onUploadFiles?: () => void
  onUploadFolder?: () => void
  onViewChange?: (view: 'cards' | 'list') => void
  onSortChange?: (sort: FileSort) => void
}

const SORT_KEYS: { key: FileSortKey; labelKey: keyof Pick<ListingActionLabels, 'sortName' | 'sortStatus' | 'sortSize' | 'sortAdded'> }[] = [
  { key: 'name', labelKey: 'sortName' },
  { key: 'status', labelKey: 'sortStatus' },
  { key: 'size', labelKey: 'sortSize' },
  { key: 'added', labelKey: 'sortAdded' },
]

export function listingActionEntries({
  labels,
  view,
  sort,
  onNewFolder,
  onUploadFiles,
  onUploadFolder,
  onViewChange,
  onSortChange,
}: ListingActionEntriesInput): ActionMenuEntry[] {
  const entries: ActionMenuEntry[] = []

  if (onNewFolder) {
    entries.push({
      type: 'item',
      id: 'new-folder',
      label: labels.newFolder,
      icon: FolderPlus,
      onSelect: onNewFolder,
      testId: 'listing-action-new-folder',
    })
  }
  if (onUploadFiles) {
    entries.push({
      type: 'item',
      id: 'upload-files',
      label: labels.uploadFiles,
      icon: Upload,
      onSelect: onUploadFiles,
      testId: 'listing-action-upload-files',
    })
  }
  if (onUploadFolder) {
    entries.push({
      type: 'item',
      id: 'upload-folder',
      label: labels.uploadFolder,
      icon: FolderUp,
      onSelect: onUploadFolder,
      testId: 'listing-action-upload-folder',
    })
  }

  if (onViewChange) {
    if (entries.length > 0) entries.push({ type: 'separator' })
    entries.push({
      type: 'radio-group',
      value: view,
      onValueChange: (value) => {
        if (value === 'cards' || value === 'list') onViewChange(value)
      },
      items: [
        { value: 'cards', label: labels.viewCards, testId: 'listing-view-cards' },
        { value: 'list', label: labels.viewList, testId: 'listing-view-list' },
      ],
    })
  }

  if (onSortChange) {
    entries.push({ type: 'separator' })
    entries.push({
      type: 'radio-group',
      value: sort.key,
      onValueChange: (value) => {
        const key = SORT_KEYS.find((row) => row.key === value)?.key
        if (!key) return
        onSortChange({
          key,
          direction: key === 'name' ? 'asc' : 'desc',
        })
      },
      items: SORT_KEYS.map((row) => ({
        value: row.key,
        label: labels[row.labelKey],
        testId: `listing-sort-${row.key}`,
      })),
    })
  }

  return entries
}
