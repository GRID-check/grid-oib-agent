import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { conversations } from '@/lib/db/schema'

const createConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
})

export async function GET(_request: Request): Promise<Response> {
  const session = await requireAuthorizedSession()
  const db = getDb()

  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.organizationId, session.organizationId))
    .orderBy(desc(conversations.updatedAt))

  return NextResponse.json(rows)
}

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuthorizedSession()

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createConversationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'id is required', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { id, title, projectId } = parsed.data
  const db = getDb()

  const [row] = await db
    .insert(conversations)
    .values({
      id,
      organizationId: session.organizationId,
      createdBy: session.userId,
      title: title ?? null,
      projectId: projectId ?? null,
    })
    .returning()

  return NextResponse.json(row, { status: 201 })
}
