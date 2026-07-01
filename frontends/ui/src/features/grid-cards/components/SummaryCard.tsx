// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FC } from 'react'
import { Card, Flex, Text } from '@/adapters/ui'
import type { SummaryCardData } from '../types'

export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  return (
    <Card className="border-l-4 border-l-brand border-base bg-surface-raised-30 p-4">
      <Flex direction="col" gap="2">
        <Text kind="label/semibold/md" className="text-brand">
          {title}
        </Text>

        {content && (
          <Text kind="body/regular/sm" className="text-primary">
            {content}
          </Text>
        )}

        {key_points && key_points.length > 0 && (
          <ul className="list-disc space-y-1 pl-4">
            {key_points.map((point, index) => (
              <Text
                key={`${point}-${index}`}
                asChild
                kind="body/regular/sm"
                className="text-primary"
              >
                <li>{point}</li>
              </Text>
            ))}
          </ul>
        )}
      </Flex>
    </Card>
  )
}
