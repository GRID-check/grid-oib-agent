'use client'

import { Loader2, RotateCcw, XCircle } from 'lucide-react'
import type { TrackedFile } from '../types'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatFileSize } from '@/lib/utils/format-file-size'

interface ActiveUploadsProps {
  files: TrackedFile[]
  onRetry: (id: string) => void
}

/**
 * Compact live panel for in-flight and failed uploads. Surfaces the per-file
 * progress percentage and the retry affordance that already exist in the upload
 * hook but were never rendered on the Files page.
 */
export function ActiveUploads({ files, onRetry }: ActiveUploadsProps) {
  if (files.length === 0) return null

  return (
    <div className="border-b bg-muted/30 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">Uploads</p>
      <ul className="space-y-2">
        {files.map((file) => {
          const isFailed = file.status === 'failed'
          // The upload flow reports coarse progress; treat a positive value as
          // determinate, otherwise fall back to an indeterminate-feeling bar.
          const value = file.progress > 0 ? file.progress : isFailed ? 0 : 15
          return (
            <li key={file.id} className="flex items-center gap-3">
              <span className="shrink-0">
                {isFailed ? (
                  <XCircle className="size-4 text-destructive" aria-hidden />
                ) : (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm text-foreground">{file.fileName}</p>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatFileSize(file.fileSize)}
                  </span>
                </div>
                {isFailed ? (
                  <p className="truncate text-xs text-destructive">{file.errorMessage ?? 'Upload failed'}</p>
                ) : (
                  <Progress value={value} className="mt-1.5 h-1" />
                )}
              </div>
              {isFailed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                  onClick={() => onRetry(file.id)}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Retry
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
