/**
 * Org-facing workflow templates gallery read (ADR-0027).
 *
 * Returns the PUBLISHED platform templates every organization's Workflows
 * gallery shows alongside the built-in ones. Session-authenticated and gated by
 * the same dark-launch workflows gate as the rest of the feature; the lean
 * projection carries both locales (the client renders the active one) and no
 * author PII. Global content — deliberately not org-scoped — so the response is
 * identical across tenants and safe to cache per deployment.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { listGalleryTemplates } from '@/lib/platform-workflow-templates/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireWorkflowsEnabled(session)
    if (gated) return gated
    return { templates: await listGalleryTemplates() }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'platform-curated workflow templates (ADR-0027), identical for every tenant and carrying no tenant data',
    },
  }
)
