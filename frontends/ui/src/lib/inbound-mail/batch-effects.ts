/**
 * Who hears what when filed mail lands (ADR-0134, DECISION D35): the upload-batch
 * effects (migration 0185, `UploadBatchEffects`) each kind of mail filing opens
 * its batch with. A filing is a person's decision, made in the E-Mail-Eingang,
 * so most of what a dropped folder sets off would be noise or a second
 * judgement of a judgement already made:
 *
 * | Upload | Completion | Content re-judgement | Intake reading | Revision notice | Document check |
 * |---|---|---|---|---|---|
 * | Person (today) | yes | yes | yes | all | yes |
 * | Inbound attachments | no | no | yes | all | yes |
 * | Inbound Verlauf append (person or follow) | no | no | no | marks only | no |
 * | Archive Verlauf render | yes | no | no | marks only | no |
 *
 * - **Completion** (`announcesCompletion`): the upload tray's summary. The
 *   decision's own notice (`inbound_mail.decided`) and the toast cover a filing;
 *   an archive import still tells the person who started it.
 * - **Content re-judgement** (`reviewsFiling`): Piloti's placement review. A
 *   person placed every filed part.
 * - **Intake reading** (`startsIntake`): reading a new document into the
 *   project profile. An attachment is a document like any other; a Verlauf is
 *   correspondence, never the project's facts.
 * - **Revision notice** (`revisionNotice`): „Neue Fassung“ to the people who
 *   follow a document. A new Fassung of S-101 is news; a reply appended to a
 *   Verlauf is not, so only the people with open marks on it hear of it.
 * - **Document check** (`runsDocumentCheck`, ADR-0130): a model call per
 *   settled document where the office switched it on. A filed plan is worth
 *   checking; each Fassung of a Verlauf is not (C4's gap, closed by C8).
 *
 * The browser can open none of these (the route's body has no field for them),
 * so only the filing job and the archive import open a quiet batch.
 */

import type { UploadBatchEffects } from '@/lib/db/schema'

/** The attachments a person filed from a held mail. */
export const INBOUND_ATTACHMENT_EFFECTS: Readonly<UploadBatchEffects> = Object.freeze({
  announcesCompletion: false,
  reviewsFiling: false,
  startsIntake: true,
  revisionNotice: 'all',
  runsDocumentCheck: true,
})

/** A Fassung of an E-Mail-Verlauf a person's filing or a follow appended. */
export const INBOUND_THREAD_APPEND_EFFECTS: Readonly<UploadBatchEffects> = Object.freeze({
  announcesCompletion: false,
  reviewsFiling: false,
  startsIntake: false,
  revisionNotice: 'marks_only',
  runsDocumentCheck: false,
})

/** A Fassung of an E-Mail-Verlauf the archive import rendered (D11's `renderPendingThreads`). */
export const ARCHIVE_THREAD_RENDER_EFFECTS: Readonly<UploadBatchEffects> = Object.freeze({
  announcesCompletion: true,
  reviewsFiling: false,
  startsIntake: false,
  revisionNotice: 'marks_only',
  runsDocumentCheck: false,
})
