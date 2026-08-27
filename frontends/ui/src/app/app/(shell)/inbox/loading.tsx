/**
 * Route-level loading state for the Postfach's hard-load page — sheet-shaped,
 * like the Archiv's, so a pasted `/app/inbox` link shows the panel arriving
 * rather than a blank frame.
 */

import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'

export default async function InboxLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
