'use client'

import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { useAppConfig } from '@/shared/context'
import { DEFAULT_ACCEPTED_FILE_TYPES, DEFAULT_MAX_FILE_SIZE } from '../constants'

interface ProjectUppyUploadProps {
  /** Present for project corpus uploads; omitted for the org-wide Archiv. */
  projectId?: string
  folderId?: string | null
  onUpload: (files: File[]) => void
  isUploading: boolean
  /**
   * Visual variant of the trigger: a button (`default`/`outline`) or the
   * dashed drop-card tile rendered inside the file card grid (`dropcard`).
   */
  variant?: 'default' | 'outline' | 'dropcard'
  size?: 'sm' | 'default'
  label?: string
}

/**
 * Upload trigger for a durable document corpus. Files selected here are
 * persisted to the target collection (a project's corpus or the org-wide
 * Archiv), not a throwaway chat session. Presentation only — validation and
 * orchestration stay in the useFileUpload hook (the onUpload contract), so
 * `projectId`/`folderId` are unused here and optional.
 */
export function ProjectUppyUpload({
  onUpload,
  isUploading,
  variant = 'default',
  size = 'sm',
  label,
}: ProjectUppyUploadProps) {
  const t = useTranslations('files')
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonLabel = label ?? t('upload.upload')
  // Server-computed, flag-gated accept-list and size limit (image types only
  // when the `image-upload` flag allows). Falls back to the static defaults if
  // the AppConfig provider is somehow absent (e.g. isolated tests).
  const fileUpload = useAppConfig().fileUpload
  const acceptedTypes = fileUpload?.acceptedTypes ?? DEFAULT_ACCEPTED_FILE_TYPES
  const maxFileSize = fileUpload?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      onUpload(Array.from(fileList))
    }
    e.target.value = ''
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={acceptedTypes}
      className="hidden"
      onChange={handleChange}
      data-testid={variant === 'dropcard' ? 'project-upload-dropcard-input' : 'project-upload-input'}
    />
  )

  if (variant === 'dropcard') {
    // The REAL accepted extensions/limit, prettified ("PDF, DOCX, TXT, MD").
    const typesLabel = acceptedTypes
      .split(',')
      .map((ext) => ext.trim().replace(/^\./, '').toUpperCase())
      .filter(Boolean)
      .join(', ')
    return (
      <>
        {input}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          data-testid="project-upload-dropcard"
          className="flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card/50 p-4 text-center transition-colors duration-200 ease-out hover:border-ring hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isUploading ? (
            <Spinner size="default" className="text-muted-foreground" />
          ) : (
            <Upload className="size-5 text-muted-foreground" aria-hidden />
          )}
          <span className="text-sm font-medium text-foreground">
            {isUploading ? t('upload.uploading') : t('uploadZone.dragOrBrowse')}
          </span>
          <span className="text-xs text-muted-foreground">
            {typesLabel} · {t('uploadZone.maxSizeShort', { size: Math.round(maxFileSize / (1024 * 1024)) })}
          </span>
        </button>
      </>
    )
  }

  return (
    <>
      {input}
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        size={size}
        variant={variant}
        className="gap-2"
      >
        {isUploading ? <Spinner size="sm" /> : <Upload className="size-4" aria-hidden />}
        {isUploading ? t('upload.uploading') : buttonLabel}
      </Button>
    </>
  )
}
