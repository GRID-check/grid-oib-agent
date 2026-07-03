// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef } from 'react'
import { Button } from '@/components/ui/button'

interface ProjectUppyUploadProps {
  projectId: string
  folderId: string | null
  onUpload: (files: File[]) => void
  isUploading: boolean
}

export function ProjectUppyUpload({ projectId, folderId, onUpload, isUploading }: ProjectUppyUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)

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
        className="hidden"
        onChange={handleChange}
      />
      <Button onClick={() => inputRef.current?.click()} disabled={isUploading} size="sm">
        {isUploading ? 'Uploading...' : 'Upload'}
      </Button>
    </>
  )
}
