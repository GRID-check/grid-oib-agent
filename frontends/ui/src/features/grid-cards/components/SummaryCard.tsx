// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FC } from 'react'
import { Card } from '@/components/ui/card'
import type { SummaryCardData } from '../types'

export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  return (
    <Card className="border-l-brand border-base bg-surface-raised-30 gap-2 border-l-4 p-4">
      <p className="text-brand text-sm font-semibold">{title}</p>

      {content && <p className="text-primary text-sm">{content}</p>}

      {key_points && key_points.length > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {key_points.map((point, index) => (
            <li key={`${point}-${index}`} className="text-primary text-sm">
              {point}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
