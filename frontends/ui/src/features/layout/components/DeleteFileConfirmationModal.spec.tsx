// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect } from 'vitest'
import { DeleteFileConfirmationModal } from './DeleteFileConfirmationModal'

describe('DeleteFileConfirmationModal', () => {
  test('renders modal when open', () => {
    render(<DeleteFileConfirmationModal open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByText('Delete File')).toBeInTheDocument()
    expect(screen.getByText(/you are about to delete this file/i)).toBeInTheDocument()
    expect(screen.getByText(/this action cannot be reversed/i)).toBeInTheDocument()
  })

  test('names the file being deleted', () => {
    render(
      <DeleteFileConfirmationModal
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        fileName="OIB-330.pdf"
      />
    )

    expect(screen.getByText(/OIB-330\.pdf/)).toBeInTheDocument()
  })

  test('does not render when closed', () => {
    render(<DeleteFileConfirmationModal open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.queryByText('Delete File')).not.toBeInTheDocument()
  })

  test('calls onConfirm and closes when delete is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <DeleteFileConfirmationModal open={true} onOpenChange={onOpenChange} onConfirm={onConfirm} />
    )

    await user.click(screen.getByRole('button', { name: /delete file/i }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('renders cancel button', () => {
    render(<DeleteFileConfirmationModal open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })
})
