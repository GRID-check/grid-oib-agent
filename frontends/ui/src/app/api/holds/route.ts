/**
 * Legal holds: preserve data and block purge (GDPR Art. 18 restriction).
 * Org-admin only. No management UI yet by design — holds are rare,
 * deliberate legal events driven via API.
 */

import { NextResponse } from 'next/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { legalHolds } from '@/lib/db/schema'
import { z } from 'zod'

const createHoldSchema = z.object({
  entityType: z.enum(['project', 'document', 'conversation', 'organization', 'user']),
  entityId: z.string().min(1),
  reason: z.string().min(1).max(2000),
})

export async function GET(): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.organizationId, session.organizationId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .orderBy(desc(legalHolds.createdAt))

  return NextResponse.json(rows)
}

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const parsed = createHoldSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid hold request.' }, { status: 400 })
  }

  const db = getDb()
  const [hold] = await db
    .insert(legalHolds)
    .values({
      ...parsed.data,
      organizationId: session.organizationId,
      createdBy: session.userId,
    })
    .returning()

  return NextResponse.json(hold, { status: 201 })
}
