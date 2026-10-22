/**
 * „Wie vorgeschlagen ablegen“ for mails that ask nothing of a person, and the
 * confirmation that says where everything goes.
 */

import { describe, expect, it } from 'vitest'
import { DETAIL_VARIANTS, FOLDERS, mail, messagePart, part } from '@/app/dev/inbound-mail/fixtures'
import { bulkPlan, incompleteReason } from './completeness'
import { initialDraft, type DraftCopy } from './draft'

const copy: DraftCopy = { unnamedAttachment: (position) => `Attachment ${position}`, untitledThread: '(no subject)' }
const reason = (name: string) => incompleteReason(DETAIL_VARIANTS[name].view, FOLDERS, copy)

describe('incompleteReason', () => {
  it('is complete for a confirmed sender, a pre-selected thread and suggested folders', () => {
    expect(reason('member-verified')).toBeNull()
    expect(reason('thread-append')).toBeNull()
    expect(reason('revision')).toBeNull()
  })

  it.each([
    ['impersonation', 'sender'],
    ['not-addressed', 'sender'],
    ['new-thread', 'no_thread'],
    ['name-stop', 'needs_person'],
    ['macro', 'needs_person'],
    ['scan-pending', 'scanning'],
    ['no-suggestion', 'folder_missing'],
    ['closed', 'project_closed'],
    ['dismissed', 'not_waiting'],
  ])('%s → %s', (name, expected) => {
    expect(reason(name)).toBe(expected)
  })

  it('counts a member’s own Bcc copy with nothing attached as complete', () => {
    expect(reason('bcc-own')).toBeNull()
  })

  it('lets a duplicate stay behind: it is already in the project', () => {
    const view = mail({ parts: [messagePart({ id: '22222222-2222-4222-8222-222222222222' }), part({ duplicateOf: { documentId: 'd', name: 'a', folderPath: null } })] })
    expect(incompleteReason(view, FOLDERS, copy)).toBeNull()
  })
})

describe('bulkPlan', () => {
  it('groups where things go, threads first', () => {
    const entries = ['member-verified', 'thread-append', 'revision'].map((name) => {
      const view = DETAIL_VARIANTS[name].view
      return { view, draft: initialDraft(view, FOLDERS, copy) }
    })
    expect(bulkPlan(entries)).toEqual({
      mails: 3,
      files: 2,
      texts: 3,
      destinations: [
        { kind: 'thread', label: 'Stellplatznachweis', count: 3 },
        { kind: 'folder', label: 'Behörde/Bescheide', count: 1 },
        { kind: 'folder', label: 'Tragwerk', count: 1 },
      ],
    })
  })
})
