/**
 * Route-level loading state for the org Archiv's hard-load page.
 *
 * The page resolves a session and feature flags before it renders anything —
 * without this, a pasted `/app/archiv` link showed a blank frame until the
 * sheet arrived. Sheet-shaped, so the skeleton and the surface replacing it
 * are the same box (soft navigations render the intercepted overlay instead,
 * which has its own loading file).
 */

import type { JSX } from 'react'
import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'

export default async function ArchivLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
