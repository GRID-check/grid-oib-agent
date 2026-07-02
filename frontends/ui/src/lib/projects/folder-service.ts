// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, and } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectFolders } from '@/lib/db/schema'
import { validateFolderName, buildFolderPath } from './folders'

export interface CreateFolderInput {
  projectId: string
  parentId?: string | null
  name: string
}

export interface FolderRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
}

export function toFolderRow(row: typeof projectFolders.$inferSelect): FolderRow {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listProjectFolders(projectId: string): Promise<FolderRow[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projectFolders)
    .where(eq(projectFolders.projectId, projectId))
    .orderBy(projectFolders.path)
  return rows.map(toFolderRow)
}

export async function createProjectFolder(
  input: CreateFolderInput,
): Promise<{ ok: true; folder: FolderRow } | { ok: false; error: string }> {
  const validation = validateFolderName(input.name)
  if (!validation.ok) {
    return { ok: false, error: validation.error! }
  }

  let parentPath = ''
  if (input.parentId) {
    const db = getDb()
    const [parent] = await db
      .select()
      .from(projectFolders)
      .where(and(eq(projectFolders.id, input.parentId), eq(projectFolders.projectId, input.projectId)))
      .limit(1)
    if (!parent) {
      return { ok: false, error: 'Parent folder not found.' }
    }
    parentPath = parent.path
  }

  const path = buildFolderPath(parentPath, validation.name!)

  const db = getDb()
  const [inserted] = await db
    .insert(projectFolders)
    .values({
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      name: validation.name!,
      path,
    })
    .returning()

  return { ok: true, folder: toFolderRow(inserted) }
}
