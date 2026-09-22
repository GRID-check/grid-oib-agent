import { CONTACT_EMAIL } from '../consts'

/**
 * LAUNCH BLOCKER: the register data below is still placeholder.
 *
 * `legalForm`, `registerCourt`, `registerNumber` and `uid` must carry the real
 * operator identity before the site is published - § 5 ECG and § 25 MedienG
 * require them, and they render verbatim on /impressum in both locales.
 * `registerNote` in `i18n/ui.ts` (de and en) is the fifth, written as prose.
 */
export interface LegalIdentity {
  operator: string
  legalForm: string
  addressLines: string[]
  registerCourt: string
  registerNumber: string
  uid: string
  email: string
}

export const legalIdentity: LegalIdentity = {
  operator: 'Piloti',
  legalForm: '[Firmenname und Rechtsform — Platzhalter / placeholder]',
  addressLines: ['Kellermanngasse 8/12', '1070 Wien, Österreich / Austria'],
  registerCourt: '[Firmenbuchgericht — Platzhalter / placeholder]',
  registerNumber: '[Firmenbuchnummer — Platzhalter / placeholder]',
  uid: '[UID-Nummer — Platzhalter / placeholder]',
  email: CONTACT_EMAIL,
}
