/**
 * Organization → quarantine. Files the content check held back (ADR-0085),
 * for the people who may release or delete them.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Deliberately NOT gated: reviewers are org admins AND each project's own
 * admins, and the second is a per-project check this layout cannot make
 * cheaply. `GET /api/quarantine` filters every row by `mayReviewQuarantine`, so
 * a member who may review nothing sees an empty queue, which is the truth.
 */

import type { JSX } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import { PageHeader } from '@/components/ui/page-header'
import { QuarantineQueue } from '@/features/organization/components/quarantine-queue'
import { getTranslations } from '@/i18n/server'

export default async function OrganizationQuarantinePage(): Promise<JSX.Element> {
  return withPageSession(async () => {
    const t = await getTranslations('organization')

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.quarantine.title')} subtitle={t('sections.quarantine.subtitle')} />
        <QuarantineQueue />
      </div>
    )
  })
}
