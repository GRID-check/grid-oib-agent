import type { en } from '../en'

/**
 * mailThread namespace: der E-Mail-Verlauf, eine Korrespondenz als ein
 * Dokument (ADR-0134). Der Reiter „E-Mails“, das Folgen und das Herauslösen
 * (D16) ergänzen ihn; die festen Codelisten aus `lib/mail-thread` werden hier
 * formuliert, damit jede Fläche sie gleich sagt.
 *
 * Die Worte der Darstellung selbst (Abschnittsüberschriften, „eingegangen …“,
 * „Zitat in der Nachricht von …“) stehen NICHT hier, sondern versioniert in
 * `lib/mail-thread/render-copy.ts`: eine Änderung schriebe jeden Abschnitt neu.
 */
export const mailThread: typeof en.mailThread = {
  followIneligible: {
    no_active_follow: 'Niemand folgt diesem E-Mail-Verlauf',
    sender_not_verified: 'Die Domain des Absenders ist nicht bestätigt',
    match_not_reference: 'Die E-Mail verweist auf keine E-Mail dieses E-Mail-Verlaufs',
    header_not_signed: 'Der Verweis auf den E-Mail-Verlauf ist nicht von der Domain signiert',
    flagged: 'Die E-Mail ist an andere adressiert, oder ihr Datum ist nicht plausibel',
    automatic: 'Die E-Mail wurde automatisch gesendet',
    new_participant_domain: 'Neue Beteiligte: {domains}',
    name_stop: 'Die Namensprüfung hat den Betreff angehalten',
    content_finding: 'Die Inhaltsprüfung hat im Text etwas gefunden',
  },
  followEnd: {
    unfollowed: 'Sie folgen nicht mehr',
    expired: 'Das Folgen ist abgelaufen',
    access_lost: 'Der Zugriff auf den E-Mail-Verlauf ist weggefallen',
    address_rotated: 'Die E-Mail-Adresse des Projekts wurde ersetzt',
    detached: 'Eine E-Mail wurde aus dem E-Mail-Verlauf herausgelöst',
    document_gone: 'Der E-Mail-Verlauf wurde gelöscht',
    revoked_by_manager: 'Von der Projektverwaltung beendet',
  },
}
