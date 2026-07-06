/**
 * User preferences API.
 *
 * Stores opaque per-user preferences such as the active project id.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'

const updatePreferencesSchema = z.object({
  prefs: z.record(z.unknown()),
})

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const db = getDb()

    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.workosUserId, session.userId))
      .limit(1)

    return NextResponse.json({ prefs: row?.prefs ?? {} })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    const body = await request.json().catch(() => null)
    const parsed = updatePreferencesSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'prefs object is required' },
        { status: 400 },
      )
    }

    const { prefs } = parsed.data
    const db = getDb()

    await db
      .insert(userPreferences)
      .values({
        workosUserId: session.userId,
        prefs,
      })
      .onConflictDoUpdate({
        target: userPreferences.workosUserId,
        set: { prefs },
      })

    return NextResponse.json({ prefs })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
