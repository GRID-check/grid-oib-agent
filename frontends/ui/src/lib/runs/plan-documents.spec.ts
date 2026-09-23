/**
 * The Unterlagen as they cross the wire. Pinned: the agent's own shape — with
 * `nur_grundlage`, as `PlanDocuments.model_dump()` sends it — is one the BFF
 * accepts, and a confinement survives the sanitiser only with a Grundlage.
 */

import { describe, expect, it } from 'vitest'
import { planDocumentsSchema, sanitizePlanDocuments } from './plan-documents'

describe('plan documents on the wire', () => {
  it('accepts the agent’s commission payload as it is dumped', () => {
    const payload = {
      grundlage: [{ name: 'Einreichplan.pdf', title: 'Einreichplan EG', shelf: 'project' }],
      ausgeschlossen: [{ name: 'alt.pdf' }],
      nur_grundlage: false,
    }
    expect(planDocumentsSchema.safeParse(payload).success).toBe(true)
  })

  it('keeps „Nur diese" only while there is something to confine to', () => {
    expect(sanitizePlanDocuments({ grundlage: ['Plan.pdf'], nur_grundlage: true })).toEqual({
      grundlage: [{ name: 'Plan.pdf' }],
      ausgeschlossen: [],
      nur_grundlage: true,
    })
    expect(sanitizePlanDocuments({ ausgeschlossen: ['Alt.pdf'], nur_grundlage: true })).toEqual({
      grundlage: [],
      ausgeschlossen: [{ name: 'Alt.pdf' }],
    })
  })
})
