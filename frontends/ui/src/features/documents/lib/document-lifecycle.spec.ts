/**
 * The two rules the Files surfaces read the lifecycle through: when the badge
 * speaks, and which controls this reader gets.
 *
 * Every expectation here is checked against `DOCUMENT_VERSION_TRANSITIONS`
 * rather than against a list written in the spec — the last test in the file is
 * the one that matters most, because it fails if this module ever starts
 * answering from a table of its own.
 */

import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_VERSION_TRANSITIONS,
  type DocumentVersionState,
} from '@/lib/documents/lifecycle-types'
import {
  DELEGATE_REVISION,
  availableLifecycleActions,
  availableLifecycleGestures,
  availableReviewOps,
  canArchiveDocument,
  documentBadgeState,
  lifecycleRequestFor,
  reviewOpRequiresComment,
  showsVersionStateBadge,
} from './document-lifecycle'

const editor = { permissions: ['project:view', 'project:edit'] as const, userId: 'user_me' }
const viewer = { permissions: ['project:view'] as const, userId: 'user_me' }
const writer = {
  permissions: ['project:view', 'project:documents:write'] as const,
  userId: 'user_me',
}

const version = (state: DocumentVersionState, submittedBy: string | null = null) => ({
  state,
  submittedBy,
})

describe('showsVersionStateBadge', () => {
  it('says nothing about a plain upload', () => {
    // The rule the Files list depends on: one version, born published, a person
    // put it there. A badge here would appear on every row of every folder.
    expect(
      showsVersionStateBadge({ versionState: 'published', versionCount: 1, authoredBy: 'user' }),
    ).toBe(false)
  })

  it('speaks once a document has a history', () => {
    expect(
      showsVersionStateBadge({ versionState: 'published', versionCount: 2, authoredBy: 'user' }),
    ).toBe(true)
  })

  it('speaks for anything Piloti wrote, at its first version', () => {
    expect(
      showsVersionStateBadge({ versionState: 'draft', versionCount: 1, authoredBy: 'agent' }),
    ).toBe(true)
  })

  it('says nothing when the listing never read the state', () => {
    // A listing that did not pay for the summary is saying "unknown here", and
    // an unknown editorial state is not `Entwurf`.
    expect(showsVersionStateBadge({ versionState: null, authoredBy: 'agent' })).toBe(false)
  })

  it('always speaks for an archived document, whatever its history', () => {
    expect(
      showsVersionStateBadge({
        versionState: 'published',
        versionCount: 1,
        authoredBy: 'user',
        lifecycle: 'archived',
      }),
    ).toBe(true)
    expect(
      documentBadgeState({ versionState: 'published', versionCount: 1, lifecycle: 'archived' }),
    ).toBe('archived')
  })
})

describe('availableReviewOps', () => {
  it('offers nothing to a reader who may only look', () => {
    expect(availableReviewOps(version('in_review'), viewer)).toEqual([])
  })

  it('offers the submit on a draft, and no decision', () => {
    expect(availableReviewOps(version('draft'), editor)).toEqual(['submit'])
  })

  it('offers the three decisions on a version in review', () => {
    expect(availableReviewOps(version('in_review'), editor)).toEqual([
      'approve',
      'request_changes',
      'reject',
    ])
  })

  it('withholds Freigeben from the person who submitted it', () => {
    // Approval is the office asserting the content; an assertion nobody but the
    // author has read is not one. The other two stay: asking yourself for
    // changes is pointless but not a lie about who has read it.
    expect(availableReviewOps(version('in_review', 'user_me'), editor)).toEqual([
      'request_changes',
      'reject',
    ])
  })

  it('offers Veröffentlichen only once a person has approved', () => {
    expect(availableReviewOps(version('approved'), writer)).toEqual(['publish'])
    expect(availableReviewOps(version('draft'), writer)).not.toContain('publish')
  })

  it('offers a resubmit after changes were requested', () => {
    expect(availableReviewOps(version('changes_requested'), editor)).toEqual(['submit'])
  })

  it('offers nothing on a state nothing leaves', () => {
    expect(availableReviewOps(version('superseded'), editor)).toEqual([])
    expect(availableReviewOps(version('rejected'), editor)).toEqual([])
  })
})

describe('archive', () => {
  it('is offered to a writer on an active document', () => {
    expect(canArchiveDocument('active', writer)).toBe(true)
    expect(availableLifecycleActions(version('published'), 'active', writer)).toContain('archive')
  })

  it('is not offered twice', () => {
    expect(canArchiveDocument('archived', writer)).toBe(false)
  })

  it('is not offered to a reader who may only look', () => {
    expect(canArchiveDocument('active', viewer)).toBe(false)
  })
})

describe('reviewOpRequiresComment', () => {
  it('requires words for the two refusals and for nothing else', () => {
    expect(reviewOpRequiresComment('request_changes')).toBe(true)
    expect(reviewOpRequiresComment('reject')).toBe(true)
    expect(reviewOpRequiresComment('approve')).toBe(false)
    expect(reviewOpRequiresComment('submit')).toBe(false)
    expect(reviewOpRequiresComment('publish')).toBe(false)
  })
})

describe('„Piloti überarbeiten lassen" is a field, not a fourth op', () => {
  it('stands beside Änderungen anfordern, and only there', () => {
    const gestures = availableLifecycleGestures(version('in_review'), 'active', editor)
    expect(gestures.indexOf(DELEGATE_REVISION)).toBe(gestures.indexOf('request_changes') + 1)
  })

  it('is absent wherever the row that carries it is', () => {
    // A reader who may not send this version back may not delegate its revision
    // either: there is one permission, because there is one transition.
    expect(availableLifecycleGestures(version('in_review'), 'active', viewer)).toEqual([])
    expect(availableLifecycleGestures(version('published'), 'active', editor)).not.toContain(
      DELEGATE_REVISION,
    )
  })

  it('resolves to the request_changes op with the flag set', () => {
    expect(lifecycleRequestFor(DELEGATE_REVISION)).toEqual({
      action: 'request_changes',
      delegateRevision: true,
    })
    expect(lifecycleRequestFor('request_changes')).toEqual({
      action: 'request_changes',
      delegateRevision: false,
    })
  })

  it('adds no gesture beyond that one, for any state', () => {
    for (const state of [
      'draft',
      'in_review',
      'changes_requested',
      'approved',
      'published',
      'superseded',
      'rejected',
    ] as const) {
      const actions = availableLifecycleActions(version(state), 'active', editor)
      const gestures = availableLifecycleGestures(version(state), 'active', editor)
      expect(gestures.filter((gesture) => gesture !== DELEGATE_REVISION)).toEqual(actions)
    }
  })
})

describe('the table is the only table', () => {
  it('offers exactly the rows the transition table allows, for every state', () => {
    // The guard on this whole module: if somebody ever answers from a second
    // list, one of these states disagrees. Permissions are held wide open here
    // on purpose — this is about the table's shape, not about access.
    const omnipotent = {
      permissions: [
        'project:view',
        'project:edit',
        'project:documents:write',
        'project:documents:generate',
      ] as const,
      userId: 'nobody',
    }

    for (const state of [
      'draft',
      'in_review',
      'changes_requested',
      'approved',
      'published',
      'superseded',
      'rejected',
    ] as const) {
      const fromTable = DOCUMENT_VERSION_TRANSITIONS.filter(
        (row) => row.from === state && !['upload', 'create', 'update'].includes(row.op),
      ).map((row) => row.op)
      expect(availableReviewOps(version(state), omnipotent)).toEqual([...new Set(fromTable)])
    }
  })
})
