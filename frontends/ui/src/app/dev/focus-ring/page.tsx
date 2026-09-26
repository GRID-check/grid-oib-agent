'use client'

/**
 * Dev preview for the global `:focus-visible` treatment on rounded controls.
 * Renders the same control shapes the profile screen uses (a text input plus
 * two Selects nested inside a Card, i.e. a non-rounded parent) so a screenshot
 * can prove the focus outline follows each control's own `rounded-xl` rather
 * than squaring off. 404s outside development. See docs/ux/visual-screenshots.md.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'

export default function FocusRingDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-10" data-testid="focus-ring-preview">
      <Card>
        <CardHeader>
          <CardTitle>Focus ring — rounded controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Input data-testid="ring-input" defaultValue="Focus me (Tab)" aria-label="Sample input" />
          <Select defaultValue="dark">
            <SelectTrigger data-testid="ring-select" className="w-full" aria-label="Theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="de">
            <SelectTrigger data-testid="ring-select-2" className="w-full" aria-label="Language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="de">Deutsch</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Button data-testid="ring-button" variant="outline">
            A button
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
