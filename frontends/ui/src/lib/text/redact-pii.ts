/**
 * Deterministic PII scrub — the first of three anonymization layers on the
 * platform-lessons pipeline (docs/architecture/platform-failure-learning.md):
 * regex scrub here, instructed omission in the distiller prompt, and an
 * auditor pass on the distilled text. No single layer is trusted, and this
 * one least of all: regexes catch the shapes of leaks (contact details,
 * account numbers, credentials), never the contextual identifiers ("the tower
 * project in Linz") — those are the LLM layers' job.
 *
 * Bought, not built (AGENTS.md): the pattern corpus is `@redactpii/node`, the
 * maintained zero-dependency successor of the 786k-download `redact-pii`.
 * What we evaluated and did not take: Microsoft Presidio is the strongest
 * library in this space but is Python + spaCy models — a native/model
 * toolchain in the image for a pre-scrub whose heavy lifting the LLM layers do
 * anyway (the carve-out AGENTS.md names). The Python reflection stage keeps
 * its own small denylist (`reflection.py::_PII_PATTERNS`) because it DROPS
 * findings rather than redacting spans — a different decision needing no
 * span-accurate replacement.
 *
 * The custom rules below are what a US-centric library cannot know: IBANs,
 * non-US phone shapes, and German/Austrian credential and ID keywords
 * (Sozialversicherungsnummer, Steuernummer, …) redacted through end-of-line,
 * because the value such a keyword labels usually follows it immediately and
 * its shape is unguessable.
 */

import { Redactor } from '@redactpii/node'

const redactor = new Redactor({
  rules: {
    EMAIL: true,
    PHONE: true,
    CREDIT_CARD: true,
    SSN: true,
    NAME: true,
  },
  customRules: [
    // IBAN.
    /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    // Non-US phone/fax-shaped digit runs (8+ digits with separators) — the
    // library's PHONE rule covers US formats only.
    /(?<!\d)(?:\+?\d[\d ()/-]{7,}\d)(?!\d)/g,
    // Credential/ID keywords redact through the end of their line, in both
    // languages the product speaks. Mirrors the reflection stage's keyword set.
    /\b(?:password|passwort|api[_ -]?key|secret|token|bearer|sozialversicherungsnummer|steuernummer|personalausweis)\b[^\n]*/gi,
  ],
})

/** Replace every leak-shaped span in `text` with a neutral marker. */
export function redactPii(text: string): string {
  return redactor.redact(text)
}
