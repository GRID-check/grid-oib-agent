// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FC } from 'react'
import { Flex } from '@/adapters/ui'
import type { GridCard } from '@/shared/cards/schemas'
import { SummaryCard } from './SummaryCard'
import { LegalBasisCard } from './LegalBasisCard'

interface GridCardsProps {
  /** Parsed grid cards to render. */
  cards: GridCard[]
}

/**
 * Renders a list of Grid cards (summary / legal_basis) in a vertical stack.
 */
export const GridCards: FC<GridCardsProps> = ({ cards }) => {
  if (cards.length === 0) {
    return null
  }

  return (
    <Flex direction="col" gap="3" className="w-full">
      {cards.map((card, index) => {
        const key = `${card.type}-${index}`

        if (card.type === 'summary') {
          return <SummaryCard key={key} {...card} />
        }

        return <LegalBasisCard key={key} {...card} />
      })}
    </Flex>
  )
}
