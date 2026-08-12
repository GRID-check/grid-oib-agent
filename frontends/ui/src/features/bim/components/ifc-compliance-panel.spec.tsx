/**
 * The Prüfbuch panel.
 *
 * The data layer already refuses to call a missing value a pass. These
 * assertions are about the second half of that promise: that the UI does not
 * quietly undo it by hiding the rows that make the report incomplete.
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IfcCompliancePanel } from './ifc-compliance-panel'
import type { BimRuleResult, BimRuleResultWithConfirmation } from '@/lib/bim/rules'

function rule(
  overrides: Partial<BimRuleResultWithConfirmation> & Pick<BimRuleResult, 'ruleId'>
): BimRuleResultWithConfirmation {
  return {
    confirmation: null,
    confirmationStale: false,
    richtlinie: 'OIB 2',
    clause: '3',
    titleDe: 'Tragende Bauteile — Feuerwiderstand',
    thresholdDe: 'Feuerwiderstand nach Gebäudeklasse (GK1 R 30 … GK5 REI 90)',
    applicable: true,
    passed: 0,
    failed: 0,
    undecidable: 0,
    failures: [],
    unknowns: [],
    truncated: false,
    missing: [],
    ...overrides,
  }
}

const FAILING = rule({
  ruleId: 'oib4-tuer-durchgangsbreite',
  richtlinie: 'OIB 4',
  clause: '3',
  titleDe: 'Türen — lichte Durchgangsbreite',
  thresholdDe: 'lichte Durchgangsbreite ≥ 0,80 m',
  passed: 12,
  failed: 2,
  failures: [
    {
      globalId: 'g-door-1',
      name: 'T-14',
      storeyName: 'Erdgeschoss',
      status: 'fail',
      reading: 'Breite 0,7 m — Schwellwert ≥ 0,80 m',
    },
    {
      globalId: 'g-door-2',
      name: 'T-15',
      storeyName: 'Erdgeschoss',
      status: 'fail',
      reading: 'Breite 0,75 m — Schwellwert ≥ 0,80 m',
    },
  ],
})

const UNDECIDABLE = rule({
  ruleId: 'oib2-feuerwiderstand-tragend',
  undecidable: 34,
  unknowns: [
    {
      globalId: 'g-wall-1',
      name: 'AW 38',
      storeyName: 'Erdgeschoss',
      status: 'undecidable',
      reading: 'Kein Feuerwiderstand am Bauteil hinterlegt — erforderlich REI 60',
    },
  ],
  missing: [{ path: 'Pset_WallCommon.FireRating', elements: 34 }],
})

const STOOD_DOWN = rule({
  ruleId: 'oib6-u-wert-fenster',
  richtlinie: 'OIB 6',
  titleDe: 'Fenster — Wärmedurchgangskoeffizient',
  applicable: false,
  notApplicableReason: 'Gebäudeklasse in den Projektangaben nicht gesetzt',
})

const SUMMARY = {
  rulesApplicable: 2,
  rulesNotApplicable: 1,
  rulesFailing: 1,
  rulesUndecidable: 1,
  rulesPassing: 0,
  rulesEmpty: 0,
  elementsFailed: 2,
  elementsUndecidable: 34,
}

function panel(overrides: Partial<React.ComponentProps<typeof IfcCompliancePanel>> = {}) {
  return render(
    <IfcCompliancePanel
      rules={[FAILING, UNDECIDABLE, STOOD_DOWN]}
      summary={SUMMARY}
      shoppingList={[
        { path: 'Pset_WallCommon.FireRating', elements: 34, rules: ['oib2-feuerwiderstand-tragend'] },
      ]}
      isLoading={false}
      error={null}
      projectId="p1"
      modelFilename="haus-a.ifc"
      missingFacts={[]}
      askHref="/app/projects/p1/chat?ask=x"
      bcfHref="/api/projects/p1/bim/checks/export?modelId=m1"
      {...overrides}
    />
  )
}

describe('IfcCompliancePanel', () => {
  it('says so, above the badges, when the catalogue only saw part of the model', () => {
    // The element loader caps at 50 000 rows. A Prüfbuch that reports counts
    // over a capped page as though they covered the building is the exact
    // failure this whole feature exists to prevent — and it ends up in the
    // BCF export and on a signed confirmation.
    panel({ truncated: true })

    const warning = screen.getByText(/the catalogue saw only part of it/i)
    expect(warning).toBeInTheDocument()
    // Ahead of the counts it invalidates, in the DOM order a reader follows.
    expect(warning.compareDocumentPosition(screen.getByText(/Met/))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('says nothing when the whole model was checked', () => {
    panel()

    expect(screen.queryByText(/only part of it/i)).not.toBeInTheDocument()
  })

  it('offers the open items as a BCF download, counting only the rules with work left', () => {
    // The count must match what the archive actually carries: `FAILING` has
    // failures and `UNDECIDABLE` has unknowns; `STOOD_DOWN` is out of scope
    // and never becomes a topic.
    panel()

    const link = screen.getByRole('link', { name: /2 open items as BCF/ })
    expect(link).toHaveAttribute('href', '/api/projects/p1/bim/checks/export?modelId=m1')
    expect(link).toHaveAttribute('download')
  })

  it('names the tools the file opens in, because BCF means nothing on its own', () => {
    panel()

    expect(screen.getByText(/opens in ArchiCAD, Revit, Solibri or BIMcollab/)).toBeInTheDocument()
  })

  it('hides the download when the ledger has nothing to export', () => {
    // A BCF with no topics is a valid file and a confusing button.
    panel({ rules: [STOOD_DOWN] })

    expect(screen.queryByRole('link', { name: /as BCF/ })).not.toBeInTheDocument()
  })

  it('hides the download before the catalogue has run', () => {
    panel({ rules: null, bcfHref: null })

    expect(screen.queryByRole('link', { name: /as BCF/ })).not.toBeInTheDocument()
  })

  it('shows the threshold beside every rule, not just the verdict', () => {
    panel()
    // The architect checks the RULE, not only the result.
    expect(screen.getByText('lichte Durchgangsbreite ≥ 0,80 m')).toBeInTheDocument()
    // Two rules in this fixture share the Gebäudeklasse threshold, and BOTH
    // must print it — a rule that stood down still shows what it would apply.
    expect(screen.getAllByText(/GK1 R 30 … GK5 REI 90/)).toHaveLength(2)
  })

  it('gives "not decidable" the same weight as a failure', () => {
    panel()
    // 34 walls whose fire rating is unknown is not a smaller problem than two
    // narrow doors — it is an unknown one, and the badge row must say both.
    expect(screen.getByText('Not met 1')).toBeInTheDocument()
    expect(screen.getByText('Not decidable 1')).toBeInTheDocument()
  })

  it('prints the reading that produced each failure', () => {
    panel()
    expect(screen.getByText(/Breite 0,7 m — Schwellwert ≥ 0,80 m/)).toBeInTheDocument()
  })

  it('links a failing element into the model, highlighted and ghosted', () => {
    panel()
    const link = screen.getByRole('link', { name: 'T-14' })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('element=g-door-1')
    expect(href).toContain('hl=fail%3Ag-door-1')
    expect(href).toContain('xray=1')
  })

  it('offers one link that highlights every element a rule failed on', () => {
    panel()
    const group = screen.getByText('Not met:').closest('p')
    const href = within(group!).getByRole('link').getAttribute('href') ?? ''
    expect(href).toContain('hl=fail%3Ag-door-1%2Cg-door-2')
  })

  it('shows a rule that stood down, with its reason', () => {
    panel()
    // Hiding it would make an under-configured project look like a clean one.
    expect(screen.getByText(/Gebäudeklasse in den Projektangaben nicht gesetzt/)).toBeInTheDocument()
  })

  it('names the project data the brief is missing and offers to fix it', () => {
    panel({ missingFacts: ['gebaeudeklasse'] })
    expect(screen.getByText(/project data this brief does not carry: Gebäudeklasse/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set it with the assistant' })).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?ask=x'
    )
  })

  it('renders the shopping list as actions rather than as a score', () => {
    panel()
    expect(screen.getByText('Pset_WallCommon.FireRating')).toBeInTheDocument()
    expect(screen.getByText('on 34 elements')).toBeInTheDocument()
    // No number pretending to be a grade.
    expect(screen.queryByText(/\/100/)).not.toBeInTheDocument()
  })

  it('always carries the orientation disclaimer', () => {
    panel()
    expect(screen.getByText(/no legal advice and no Nachweis/)).toBeInTheDocument()
  })

  it('reports a failed run instead of an empty check', () => {
    panel({ rules: null, summary: null, shoppingList: null, error: 'load-failed' })
    expect(screen.getByText('The requirement check could not be run.')).toBeInTheDocument()
    expect(screen.queryByText(/no legal advice/)).not.toBeInTheDocument()
  })

  describe('human confirmations', () => {
    const CONFIRMED = rule({
      ruleId: 'oib2-feuerwiderstand-tragend',
      undecidable: 34,
      confirmation: {
        ruleId: 'oib2-feuerwiderstand-tragend',
        modelId: 'rev-3',
        confirmedBy: 'a.muster',
        note: 'Mit dem Brandschutzplaner abgeklärt.',
        confirmedAt: '2026-03-02T09:00:00.000Z',
      },
    })

    it('shows who settled it and why, beside the machine counts', () => {
      panel({ rules: [CONFIRMED] })
      expect(screen.getByText(/Confirmed by a.muster/)).toBeInTheDocument()
      expect(screen.getByText(/Mit dem Brandschutzplaner abgeklärt/)).toBeInTheDocument()
      // The machine verdict is NOT overwritten — the reader still sees that 34
      // walls publish nothing.
      expect(screen.getByText(/34 not decidable/)).toBeInTheDocument()
    })

    it('marks a confirmation from an older revision as no longer covering', () => {
      panel({ rules: [{ ...CONFIRMED, confirmationStale: true }] })
      expect(screen.getByText('Older revision')).toBeInTheDocument()
      expect(screen.getByText(/does not apply to the current revision/)).toBeInTheDocument()
      // Still recorded: a signature is not deleted by a re-export.
      expect(screen.getByText(/Confirmed by a.muster/)).toBeInTheDocument()
    })

    it('records a confirmation with the note the user typed', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined)
      panel({ rules: [rule({ ruleId: 'oib2-feuerwiderstand-tragend', undecidable: 34 })], onConfirm })
      await userEvent.click(screen.getByRole('button', { name: 'Confirm manually' }))
      await userEvent.type(screen.getByLabelText('Why this is settled'), 'Anhand des Plans geprüft')
      await userEvent.click(screen.getByRole('button', { name: 'Save confirmation' }))
      expect(onConfirm).toHaveBeenCalledWith('oib2-feuerwiderstand-tragend', 'Anhand des Plans geprüft')
    })

    it('lands the reader in the note field they just asked for', async () => {
      // Pressing "Bestätigen" unmounts the button that was pressed. Without a
      // focus move the reader is thrown to the top of the enclosing dialog and
      // has to Tab back through the whole Prüfbuch to reach a textarea that
      // appeared because of them — a signature a keyboard cannot complete
      // without counting Tab stops.
      panel({ rules: [rule({ ruleId: 'oib2-feuerwiderstand-tragend', undecidable: 34 })], onConfirm: vi.fn() })
      await userEvent.click(screen.getByRole('button', { name: 'Confirm manually' }))
      expect(document.activeElement).toBe(screen.getByLabelText('Why this is settled'))
    })

    it('gives focus back to the button that opened the form when it is cancelled', async () => {
      panel({ rules: [rule({ ruleId: 'oib2-feuerwiderstand-tragend', undecidable: 34 })], onConfirm: vi.fn() })
      await userEvent.click(screen.getByRole('button', { name: 'Confirm manually' }))
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm manually' }))
    })

    it('asks before deleting a signed record', async () => {
      // One click used to delete it — permanently, across every revision of
      // the building, with no confirmation, no undo, and no feedback beyond
      // the button vanishing. Everything else in this component asks first;
      // the note form is itself a two-step disclosure.
      const onWithdraw = vi.fn().mockResolvedValue(undefined)
      panel({ rules: [CONFIRMED], onConfirm: vi.fn(), onWithdraw })

      await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
      expect(onWithdraw).not.toHaveBeenCalled()
      expect(screen.getByText('Delete this confirmation and its note?')).toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
      expect(onWithdraw).toHaveBeenCalledWith('oib2-feuerwiderstand-tragend')
    })

    it('lets the reader back out of the withdrawal', async () => {
      const onWithdraw = vi.fn().mockResolvedValue(undefined)
      panel({ rules: [CONFIRMED], onConfirm: vi.fn(), onWithdraw })

      await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onWithdraw).not.toHaveBeenCalled()
      expect(screen.queryByText('Delete this confirmation and its note?')).not.toBeInTheDocument()
    })

    it('tells a read-only reader why, rather than telling them to try again', async () => {
      // The retry can never succeed and the note is retyped each time. The
      // panel's own prop doc says the write callbacks are absent for a viewer
      // without `project:edit`; nothing ever omits them.
      const onConfirm = vi.fn().mockRejectedValue(new Error('403'))
      panel({ rules: [rule({ ruleId: 'oib2-feuerwiderstand-tragend', undecidable: 34 })], onConfirm })

      await userEvent.click(screen.getByRole('button', { name: 'Confirm manually' }))
      await userEvent.type(screen.getByLabelText('Why this is settled'), 'Geprüft')
      await userEvent.click(screen.getByRole('button', { name: 'Save confirmation' }))

      expect(await screen.findByText(/cannot be added or withdrawn/)).toBeInTheDocument()
      expect(screen.queryByTestId('bim-confirmation-failed')).not.toBeInTheDocument()
      // And the note survives, so nothing they typed is lost.
      expect(screen.getByLabelText('Why this is settled')).toHaveValue('Geprüft')
    })

    it('says a brief it could not READ was not read, rather than naming gaps in it', () => {
      // Untested on both sides until now: the hook's `failed` had no assertion
      // and no caller passed `factsFailed`. The two sentences send the reader
      // to different places, and only one of them can help.
      panel({
        rules: [rule({ ruleId: 'oib3-raumhoehe', passed: 9 })],
        factsFailed: true,
        missingFacts: [],
      })
      expect(screen.getByText(/project brief could not be read/)).toBeInTheDocument()
      expect(screen.queryByText(/Some rules depend on project data/)).not.toBeInTheDocument()
    })

    it('offers nothing to confirm on a rule the model settled cleanly', () => {
      // A signature there would be one nobody needs.
      panel({ rules: [rule({ ruleId: 'oib3-raumhoehe', passed: 9 })], onConfirm: vi.fn() })
      expect(screen.queryByRole('button', { name: 'Confirm manually' })).not.toBeInTheDocument()
    })

    it('shows a confirmation to a viewer who cannot add one', () => {
      // Read access is enough to SEE the record; only writing is withheld.
      panel({ rules: [CONFIRMED] })
      expect(screen.getByText(/Confirmed by a.muster/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument()
    })
  })
})

describe('a confirmation that could not be saved', () => {
  const unsettled = rule({
    ruleId: 'oib2-feuerwiderstand-tragend',
    undecidable: 34,
    unknowns: [
      {
        status: 'undecidable',
        globalId: '0GridFixture00Wall0001',
        name: 'AW 38 Nord',
        storeyName: 'Erdgeschoss',
        reading: 'Kein Feuerwiderstand am Bauteil hinterlegt',
      },
    ],
  })

  const panel = (onConfirm: (ruleId: string, note: string) => Promise<void>) =>
    render(
      <IfcCompliancePanel
        rules={[unsettled]}
        summary={null}
        shoppingList={[]}
        isLoading={false}
        error={null}
        projectId="p1"
        modelFilename="haus.ifc"
        missingFacts={[]}
        askHref="/app/projects/p1/chat?ask=x"
        bcfHref={null}
        onConfirm={onConfirm}
      />
    )

  it('says so, instead of leaving the form open with no explanation', async () => {
    // The failure used to be invisible: the request rejected, the form stayed
    // open, and an architect who had just signed off a requirement had every
    // reason to believe it was recorded. A record of a decision that was never
    // recorded is the worst thing this surface can produce.
    const user = userEvent.setup()
    panel(() => Promise.reject(new Error('offline')))

    await user.click(screen.getByTestId('bim-confirm-open'))
    await user.click(screen.getByTestId('bim-confirm-save'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/NOT recorded/i)
    // And the form stays open, holding the note the person typed, so
    // "try again" does not mean "type it all again".
    expect(screen.getByTestId('bim-confirm-save')).toBeInTheDocument()
  })

  it('says nothing when the confirmation saved', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    panel(onConfirm)

    await user.click(screen.getByTestId('bim-confirm-open'))
    await user.click(screen.getByTestId('bim-confirm-save'))

    // Awaited on a POSITIVE signal first. Its sibling above needs
    // `findByRole('alert')` to see the failure, i.e. the alert arrives a tick
    // later — so asserting its ABSENCE synchronously would stay green for a
    // regression that surfaced it on the next tick.
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('bim-confirm-save')).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
