/**
 * Render tests for the four "answer shape" cards — the verdict header, the
 * condition tree, the typed table and the norm chain. Focus: each renders its
 * headline content, the active branch is marked, typed columns render by type
 * (a verdict cell as its German word, a numeric column right-aligned), and the
 * norm chain distinguishes binding from interpretive links in words, not colour.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VerdictHeaderCard } from './VerdictHeaderCard'
import { ConditionTreeCard } from './ConditionTreeCard'
import { TypedTableCard } from './TypedTableCard'
import { NormChainCard } from './NormChainCard'

describe('VerdictHeaderCard', () => {
  it('renders the subject, the verdict and the confidence label', () => {
    render(
      <VerdictHeaderCard
        verdict="1,10 m"
        subject="Erforderliche Geländerhöhe"
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 4.3' }}
        confidence="high"
        confidence_reason={null}
      />,
    )

    expect(screen.getByText('Erforderliche Geländerhöhe')).toBeInTheDocument()
    expect(screen.getByText('1,10 m')).toBeInTheDocument()
    expect(screen.getByText('hohe Sicherheit')).toBeInTheDocument()
    // The grounding norm rides in the shared citation footer.
    expect(screen.getByText('OIB-Richtlinie 4')).toBeInTheDocument()
  })
})

describe('ConditionTreeCard', () => {
  const branches = [
    { condition: 'GK 1–3', outcome: 'REI 30' },
    { condition: 'GK 4', outcome: 'REI 60', active: true },
    {
      condition: 'GK 5',
      outcome: 'REI 90',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
    },
  ]

  it('renders the deciding factor, every branch, and marks the active one', () => {
    render(
      <ConditionTreeCard
        title="Erforderliche Feuerwiderstandsklasse"
        question="Gebäudeklasse"
        branches={branches}
        reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
      />,
    )

    expect(screen.getByText('Gebäudeklasse')).toBeInTheDocument()
    // Every case is present, collapsed or not.
    expect(screen.getByText('GK 1–3')).toBeInTheDocument()
    expect(screen.getByText('GK 4')).toBeInTheDocument()
    expect(screen.getByText('GK 5')).toBeInTheDocument()
    expect(screen.getByText('REI 60')).toBeInTheDocument()
    // The matching branch is called out in words, not by colour alone.
    expect(screen.getByText('trifft zu')).toBeInTheDocument()
  })

  it('expands a branch on click to reveal its norm (hidden while collapsed)', async () => {
    const user = userEvent.setup()
    render(
      <ConditionTreeCard
        title="Erforderliche Feuerwiderstandsklasse"
        question="Gebäudeklasse"
        branches={branches}
        reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
      />,
    )

    // GK 5 starts collapsed, so the norm it rests on is not in the document yet.
    // The section (unique to the branch) stands in for the whole reference block;
    // the bare document name also rides in the card footer, so it is not a proof.
    expect(screen.queryByText('Tabelle 1b')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /GK 5/ }))

    // „Ich klick das und sehe mehr" — the branch's Grundlage is now revealed.
    expect(screen.getByText('Tabelle 1b')).toBeInTheDocument()
    expect(screen.getByText('Grundlage')).toBeInTheDocument()
  })
})

describe('TypedTableCard', () => {
  it('renders columns by type: a verdict word and a numeric cell', () => {
    render(
      <TypedTableCard
        title="Mindestmaße barrierefreie Erschließung"
        columns={[
          { label: 'Bauteil', type: 'text' },
          { label: 'Mindestmaß', type: 'mass' },
          { label: 'Erfüllt', type: 'verdict' },
        ]}
        rows={[
          ['Türdurchgangsbreite', '90 cm', 'erfüllt'],
          ['Rampenneigung', '6 %', 'nicht erfüllt'],
        ]}
        reference={{ document: 'ÖNORM B 1600' }}
        note={null}
      />,
    )

    expect(screen.getByRole('columnheader', { name: 'Mindestmaß' })).toBeInTheDocument()
    expect(screen.getByText('Türdurchgangsbreite')).toBeInTheDocument()
    expect(screen.getByText('90 cm')).toBeInTheDocument()
    // A verdict cell renders its German word as a status chip, with the word
    // carrying the verdict (colour never travels alone).
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
  })
})

describe('NormChainCard', () => {
  it('renders the chain and tags binding vs interpretive links', () => {
    render(
      <NormChainCard
        title="Normenkette – Absturzsicherung"
        links={[
          { label: 'Wiener Bautechnikverordnung', rank: 'verordnung', note: 'erklärt die OIB-Richtlinien' },
          { label: 'OIB-Richtlinie 4', rank: 'oib_richtlinie', note: null },
          { label: 'ÖNORM B 1600', rank: 'oenorm', note: null },
        ]}
      />,
    )

    expect(screen.getByText('Wiener Bautechnikverordnung')).toBeInTheDocument()
    expect(screen.getByText('ÖNORM B 1600')).toBeInTheDocument()
    // A binding link is tagged "bindend"; the OIB-Richtlinie carries its caveat;
    // an interpretive ÖNORM is tagged "auslegend".
    expect(screen.getByText('bindend')).toBeInTheDocument()
    expect(screen.getByText('bindend, wenn erklärt')).toBeInTheDocument()
    expect(screen.getByText('auslegend')).toBeInTheDocument()
  })
})
