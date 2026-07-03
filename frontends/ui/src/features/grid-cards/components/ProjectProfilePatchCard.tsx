// SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Card, Flex, Text } from '@/adapters/ui'

interface PreviewItem {
  label: string
  before: string
  after: string
}

interface ProjectProfilePatchCardProps {
  title: string
  rationale: string
  preview: PreviewItem[]
  patch: Array<{ op: string; path: string; value: unknown }>
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
      <Card className="border-l-4 border-l-success border-base bg-surface-raised-30 p-4">
        <Flex direction="col" gap="2">
          <Text kind="body/regular/sm" className="text-primary">Project context updated.</Text>
        </Flex>
      </Card>
    )
  }

  if (status === 'rejected') {
    return (
      <Card className="border-l-4 border-l-subtle border-base bg-surface-raised-30 p-4">
        <Flex direction="col" gap="2">
          <Text kind="body/regular/sm" className="text-subtle">Changes discarded.</Text>
        </Flex>
      </Card>
    )
  }

  return (
    <Card className="border-l-4 border-l-warning border-base bg-surface-raised-30 p-4">
      <Flex direction="col" gap="3">
        <Text kind="label/semibold/md" className="text-warning">{title}</Text>
        <Text kind="body/regular/sm" className="text-primary">{rationale}</Text>

        {preview.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-base text-subtle">
                <th scope="col" className="py-1 pr-2 text-left font-medium">Field</th>
                <th scope="col" className="p-1 text-left font-medium">Before</th>
                <th scope="col" className="pl-2 text-left font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((item, i) => (
                <tr key={i} className="border-b border-base">
                  <td className="py-1 pr-2 font-medium text-primary">{item.label}</td>
                  <td className="p-1 text-subtle">{item.before}</td>
                  <td className="pl-2 text-primary">{item.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {error && (
          <Text kind="body/regular/sm" className="text-danger">{error}</Text>
        )}

        <Flex gap="2">
          {!projectId && <p className="grid-card__hint">Project ID required to apply changes.</p>}
          <button
            type="button"
            onClick={handleAccept}
            disabled={!projectId || isSubmitting}
            className="rounded bg-brand px-3 py-1 text-sm font-medium text-on-brand hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? 'Applying...' : 'Accept'}
          </button>
          <button
            type="button"
            onClick={handleReject}
            className="rounded border border-base bg-surface-raised px-3 py-1 text-sm font-medium text-primary hover:bg-surface-raised-hovered"
          >
            Reject
          </button>
        </Flex>
      </Flex>
    </Card>
  )
}
