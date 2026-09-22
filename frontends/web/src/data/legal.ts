import { CONTACT_EMAIL } from '../consts'

/**
 * Who answers for this site, in the shape § 5 ECG and § 25 MedienG ask for.
 *
 * There is no company yet. Until the FlexCo reaches the Firmenbuch the three
 * founders are the Medieninhaber personally, and the register fields have no
 * value to carry - a sole trader who is not registered HAS no Firmenbuchnummer,
 * and without a Gewerbeberechtigung there is no chamber to name. That is why
 * they are optional rather than blank: /impressum drops the whole register
 * section while every one of them is unset, and shows it again the day one is
 * filled. Blank strings would have rendered "Firmenbuchnummer:" with nothing
 * behind it.
 *
 * ONCE THE FLEXCO IS REGISTERED: put the company in `mediaOwners`, set
 * `legalForm`, `registerNumber` and `registerCourt`, and add `uid` and
 * `chamber` when the UID and the Gewerbeberechtigung follow.
 */
export interface LegalIdentity {
  /** The brand the site trades under. Not a legal entity, so not enough on its own. */
  operator: string
  /** Everyone who answers for the site by name - the founders, later the company. */
  mediaOwners: string[]
  /** Company name and legal form. Unset while there is no company. */
  legalForm?: string
  addressLines: string[]
  registerCourt?: string
  registerNumber?: string
  uid?: string
  /** Chamber and supervising authority (§ 5 ECG). None without a Gewerbeberechtigung. */
  chamber?: string
  email: string
}

export const legalIdentity: LegalIdentity = {
  operator: 'Piloti',
  mediaOwners: ['[Die drei Gründer, je Vor- und Nachname — Platzhalter / placeholder]'],
  addressLines: ['Kellermanngasse 8/12', '1070 Wien, Österreich / Austria'],
  email: CONTACT_EMAIL,
}

/**
 * The identity as lines, in the order an Impressum states it. Shared so the
 * imprint and the privacy policy can never name a different set of people:
 * one renders the lines stacked, the other joins them into a sentence.
 */
export function identityLines(id: LegalIdentity): string[] {
  return [id.operator, ...id.mediaOwners, id.legalForm, ...id.addressLines].filter(
    (line): line is string => Boolean(line)
  )
}
