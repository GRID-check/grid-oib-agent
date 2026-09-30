/**
 * Deliver an .eml file to a local BFF exactly as the Cloudflare Email Worker
 * would (ADR-0074): the raw bytes as the body, the envelope recipient in
 * `x-envelope-to`, and the Worker's own token.
 *
 *   Usage:
 *     GRID_INBOUND_MAIL_TOKEN=… npx tsx scripts/send-test-mail.ts \
 *       --to wohnbau.abcdefgh2345@piloti-post.at path/to/mail.eml
 *
 *   Options:
 *     --to <address>     envelope recipient (required): the project address
 *     --from <address>   envelope sender, informational (default: the From header's)
 *     --url <base>       BFF base URL (default: $BFF_URL or http://localhost:3000)
 *
 * The BFF verifies the sender for real — DKIM against DNS, or an enforcing
 * DMARC record — so a hand-written .eml from a domain without either is
 * refused with 403, which is the correct answer and not a bug in this script.
 * Save a real mail from your client ("Show original" / "Als Datei speichern")
 * to test the happy path; its DKIM signature still verifies as long as nothing
 * in the signed headers or the body was edited.
 *
 * Prints the status and the JSON answer, and maps the status the way the
 * Worker does, so what you see is what the sending server would be told.
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

function workerOutcome(status: number): string {
  if (status >= 200 && status < 300) return 'accept'
  if (status === 403 || status === 404 || status === 413) return 'reject (bounce)'
  return 'throw (the sending server retries)'
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      url: { type: 'string' },
    },
  })
  const file = positionals[0]
  const token = process.env.GRID_INBOUND_MAIL_TOKEN
  if (!file || !values.to) {
    console.error('usage: send-test-mail.ts --to <project address> [--from <sender>] [--url <bff>] <file.eml>')
    process.exit(2)
  }
  if (!token) {
    console.error('GRID_INBOUND_MAIL_TOKEN is not set (use the same value the BFF runs with).')
    process.exit(2)
  }

  const raw = await readFile(file)
  const fromHeader = /^From:.*?([^\s<>"]+@[^\s<>"]+)/im.exec(raw.toString('latin1'))?.[1]
  const base = (values.url ?? process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '')

  const response = await fetch(`${base}/api/internal/inbound-mail`, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      'x-grid-internal-token': token,
      'x-envelope-to': values.to,
      'x-envelope-from': values.from ?? fromHeader ?? '',
    },
    body: raw,
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON (a proxy error page, say): print it as it came.
  }
  console.log(`${response.status} → ${workerOutcome(response.status)}`)
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  if (!response.ok) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
