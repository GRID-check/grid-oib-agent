// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useActionState } from 'react'
import { Button, Flex, Text, TextInput } from '@/adapters/ui'
import { createProject, type CreateProjectState } from '@/app/projects/actions'

const initialState: CreateProjectState = {}

export function CreateProjectForm(): JSX.Element {
  const [state, formAction, isPending] = useActionState(createProject, initialState)

  return (
    <form action={formAction}>
      <Flex direction="col" gap="4">
        <TextInput
          name="name"
          placeholder="e.g. Vienna Tower Renovation"
          disabled={isPending}
          autoFocus
          aria-label="Project name"
        />

        {state.error && (
          <Text kind="body/regular/sm" className="text-red-500">
            {state.error}
          </Text>
        )}

        <Flex gap="2" justify="end">
          <Button kind="primary" size="small" type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create project'}
          </Button>
        </Flex>
      </Flex>
    </form>
  )
}
