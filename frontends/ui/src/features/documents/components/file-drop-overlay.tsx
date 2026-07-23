'use client'

import { useEffect } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Prevent the browser from navigating away when a file is dropped anywhere
 * outside a drop target. Both file workspaces installed this identical
 * window-level guard; this owns it once.
 */
export function useWindowDragGuard(): void {
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])
}

interface FileDropOverlayProps {
  /** True when the dragged payload is a type the surface can't accept. */
  isUnsupported: boolean
  uploadLabel: string
  unsupportedLabel: string
  testId: string
}

/**
 * The dashed full-surface overlay shown while a file is dragged over a
 * workspace. Identical across the Files and Archiv workspaces (they differ only
 * in the test id), so it lives here once. Callers gate rendering on their own
 * drag + permission state.
 */
export function FileDropOverlay({ isUnsupported, uploadLabel, unsupportedLabel, testId }: FileDropOverlayProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center',
        isUnsupported ? 'border-destructive bg-destructive/5' : 'border-ring bg-primary/5 backdrop-blur-sm'
      )}
      data-testid={testId}
    >
      <Upload className={cn('size-6', isUnsupported ? 'text-destructive' : 'text-primary')} aria-hidden />
      <p className={cn('text-sm font-medium', isUnsupported ? 'text-destructive' : 'text-primary')}>
        {isUnsupported ? unsupportedLabel : uploadLabel}
      </p>
    </div>
  )
}
