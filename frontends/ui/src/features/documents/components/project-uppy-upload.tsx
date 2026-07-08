'use client'

import { useRef } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { DEFAULT_ACCEPTED_FILE_TYPES } from '../constants'

interface ProjectUppyUploadProps {
  projectId: string
  folderId: string | null
  onUpload: (files: File[]) => void
  isUploading: boolean
  /** Visual variant of the trigger button. */
  variant?: 'default' | 'outline'
  size?: 'sm' | 'default'
  label?: string
}

/**
 * Upload trigger for the project corpus. Files selected here are persisted to the
 * project's durable document collection (not a throwaway chat session), so they
 * ground Grid's answers for the whole project. Presentation only — validation and
 * orchestration stay in the useFileUpload hook (the onUpload contract).
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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      onUpload(Array.from(fileList))
    }
    e.target.value = ''
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={DEFAULT_ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={handleChange}
        data-testid="project-upload-input"
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        size={size}
        variant={variant}
        className="gap-2"
      >
        {isUploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
        {isUploading ? t('upload.uploading') : buttonLabel}
      </Button>
    </>
  )
}
