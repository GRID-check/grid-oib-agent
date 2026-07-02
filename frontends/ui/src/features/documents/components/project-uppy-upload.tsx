// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef } from 'react'

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
      <button
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        className="inline-flex items-center rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
      >
        {isUploading ? 'Uploading...' : 'Upload'}
      </button>
    </>
  )
}
