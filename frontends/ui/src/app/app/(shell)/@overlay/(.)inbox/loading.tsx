/**
 * Loading state for the intercepted Postfach sheet: the scrim and panel appear
 * immediately over the page the reader is on, so the click lands before the
 * session round-trip resolves.
 */

import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'

export default async function InboxOverlayLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
