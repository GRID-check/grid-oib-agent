// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import type { FolderItem } from './project-file-workspace'
import { Folder, ChevronDown, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

interface FolderTreePaneProps {
  folders: FolderItem[]
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  isLoading: boolean
}

export function FolderTreePane({
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  isLoading,
}: FolderTreePaneProps) {
  const [isCreating, setIsCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders])

  const getChildren = (parentId: string) => folders.filter((f) => f.parentId === parentId)

  const handleCreate = async () => {
    if (!newFolderName.trim()) return
    setIsCreating(false)
    const ok = await onCreateFolder(newFolderName.trim(), selectedFolderId ?? undefined)
    if (ok) {
      setNewFolderName('')
    }
  }

  const renderFolderTree = (items: FolderItem[], depth: number = 0): JSX.Element[] => {
    return items.flatMap((folder) => {
      const children = getChildren(folder.id)
      return [
        <button
          key={folder.id}
          onClick={() => onSelectFolder(folder.id)}
          className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
            selectedFolderId === folder.id
              ? 'bg-surface-sunken text-primary font-medium'
              : 'text-secondary hover:bg-surface-sunken'
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span className="mr-2 text-subtle inline-flex items-center">
            {children.length > 0 ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
          {folder.name}
        </button>,
        ...(children.length > 0 ? renderFolderTree(children, depth + 1) : []),
      ]
    })
  }

  return (
    <div className="py-2">
      {/* All Files root */}
      <button
        onClick={() => onSelectFolder(null)}
        className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
          selectedFolderId === null
            ? 'bg-surface-sunken text-primary font-medium'
            : 'text-secondary hover:bg-surface-sunken'
        }`}
      >
        <span className="mr-2 inline-flex items-center"><Folder className="h-4 w-4" /></span>
        All Files
      </button>

      {isLoading ? (
        <div className="space-y-2 p-2">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-1/2 ml-4" />
          <Skeleton className="h-6 w-2/3 ml-4" />
          <Skeleton className="h-6 w-3/5 ml-4" />
          <Skeleton className="h-6 w-4/5" />
        </div>
      ) : (
        renderFolderTree(rootFolders)
      )}

      {/* Create folder */}
      {isCreating ? (
        <div className="px-3 py-1">
          <Input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') { setIsCreating(false); setNewFolderName('') }
            }}
            onBlur={() => { if (!newFolderName.trim()) setIsCreating(false) }}
            placeholder="Folder name"
            className="h-auto py-1 focus-visible:border-brand"
          />
        </div>
      ) : (
        <button
          onClick={() => setIsCreating(true)}
          className="w-full text-left px-3 py-1.5 text-sm text-subtle hover:text-secondary"
        >
          + New Folder
        </button>
      )}
    </div>
  )
}
