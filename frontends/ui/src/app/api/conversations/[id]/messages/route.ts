// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { conversations, messages } from '@/lib/db/schema'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  const db = getDb()

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)

  if (!conv || conv.organizationId !== session.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt))

  return NextResponse.json(rows)
}

const createMessageSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  content: z.string(),
  messageType: z.string().optional(),
  metadata: z.any().optional(),
  createdAt: z.string().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  const db = getDb()

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)

  if (!conv || conv.organizationId !== session.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const messagesArray = Array.isArray(body) ? body : [body]
  const parsed: z.infer<typeof createMessageSchema>[] = []

  for (const msg of messagesArray) {
    const result = createMessageSchema.safeParse(msg)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid message', issues: result.error.issues },
        { status: 400 },
      )
    }
    parsed.push(result.data)
  }

  if (parsed.length === 0) {
    return NextResponse.json({ error: 'No valid messages' }, { status: 400 })
  }

  const rows = await db
    .insert(messages)
    .values(
      parsed.map((m) => ({
        id: m.id,
        conversationId: id,
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? {},
        createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
      }))
    )
    .returning()

  return NextResponse.json(rows, { status: 201 })
}
