/**
 * The contract of „Im Büro behandelt" (`POST /api/passages/similar`): the
 * passage a person is reading, and the passages like it across what they may
 * read, grouped project → document → passage.
 *
 * No `server-only` and no drizzle: the route, the typed client and the panel
 * share these (ADR-0055).
 */

import { z } from 'zod'
import type { FassungTag } from '@/features/documents/lib/fassung-timeline'
import type { ProjectStatus } from '@/lib/cross-project/types'

/** Longer than this, a selection is a page and not a passage; the server reads its head. */
export const SIMILAR_PASSAGE_TEXT_MAX = 4000
/** Shorter than this, a passage says too little to find another like it. */
export const SIMILAR_PASSAGE_TEXT_MIN = 12

/** Which document the passage is in: a stored document by id, or a legal-corpus file by name. */
const sourceDocumentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stored'), documentId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('base'), fileName: z.string().min(1).max(500) }),
])

export const similarPassagesRequestSchema = z.object({
  document: sourceDocumentSchema,
  passage: z.object({
    /** The passage's words: a citation's Fundstelle, or what the reader selected. */
    text: z.string().trim().min(SIMILAR_PASSAGE_TEXT_MIN).max(SIMILAR_PASSAGE_TEXT_MAX),
    page: z.number().int().min(1).nullable().optional(),
    /** A Fundstelle the answer cited (retrieved text, so its stored chunk can stand in) rather than a selection. */
    cited: z.boolean(),
  }),
  /**
   * The project the reader is working in, when the document itself names none
   * (a legal-corpus citation in a project's chat). A stored project document's
   * own project always wins.
   */
  projectId: z.string().min(1).max(100).nullable().optional(),
})

export type SimilarPassagesRequest = z.infer<typeof similarPassagesRequestSchema>
export type SimilarSourceDocument = SimilarPassagesRequest['document']

/** One passage like the source, in a document the reader may open. */
export interface SimilarPassage {
  page: number | null
  /** The passage's opening, the words the viewer looks for to mark it. */
  snippet: string
  /** Cosine similarity to the source passage, 0..1. */
  score: number
}

/** A document holding passages like the source, its best passage first. */
export interface SimilarDocument {
  documentId: string
  filename: string
  /** The document's own name when a person renamed it; null shows `filename`. */
  displayName: string | null
  contentType: string | null
  /** The Fassung the office gave it (Index C, or the date it is stamped with), when it says one. */
  stand: FassungTag | null
  passages: SimilarPassage[]
}

/** Where a group of documents sits: the reader's own project, another project, or the Büroablage. */
export type SimilarGroupKind = 'current' | 'project' | 'archiv'

export interface SimilarGroup {
  kind: SimilarGroupKind
  /** The project, for `current` and `project`; null for the Büroablage. */
  project: { id: string; name: string; status: ProjectStatus } | null
  documents: SimilarDocument[]
}

export interface SimilarPassagesResponse {
  /** The reader's project first, then the others and the Büroablage by their best passage. */
  groups: SimilarGroup[]
  /** How many projects were searched besides the reader's own (closed ones included). */
  projectsSearched: number
  /** `point`: the cited passage's stored vector was used; `embedded`: the text was embedded once. */
  origin: 'point' | 'embedded'
}

/** Every document of a response, in the groups' order: what the panel lists and a test counts. */
export const similarDocumentsOf = (response: SimilarPassagesResponse): SimilarDocument[] =>
  response.groups.flatMap((group) => group.documents)
