// SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface PreviewItem {
  label: string
  before: string
  after: string
}

interface ProjectProfilePatchCardProps {
  title: string
  rationale: string
  preview: PreviewItem[]
  patch: Array<{ op: string; path: string; value?: unknown }>
  projectId?: string | null
}

export function ProjectProfilePatchCard({
  title,
  rationale,
  preview,
  patch,
  projectId,
}: ProjectProfilePatchCardProps) {
  const [status, setStatus] = useState<'pending' | 'accepted' | 'rejected'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleAccept = async () => {
    if (!projectId) {
      setError('Project ID required to apply changes.')
      return
    }
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/profile/patches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed (${res.status})`)
      }
      setIsSubmitting(false)
      setStatus('accepted')
    } catch (e) {
      setIsSubmitting(false)
      setError(e instanceof Error ? e.message : 'Failed to apply patch')
    }
  }

  const handleReject = () => {
    setStatus('rejected')
    setError(null)
  }

  if (status === 'accepted') {
    return (
      <Card className="border-l-success border-base bg-surface-raised-30 gap-2 border-l-4 p-4">
        <p className="text-primary text-sm">Project context updated.</p>
      </Card>
    )
  }

  if (status === 'rejected') {
    return (
      <Card className="border-l-subtle border-base bg-surface-raised-30 gap-2 border-l-4 p-4">
        <p className="text-subtle text-sm">Changes discarded.</p>
      </Card>
    )
  }

  return (
    <Card className="border-l-warning border-base bg-surface-raised-30 gap-3 border-l-4 p-4">
      <p className="text-warning text-sm font-semibold">{title}</p>
      <p className="text-primary text-sm">{rationale}</p>

      {preview.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-base text-subtle border-b">
              <th scope="col" className="py-1 pr-2 text-left font-medium">Field</th>
              <th scope="col" className="p-1 text-left font-medium">Before</th>
              <th scope="col" className="pl-2 text-left font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((item, i) => (
              <tr key={i} className="border-base border-b">
                <td className="text-primary py-1 pr-2 font-medium">{item.label}</td>
                <td className="text-subtle p-1">{item.before}</td>
                <td className="text-primary pl-2">{item.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="flex items-center gap-2">
        {!projectId && (
          <p className="text-subtle text-xs">Project ID required to apply changes.</p>
        )}
        <Button
          type="button"
          size="sm"
          onClick={handleAccept}
          disabled={!projectId || isSubmitting}
        >
          {isSubmitting ? 'Applying...' : 'Accept'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleReject}>
          Reject
        </Button>
      </div>
    </Card>
  )
}
