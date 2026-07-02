// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import type { FolderItem } from './project-file-workspace'

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
              ? 'bg-neutral-100 text-neutral-900 font-medium'
              : 'text-neutral-600 hover:bg-neutral-50'
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span className="mr-2 text-neutral-400">
            {children.length > 0 ? '▾' : '▸'}
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
            ? 'bg-neutral-100 text-neutral-900 font-medium'
            : 'text-neutral-600 hover:bg-neutral-50'
        }`}
      >
        <span className="mr-2">📁</span>
        All Files
      </button>

      {isLoading ? (
        <div className="px-3 py-4 text-sm text-neutral-400">Loading folders...</div>
      ) : (
        renderFolderTree(rootFolders)
      )}

      {/* Create folder */}
      {isCreating ? (
        <div className="px-3 py-1">
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') { setIsCreating(false); setNewFolderName('') }
            }}
            onBlur={() => { if (!newFolderName.trim()) setIsCreating(false) }}
            placeholder="Folder name"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => setIsCreating(true)}
          className="w-full text-left px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-600"
        >
          + New Folder
        </button>
      )}
    </div>
  )
}
