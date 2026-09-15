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
  LIFECYCLE_STAGES,
  canArchiveDocument,
  documentBadgeState,
  lifecycleNeedsReader,
  lifecycleProgress,
  lifecycleRequestFor,
  lifecycleWaiting,
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

describe('lifecycleProgress — the track', () => {
  it('walks one segment per stage, ending full on a published version', () => {
    expect(lifecycleProgress(version('draft'), 'active').reached).toBe(1)
    expect(lifecycleProgress(version('in_review'), 'active').reached).toBe(2)
    expect(lifecycleProgress(version('approved'), 'active').reached).toBe(3)
    expect(lifecycleProgress(version('published'), 'active').reached).toBe(LIFECYCLE_STAGES.length)
  })

  it('puts a sent-back version where it actually is: at the draft, stopped', () => {
    // Not a fifth stage. „Änderungen erbeten" is a draft that has been round
    // once, and the next move is a new version rather than a step forward.
    expect(lifecycleProgress(version('changes_requested'), 'active')).toMatchObject({
      reached: 1,
      halted: true,
    })
  })

  it('stops a refused version after its review rather than before it', () => {
    expect(lifecycleProgress(version('rejected'), 'active')).toMatchObject({
      reached: 2,
      halted: true,
    })
  })

  it('counts a superseded version as having completed the walk', () => {
    // It was live once; a newer version took its place. Nothing was halted.
    expect(lifecycleProgress(version('superseded'), 'active')).toMatchObject({
      reached: 4,
      halted: false,
    })
  })

  it('carries the item-level fact separately from the version-level one', () => {
    const progress = lifecycleProgress(version('published'), 'archived')
    expect(progress.archived).toBe(true)
    expect(progress.reached).toBe(4)
  })

  it('starts at nothing where there is no version yet', () => {
    expect(lifecycleProgress(null, 'active').reached).toBe(0)
  })
})

describe('lifecycleWaiting — one place decides what a state waits for', () => {
  it('names the submitter only where the row records one', () => {
    expect(lifecycleWaiting(version('in_review', 'user_anna'), 'active')).toEqual({
      key: 'inReviewBy',
      submitterUserId: 'user_anna',
    })
    expect(lifecycleWaiting(version('in_review'), 'active')).toEqual({ key: 'inReview' })
  })

  it('lets the item win once it is archived, whatever the version says', () => {
    expect(lifecycleWaiting(version('published'), 'archived')).toEqual({ key: 'archived' })
  })

  it('has a leaf for every state, and one for no version at all', () => {
    for (const state of [
      'draft',
      'in_review',
      'changes_requested',
      'approved',
      'published',
      'rejected',
      'superseded',
    ] as const) {
      expect(lifecycleWaiting(version(state), 'active').key).toBeTruthy()
    }
    expect(lifecycleWaiting(null, 'active')).toEqual({ key: 'none' })
  })
})

describe('lifecycleNeedsReader — what opens the panel by itself', () => {
  it('holds when a decision is this reader\u2019s to take', () => {
    expect(lifecycleNeedsReader(version('in_review', 'user_anna'), 'active', editor)).toBe(true)
    expect(lifecycleNeedsReader(version('draft'), 'active', editor)).toBe(true)
  })

  it('does not hold on Archivieren alone', () => {
    // The rule, not a tweak: `archive` is offered on every active document to
    // anybody who may write, so counting it would open the panel on every file
    // in the project and would therefore mean nothing.
    expect(canArchiveDocument('active', writer)).toBe(true)
    expect(lifecycleNeedsReader(version('published'), 'active', writer)).toBe(false)
  })

  it('does not hold for a reader who can only look', () => {
    expect(lifecycleNeedsReader(version('in_review', 'user_anna'), 'active', viewer)).toBe(false)
  })

  it('still holds for the submitter, because the table still offers them a move', () => {
    // Approval is withheld from them (`notSubmitter`) — but „Änderungen
    // anfordern" and „Ablehnen" are not, so somebody who submitted their own
    // version can still pull it back, and that IS a decision of theirs.
    //
    // Asserted rather than assumed: this function reads the transition table
    // and nothing else, which is the whole invariant of this module. A rule
    // that said „not for the submitter" here would be a second table — the one
    // the file header refuses — and it would have to be kept in step with the
    // first by hand.
    expect(availableLifecycleGestures(version('in_review', 'user_me'), 'active', editor)).not.toContain(
      'approve',
    )
    expect(lifecycleNeedsReader(version('in_review', 'user_me'), 'active', editor)).toBe(true)
  })
})
