// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FC } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { LegalBasisCardData } from '../types'

export const LegalBasisCard: FC<LegalBasisCardData> = ({
  law,
  article,
  section,
  summary,
  original_text,
}) => {
  return (
    <Card className="border-l-info border-base bg-surface-raised-30 gap-2 border-l-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-info text-sm font-semibold">Legal basis: {law}</p>
        {article && (
          <Badge variant="outline" className="border-brand/30 text-brand">
            Art. {article}
          </Badge>
        )}
        {section && (
          <Badge variant="outline" className="border-brand/30 text-brand">
            § {section}
          </Badge>
        )}
      </div>

      {summary && <p className="text-primary text-sm">{summary}</p>}

      {original_text && (
        <blockquote className="border-info text-subtle my-1 border-l-4 pl-3 text-sm italic">
          {original_text}
        </blockquote>
      )}
    </Card>
  )
}
