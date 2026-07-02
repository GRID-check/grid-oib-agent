// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectFileWorkspace } from './project-file-workspace'

vi.mock('../hooks/use-project-documents', () => ({
  useProjectDocuments: vi.fn().mockReturnValue({
    uploadFiles: vi.fn(),
    isUploading: false,
    trackedFiles: [],
  }),
}))

describe('ProjectFileWorkspace', () => {
  it('renders the file workspace', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(screen.getByText(/Test \/ Files/i)).toBeDefined()
  })
})
