/**
 * Platform workflow template item API — update or delete a single template
 * (including the publish/unpublish toggle, which is just a `published` PATCH).
 * Platform owners only (ADR-0016 / ADR-0027).
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import {
  deletePlatformTemplate,
  updatePlatformTemplate,
} from '@/lib/platform-workflow-templates/service'
import { updatePlatformTemplateSchema } from '@/lib/platform-workflow-templates/types'

export const PATCH = platformApiRoute<{ templateId: string }>(async ({ request, params }) => {
  const { templateId } = params

  const json = await request.json().catch(() => null)
  const parsed = updatePlatformTemplateSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid template', code: 'BAD_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const updated = await updatePlatformTemplate(templateId, parsed.data)
  if (!updated) {
    return NextResponse.json({ error: 'Template not found', code: 'NOT_FOUND' }, { status: 404 })
  }
  return NextResponse.json(updated)
})

export const DELETE = platformApiRoute<{ templateId: string }>(async ({ params }) => {
  const { templateId } = params

  const removed = await deletePlatformTemplate(templateId)
  if (!removed) {
    return NextResponse.json({ error: 'Template not found', code: 'NOT_FOUND' }, { status: 404 })
  }
  return new NextResponse(null, { status: 204 })
})
