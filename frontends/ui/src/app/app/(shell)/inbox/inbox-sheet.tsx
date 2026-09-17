/**
 * The inbox, presented as a page sheet — one place per user, per organization,
 * that answers "what needs me?" (spec IB-1, IB-18).
 *
 * Like the Archiv, one component behind both arrivals: the intercepted overlay
 * (`(shell)/@overlay/(.)inbox`) above whatever page the reader is on, and the
 * real `/app/inbox` page for a hard load. Only `standalone` differs — see
 * {@link RoutePageSheet}.
 *
 * The gate is a `notFound()`, not a polite empty card — but it is no longer the
 * collaboration flag. It is `inboxIsReachable`, derived from the item-type
 * registry, because the inbox stopped being a collaboration-only surface once
 * it carried operational alerts (ADR-0042): gating the page on collaboration
 * meant a tenant without that feature could never see the warning that its
 * storage was filling up. The BFF routes apply the SAME per-type gate, so the
 * two still cannot disagree.
 */

import { notFound } from 'next/navigation'

import { withPageSession } from '@/lib/auth/require-auth'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { inboxIsReachable } from '@/lib/inbox/registry'
import { getTranslations } from '@/i18n/server'
import { RoutePageSheet } from '@/components/shell/route-page-sheet'
import { InboxList } from '@/features/collaboration/components'

export async function InboxSheet({ standalone }: { standalone: boolean }): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    if (!inboxIsReachable(isCollaborationEnabled(session))) {
      notFound()
    }

    const t = await getTranslations('collaboration')
    const tCommon = await getTranslations('common')

    return (
      <RoutePageSheet
        title={t('inbox.title')}
        subtitle={t('inbox.subtitle')}
        closeLabel={tCommon('actions.close')}
        standalone={standalone}
        bodyClassName="overflow-y-auto"
      >
        {/* A capped, centred column: inbox rows are reading material, and a
            1400px line of them is not. The sheet's width is the place; the
            column is the text measure inside it. */}
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
          <InboxList />
        </div>
      </RoutePageSheet>
    )
  })
}
