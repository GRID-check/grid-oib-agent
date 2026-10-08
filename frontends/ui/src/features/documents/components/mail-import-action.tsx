'use client'

/**
 * The Dateien header's way into the Outlook archive import (ADR-0085): one
 * outline button beside the upload control, project shelf only, and only where
 * the import is switched on. A peer of the upload button rather than an item in
 * its menu, because it is not an upload of files: it is a different kind of
 * source, and the menu's two items both mean "these files go here".
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { MailImportDialog } from './mail-import-dialog'

export function MailImportAction({ projectId }: { projectId: string }): JSX.Element {
  const t = useTranslations('files')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="mail-import-trigger"
      >
        <Mail className="size-4" aria-hidden />
        {t('mailImport.action')}
      </Button>
      <MailImportDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  )
}
