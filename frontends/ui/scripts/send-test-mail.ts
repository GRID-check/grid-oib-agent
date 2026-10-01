/**
 * Deliver an .eml file to a local BFF exactly as the Cloudflare Email Worker
 * would (ADR-0075): the raw bytes as the body, the envelope recipient in
 * `x-envelope-to`, the size in `x-inbound-raw-size`, and the Worker's own token.
 *
 *   Usage:
 *     GRID_INBOUND_MAIL_TOKEN=… npx tsx scripts/send-test-mail.ts \
 *       --to wohnbau.abcdefgh2345@piloti.at path/to/mail.eml
 *
 *   Options:
 *     --to <address>     envelope recipient (required): the project address
 *     --url <base>       BFF base URL (default: $BFF_URL or http://localhost:3000)
 *
 * The BFF verifies the sender for real: an aligned, passing DKIM signature
 * that covers From, Subject and the To or Cc naming the project address. A
 * hand-written .eml is refused with 403, which is the correct answer and not
 * a bug in this script. Save a real mail from your client ("Show original" /
 * "Als Datei speichern") that was sent To or Cc the project address to test
 * the happy path; its signature still verifies as long as nothing it signs was
 * edited. The organization's `project-mail-inbox` switch must be on
 * (`GRID_PROJECT_MAIL_INBOX_ENABLED=true` without flag enforcement).
 *
 * A 202 means the mail is queued, not filed: the scheduler's drain files it on
 * its next tick (`POST /api/internal/inbound-mail/drain`, or run the scheduler).
 *
 * Prints the status and the JSON answer, and maps the answer the way the
 * Worker does, so what you see is what the sending server would be told.
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  INBOUND_ENVELOPE_TO_HEADER,
  INBOUND_RAW_SIZE_HEADER,
  INBOUND_VERDICT_HEADER,
  INBOUND_VERDICT_REJECT,
} from '../src/lib/inbound-mail/contract'

/**
 * The Worker's rule: bounce ONLY a 4xx that carries the reject verdict;
 * accept a 2xx; throw (so the sending server retries) on everything else.
 */
function workerOutcome(response: Response): string {
  if (response.status >= 200 && response.status < 300) {
    return response.status === 202 ? 'accept (queued for the drain)' : 'accept (a duplicate: nothing new stored)'
  }
  const rejected = response.headers.get(INBOUND_VERDICT_HEADER) === INBOUND_VERDICT_REJECT
  if (rejected && response.status >= 400 && response.status < 500) return 'reject (bounce)'
  return 'throw (the sending server retries)'
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      url: { type: 'string' },
    },
  })
  const file = positionals[0]
  const token = process.env.GRID_INBOUND_MAIL_TOKEN
  if (!file || !values.to) {
    console.error('usage: send-test-mail.ts --to <project address> [--url <bff>] <file.eml>')
    process.exit(2)
  }
  if (!token) {
    console.error('GRID_INBOUND_MAIL_TOKEN is not set (use the same value the BFF runs with).')
    process.exit(2)
  }

  const raw = await readFile(file)
  const base = (values.url ?? process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '')

  const response = await fetch(`${base}/api/internal/inbound-mail`, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      'x-grid-internal-token': token,
      [INBOUND_ENVELOPE_TO_HEADER]: values.to,
      [INBOUND_RAW_SIZE_HEADER]: String(raw.byteLength),
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
  console.log(`${response.status} → ${workerOutcome(response)}`)
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  if (!response.ok) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
