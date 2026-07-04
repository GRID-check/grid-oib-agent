'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { motion, springGentle } from '@/components/motion'

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
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={springGentle}>
        <Card className="gap-2 border-l-4 border-l-success p-5 shadow-xs">
          <p className="text-sm text-foreground">Project context updated.</p>
        </Card>
      </motion.div>
    )
  }

  if (status === 'rejected') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={springGentle}>
        <Card className="gap-2 border-l-4 border-l-muted-foreground/30 p-5 shadow-xs">
          <p className="text-sm text-muted-foreground">Changes discarded.</p>
        </Card>
      </motion.div>
    )
  }

  return (
    <Card className="gap-3 border-l-4 border-l-[var(--border-color-feedback-warning)] p-5 shadow-xs">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{rationale}</p>

      {preview.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="py-1 pr-2 text-left font-medium">Field</th>
              <th scope="col" className="p-1 text-left font-medium">Before</th>
              <th scope="col" className="pl-2 text-left font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((item, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-1 pr-2 font-medium text-foreground">{item.label}</td>
                <td className="p-1 text-muted-foreground">{item.before}</td>
                <td className="pl-2 text-foreground">{item.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        {!projectId && (
          <p className="text-xs text-muted-foreground">Project ID required to apply changes.</p>
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
