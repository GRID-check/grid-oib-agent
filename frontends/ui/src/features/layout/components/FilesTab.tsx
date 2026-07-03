// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FilesTab Component
 *
 * Sub-tab within ThinkingTab displaying files created/modified during deep research.
 * Shows file artifacts like drafts, reports, and other generated content.
 *
 * SSE Events: artifact.update with type: "file"
 */

'use client'

import { type FC } from 'react'
import { FileText } from 'lucide-react'
import { useChatStore } from '@/features/chat/store'
import { FileCard } from './FileCard'
import { EMPTY_RESEARCH_DETAILS_HELP_TEXT } from './research-empty-state-copy'

/**
 * Files sub-tab content showing file artifacts from deep research.
 * Consumes deepResearchFiles from the chat store.
 */
export const FilesTab: FC = () => {
  // Get files from the dedicated store array
  const files = useChatStore((state) => state.deepResearchFiles)
  const isEmpty = files.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">Files</span>
          {files.length > 0 && (
            <span className="text-xs text-muted-foreground">{files.length}</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Generated drafts, reports, and other file artifacts.
        </span>
      </div>

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <FileText className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No generated files available.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {EMPTY_RESEARCH_DETAILS_HELP_TEXT}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {files.map((file) => (
            <div key={file.id} className="shrink-0">
              <FileCard file={file} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
