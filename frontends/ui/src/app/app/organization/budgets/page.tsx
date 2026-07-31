/**
 * Organization → budgets. LLM spend against the limits that stop it.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Deliberately NOT gated: when a budget is exhausted chat stops, and the person
 * it stopped for is usually not an admin. `canManageBudgets` therefore decides
 * what the card shows rather than whether the route opens — admins get the
 * org-wide meters plus the limit editors, everyone else gets their own spend
 * (ADR-0015), which is the only place that explains why chat went quiet.
 */

import { Gauge } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { canManageBudgets } from '@/lib/authz/organizations'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { BudgetUsageCard } from '../budget-usage-card'

export default async function OrganizationBudgetsPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const t = await getTranslations('organization')

  const isAdmin = canManageBudgets(session)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.budgets.title')} subtitle={t('sections.budgets.subtitle')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" aria-hidden />
            {isAdmin ? t('budgets.title') : t('budgets.memberTitle')}
          </CardTitle>
          <CardDescription>
            {isAdmin ? t('budgets.description') : t('budgets.memberDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetUsageCard isAdmin={isAdmin} />
        </CardContent>
      </Card>
    </div>
  )
}
