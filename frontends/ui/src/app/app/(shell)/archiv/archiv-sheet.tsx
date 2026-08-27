/**
 * Org-wide Archiv, presented as a page sheet (ADR-0024).
 *
 * One component behind both arrivals: the intercepted overlay
 * (`(shell)/@overlay/(.)archiv`), where the sheet rises above whatever page
 * the reader is on, and the real `/app/archiv` page, where a hard load renders
 * the same sheet standing alone over the org chrome. Only `standalone` — what
 * "close" means — differs; see {@link RoutePageSheet}.
 *
 * Dark-launched behind the `organization-archiv` gate; reachable by any org
 * member, with uploads and deletes gated on `org:archiv:manage`.
 *
 * Headerless on purpose: {@link ArchivWorkspace} already opens with the gold
 * Büroarchiv identity row (mark, name, count, upload). A sheet header above it
 * would say "Archiv" twice, so the sheet's close control slots into that row
 * instead and the workspace's header is the sheet's one header.
 */

import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { canManageArchiv } from '@/lib/authz/organizations'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { getTranslations } from '@/i18n/server'
import { PageSheetClose } from '@/components/ui/page-sheet'
import { RoutePageSheet } from '@/components/shell/route-page-sheet'
import { ArchivWorkspace } from '@/features/documents/components/archiv-workspace'

export async function ArchivSheet({ standalone }: { standalone: boolean }): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    // Feature-flag gate — an org without the flag gets a 404.
    if (!isFeatureEnabled(session, FEATURE_FLAGS.orgArchiv)) {
      notFound()
    }

    const t = await getTranslations('archiv')
    const tCommon = await getTranslations('common')
    const canManage = canManageArchiv(session)
    const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

    return (
      <RoutePageSheet
        title={t('title')}
        subtitle={t('subtitle')}
        closeLabel={tCommon('actions.close')}
        headerless
        standalone={standalone}
      >
        <ArchivWorkspace
          canManage={canManage}
          showMetadataPanel={showMetadataPanel}
          trailingActions={<PageSheetClose label={tCommon('actions.close')} />}
        />
      </RoutePageSheet>
    )
  })
}
