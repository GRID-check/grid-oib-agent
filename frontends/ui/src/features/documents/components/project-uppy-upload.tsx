'use client'

import { useRef } from 'react'
import { ChevronDown, FolderUp, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  /**
   * Offer a second trigger that picks a WHOLE FOLDER.
   *
   * A büro onboarding a project moves a directory tree, not a hand-picked list,
   * and the file picker cannot express that at all. Kept as a separate control
   * rather than a mode on this one: an input carrying `webkitdirectory` can
   * ONLY choose folders, so making it the same button would take away the
   * ordinary case to add the bulk one.
   */
  allowFolders?: boolean
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
  allowFolders = false,
}: ProjectUppyUploadProps) {
  const t = useTranslations('files')
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
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
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={acceptedTypes}
        className="hidden"
        onChange={handleChange}
        data-testid={
          variant === 'dropcard' ? 'project-upload-dropcard-input' : 'project-upload-input'
        }
      />
      {allowFolders && (
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // No `accept`: a folder input applies it to the FOLDER, not to the
          // files inside, and the browser then offers nothing at all. What is
          // acceptable is decided by the validator on the way through, which is
          // where the whole rejected/accepted report comes from anyway.
          //
          // Both spellings, and both as strings: `webkitdirectory` is the one
          // every engine implements and `directory` is the standardised name,
          // and React only forwards these to the DOM when they are strings.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          className="hidden"
          onChange={handleChange}
          data-testid="project-upload-folder-input"
        />
      )}
    </>
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
          className="flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card p-4 text-center transition-colors duration-quick ease-out hover:border-ring hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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

  const trigger = (
    <Button
      type="button"
      onClick={allowFolders ? undefined : () => inputRef.current?.click()}
      disabled={isUploading}
      size={size}
      variant={variant}
      className="gap-2"
    >
      {isUploading ? <Spinner size="sm" /> : <Upload className="size-4" aria-hidden />}
      {isUploading ? t('upload.uploading') : buttonLabel}
      {allowFolders && <ChevronDown className="size-3.5 opacity-70" aria-hidden />}
    </Button>
  )

  if (!allowFolders) {
    return (
      <>
        {input}
        {trigger}
      </>
    )
  }

  // ONE CONTROL, TWO SOURCES.
  //
  // Folder upload first shipped as a second button beside this one, and it cost
  // more than it looked: the action row is in a header that shares its width
  // with the section's description, so an extra full-width button squeezed that
  // text into a four-word column. A second button also overstated the feature —
  // picking a folder is the occasional onboarding move, not a peer of the
  // everyday one.
  //
  // It cannot be folded into the same INPUT (one carrying `webkitdirectory` can
  // only choose folders), so the split lives in a menu instead of in the
  // toolbar: same single affordance, and the choice appears only for the reader
  // who wants it.
  return (
    <>
      {input}
      <DropdownMenu>
        <DropdownMenuTrigger asChild data-testid="project-upload-trigger">
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onSelect={() => inputRef.current?.click()}
            data-testid="project-upload-files-item"
          >
            <Upload className="size-4" aria-hidden />
            {t('upload.uploadFiles')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => folderInputRef.current?.click()}
            data-testid="project-upload-folder-item"
          >
            <FolderUp className="size-4" aria-hidden />
            {t('upload.uploadFolder')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
