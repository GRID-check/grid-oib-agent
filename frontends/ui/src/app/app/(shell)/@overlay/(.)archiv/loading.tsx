/**
 * Loading state for the intercepted Archiv sheet: the scrim and panel appear
 * immediately over the page the reader is on, so the click lands before the
 * session/flag round-trip resolves.
 */

import type { JSX } from 'react'
import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'

export default async function ArchivOverlayLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
