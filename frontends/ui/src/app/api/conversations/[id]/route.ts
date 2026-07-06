import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { conversations } from '@/lib/db/schema'

const updateConversationSchema = z.object({
  title: z.string().min(1),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    const db = getDb()

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)

    if (!row || row.organizationId !== session.organizationId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(row)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateConversationSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'title is required', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const db = getDb()

    const [row] = await db
      .update(conversations)
      .set({ title: parsed.data.title, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning()

    if (!row || row.organizationId !== session.organizationId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(row)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    const db = getDb()

    await db.delete(conversations).where(eq(conversations.id, id))

    return new Response(null, { status: 204 })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
