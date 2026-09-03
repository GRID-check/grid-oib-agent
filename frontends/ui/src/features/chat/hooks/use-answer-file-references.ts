'use client'

/**
 * Which files an answer's prose names, and how to open each one.
 *
 * The resolution half of the file-reference feature: the marker plugin needs
 * the names BEFORE it rewrites anything (so it never links a document nobody
 * has), and the chip needs the row AFTER a click (so it can put the document in
 * the preview pane). Both come from the one index this returns.
 *
 * ## What it costs, and when
 *
 * Three list fetches, module-cached per (project, conversation) and shared with
 * every other consumer of `storedFileIndex` on the page — so at most one set
 * per chat visit however many answers ask for it. The gate in front of them is
 * {@link mentionsAnyFileType}: an answer with no document extension anywhere in
 * it cannot be naming a file, and most answers are that answer, so most answers
 * cost nothing at all.
 *
 * ## Not while it is arriving
 *
 * A streaming body changes on every token, and half a filename is not a file
 * reference — so a chip would appear mid-word, or (worse) a name would match a
 * DIFFERENT file until its distinguishing tail arrived. Nothing is scanned
 * until the answer is finished, which in this product is a frame or two after
 * the first delta.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  storedFileIndex,
  type StoredFile,
} from '@/features/documents/hooks/use-surfaced-documents'
import { fileNamesPresentIn, mentionsAnyFileType } from '../lib/file-references'

export interface AnswerFileReferences {
  /**
   * The filenames this body actually writes out, longest first — exactly what
   * `remarkFileReferences` links, and nothing else.
   */
  fileNames: readonly string[]
  /** The row behind a name as the prose spelled it, or null. */
  resolve: (fileName: string) => StoredFile | null
}

const NO_NAMES: readonly string[] = []
const NO_REFERENCES: AnswerFileReferences = { fileNames: NO_NAMES, resolve: () => null }

export function useAnswerFileReferences(options: {
  /** The answer body, as the renderer will parse it. */
  body: string
  projectId: string | null
  conversationId: string | null
  /** Nothing is scanned or fetched while the answer is still arriving. */
  isStreaming?: boolean
}): AnswerFileReferences {
  const { body, projectId, conversationId, isStreaming } = options
  const worthLooking = !isStreaming && mentionsAnyFileType(body)
  const [index, setIndex] = useState<Map<string, StoredFile> | null>(null)

  useEffect(() => {
    if (!worthLooking) return
    let cancelled = false
    storedFileIndex(projectId, conversationId)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      // A failed index is simply no file references: the prose renders exactly
      // as it did before this feature existed, which is a correct answer to
      // "we could not find out what you have".
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [worthLooking, projectId, conversationId])

  const fileNames = useMemo(
    () =>
      worthLooking && index
        ? fileNamesPresentIn(
            body,
            [...index.values()].map((entry) => entry.file.filename)
          )
        : NO_NAMES,
    [worthLooking, index, body]
  )

  return useMemo(() => {
    if (fileNames.length === 0) return NO_REFERENCES
    return {
      fileNames,
      // Lowercased on the way in because the chip resolves the name AS WRITTEN:
      // the label keeps the model's spelling, and only the index knows the
      // file's own.
      resolve: (fileName: string) => index?.get(fileName.trim().toLowerCase()) ?? null,
    }
  }, [fileNames, index])
}
