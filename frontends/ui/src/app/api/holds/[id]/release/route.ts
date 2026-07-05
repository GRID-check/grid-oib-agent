import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { legalHolds } from '@/lib/db/schema'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const db = getDb()
  const [hold] = await db
    .update(legalHolds)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(legalHolds.id, id),
        eq(legalHolds.organizationId, session.organizationId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning()

  if (!hold) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(hold)
}
