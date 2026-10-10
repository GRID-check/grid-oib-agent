'use client'

import { useEffect, useState } from 'react'
import { useDocumentsGeneration } from '@/lib/documents/document-changes'
import type { MissingDocument } from '@/lib/document-roles/prompt-loader'

/**
 * What Piloti expects a project to hold and does not — the agent's own
 * `documents_missing:` list, from `GET /api/projects/{id}/document-roles`.
 *
 * Re-read whenever a document changes anywhere in the tab (an upload, a role
 * bound in the preview), so the list shrinks as the gaps are filled. Null
 * while unknown, for the Büroablage (no project, no expectations), or when the
 * read fails: the brief then says nothing rather than claiming nothing is
 * missing.
 */
export function useMissingDocuments(projectId: string | null): readonly MissingDocument[] | null {
  const generation = useDocumentsGeneration()
  const [missing, setMissing] = useState<readonly MissingDocument[] | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/document-roles`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled) return
        const list = (body as { missing?: unknown } | null)?.missing
        setMissing(Array.isArray(list) ? (list as MissingDocument[]) : null)
      })
      .catch(() => {
        if (!cancelled) setMissing(null)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, generation])
  return projectId ? missing : null
}
