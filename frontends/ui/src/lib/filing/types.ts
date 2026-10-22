/**
 * The filing judgement's wire contract with `POST /v1/filing-fit`
 * (`frontends/aiq_api/src/aiq_api/routes/filing_fit.py`), and what the BFF
 * keeps of the answer. The request is built here; the answer is parsed here
 * and never trusted: `keepKnownMoves` (`./judge`) drops anything that names a
 * document or a folder the request did not send.
 *
 * No `server-only`: the specs and the preview import it.
 */

import { z } from 'zod'
import type { DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import type { FilingBasis } from '@/lib/proposals/types'

export type { FilingBasis }

/** Most documents one judgement reads: one batch, one bounded call (`MAX_DOCUMENTS` in the route). */
export const MAX_JUDGED_DOCUMENTS = 60
/** Most folders of a shelf one judgement reads (`MAX_FOLDERS`). */
export const MAX_JUDGED_FOLDERS = 300
/** Most office conventions one judgement reads (`MAX_CONVENTIONS`). */
export const MAX_JUDGED_CONVENTIONS = 80
/** Most Dokumentarten named per folder. */
export const MAX_FOLDER_DOC_TYPES = 3

/** A folder of the shelf, open to every reader of it. */
export interface FilingFolderInput {
  path: string
  description: string | null
  /** The Dokumentarten already filed there, most frequent first. */
  docTypes: string[]
}

/** A folder the office uses in its other projects (or the Austrian default); proposing it creates it. */
export interface FilingConventionInput {
  path: string
  description: string | null
  /** How many of the office's projects use it; 0 for the default. */
  projects: number
  docTypes: string[]
}

/** One document of the batch: what ingestion produced about it, never its bytes. */
export interface FilingDocumentInput {
  id: string
  file: string
  /** The folder it landed in; `''` is the shelf root. */
  folder: string
  /** Its Dokumentart: a person's tag or ingestion's, the type tag of its controlled tags. */
  type: string | null
  /** Its other controlled tags (the OIB disciplines). */
  tags: string[]
  summary: string | null
}

/** Why the judgement runs: an upload proposes only when sure; a sort places every document it can. */
export type FilingPurpose = 'upload' | 'sort'

export interface FilingJudgementInput {
  basis: FilingBasis
  /** `upload` when omitted. */
  purpose?: FilingPurpose
  locale: string
  folders: FilingFolderInput[]
  conventions: FilingConventionInput[]
  documents: FilingDocumentInput[]
  trace: { batchId: string; projectId: string | null; shelf: 'project' | 'office_shelf' }
}

/** The route's answer, as it is parsed. Anything else is no answer. */
export const filingFitResponseSchema = z.object({
  moves: z
    .array(
      z.object({
        id: z.string(),
        folder: z.string(),
        reason: z.string(),
        new: z.boolean().optional(),
        description: z.string().nullish(),
        /** The decision model's agreement with the folder; asked on the sort purpose only. */
        confidence: z.number().min(0).max(1).nullish(),
        /** The Dokumentart the model names; answered on the mail basis only. */
        type: z.string().nullish(),
      })
    )
    .default([]),
  model: z.string().nullish(),
  error: z.string().nullish(),
  trace_id: z.string().nullish(),
})

/** One document Piloti would file elsewhere, checked against the input. */
export interface FilingMove {
  documentId: string
  /** The target as the input spelled it. */
  folder: string
  reason: string
  /** A convention the shelf does not have yet: applying the proposal creates it. */
  newFolder: { description: string | null } | null
  /** The decision model's agreement with the folder; null when it was not asked or not reachable. */
  confidence: number | null
}

export interface FilingJudgement {
  moves: FilingMove[]
  /** The generation's trace, for the decision score; null when tracing is off or the call never ran. */
  traceId: string | null
  /** Why there is no judgement (`llm_not_configured`, `backend_502`, …); null when there is one, empty or not. */
  error: string | null
}

// ── A held mail (`basis: mail`, ADR-0134, D21) ──────────────────────────────

/**
 * What the filing judgement reads of a mail that waits in the E-Mail-Eingang:
 * names and labels only. There is no field for its text or its bytes, here
 * or in the route's strict model, so neither can ride along.
 */
export interface MailFilingInput {
  locale: string
  /** The project's folders every member reads, each with its description and Dokumentarten. */
  folders: FilingFolderInput[]
  conventions: FilingConventionInput[]
  /** The attachments to place: the part's id and its name, which passed the name check. */
  attachments: Array<{ id: string; file: string }>
  mail: {
    /** Masked by the office's content check, as every reader sees it. */
    subject: string | null
    senderDomain: string | null
    /** The text part, when the mail matched no E-Mail-Verlauf and its text would start one; else null. */
    textId: string | null
  }
  trace: { mailId: string; projectId: string }
}

/** Where Piloti would file one part of a held mail, checked against the input. */
export interface MailPlacement {
  partId: string
  /** The folder as the input spelled it. */
  folder: string
  /** A convention the project does not have yet: filing there creates it. */
  newFolder: { description: string | null } | null
  /** For an attachment, when the model named one of the vocabulary; always null for the text. */
  documentType: DocumentTypeTag | null
  reason: string
}

export interface MailFilingJudgement {
  placements: MailPlacement[]
  /** The `filing-fit` generation's trace, for the decision score; null when tracing is off or no call ran. */
  traceId: string | null
  /** Why there is no judgement; null when there is one, empty or not. */
  error: string | null
}
