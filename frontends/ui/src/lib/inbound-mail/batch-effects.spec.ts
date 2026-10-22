/**
 * @vitest-environment node
 */
/**
 * ADR-0134's „who hears what“ table, row by row (DECISION D35): a filing is a
 * person's decision, so it neither announces itself like a dropped folder nor
 * asks Piloti to judge a placement a person made; a Verlauf append tells only
 * the people with open marks and runs no document check.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_UPLOAD_BATCH_EFFECTS, type UploadBatchEffects } from '@/lib/db/schema'
import {
  ARCHIVE_THREAD_RENDER_EFFECTS,
  INBOUND_ATTACHMENT_EFFECTS,
  INBOUND_THREAD_APPEND_EFFECTS,
} from './batch-effects'

const row = (
  completion: boolean,
  rejudgement: boolean,
  intake: boolean,
  notice: UploadBatchEffects['revisionNotice'],
  documentCheck: boolean
): UploadBatchEffects => ({
  announcesCompletion: completion,
  reviewsFiling: rejudgement,
  startsIntake: intake,
  revisionNotice: notice,
  runsDocumentCheck: documentCheck,
})

describe('who hears what when filed mail lands', () => {
  it.each<[string, Readonly<UploadBatchEffects>, UploadBatchEffects]>([
    ['a person’s upload (today)', DEFAULT_UPLOAD_BATCH_EFFECTS, row(true, true, true, 'all', true)],
    ['inbound attachments', INBOUND_ATTACHMENT_EFFECTS, row(false, false, true, 'all', true)],
    [
      'an inbound Verlauf append',
      INBOUND_THREAD_APPEND_EFFECTS,
      row(false, false, false, 'marks_only', false),
    ],
    [
      'an archive Verlauf render',
      ARCHIVE_THREAD_RENDER_EFFECTS,
      row(true, false, false, 'marks_only', false),
    ],
  ])('%s', (_upload, effects, expected) => {
    expect(effects).toEqual(expected)
  })

  it('names every effect the batch row has, so a sixth column is decided here too', () => {
    for (const effects of [
      INBOUND_ATTACHMENT_EFFECTS,
      INBOUND_THREAD_APPEND_EFFECTS,
      ARCHIVE_THREAD_RENDER_EFFECTS,
    ]) {
      expect(Object.keys(effects).sort()).toEqual(Object.keys(DEFAULT_UPLOAD_BATCH_EFFECTS).sort())
    }
  })
})
