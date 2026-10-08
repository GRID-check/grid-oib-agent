'use client'

/**
 * Dev preview for the composer's „Sensible Daten" notice (ADR-0086, "Chat
 * messages are screened too"). Renders the REAL notice over the REAL matcher
 * with Piloti's suggested list, no backend:
 *
 *  - the agreed mock: one IBAN;
 *  - a message with a content term, an IBAN and a social-security number;
 *  - two IBANs (a count, no sample);
 *  - a live box: type, press the button, see what the composer would say.
 *
 * The buttons only say which was pressed; the composer owns the send. Not linked from
 * anywhere and 404s outside development.
 */

import { useState, type JSX } from 'react'
import { notFound } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { ChatScreeningNotice } from '@/features/chat/components/ChatScreeningNotice'
import {
  chatScreeningRules,
  maskText,
  type MaskedText,
} from '@/lib/upload-screening/content-screen'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

const RULES = chatScreeningRules(SUGGESTED_SCREENING_POLICY)

const SAMPLES: Array<{ title: string; text: string }> = [
  { title: 'One IBAN (the agreed mock)', text: 'Bitte überweise an AT61 1904 3002 3457 3201' },
  {
    title: 'A content term, an IBAN and a social-security number',
    text: 'Anbei der Lohnzettel für März. Konto AT61 1904 3002 3457 3201, SVNR 1237 010180.',
  },
  {
    title: 'Two IBANs',
    text: 'Alt: AT61 1904 3002 3457 3201, neu: DE89 3704 0044 0532 0130 00',
  },
]

function Composed({ text, masked }: { text: string; masked: MaskedText }): JSX.Element {
  const [pressed, setPressed] = useState<string | null>(null)
  return (
    <div className="bg-card rounded-xl border p-3">
      <p className="px-1.5 py-1 text-sm">{text}</p>
      <ChatScreeningNotice
        findings={masked.findings}
        maskedText={masked.text}
        onSendMasked={() => setPressed(`Sent: ${masked.text}`)}
        onEdit={() => setPressed('Back to the editor; nothing sent.')}
      />
      {pressed && <p className="text-muted-foreground mt-2 text-xs">{pressed}</p>}
    </div>
  )
}

export default function ChatScreeningDevPage(): JSX.Element {
  const [draft, setDraft] = useState('Gehaltsabrechnung, Karte 4111 1111 1111 1111')
  const [checked, setChecked] = useState<MaskedText | null>(null)

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main
      className="mx-auto flex max-w-2xl flex-col gap-6 p-4 sm:p-8"
      data-testid="chat-screening-preview"
    >
      <div>
        <h1 className="text-lg font-semibold">Composer — Sensible Daten</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What the composer says before a message with sensitive data leaves the browser (ADR-0086).
          Piloti&apos;s suggested list; the office&apos;s own list works the same way.
        </p>
      </div>
      {SAMPLES.map((sample) => (
        <Card key={sample.title}>
          <CardHeader>
            <CardTitle className="text-sm">{sample.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Composed text={sample.text} masked={maskText(sample.text, RULES)} />
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Try it</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setChecked(null)
            }}
            aria-label="Message"
          />
          <Button
            type="button"
            size="sm"
            className="self-start"
            onClick={() => setChecked(maskText(draft, RULES))}
          >
            Check
          </Button>
          {checked && checked.findings.length > 0 && <Composed text={draft} masked={checked} />}
          {checked && checked.findings.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Nothing found: the composer would send it as typed.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
