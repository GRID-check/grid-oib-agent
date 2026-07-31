/**
 * Platform workflow templates API — list every template (drafts included) and
 * create a new one. Platform owners only (ADR-0016 / ADR-0027). The create body
 * is the JSON interchange shape, so the UI's file-import path posts here too.
 *
 * Not gated by the per-org workflows feature flag: authoring the shared catalog
 * is a platform-owner capability independent of any tenant's rollout state. The
 * catalog's org-facing READ (the gallery) is where the flag applies.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import {
  createPlatformTemplate,
  listPlatformTemplates,
} from '@/lib/platform-workflow-templates/service'
import { createPlatformTemplateSchema } from '@/lib/platform-workflow-templates/types'

export const GET = platformApiRoute(async () => {
  return NextResponse.json({ templates: await listPlatformTemplates() })
})

export const POST = platformApiRoute(async ({ request, session }) => {
  const json = await request.json().catch(() => null)
  const parsed = createPlatformTemplateSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid template', code: 'BAD_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const template = await createPlatformTemplate(parsed.data, {
    userId: session.userId,
    email: session.email ?? null,
  })
  return NextResponse.json(template, { status: 201 })
})
