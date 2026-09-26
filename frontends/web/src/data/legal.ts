import { CONTACT_EMAILS } from '../consts'
import { founders } from './founders'

/**
 * Who operates this site, as the Impressum (§ 5 ECG, § 25 MedienG) and the
 * privacy policy state it.
 *
 * Piloti is not incorporated yet: the three founders work together under a
 * letter of intent, which Austrian law treats as a GesbR, so the operator is
 * the founders by name. When the company is registered, this becomes its
 * Firma, Firmenbuchnummer, Firmenbuchgericht and UID, and `legal.impressum.status`
 * in `i18n/ui.ts` goes.
 *
 * LAUNCH BLOCKER: § 5 ECG requires a geographic address (street, number,
 * postcode). The founders chose to omit it during the proof of concept; add it
 * here before the site is promoted.
 */
export const legalIdentity = {
  members: founders.map((f) => f.name),
  seat: { de: 'Wien, Österreich', en: 'Vienna, Austria' },
  emails: CONTACT_EMAILS,
} as const
