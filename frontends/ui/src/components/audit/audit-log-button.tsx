'use client'

/**
 * Opens the native WorkOS Admin Portal audit-log viewer. Each click mints a
 * fresh short-lived, org-scoped portal link via the given endpoint (POST) —
 * links are single-use sessions, so nothing is prefetched or cached.
 */

import { type FC, useState } from 'react'
import { ExternalLink, Loader2, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface AuditLogButtonProps {
  endpoint: string
  label: string
  errorMessage: string
}

export const AuditLogButton: FC<AuditLogButtonProps> = ({ endpoint, label, errorMessage }) => {
  const [loading, setLoading] = useState(false)

  const open = async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      const { link } = (await res.json()) as { link: string }
      window.open(link, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={open} disabled={loading}>
      {loading ? (
        <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
      ) : (
        <ScrollText className="mr-1.5 size-3.5" aria-hidden />
      )}
      {label}
      <ExternalLink className="ml-1.5 size-3 text-muted-foreground" aria-hidden />
    </Button>
  )
}
