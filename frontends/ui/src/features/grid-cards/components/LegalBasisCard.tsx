// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FC } from 'react'
import { Card, Flex, Text, Badge } from '@/adapters/ui'
import type { LegalBasisCardData } from '../types'

export const LegalBasisCard: FC<LegalBasisCardData> = ({
  law,
  article,
  section,
  summary,
  original_text,
}) => {
  return (
    <Card className="border-l-4 border-l-info border-base bg-surface-raised-30 p-4">
      <Flex direction="col" gap="2">
        <Flex align="center" gap="2" wrap="wrap">
          <Text kind="label/semibold/md" className="text-info">
            Legal basis: {law}
          </Text>
          {article && (
            <Badge color="blue">
              Art. {article}
            </Badge>
          )}
          {section && (
            <Badge color="blue">
              § {section}
            </Badge>
          )}
        </Flex>

        {summary && (
          <Text kind="body/regular/sm" className="text-primary">
            {summary}
          </Text>
        )}

        {original_text && (
          <blockquote className="border-info text-subtle my-1 border-l-4 pl-3 italic">
            <Text kind="body/regular/sm">{original_text}</Text>
          </blockquote>
        )}
      </Flex>
    </Card>
  )
}
