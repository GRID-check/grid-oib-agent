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
 * ## While it is arriving, too
 *
 * The index is fetched as soon as the body mentions a file type, streaming or
 * not, and names are linked as they appear. Waiting for the finished answer
 * started the fetch at the settle, so the chips arrived a round trip later and
 * re-parsed and re-wrapped an answer the reader had just finished. Half a
 * filename is not a risk here: the body this reads is the PACED one, which
 * grows a whole word at a time, and the match is the literal name the reader
 * owns, so a name is linked once all of it is on screen and not before.
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
}): AnswerFileReferences {
  const { body, projectId, conversationId } = options
  const worthLooking = mentionsAnyFileType(body)
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
