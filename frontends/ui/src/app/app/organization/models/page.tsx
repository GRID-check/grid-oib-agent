/**
 * Organization → models. Which LLM the organization runs on, and whose account
 * pays for it.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Both cards carry the same double gate the API enforces: the caller's
 * `org:models:manage` permission AND the deployment's feature flag. Model
 * configuration (ADR-0014) and BYOK credentials (ADR-0022) share the permission
 * but ship on separate flags, so an organization can have one without the other
 * — hence two independent conditions rather than one section-wide gate. With
 * neither available the section says so instead of rendering an empty column.
 */

import { Cpu, KeyRound, ShieldAlert } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { canManageModels } from '@/lib/authz/organizations'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { ModelConfigCard } from '../model-config-card'
import { LlmCredentialsCard } from '../llm-credentials-card'

export default async function OrganizationModelsPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const t = await getTranslations('organization')

  // Permission AND feature flag — the cards mirror the API's double gate.
  const models =
    canManageModels(session) && isFeatureEnabled(session, FEATURE_FLAGS.modelConfiguration)
  const byok = canManageModels(session) && isFeatureEnabled(session, FEATURE_FLAGS.byokLlm)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.models.title')} subtitle={t('sections.models.subtitle')} />

      {/* Runtime model configuration (ADR-0014) */}
      {models && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="size-4 text-muted-foreground" aria-hidden />
              {t('models.title')}
            </CardTitle>
            <CardDescription>{t('models.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ModelConfigCard />
          </CardContent>
        </Card>
      )}

      {/* BYOK LLM credentials (ADR-0022) */}
      {byok && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden />
              {t('byok.title')}
            </CardTitle>
            <CardDescription>{t('byok.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <LlmCredentialsCard />
          </CardContent>
        </Card>
      )}

      {!models && !byok && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
              {t('notAdmin.title')}
            </CardTitle>
            <CardDescription>{t('notAdmin.description')}</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  )
}
