// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Card, Flex, Text } from '@/adapters/ui'
import type { Project } from '@/lib/db/schema'

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps): JSX.Element {
  return (
    <Card className="p-4">
      <Flex direction="col" gap="3">
        <Text kind="label/bold/md" className="text-primary">
          {project.name}
        </Text>
        <Text kind="body/regular/sm" className="text-subtle">
          {project.collectionName}
        </Text>
        <Flex gap="3">
          <a
            href={`/chat?projectId=${project.id}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open chat
          </a>
          <a
            href={`/projects/${project.id}/members`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Members
          </a>
        </Flex>
      </Flex>
    </Card>
  )
}
