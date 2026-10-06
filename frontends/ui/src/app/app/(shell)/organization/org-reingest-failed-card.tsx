'use client'

/**
 * Rescan every failed ingestion in the organization.
 *
 * Sits in Organization > Enterprise beside the other advanced controls: all
 * files that were stored but could never be read go back through the ingest
 * pipeline under their own ids. Rendered on the admin-only enterprise page,
 * and the API independently requires `org:settings:manage`, so this button
 * never reaches a session that may not re-read the tenant's estate at once.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslations } from '@/i18n'

export function OrgReingestFailedCard(): JSX.Element {
  const t = useTranslations('organization')
  const [isRescanning, setIsRescanning] = useState(false)

  const handleRescan = async (): Promise<void> => {
    setIsRescanning(true)
    try {
      const response = await fetch('/api/organization/documents/reingest-failed', {
        method: 'POST',
      })
      if (!response.ok) throw new Error(String(response.status))
      // 202: the rescan is queued and runs on its own, so there is no count
      // to show. Each document's own status is where it reports.
      toast.success(t('advanced.reingestFailed.started'))
    } catch {
      toast.error(t('advanced.reingestFailed.failed'))
    } finally {
      setIsRescanning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('advanced.reingestFailed.title')}</CardTitle>
        <CardDescription>{t('advanced.reingestFailed.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={handleRescan} disabled={isRescanning}>
          <RefreshCw
            className={isRescanning ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden="true"
          />
          {isRescanning ? t('advanced.reingestFailed.busy') : t('advanced.reingestFailed.action')}
        </Button>
      </CardContent>
    </Card>
  )
}
