import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
// Type-only, and deliberately so: `document-roles` imports the condition
// evaluator from this module as a VALUE. A type import is erased at compile
// time, so the two files reference each other without a runtime cycle.
import type { DocumentRole } from './document-roles'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

// ---------------------------------------------------------------------------
// Project-Wizard Baurecht Österreich — machine-readable content specification.
//
// Faithful implementation of `wizard_spec.json` / `wizard_konzept.md`: modules
// A–H, the stable question IDs (A5, C4, D_garagenfl …) that are the reference
// anchors of the later classification logic, the four scopes
// (projekt → grundstück → bauwerk 1..n → nutzungszone 1..n per bauwerk), and the
// three answer modes.
//
// Answer modes map onto the profile's existing three-state model rather than a
// new schema field, so the mode already reaches the AI agent through the
// prompt-view (confirmed: / assumptions: / unknown: sections):
//   • number_tri mode 'wert'       → confirmed fact
//   • number_tri mode 'geschaetzt' → unconfirmed assumption (estimated)
//   • number_tri mode 'offen'      → unknown
//   • yes_no_open 'ja' / 'nein'    → boolean fact
//   • yes_no_open 'offen'          → unknown
//
// The stable question `id` is the classification anchor; `writesTo` bridges it to
// a descriptive storage key so the jurisdiction pipeline (facts.bundesland) and
// the LLM-consumed prompt view stay readable. Two bridges are load-bearing and
// MUST NOT change key: A1 → project_name, A2_land → bundesland.
// ---------------------------------------------------------------------------

export type ProjectIntakeQuestionType =
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'number'
  | 'text'
  | 'textarea'
  | 'number_tri'
  | 'yes_no_open'
  | 'upload'
  | 'document_role'
  | 'info_placeholder'

/** The three answer-modes a number_tri question persists. */
export type IntakeAnswerMode = 'wert' | 'geschaetzt' | 'offen'

/** The three-valued yes_no_open answer. */
export type YesNoOpen = 'ja' | 'nein' | 'offen'

export type ProjectIntakeScope = 'projekt' | 'grundstueck' | 'bauwerk'

export interface ProjectIntakeOption {
  value: string
  label: string
}

/**
 * A single display condition. Multiple conditions on one question are
 * AND-combined. `param` references another question's id; it is resolved within
 * the same scope instance (a bauwerk question's condition on `C1` reads *this*
 * bauwerk's C1), falling back to the project-global answer for project-scope
 * params such as `A5`.
 */
export interface ProjectIntakeCondition {
  param: string
  /** `lte` is numeric and only satisfied when a value exists AND its answer mode is not 'offen'. */
  op: 'equals' | 'includes_any' | 'not_empty' | 'lte'
  value?: string | string[] | number
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  type: ProjectIntakeQuestionType
  /** Short helper under the label. */
  help?: string
  /** One-sentence legal rationale, shown behind a "Warum fragen wir das?" toggle. */
  why?: string
  /** Extra guidance / definition hint. */
  hint?: string
  /** Unit suffix for numeric questions (m, m², dB …). */
  unit?: string
  /**
   * For `document_role`: which slot this question fills. The binding is stored
   * in `document_roles`, not in the answer map — a document is not an answer,
   * and putting a file id in the profile would make the profile the second
   * place a binding lives.
   */
  role?: DocumentRole
  /**
   * Sub-heading this question opens within its module.
   *
   * Modul C interleaves two descriptions of the same building — what stands
   * there today (CB*) and what will stand there after the work (C3–C11) — and
   * the Zielzustand principle is the concept's whole basis for deriving the
   * Gebäudeklasse. Running them together as one list of twenty-two fields makes
   * "Bestand heute: oberirdische Geschoße" and "Anzahl oberirdischer Geschoße
   * (Zielzustand)" look like the same question asked twice.
   */
  group?: string
  /**
   * Kernfrage: shown in Schnellstart mode; every non-core question the
   * Schnellstart skips is persisted with mode 'offen' so the completion
   * checklist in Modul H can list it.
   */
  core?: boolean
  /**
   * Part of the Bebauungsplan extraction core set (concept Kap. 4-B): the
   * values the phase-2 vision extraction targets and the review screen
   * confirms. Descriptive until that flow lands.
   */
  kernset?: boolean
  placeholder?: string
  options?: ProjectIntakeOption[]
  /** AND-combined display conditions. */
  conditions?: ProjectIntakeCondition[]
  writesTo?: string
  /**
   * Hard-required: the wizard blocks advancing until this is answered. Per the
   * konzept only A1/A2/A5 are required; everything else is deliberately soft so
   * the wizard never blocks (an empty answer degrades to an unknown).
   */
  required?: boolean
  /**
   * Skippable: shown with an "optional" hint. Purely cosmetic — non-required
   * questions are already non-blocking; this just labels the ones worth flagging.
   */
  optional?: boolean
  /**
   * For `info_placeholder`: the id of the system derivation that will appear
   * here in phase 2 (e.g. `gebaeudeklasse`, `uvp`). Purely descriptive.
   */
  derives?: string
}

/** A per-use zone question set (module D `zone_definitions`). */
export interface ProjectIntakeZoneDefinition {
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeStage {
  id: string
  title: string
  description?: string
  scope: ProjectIntakeScope
  /** `bauwerk` modules render once per building. */
  repeatable?: boolean
  questions: ProjectIntakeQuestion[]
  /** Module D: questions asked for every selected use-zone. */
  zoneCommon?: ProjectIntakeQuestion[]
  /** Module D: use-specific follow-up questions, keyed by the D0 option value. */
  zoneDefinitions?: Record<string, ProjectIntakeZoneDefinition>
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}

/** The use-catalog (D0), reused for both the multi-select and the zone expansion. */
const NUTZUNGEN: ProjectIntakeOption[] = [
  { value: 'wohnen', label: 'Wohnen' },
  { value: 'buero', label: 'Büro / Verwaltung' },
  { value: 'handel', label: 'Handel / Verkauf' },
  { value: 'gastro', label: 'Gastronomie' },
  { value: 'beherbergung', label: 'Beherbergung' },
  { value: 'versammlung', label: 'Versammlung / Veranstaltung' },
  { value: 'bildung', label: 'Bildung / Betreuung' },
  { value: 'gesundheit', label: 'Gesundheit / Pflege' },
  { value: 'produktion', label: 'Produktion / Gewerbe / Lager' },
  { value: 'garage', label: 'Garage / Stellplätze' },
  { value: 'landwirtschaft', label: 'Landwirtschaft' },
  { value: 'technik', label: 'Technik / Sonstiges' },
]

export const projectIntakeDefinitionV1: ProjectIntakeDefinition = {
  version: 5,
  stages: [
    // ------------------------------------------------------------------ A
    {
      id: 'A',
      title: 'Projektbasis',
      scope: 'projekt',
      description: 'Stammdaten, Standort und Art des Vorhabens.',
      questions: [
        {
          id: 'A1',
          core: true,
          label: 'Projektname',
          type: 'text',
          required: true,
          placeholder: 'z. B. WHA Quellenstraße',
          writesTo: '/facts/project_name/value',
        },
        {
          id: 'A2_adr',
          core: true,
          label: 'Adresse / Gemeinde',
          type: 'text',
          required: true,
          placeholder: 'Straße, PLZ Ort',
          why: 'Aus der Gemeinde folgen örtliche Vorschriften wie Fernwärme-Anschlussgebiete oder Schutzzonen.',
          writesTo: '/facts/standort_adresse/value',
        },
        // Spec id A2_staat with AT/DE only. Kept as the shipped superset: the
        // storage key `country` and its token set are load-bearing (mirrored by
        // the backend jurisdiction pipeline), and CH/other already exist in
        // stored projects. The German Bundesland list rides with the German
        // question catalog (v2, per README Länder-Scope) — until then non-AT
        // locations describe themselves in `standort_details`.
        {
          id: 'A2_country',
          core: true,
          label: 'Land',
          type: 'single_select',
          required: true,
          help: 'In welchem Land befindet sich das Bauvorhaben?',
          why: 'Über den Standort stellt das System zusammen, welche Rechtstexte und Richtlinien für dieses Projekt gelten. Für Deutschland werden Fragebogen und Regelwerks-Layer noch angepasst.',
          options: [
            { value: 'at', label: 'Österreich (AT)' },
            { value: 'de', label: 'Deutschland (DE)' },
            { value: 'ch', label: 'Schweiz (CH)' },
            { value: 'other', label: 'Anderes Land' },
          ],
          writesTo: '/facts/country/value',
        },
        {
          id: 'A2_land',
          core: true,
          label: 'Bundesland',
          type: 'single_select',
          required: true,
          conditions: [{ param: 'A2_country', op: 'equals', value: 'at' }],
          why: 'Bestimmt, welche landesspezifischen Rechtstexte für den Standort herangezogen werden.',
          options: [
            { value: 'wien', label: 'Wien' },
            { value: 'niederoesterreich', label: 'Niederösterreich' },
            { value: 'oberoesterreich', label: 'Oberösterreich' },
            { value: 'steiermark', label: 'Steiermark' },
            { value: 'kaernten', label: 'Kärnten' },
            { value: 'salzburg', label: 'Salzburg' },
            { value: 'tirol', label: 'Tirol' },
            { value: 'vorarlberg', label: 'Vorarlberg' },
            { value: 'burgenland', label: 'Burgenland' },
            { value: 'ausserhalb_oesterreichs', label: 'Außerhalb Österreichs' },
          ],
          writesTo: '/facts/bundesland/value',
        },
        {
          id: 'standort_details',
          label: 'Land & Region',
          help: 'Land und Region/Stadt, z. B. „Bayern, Deutschland" — für die Einordnung des anwendbaren Rechts.',
          type: 'text',
          conditions: [{ param: 'A2_country', op: 'includes_any', value: ['de', 'ch', 'other'] }],
          writesTo: '/facts/standort_details/value',
        },
        {
          id: 'A4',
          core: true,
          label: 'Aktuelle Projektphase',
          type: 'single_select',
          why: 'Steuert die Erwartung an die Antwortgüte und das Phasen-Nudging: in frühen Phasen werden Schätzwerte aktiv angeboten, vor der Einreichung an offene Schätzungen erinnert.',
          options: [
            { value: 'grundlagenermittlung', label: 'Grundlagenermittlung' },
            { value: 'vorentwurf', label: 'Vorentwurf' },
            { value: 'entwurf', label: 'Entwurf' },
            { value: 'einreichplanung', label: 'Einreichplanung' },
            { value: 'ausfuehrungsplanung', label: 'Ausführungsplanung' },
            { value: 'ausschreibung_vergabe', label: 'Ausschreibung & Vergabe' },
            { value: 'ausfuehrung', label: 'Ausführung' },
            { value: 'fertigstellung_uebergabe', label: 'Fertigstellung & Übergabe' },
            { value: 'bestand_betrieb', label: 'Bestand & Betrieb' },
          ],
          writesTo: '/facts/projektphase/value',
        },
        {
          id: 'A5',
          core: true,
          label: 'Art des Vorhabens (Projekt gesamt)',
          type: 'multi_select',
          required: true,
          why: 'Steuert, welche Fragen und Themen für dieses Projekt überhaupt relevant sind.',
          options: [
            { value: 'neubau', label: 'Neubau' },
            { value: 'zubau', label: 'Zubau' },
            { value: 'umbau', label: 'Umbau' },
            { value: 'sanierung', label: 'Sanierung' },
            { value: 'nutzungsaenderung', label: 'Nutzungsänderung' },
            { value: 'abbruch', label: 'Abbruch' },
            { value: 'aussenanlagen', label: 'Außenanlagen' },
          ],
          writesTo: '/facts/vorhabensart/value',
        },
      ],
    },
    // ------------------------------------------------------------------ B
    {
      id: 'B',
      title: 'Grundstück & Widmung',
      scope: 'grundstueck',
      description:
        'Widmung, Bebauungsplan-Kernset, Standortrisiken und Erschließung. Jede Kennzahl einzeln offen lassbar.',
      questions: [
        {
          id: 'B1',
          core: true,
          label: 'Flächenwidmung (Kategorie)',
          type: 'single_select',
          optional: true,
          why: 'Hilft einzuschätzen, ob die geplante Nutzung an diesem Standort grundsätzlich möglich ist.',
          options: [
            { value: 'wohngebiet', label: 'Wohngebiet' },
            { value: 'gemischt', label: 'gemischtes Baugebiet' },
            { value: 'kerngebiet', label: 'Kerngebiet' },
            { value: 'betriebsgebiet', label: 'Betriebs-/Industriegebiet' },
            { value: 'sondergebiet', label: 'Sondergebiet' },
            { value: 'gruenland_sonder', label: 'Grünland mit Sonderwidmung' },
            { value: 'sonstige', label: 'sonstige' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/flaechenwidmung/value',
        },
        {
          // v1.0's B1_orig, now unconditionally visible: the original wording
          // OR the user's own words both land here.
          id: 'B1_text',
          core: true,
          label: 'Widmung im Originalwortlaut oder eigenen Worten',
          type: 'text',
          optional: true,
          placeholder: 'z. B. W II g 12m – oder frei beschreiben',
          writesTo: '/facts/flaechenwidmung_orig/value',
        },
        {
          id: 'B2',
          core: true,
          label: 'Liegt ein Bebauungsplan vor?',
          type: 'yes_no_open',
          writesTo: '/facts/bebauungsplan/value',
        },
        {
          // Spec: unconditional `upload` for B-Plan OR FWP. Ours binds the
          // `bebauungsplan` role, so it stays behind B2 = ja; the
          // Flächenwidmungsplan has its own Modul I slot. Same document space
          // either way (ADR: document_roles), so "dort abgelegte Dokumente hier
          // als erledigt anzeigen" holds by construction.
          id: 'B2_upl',
          core: true,
          label: 'Bebauungsplan ablegen',
          type: 'document_role',
          role: 'bebauungsplan',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          why: 'Der Plan ist die Quelle für Bauklasse, Bebauungsweise, Dichte und Fluchtlinien — Piloti kann sich dann darauf beziehen.',
        },
        {
          id: 'B3_hoehe',
          label: 'Bauklasse oder zulässige Gebäudehöhe',
          type: 'number_tri',
          unit: 'm',
          kernset: true,
          why: 'Höhenvorgaben der Landes-Bauordnung; Grundlage der Zulässigkeitsprüfung des Entwurfs.',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/max_gebaeudehoehe/value',
        },
        {
          id: 'B3_weise',
          label: 'Bebauungsweise',
          type: 'single_select',
          kernset: true,
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          options: [
            { value: 'offen', label: 'offen' },
            { value: 'gekuppelt', label: 'gekuppelt' },
            { value: 'geschlossen', label: 'geschlossen' },
            { value: 'noch_offen', label: 'noch offen' },
          ],
          writesTo: '/facts/bebauungsweise/value',
        },
        {
          id: 'B3_dichte',
          label: 'Bebauungsdichte (GFZ, GRZ oder bebaubare Fläche)',
          type: 'number_tri',
          kernset: true,
          placeholder: 'z. B. 1.5',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/bebauungsdichte/value',
        },
        {
          id: 'B3_flucht',
          label: 'Baufluchtlinien oder Baugrenzen einschränkend?',
          type: 'yes_no_open',
          kernset: true,
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/baufluchtlinien/value',
        },
        {
          // Absorbs v1.0's A8 (Schutzzone / Altstadterhaltung) — part of the
          // B-Plan-Kernset now.
          id: 'B3_bes',
          label: 'Besondere Bestimmungen inkl. Schutzzone',
          type: 'text',
          kernset: true,
          optional: true,
          placeholder: 'z. B. Schutzzone, Dachvorschriften, Begrünungspflicht',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/bebauungsplan_besonderes/value',
        },
        {
          id: 'B3_stellplatz',
          label: 'Stellplatzregulativ (falls vorhanden)',
          type: 'text',
          kernset: true,
          optional: true,
          placeholder: 'z. B. 1 Stellplatz je Wohnung',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/stellplatzregulativ/value',
        },
        {
          // v1.0's B4 + B5 (Altlast) + B9 (Baumbestand) + B10 (Schutzgebiet)
          // as ONE multi-select. The storage key stays `gefahrenzonen`: the old
          // values are a strict subset of the new vocabulary, so every stored
          // answer remains valid, and a key rename would strand them.
          id: 'B4',
          label: 'Standortrisiken & Schutzgüter',
          type: 'multi_select',
          optional: true,
          why: 'Solche Punkte können Einschränkungen oder zusätzliche Verfahren mit sich bringen — der Assistent behält sie im Blick.',
          options: [
            { value: 'hw_hq30', label: 'Hochwasser HQ30' },
            { value: 'hw_hq100', label: 'Hochwasser HQ100' },
            { value: 'wildbach_gelb', label: 'Wildbach/Lawine – gelbe Zone' },
            { value: 'wildbach_rot', label: 'Wildbach/Lawine – rote Zone' },
            { value: 'rutschung', label: 'Rutschung / Steinschlag' },
            { value: 'altlast', label: 'Altlast / Verdachtsfläche' },
            { value: 'baumbestand', label: 'geschützter Baumbestand' },
            { value: 'schutzgebiet', label: 'Natur- oder Landschaftsschutzgebiet' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/gefahrenzonen/value',
        },
        {
          id: 'B5',
          label: 'Lärmsituation am Standort',
          type: 'single_select',
          optional: true,
          why: 'Die Lärmsituation beeinflusst typischerweise die Anforderungen an Fenster und Außenbauteile — exakte Pegel kommen später mit dem Gutachten.',
          options: [
            { value: 'ruhig', label: 'ruhig' },
            { value: 'innerstaedtisch', label: 'innerstädtisch üblich' },
            { value: 'strasse', label: 'stark befahrene Straße' },
            { value: 'bahn', label: 'Bahn' },
            { value: 'flug', label: 'Fluglärm' },
            { value: 'gewerbe', label: 'Gewerbelärm' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/laermsituation/value',
        },
        {
          id: 'B6',
          label: 'Ist das Grundstück voll erschlossen (Kanal, Wasser, Strom, Zufahrt)?',
          type: 'single_select',
          why: 'Zeigt, ob Erschließungsthemen wie Anschlüsse oder Zufahrt im Projekt mitzudenken sind.',
          options: [
            { value: 'ja', label: 'ja' },
            { value: 'teilweise', label: 'teilweise' },
            { value: 'nein', label: 'nein' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/erschliessung/value',
        },
        {
          id: 'B7',
          label: 'Fernwärme',
          type: 'single_select',
          why: 'In manchen Gebieten gibt es Anschlussvorgaben — außerdem relevant für die Wahl der Wärmeversorgung.',
          options: [
            { value: 'verfuegbar', label: 'verfügbar' },
            { value: 'anschlussgebiet', label: 'Anschlussgebiet (Anschlusspflicht möglich)' },
            { value: 'nicht_verfuegbar', label: 'nicht verfügbar' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/fernwaerme_status/value',
        },
        {
          id: 'B8',
          label: 'Anbau an Nachbargebäude oder Bebauung nahe der Grundgrenze geplant?',
          type: 'yes_no_open',
          why: 'Bei Bebauung nahe der Grundgrenze spielen Abstände und Brandschutz zwischen Gebäuden eine größere Rolle.',
          writesTo: '/facts/anbau_grundgrenze/value',
        },
      ],
    },
    // ------------------------------------------------------------------ C
    //
    // Spec C0 (Bauwerksliste) is realized by the wizard's building-management
    // UI (duplizierbare Karten, min. 1 Bauwerk) rather than a question row —
    // rendering it additionally as a question would describe controls sitting
    // directly above it.
    {
      id: 'C',
      title: 'Bauwerke',
      scope: 'bauwerk',
      repeatable: true,
      description:
        'Je Bauwerk: Neubau oder Bestand, ggf. Bestandsblock, dann Zielgeometrie. Die Zielgeometrie beschreibt immer den Zustand nach Umsetzung aller Maßnahmen; daraus wird die Gebäudeklasse abgeleitet.',
      questions: [
        {
          id: 'C1',
          core: true,
          label: 'Bauwerkstyp',
          type: 'single_select',
          why: 'Für sehr kleine und sonstige Bauwerke gelten deutlich reduzierte Anforderungen.',
          options: [
            { value: 'gebaeude', label: 'Gebäude' },
            { value: 'klein', label: 'Kleinstgebäude (bis 15 m²)' },
            { value: 'sonstig', label: 'sonstiges Bauwerk (Flugdach, Stützmauer, Werbeanlage …)' },
          ],
          writesTo: '/facts/bauwerkstyp/value',
        },
        {
          id: 'C2',
          core: true,
          label: 'Neubau oder Bestand?',
          type: 'single_select',
          why: 'Für Bestandsgebäude gibt es einen eigenen Fragenblock, weil dort teils andere Regeln gelten.',
          options: [
            { value: 'neubau', label: 'Neubau' },
            { value: 'bestand', label: 'Bestandsgebäude' },
          ],
          writesTo: '/facts/errichtungsstatus/value',
        },
        // -------------------------------------------------- Bestandsblock
        // v1.0 asked these once per PROJECT (A6/A7/A9/A10); since v1.1 they
        // belong to the building whose Bestand they describe. The storage keys
        // are unchanged — only the scope suffix is new — and
        // `answersFromProfile` bridges legacy project-scope values into the
        // single-building case.
        {
          id: 'CB1',
          group: 'Bestand heute',
          label: 'Baujahr des Bestands (ca.)',
          type: 'number_tri',
          placeholder: 'z. B. 1962',
          why: 'Das Alter hilft einzuordnen, welche Regeln damals galten und was heute Bestandsschutz genießt.',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/baujahr_bestand/value',
        },
        {
          id: 'CB2',
          label: 'Bisherige Nutzung',
          type: 'text',
          placeholder: 'z. B. Wohnhaus, Lagerhalle, Bürogebäude',
          why: 'Ändert sich die Nutzung, kann das zusätzliche Anforderungen auslösen.',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_nutzung/value',
        },
        {
          id: 'CB3',
          core: true,
          label: 'Steht das Gebäude unter Denkmalschutz?',
          type: 'yes_no_open',
          why: 'Denkmalschutz bringt ein eigenes Verfahren und teils Erleichterungen bei anderen Anforderungen mit sich.',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/denkmalschutz/value',
        },
        {
          id: 'CB4',
          core: true,
          label: 'Geplante Maßnahmen am Bestand',
          type: 'multi_select',
          why: 'Die Art der Maßnahmen bestimmt, welche Anforderungen am Bestand überhaupt greifen.',
          options: [
            { value: 'huelle_sanierung', label: 'Sanierung der Gebäudehülle' },
            { value: 'umbau_innen', label: 'Umbau im Inneren' },
            { value: 'aufstockung', label: 'Aufstockung' },
            { value: 'zubau', label: 'Zubau' },
            { value: 'nutzungsaenderung', label: 'Nutzungsänderung' },
            { value: 'kernsanierung', label: 'Kernsanierung' },
            { value: 'teilabbruch', label: 'Teilabbruch' },
          ],
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_massnahmen/value',
        },
        {
          id: 'CB5',
          label: 'Eingriff in die Tragstruktur geplant?',
          type: 'yes_no_open',
          why: 'Eingriffe ins Tragwerk sind statisch und im Verfahren gesondert zu betrachten.',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/tragstruktur_eingriff/value',
        },
        {
          id: 'CB6',
          label: 'Größere Renovierung (mehr als 25 % der Gebäudehülle betroffen)?',
          type: 'yes_no_open',
          why: 'Ab einem gewissen Sanierungsumfang gelten erhöhte energetische Anforderungen.',
          conditions: [
            { param: 'C2', op: 'equals', value: 'bestand' },
            { param: 'CB4', op: 'includes_any', value: ['huelle_sanierung', 'kernsanierung'] },
          ],
          writesTo: '/facts/groessere_renovierung/value',
        },
        {
          id: 'CB7_og',
          label: 'Bestand heute: oberirdische Geschoße',
          type: 'number_tri',
          why: 'Der Vergleich von Bestand und Ziel zeigt, welche Teile eher wie ein Neubau und welche im Bestandsschutz zu behandeln sind.',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_geschosse_oberirdisch/value',
        },
        {
          id: 'CB7_ug',
          label: 'Bestand heute: unterirdische Geschoße',
          type: 'number_tri',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_geschosse_unterirdisch/value',
        },
        {
          id: 'CB7_bgf',
          label: 'Bestand heute: BGF der oberirdischen Geschoße',
          type: 'number_tri',
          unit: 'm²',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_bgf_oberirdisch/value',
        },
        {
          id: 'CB7_fn',
          label: 'Bestand heute: Fluchtniveau',
          type: 'number_tri',
          unit: 'm',
          conditions: [{ param: 'C2', op: 'equals', value: 'bestand' }],
          writesTo: '/facts/bestand_fluchtniveau_m/value',
        },
        // -------------------------------------------------- Zielgeometrie
        {
          id: 'C3',
          group: 'Zielzustand — nach Umsetzung aller Maßnahmen',
          core: true,
          label: 'Anzahl oberirdischer Geschoße (Zielzustand)',
          type: 'number_tri',
          why: 'Einer der wichtigsten Werte für die Einstufung des Gebäudes — außerdem relevant für die Aufzugsfrage.',
          hint: 'Immer den Zustand NACH Umsetzung aller Maßnahmen angeben – bei Aufstockung von drei auf fünf Geschoße also fünf.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/geschosse_oberirdisch/value',
        },
        {
          id: 'C4',
          label: 'Anzahl unterirdischer Geschoße (Zielzustand)',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/geschosse_unterirdisch/value',
        },
        {
          id: 'C5',
          core: true,
          label: 'Fluchtniveau (Zielzustand)',
          type: 'number_tri',
          unit: 'm',
          why: 'Zentraler Wert für die Einstufung des Gebäudes — bei sehr hohen Gebäuden gelten eigene Hochhaus-Regeln.',
          hint: 'Höhendifferenz zwischen der Fußbodenoberkante des höchstgelegenen Geschoßes mit Aufenthaltsräumen und dem tiefsten Punkt des angrenzenden Geländes.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/fluchtniveau_m/value',
        },
        {
          id: 'C6',
          label: 'Brutto-Grundfläche der oberirdischen Geschoße gesamt (Zielzustand)',
          type: 'number_tri',
          unit: 'm²',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/bgf_oberirdisch/value',
        },
        {
          id: 'C7',
          core: true,
          label: 'Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten, Zielzustand)',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/nutzungseinheiten/value',
        },
        {
          // v1.0's C7 with INVERTED polarity, so it writes a NEW key:
          // `ne_unter_400` (ja = alle Einheiten bis 400 m²) stays untouched in
          // stored profiles and `answersFromProfile` bridges it, inverted, into
          // this question. Reusing the old key would silently flip the meaning
          // of every stored answer — and the GK derivation with it.
          id: 'C8',
          label:
            'Gibt es einzelne Wohnungen oder Betriebseinheiten mit mehr als 400 m² Brutto-Grundfläche?',
          type: 'yes_no_open',
          why: 'Hilft bei der Abgrenzung zwischen den Gebäudeklassen — erscheint nur, wenn es für die Einstufung wirklich gebraucht wird.',
          conditions: [
            { param: 'C1', op: 'equals', value: 'gebaeude' },
            { param: 'C3', op: 'lte', value: 4 },
          ],
          writesTo: '/facts/einheiten_ueber_400/value',
        },
        {
          id: 'C9',
          label: 'Gebäudestellung',
          type: 'single_select',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          options: [
            { value: 'freistehend', label: 'freistehend' },
            { value: 'angebaut', label: 'angebaut' },
            { value: 'reihenhaus', label: 'Reihenhaus' },
          ],
          writesTo: '/facts/gebaeudestellung/value',
        },
        {
          // Multi-select since v1.1 (a building can combine structures); the
          // storage key stays `bauweise` — legacy single values are mapped by
          // the `answersFromProfile` bridge.
          id: 'C10',
          label: 'Tragstruktur / Bauweise (Mehrfachauswahl bei Kombination)',
          type: 'multi_select',
          why: 'Die Bauweise — besonders Holzbau — beeinflusst die Brandschutzanforderungen deutlich; Kombinationen bitte zusätzlich kurz beschreiben.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          options: [
            { value: 'mauerwerk_massivbau', label: 'Mauerwerk / Massivbau' },
            { value: 'stahlbeton', label: 'Stahlbeton' },
            { value: 'holzbau', label: 'Holzbau' },
            { value: 'stahlbau', label: 'Stahlbau' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/bauweise/value',
        },
        {
          id: 'C10_text',
          label: 'Kombination beschreiben (optional)',
          type: 'text',
          optional: true,
          placeholder: 'z. B. EG Stahlbeton, ab 1. OG Holzbau',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/bauweise_beschreibung/value',
        },
        {
          id: 'C11',
          label: 'Konditionierung',
          type: 'single_select',
          why: 'Energieanforderungen und Energieausweis betreffen vor allem beheizte oder gekühlte Gebäude.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          options: [
            { value: 'beheizt', label: 'beheizt' },
            { value: 'beheizt_gekuehlt', label: 'beheizt + gekühlt' },
            { value: 'teilkonditioniert', label: 'teilkonditioniert' },
            { value: 'unkonditioniert', label: 'unkonditioniert' },
          ],
          writesTo: '/facts/konditionierung/value',
        },
        {
          id: 'C_GK_CONFIRM',
          label: 'Gebäudeklasse',
          type: 'info_placeholder',
          derives: 'gebaeudeklasse',
          hint: 'Die Gebäudeklasse folgt aus Fluchtniveau, Geschoßanzahl, Fläche und Nutzung — immer auf Basis der Zielgeometrie. Sie wird hier noch nicht automatisch gesetzt. Solange sie im Brief offen ist, fragt Piloti nach, bevor eine Anforderung zitiert wird, die an der Klasse hängt.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
        },
      ],
    },
    // ------------------------------------------------------------------ D
    {
      id: 'D',
      title: 'Nutzungen',
      scope: 'bauwerk',
      repeatable: true,
      description:
        'Nutzungsmix je Bauwerk. Jede gewählte Nutzung erzeugt eine Zone mit generischen und nutzungsspezifischen Kennzahlen.',
      questions: [
        {
          id: 'D0',
          core: true,
          label: 'Welche Nutzungen enthält dieses Bauwerk (Zielzustand)?',
          type: 'multi_select',
          why: 'Jede Nutzung bringt eigene Themen und Regelwerke mit — vom Brandschutz bis zu speziellen Genehmigungen.',
          hint: 'Mehrfachauswahl — je Nutzung folgen Kennzahlen.',
          options: NUTZUNGEN,
          writesTo: '/facts/nutzungen/value',
        },
        {
          id: 'DX1',
          core: true,
          label: 'Ist das Bauwerk (teilweise) öffentlich zugänglich / mit Publikumsverkehr?',
          type: 'yes_no_open',
          why: 'Öffentlich zugängliche Bereiche bringen typischerweise Barrierefreiheitsanforderungen mit sich.',
          writesTo: '/facts/publikumsverkehr/value',
        },
        {
          id: 'DX2',
          label: 'Ist das Bauwerk (teilweise) Arbeitsstätte?',
          type: 'yes_no_open',
          why: 'Für Arbeitsstätten gelten zusätzlich Vorschriften des Arbeitnehmerschutzes.',
          hint: 'Aus den Nutzungen vorbelegt (z. B. Büro, Handel, Produktion) — hier bestätigen.',
          writesTo: '/facts/arbeitsstaette/value',
        },
      ],
      zoneCommon: [
        {
          id: 'D_fl',
          label: 'Fläche der Zone (BGF)',
          type: 'number_tri',
          unit: 'm²',
          writesTo: '/facts/zone_flaeche/value',
        },
        {
          id: 'D_lage',
          label: 'Geschoßlage',
          type: 'single_select',
          options: [
            { value: 'oberirdisch', label: 'oberirdisch' },
            { value: 'unterirdisch', label: 'unterirdisch' },
            { value: 'beides', label: 'beides' },
          ],
          writesTo: '/facts/zone_lage/value',
        },
      ],
      zoneDefinitions: {
        wohnen: {
          questions: [
            {
              id: 'D_we',
              label: 'Anzahl Wohneinheiten',
              type: 'number_tri',
              writesTo: '/facts/wohneinheiten/value',
            },
            {
              id: 'D_wohnform',
              label: 'Wohnform',
              type: 'single_select',
              options: [
                { value: 'klassisch', label: 'klassisch' },
                { value: 'betreut', label: 'betreutes Wohnen' },
                { value: 'heim', label: 'Heim' },
                { value: 'studierende', label: 'Studierendenheim' },
              ],
              writesTo: '/facts/wohnform/value',
            },
          ],
        },
        buero: {
          questions: [
            {
              id: 'D_an',
              label: 'Max. gleichzeitig anwesende Arbeitnehmer:innen',
              type: 'number_tri',
              writesTo: '/facts/arbeitnehmer/value',
            },
          ],
        },
        handel: {
          questions: [
            {
              id: 'D_vkf',
              label: 'Verkaufsfläche',
              type: 'number_tri',
              unit: 'm²',
              writesTo: '/facts/verkaufsflaeche/value',
            },
            {
              id: 'D_ekz',
              label: 'Teil eines Einkaufszentrums?',
              type: 'yes_no_open',
              writesTo: '/facts/einkaufszentrum/value',
            },
          ],
        },
        gastro: {
          questions: [
            {
              id: 'D_plaetze',
              label: 'Max. Verabreichungsplätze / Personen',
              type: 'number_tri',
              writesTo: '/facts/verabreichungsplaetze/value',
            },
          ],
        },
        beherbergung: {
          questions: [
            {
              id: 'D_betten',
              label: 'Anzahl Gästebetten',
              type: 'number_tri',
              writesTo: '/facts/gaestebetten/value',
            },
          ],
        },
        versammlung: {
          questions: [
            {
              id: 'D_pers',
              label: 'Max. gleichzeitig anwesende Personen',
              type: 'number_tri',
              writesTo: '/facts/personen_max/value',
            },
          ],
        },
        bildung: {
          questions: [
            {
              id: 'D_bildung',
              label: 'Einrichtungstyp',
              type: 'single_select',
              options: [
                { value: 'kindergarten', label: 'Kindergarten' },
                { value: 'schule', label: 'Schule' },
                { value: 'hochschule', label: 'Hochschule' },
                { value: 'hort', label: 'Hort' },
              ],
              writesTo: '/facts/bildung_typ/value',
            },
            {
              id: 'D_kinder',
              label: 'Anzahl Kinder / Schüler:innen',
              type: 'number_tri',
              writesTo: '/facts/anzahl_kinder/value',
            },
          ],
        },
        gesundheit: {
          questions: [
            {
              id: 'D_gesund',
              label: 'Einrichtungstyp',
              type: 'single_select',
              options: [
                { value: 'ordination', label: 'Ordination' },
                { value: 'krankenhaus', label: 'Krankenhaus' },
                { value: 'pflegeheim', label: 'Pflegeheim' },
              ],
              writesTo: '/facts/gesundheit_typ/value',
            },
          ],
        },
        produktion: {
          questions: [
            {
              id: 'D_gefstoffe',
              label: 'Lagerung / Verwendung gefährlicher Stoffe?',
              type: 'yes_no_open',
              writesTo: '/facts/gefaehrliche_stoffe/value',
            },
            {
              id: 'D_brandlast',
              label: 'Brandlastintensive Nutzung?',
              type: 'yes_no_open',
              writesTo: '/facts/brandlast/value',
            },
          ],
        },
        garage: {
          questions: [
            {
              id: 'D_stp',
              label: 'Anzahl Pkw-Stellplätze',
              type: 'number_tri',
              writesTo: '/facts/stellplaetze/value',
            },
            {
              id: 'D_garagenlage',
              label: 'Lage',
              type: 'single_select',
              options: [
                { value: 'tiefgarage', label: 'Tiefgarage' },
                { value: 'oberirdisch_geschlossen', label: 'oberirdisch geschlossen' },
                { value: 'ueberdacht_offen', label: 'überdacht offen' },
                { value: 'freistellplaetze', label: 'Freistellplätze' },
              ],
              writesTo: '/facts/garagenlage/value',
            },
            {
              id: 'D_garagenfl',
              label: 'Nutzfläche der Garage',
              type: 'number_tri',
              unit: 'm²',
              writesTo: '/facts/garagenflaeche/value',
            },
            {
              id: 'D_lade',
              label: 'E-Ladepunkte geplant?',
              type: 'yes_no_open',
              writesTo: '/facts/e_ladepunkte/value',
            },
          ],
        },
        landwirtschaft: {
          questions: [
            {
              id: 'D_tiere',
              label: 'Tierhaltung?',
              type: 'yes_no_open',
              writesTo: '/facts/tierhaltung/value',
            },
          ],
        },
        technik: {
          questions: [
            {
              id: 'D_technik',
              label: 'Kurzbeschreibung',
              type: 'text',
              placeholder: 'z. B. Trafostation, Haustechnikzentrale',
              writesTo: '/facts/technik_beschreibung/value',
            },
          ],
        },
      },
    },
    // ------------------------------------------------------------------ E
    {
      id: 'E',
      title: 'Technik & Energie',
      scope: 'bauwerk',
      repeatable: true,
      description: 'Wärmeversorgung, PV, Lüftung und anlagentechnischer Brandschutz je Bauwerk.',
      questions: [
        {
          id: 'E1',
          label: 'Geplante Wärmeversorgung',
          type: 'single_select',
          why: 'Relevant für Vorgaben zu erneuerbarer Wärme — bei fossilen Systemen im Neubau weist das System auf mögliche Konflikte hin.',
          options: [
            { value: 'waermepumpe', label: 'Wärmepumpe' },
            { value: 'fernwaerme', label: 'Fernwärme' },
            { value: 'biomasse', label: 'Biomasse' },
            { value: 'solar_hybrid', label: 'Solar-Hybrid' },
            { value: 'gas', label: 'Gas (nur Bestand)' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/waermeversorgung/value',
        },
        {
          // v1.0's E2 (PV) + E3 (Lüftung) + E4 (Kühlung) + E6 (Versickerung)
          // as one multi-select; the four boolean keys are bridged in
          // `answersFromProfile`.
          id: 'E2',
          label: 'Weitere Technik angedacht',
          type: 'multi_select',
          optional: true,
          why: 'Für einzelne Technikthemen gibt es je nach Standort eigene Vorgaben oder Fördermöglichkeiten.',
          options: [
            { value: 'pv', label: 'PV-Anlage' },
            { value: 'lueftung', label: 'mechanische Lüftung' },
            { value: 'kuehlung', label: 'aktive Kühlung' },
            { value: 'versickerung', label: 'Regenwasser-Versickerung' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/technik_weitere/value',
        },
        {
          id: 'E3',
          label: 'Anlagentechnischer Brandschutz angedacht',
          type: 'multi_select',
          optional: true,
          why: 'Solche Anlagen sind oft Teil des Brandschutzkonzepts und bringen eigene technische Richtlinien mit.',
          options: [
            { value: 'bma', label: 'Brandmeldeanlage' },
            { value: 'sprinkler', label: 'Sprinkler' },
            { value: 'rwa', label: 'RWA' },
            { value: 'druckbelueftung', label: 'Druckbelüftung' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/brandschutz_anlagen/value',
        },
        {
          id: 'E4',
          label: 'Aufzug geplant?',
          type: 'yes_no_open',
          hint: 'Die Aufzugspflicht wird später aus Geschoßanzahl und Landesrecht abgeleitet und gegen diese Angabe geprüft.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/aufzug/value',
        },
        {
          id: 'E5',
          label: 'Feuerstätten / Rauchfänge geplant?',
          type: 'yes_no_open',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/feuerstaetten/value',
        },
      ],
    },
    // ------------------------------------------------------------------ F
    {
      id: 'F',
      title: 'Verfahren & Sonderrecht',
      scope: 'projekt',
      description:
        'Behördenverfahren, Förderungen und Sonderthemen — im Zielsystem großteils vorbelegt, hier bestätigen.',
      questions: [
        {
          id: 'F1',
          label: 'Gewerbliche Betriebsanlage?',
          type: 'yes_no_open',
          why: 'Betriebsanlagen benötigen ein Genehmigungsverfahren nach der Gewerbeordnung, parallel zur Baubewilligung.',
          hint: 'Im echten System aus den Nutzungen vorbelegt.',
          writesTo: '/facts/betriebsanlage/value',
        },
        {
          id: 'F2',
          label: 'UVP-Relevanz',
          type: 'info_placeholder',
          derives: 'uvp',
          hint: 'Das System prüft anhand Ihrer Angaben die Schwellenwerte des UVP-Gesetzes (Stellplätze gesamt, Verkaufsflächen, Städtebauvorhaben) und zeigt an, ob eine Umweltverträglichkeitsprüfung nötig sein könnte.',
        },
        {
          id: 'F3',
          label: 'Wasserrechtliche Bewilligung voraussichtlich nötig?',
          type: 'yes_no_open',
          hint: 'Vorbelegt aus Standortrisiken (B4) und Versickerung (E2).',
          writesTo: '/facts/wasserrecht/value',
        },
        {
          // v1.0's F4 (Förderung) + F5 (Zertifizierung) as one multi-select.
          // The storage key stays `foerderung`: old values are a subset, and
          // the legacy `zertifizierung` single-select is bridged in.
          id: 'F4',
          label: 'Förderung oder Zertifizierung angestrebt?',
          type: 'multi_select',
          optional: true,
          why: 'Förderungen und Zertifizierungen bringen oft eigene, teils strengere Anforderungen mit.',
          options: [
            { value: 'wohnbaufoerderung', label: 'Wohnbauförderung des Landes' },
            { value: 'sanierungsfoerderung', label: 'Sanierungsförderung' },
            { value: 'klimaaktiv', label: 'klimaaktiv' },
            { value: 'oegni_dgnb', label: 'ÖGNI / DGNB' },
            { value: 'leed_breeam', label: 'LEED / BREEAM' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/foerderung/value',
        },
        {
          id: 'F5',
          label: 'Schad- und Störstofferkundung / Rückbaukonzept relevant?',
          type: 'yes_no_open',
          why: 'Beim Abbruch sind Schadstoffe und Verwertung gesondert zu betrachten.',
          conditions: [{ param: 'A5', op: 'includes_any', value: ['abbruch'] }],
          writesTo: '/facts/rueckbaukonzept/value',
        },
      ],
    },
    // ------------------------------------------------------------------ G
    {
      id: 'G',
      title: 'Projektkontext',
      scope: 'projekt',
      description:
        'Geführter Freitext: alles, was der Assistent über die Zahlen hinaus wissen sollte. Alle Felder optional — je mehr Kontext, desto besser.',
      questions: [
        {
          // v1.0's G1 + G2; the legacy `kontext_grundstueck` text is bridged
          // into this field. G5 + G6 merged into G4 the same way.
          id: 'G1',
          core: true,
          label: 'Projektbeschreibung, Entwurfsidee & Umfeld',
          type: 'textarea',
          optional: true,
          placeholder:
            'Was ist das Projekt in 3–10 Sätzen? Städtebauliche Setzung, Konzept, Materialität, Besonderheiten von Grundstück und Nachbarschaft …',
          writesTo: '/facts/kontext_beschreibung/value',
        },
        {
          id: 'G2',
          label: 'Ziele & Prioritäten der Bauherrschaft',
          type: 'textarea',
          optional: true,
          placeholder:
            'Kosten- und Terminrahmen, Nachhaltigkeitsambition, Flexibilität, besondere Wünsche …',
          writesTo: '/facts/kontext_ziele/value',
        },
        {
          id: 'G3',
          label: 'Bekannte Konfliktpunkte & Risiken',
          type: 'textarea',
          optional: true,
          placeholder: 'Nachbarn, Behördenvorgespräche, technische Risiken, Widmungskonflikte …',
          writesTo: '/facts/kontext_konflikte/value',
        },
        {
          id: 'G4',
          label: 'Sonderlösungen, Abweichungen & Sonstiges',
          type: 'textarea',
          optional: true,
          placeholder:
            'Geplante Abweichungen (z. B. Brandschutzkonzept mit Kompensation) und alles Weitere für den Assistenten.',
          writesTo: '/facts/kontext_sonderloesungen/value',
        },
      ],
    },
    // ------------------------------------------------------------------ I
    //
    // Placed BEFORE the summary, which is where the handover concept puts it
    // last. Deliberate: Bestandspläne and the Bebauungsplan are INPUTS to the
    // Modul B and C answers. Asking for geometry from memory and only then
    // asking for the plan that contains it gets the order backwards. The
    // module letter follows the concept so the two can be read side by side.
    //
    // It carries no questions. The slots are generated from the role registry
    // (`document-roles.ts`) and rendered by the wizard, so adding a role is one
    // entry there rather than a question here plus a component.
    {
      id: 'I',
      title: 'Projektgrundlagen',
      scope: 'projekt',
      description:
        'Alles, was schon existiert. Piloti nutzt diese Unterlagen als Grundlage für jede Antwort zu diesem Projekt — und sagt Ihnen, was noch fehlt.',
      questions: [],
    },
    // ------------------------------------------------------------------ H
    {
      id: 'H',
      title: 'Zusammenfassung',
      scope: 'projekt',
      description:
        'Ihre Angaben im Überblick. Prüfen Sie alles, bevor das Projektprofil an Piloti übergeben wird.',
      questions: [],
    },
  ],
}

// ---------------------------------------------------------------------------
// Scope helpers — the four-scope model layered onto the flat profile store.
// ---------------------------------------------------------------------------

/** A repeatable building instance. */
export interface BauwerkInstance {
  id: string
  name: string
}

export function defaultBauwerke(): BauwerkInstance[] {
  return [{ id: 'bw1', name: 'Bauwerk 1' }]
}

/** The wizard's answer-state key for a question in a given scope instance. */
export function answerKeyFor(questionId: string, bauwerkId?: string, zoneKey?: string): string {
  let key = questionId
  if (bauwerkId) key += `@${bauwerkId}`
  if (zoneKey) key += `@${zoneKey}`
  return key
}

/**
 * The building an answer key belongs to, or null for a project-scope one.
 *
 * The inverse of {@link answerKeyFor}, kept beside it so the two cannot drift
 * about what the separator means. A document-role question needs this: a
 * `bauwerk` role has to name its building, and the wizard only knows which
 * building it is rendering through the key.
 */
export function bauwerkIdFromAnswerKey(answerKey: string): string | null {
  const [, bauwerkId] = answerKey.split('@')
  return bauwerkId ?? null
}

/** The sibling key under which a number_tri question stores its answer mode. */
export function modeKeyFor(answerKey: string): string {
  return `${answerKey}__mode`
}

/** Map a question id to its module scope (projekt/grundstueck/bauwerk). */
function scopeOfQuestion(questionId: string): ProjectIntakeScope | null {
  for (const stage of projectIntakeDefinitionV1.stages) {
    if (stage.questions.some((q) => q.id === questionId)) return stage.scope
    if (stage.zoneCommon?.some((q) => q.id === questionId)) return 'bauwerk'
    for (const def of Object.values(stage.zoneDefinitions ?? {})) {
      if (def.questions.some((q) => q.id === questionId)) return 'bauwerk'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared intake helpers — pure and isomorphic; used by the wizard and server.
// ---------------------------------------------------------------------------

/**
 * The validated `bundesland` token vocabulary, read straight off the A2_land
 * question's own options so it can never drift from what the wizard offers.
 * (Backlog T3-9: mirrored, not shared, by the Python backend's
 * `project_context._BUNDESLAND_TOKENS`.)
 */
export const BUNDESLAND_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find((q) => q.id === 'A2_land')
  return question?.options?.map((option) => option.value) ?? []
})()

/** Whether `token` is a recognized `bundesland` (A2_land) intake answer. */
export function isValidBundeslandToken(token: string): boolean {
  return BUNDESLAND_TOKENS.includes(token)
}

export const COUNTRY_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (q) => q.id === 'A2_country'
  )
  return question?.options?.map((option) => option.value) ?? []
})()

export function isValidCountryToken(token: string): boolean {
  return COUNTRY_TOKENS.includes(token)
}

/**
 * Whether a question is currently relevant given the answers collected so far.
 * Conditions are AND-combined. `param` is resolved within `instanceId`'s scope
 * (a bauwerk question's condition on a bauwerk param reads that building's
 * answer), falling back to the project-global answer for non-bauwerk params.
 */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  return evaluateIntakeConditions(question.conditions, answers, instanceId)
}

/**
 * The same evaluation, given the conditions directly rather than a question.
 *
 * Exported because conditions are no longer only a question's: document roles
 * (`document-roles.ts`) carry a `recommendedWhen` list in this language so the
 * Modul I checklist is data rather than bespoke UI code. Sharing the evaluator
 * is what stops the checklist and the questions ever disagreeing about what a
 * project is.
 *
 * An empty or absent list means "always", which is what a question with no
 * conditions means.
 */
export function evaluateIntakeConditions(
  conditions: ProjectIntakeCondition[] | undefined,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every((cond) => evaluateSingleCondition(cond, answers, instanceId))
}

function evaluateSingleCondition(
  cond: ProjectIntakeCondition,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  // Resolve which answer key this param lives under: a bauwerk-scope param is
  // read from the current building instance; everything else is project-global.
  const paramScope = scopeOfQuestion(cond.param)
  const key = paramScope === 'bauwerk' && instanceId ? `${cond.param}@${instanceId}` : cond.param
  const answer = answers[key]

  switch (cond.op) {
    case 'not_empty':
      return isIntakeAnswerProvided(answer)
    case 'includes_any': {
      const needles = Array.isArray(cond.value)
        ? cond.value
        : cond.value !== undefined
          ? [cond.value]
          : []
      if (Array.isArray(answer)) return answer.some((v) => needles.includes(String(v)))
      return typeof answer === 'string' && needles.includes(answer)
    }
    case 'lte': {
      // Only a PRESENT, non-'offen' value can satisfy a numeric bound: a
      // question gated on "höchstens 4 Geschoße" must not appear while the
      // storey count is unknown or explicitly left open (spec conventions).
      if (!isIntakeAnswerProvided(answer)) return false
      if (answers[modeKeyFor(key)] === 'offen') return false
      const numeric = typeof answer === 'number' ? answer : Number(answer)
      return typeof cond.value === 'number' && Number.isFinite(numeric) && numeric <= cond.value
    }
    case 'equals':
    default: {
      if (Array.isArray(answer))
        return cond.value !== undefined && answer.includes(cond.value as string)
      return answer === cond.value
    }
  }
}

/** All questions across every stage (including zone questions), in definition order. */
export function flattenIntakeQuestions(
  definition: ProjectIntakeDefinition
): ProjectIntakeQuestion[] {
  const out: ProjectIntakeQuestion[] = []
  for (const stage of definition.stages) {
    out.push(...stage.questions)
    if (stage.zoneCommon) out.push(...stage.zoneCommon)
    for (const def of Object.values(stage.zoneDefinitions ?? {})) out.push(...def.questions)
  }
  return out
}

/** Look up a question by its stable id anywhere in the definition. */
export function findIntakeQuestion(
  definition: ProjectIntakeDefinition,
  questionId: string
): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === questionId)
}

/**
 * The distinct scope instances (bauwerke) implied by the current answer state.
 * Reconstructed from `@bwN`-suffixed keys plus any stored bauwerk names, so an
 * edit session can rebuild the building list the same way the wizard held it.
 */
export function bauwerkeFromAnswers(
  answers: Record<string, ProjectPrimitiveValue>
): BauwerkInstance[] {
  const ids = new Set<string>()
  for (const key of Object.keys(answers)) {
    const match = key.match(/@(bw\d+)(?:@|$|__)/)
    if (match) ids.add(match[1])
  }
  const sorted = [...ids].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
  if (sorted.length === 0) return defaultBauwerke()
  return sorted.map((id, i) => {
    const stored = answers[`__bwname@${id}`]
    return { id, name: typeof stored === 'string' && stored ? stored : `Bauwerk ${i + 1}` }
  })
}

/**
 * Remove answers for conditional questions whose visibility condition no longer
 * holds — across every scope instance. Recursive: dropping one answer can turn a
 * chained condition false. Returns the same reference when nothing changed.
 */
export function pruneStaleConditionalAnswers(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition | null | undefined
): Record<string, ProjectPrimitiveValue> {
  if (!definition) return answers
  const bauwerke = bauwerkeFromAnswers(answers)
  let current = answers
  let changedAny = false

  for (;;) {
    let changedThisPass = false
    let next: Record<string, ProjectPrimitiveValue> | null = null

    const dropIfOrphaned = (
      question: ProjectIntakeQuestion,
      answerKey: string,
      instanceId?: string
    ) => {
      if (!question.conditions || question.conditions.length === 0) return
      const hasAnswer = answerKey in current || modeKeyFor(answerKey) in current
      if (!hasAnswer) return
      if (evaluateIntakeCondition(question, current, instanceId)) return
      if (!next) next = { ...current }
      delete next[answerKey]
      delete next[modeKeyFor(answerKey)]
      changedThisPass = true
    }

    for (const stage of definition.stages) {
      if (stage.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of stage.questions) dropIfOrphaned(q, answerKeyFor(q.id, bw.id), bw.id)
        }
      } else {
        for (const q of stage.questions) dropIfOrphaned(q, q.id)
      }
    }

    if (!changedThisPass) break
    if (next) current = next
    changedAny = true
  }

  return changedAny ? current : answers
}

/** Whether an answer counts as provided (non-empty). */
export function isIntakeAnswerProvided(answer: ProjectPrimitiveValue | undefined): boolean {
  if (answer === undefined || answer === null || answer === '') return false
  if (Array.isArray(answer)) return answer.length > 0
  return true
}

interface WriteTarget {
  scope: 'facts' | 'goals'
  key: string
}

/** Resolve the fact/goal base key a question writes to. */
function resolveWriteTarget(writesTo: string | undefined): WriteTarget | null {
  if (!writesTo) return null
  const factMatch = writesTo.match(/^\/facts\/([^/]+)/)
  if (factMatch) return { scope: 'facts', key: factMatch[1] }
  const goalMatch = writesTo.match(/^\/goals\/([^/]+)/)
  if (goalMatch) return { scope: 'goals', key: goalMatch[1] }
  return null
}

/** Namespace a base storage key with the bauwerk/zone instance it belongs to. */
function instanceStorageKey(baseKey: string, bauwerkId?: string, zoneKey?: string): string {
  let key = baseKey
  if (bauwerkId) key += `@${bauwerkId}`
  if (zoneKey) key += `@${zoneKey}`
  return key
}

const NOW_SOURCE = 'onboarding' as const

interface BuildContext {
  now: string
  patch: ProjectProfilePatchOperation[]
  unknowns: string[]
}

/**
 * Emit the right profile entry for a single answered/-unanswered question,
 * mapping the answer mode onto the three-state profile model:
 *   • confirmed value   → fact
 *   • estimated value   → assumption (unconfirmed)
 *   • open / unanswered → unknown
 */
function emitAnswer(
  ctx: BuildContext,
  question: ProjectIntakeQuestion,
  answerKey: string,
  storageKey: string,
  target: WriteTarget,
  answers: Record<string, ProjectPrimitiveValue>
): void {
  const raw = answers[answerKey]

  if (question.type === 'yes_no_open') {
    if (raw === 'ja' || raw === 'nein') {
      addFact(ctx, target, storageKey, raw === 'ja')
    } else {
      ctx.unknowns.push(storageKey)
    }
    return
  }

  if (question.type === 'number_tri') {
    const mode = (answers[modeKeyFor(answerKey)] as IntakeAnswerMode) ?? 'wert'
    if (mode === 'offen' || !isIntakeAnswerProvided(raw)) {
      ctx.unknowns.push(storageKey)
      return
    }
    const numeric = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(numeric)) {
      ctx.unknowns.push(storageKey)
      return
    }
    if (mode === 'geschaetzt') {
      ctx.patch.push({
        op: 'add',
        path: `/assumptions/${encodeKey(storageKey)}`,
        value: {
          value: numeric,
          status: 'unconfirmed',
          reason: 'Während der Erhebung geschätzt',
          source: 'onboarding_default',
          updatedAt: ctx.now,
        },
      })
    } else {
      addFact(ctx, target, storageKey, numeric)
    }
    return
  }

  // Plain types.
  if (!isIntakeAnswerProvided(raw)) {
    ctx.unknowns.push(storageKey)
    return
  }
  const value: ProjectPrimitiveValue = Array.isArray(raw) ? [...raw] : raw
  addFact(ctx, target, storageKey, value)
}

function addFact(
  ctx: BuildContext,
  target: WriteTarget,
  storageKey: string,
  value: ProjectPrimitiveValue
): void {
  if (target.scope === 'goals') {
    ctx.patch.push({ op: 'add', path: `/goals/${encodeKey(storageKey)}`, value })
  } else {
    ctx.patch.push({
      op: 'add',
      path: `/facts/${encodeKey(storageKey)}`,
      value: { value, confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
    })
  }
}

/** JSON-pointer-encode a storage key (the only special char we use is `~`/`/`). */
function encodeKey(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Build a {@link ProjectProfile} from collected intake answers, expanding the
 * bauwerk scope over every building and the zone scope over every selected use.
 */
export function buildIntakeProfile(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition,
  options?: { projectName?: string; bauwerke?: BauwerkInstance[] }
): ProjectProfile {
  const ctx: BuildContext = { now: new Date().toISOString(), patch: [], unknowns: [] }
  const bauwerke = options?.bauwerke ?? bauwerkeFromAnswers(answers)

  // The name may have been captured at project creation; seed it so A1 is never
  // asked twice, but let an explicit A1 answer (below) override it.
  const projectName = options?.projectName?.trim()
  if (projectName && !isIntakeAnswerProvided(answers['A1'])) {
    ctx.patch.push({
      op: 'add',
      path: '/facts/project_name',
      value: {
        value: projectName,
        confidence: 'confirmed',
        source: NOW_SOURCE,
        updatedAt: ctx.now,
      },
    })
  }

  // Record building names so an edit session can rebuild the list.
  if (bauwerke.length > 1 || bauwerke[0]?.name !== 'Bauwerk 1') {
    for (const bw of bauwerke) {
      ctx.patch.push({
        op: 'add',
        path: `/facts/${encodeKey(`bauwerk_name@${bw.id}`)}`,
        value: { value: bw.name, confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
      })
    }
  }

  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') {
      for (const bw of bauwerke) emitStageForBauwerk(ctx, stage, bw, answers)
    } else {
      for (const question of stage.questions) {
        const target = resolveWriteTarget(question.writesTo)
        if (!target) continue
        if (!evaluateIntakeCondition(question, answers)) continue
        emitAnswer(ctx, question, question.id, target.key, target, answers)
      }
    }
  }

  const bundeslandPath = '/facts/bundesland'

  // A patch value is either a bare primitive or a fact envelope
  // (`{ value, confidence, source, updatedAt }`) depending on which producer
  // emitted it; both forms have to yield the same token here.
  const unwrapFactValue = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'value' in value
      ? (value as { value: unknown }).value
      : value

  // Derive country from bundesland for legacy profiles.
  const hasCountry = ctx.patch.some((p) => p.path === '/facts/country')
  const bundeslandPatch = ctx.patch.find((p) => p.path === bundeslandPath)
  if (!hasCountry && bundeslandPatch) {
    const bToken = unwrapFactValue(bundeslandPatch.value)
    if (
      typeof bToken === 'string' &&
      bToken !== 'ausserhalb_oesterreichs' &&
      (BUNDESLAND_TOKENS as readonly string[]).includes(bToken)
    ) {
      ctx.patch.push({
        op: 'add',
        path: '/facts/country',
        value: { value: 'at', confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
      })
    }
  }

  // Derive bundesland for non-AT country.
  const countryFact = ctx.patch.find((p) => p.path === '/facts/country')
  const hasBundesland = ctx.patch.some((p) => p.path === bundeslandPath)
  const countryValue = unwrapFactValue(countryFact?.value)
  if (countryFact && typeof countryValue === 'string' && countryValue !== 'at' && !hasBundesland) {
    ctx.patch.push({
      op: 'add',
      path: bundeslandPath,
      value: {
        value: 'ausserhalb_oesterreichs',
        confidence: 'confirmed',
        source: NOW_SOURCE,
        updatedAt: ctx.now,
      },
    })
  }

  for (const key of ctx.unknowns) {
    ctx.patch.push({ op: 'add', path: '/unknowns/-', value: key })
  }

  return applyProjectProfilePatch(emptyProjectProfile(), ctx.patch)
}

function emitStageForBauwerk(
  ctx: BuildContext,
  stage: ProjectIntakeStage,
  bw: BauwerkInstance,
  answers: Record<string, ProjectPrimitiveValue>
): void {
  for (const question of stage.questions) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    if (!evaluateIntakeCondition(question, answers, bw.id)) continue
    const answerKey = answerKeyFor(question.id, bw.id)
    emitAnswer(ctx, question, answerKey, instanceStorageKey(target.key, bw.id), target, answers)
  }

  // Zones: one per selected use in this building's D0.
  if (!stage.zoneDefinitions && !stage.zoneCommon) return
  const selectedUses = answers[answerKeyFor('D0', bw.id)]
  if (!Array.isArray(selectedUses)) return

  for (const use of selectedUses) {
    const zoneQuestions = [
      ...(stage.zoneCommon ?? []),
      ...(stage.zoneDefinitions?.[use]?.questions ?? []),
    ]
    for (const question of zoneQuestions) {
      const target = resolveWriteTarget(question.writesTo)
      if (!target) continue
      const answerKey = answerKeyFor(question.id, bw.id, use)
      emitAnswer(
        ctx,
        question,
        answerKey,
        instanceStorageKey(target.key, bw.id, use),
        target,
        answers
      )
    }
  }
}

/**
 * Merge a freshly wizard-built profile over the previously stored one so a
 * whole-profile PUT can never destroy knowledge the wizard doesn't own
 * (agent-recorded novel facts/goals/unknowns, assumptions).
 *
 * Intake-owned keys are matched by their base key ignoring any `@bwN` / `@zone`
 * suffix, so every scope instance the wizard produced is treated as wizard-owned.
 */
export function mergeIntakeProfile(
  built: ProjectProfile,
  previous: ProjectProfile | null | undefined,
  definition: ProjectIntakeDefinition
): ProjectProfile {
  if (!previous) return built

  const intakeFactBaseKeys = new Set<string>(['project_name', 'bauwerk_name'])
  const intakeGoalBaseKeys = new Set<string>()
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    ;(target.scope === 'goals' ? intakeGoalBaseKeys : intakeFactBaseKeys).add(target.key)
  }
  const baseKeyOf = (key: string): string => key.split('@')[0]
  const isIntakeFact = (key: string) => intakeFactBaseKeys.has(baseKeyOf(key))
  const isIntakeGoal = (key: string) => intakeGoalBaseKeys.has(baseKeyOf(key))

  const facts = {
    ...Object.fromEntries(Object.entries(previous.facts).filter(([key]) => !isIntakeFact(key))),
    ...built.facts,
  }
  const goals = {
    ...Object.fromEntries(Object.entries(previous.goals).filter(([key]) => !isIntakeGoal(key))),
    ...built.goals,
  }
  const assumptions = {
    ...Object.fromEntries(
      Object.entries(previous.assumptions).filter(
        ([key]) => !isIntakeFact(key) && !isIntakeGoal(key)
      )
    ),
    ...built.assumptions,
  }

  const unknowns = [...built.unknowns]
  for (const key of previous.unknowns) {
    if (isIntakeFact(key) || isIntakeGoal(key)) continue
    if (unknowns.includes(key)) continue
    if (key in facts || key in goals) continue
    unknowns.push(key)
  }

  return { facts, goals, unknowns, assumptions }
}

/**
 * Reverse of {@link buildIntakeProfile}: seed wizard answers (and the building
 * list) from an already-saved profile so re-entering intake opens prefilled.
 */
export function answersFromProfile(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition
): { answers: Record<string, ProjectPrimitiveValue>; bauwerke: BauwerkInstance[] } {
  const answers: Record<string, ProjectPrimitiveValue> = {}

  // Rebuild the building list from stored bauwerk_name facts / suffixed keys.
  const bwIds = new Set<string>()
  const collectId = (key: string) => {
    const m = key.match(/@(bw\d+)(?:@|$)/)
    if (m) bwIds.add(m[1])
  }
  Object.keys(profile.facts).forEach(collectId)
  Object.keys(profile.assumptions).forEach(collectId)
  profile.unknowns.forEach(collectId)
  const bauwerke: BauwerkInstance[] =
    bwIds.size === 0
      ? defaultBauwerke()
      : [...bwIds]
          .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
          .map((id, i) => {
            const stored = profile.facts[`bauwerk_name@${id}`]?.value
            return { id, name: typeof stored === 'string' && stored ? stored : `Bauwerk ${i + 1}` }
          })

  const readInto = (question: ProjectIntakeQuestion, answerKey: string, storageKey: string) => {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) return

    // number_tri: fact → wert, assumption → geschaetzt, unknown → offen.
    if (question.type === 'number_tri') {
      const fact = profile.facts[storageKey]
      const assumption = profile.assumptions[storageKey]
      if (fact !== undefined && typeof fact.value === 'number') {
        answers[answerKey] = fact.value
        answers[modeKeyFor(answerKey)] = 'wert'
      } else if (assumption !== undefined && typeof assumption.value === 'number') {
        answers[answerKey] = assumption.value
        answers[modeKeyFor(answerKey)] = 'geschaetzt'
      } else if (profile.unknowns.includes(storageKey)) {
        answers[modeKeyFor(answerKey)] = 'offen'
      }
      return
    }

    // yes_no_open: boolean fact → ja/nein, unknown → offen.
    if (question.type === 'yes_no_open') {
      const fact = profile.facts[storageKey]
      if (fact !== undefined && typeof fact.value === 'boolean') {
        answers[answerKey] = fact.value ? 'ja' : 'nein'
      } else if (profile.unknowns.includes(storageKey)) {
        answers[answerKey] = 'offen'
      }
      return
    }

    let value: ProjectPrimitiveValue | undefined =
      target.scope === 'goals' ? profile.goals?.[storageKey] : profile.facts?.[storageKey]?.value
    if (value === undefined || value === null) return
    if (question.type === 'multi_select' && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) value = parsed as string[]
      } catch {
        /* keep as-is */
      }
    }
    answers[answerKey] = value
  }

  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') {
      for (const bw of bauwerke) {
        for (const q of stage.questions) {
          const target = resolveWriteTarget(q.writesTo)
          if (target) readInto(q, answerKeyFor(q.id, bw.id), instanceStorageKey(target.key, bw.id))
        }
        const uses = answers[answerKeyFor('D0', bw.id)]
        if (Array.isArray(uses)) {
          for (const use of uses) {
            const zoneQs = [
              ...(stage.zoneCommon ?? []),
              ...(stage.zoneDefinitions?.[use]?.questions ?? []),
            ]
            for (const q of zoneQs) {
              const target = resolveWriteTarget(q.writesTo)
              if (target)
                readInto(
                  q,
                  answerKeyFor(q.id, bw.id, use),
                  instanceStorageKey(target.key, bw.id, use)
                )
            }
          }
        }
      }
    } else {
      for (const q of stage.questions) {
        const target = resolveWriteTarget(q.writesTo)
        if (target) readInto(q, q.id, target.key)
      }
    }
  }

  applyLegacyAnswerBridges(profile, answers, bauwerke)

  return { answers, bauwerke }
}

// ---------------------------------------------------------------------------
// Legacy bridges: v1.0-catalog profiles opened by the v1.2 catalog.
//
// Storage keys are id-independent, so the v1.1 renumbering costs nothing. What
// remains are the places where a MEANING moved: merged questions, the
// project→bauwerk scope move of the Bestand block, and the one inversion.
// Bridges only PREFILL wizard answers — the stored profile is untouched until
// the user saves, at which point the answers re-emit under the new shape and
// `mergeIntakeProfile` retires the intake-owned legacy keys.
// ---------------------------------------------------------------------------

/** The four v1.0 booleans that v1.2's `E2` multi-select absorbed. */
const LEGACY_TECHNIK_KEYS = ['pv', 'lueftung', 'kuehlung', 'versickerung'] as const

/** v1.0 `vorhabensart` → the v1.2 `CB4` measure it corresponds to. */
const LEGACY_VORHABEN_TO_MASSNAHME: Record<string, string> = {
  sanierung: 'huelle_sanierung',
  umbau: 'umbau_innen',
  zubau: 'zubau',
  nutzungsaenderung: 'nutzungsaenderung',
  abbruch: 'teilabbruch',
}

function legacyBoolean(profile: ProjectProfile, key: string): boolean | undefined {
  const value = profile.facts[key]?.value
  return typeof value === 'boolean' ? value : undefined
}

function applyLegacyAnswerBridges(
  profile: ProjectProfile,
  answers: Record<string, ProjectPrimitiveValue>,
  bauwerke: BauwerkInstance[]
): void {
  // --- Bestand block (v1.0 A6/A7/A9/A10 → CB1/CB3/CB5/CB6, project → bauwerk).
  // Only bridged into a single-building project: the legacy answer was one
  // project-global statement, and guessing WHICH of several buildings it
  // described would plant a wrong fact. Multi-building projects re-answer per
  // building; the completion checklist surfaces the gap.
  if (bauwerke.length === 1) {
    const bw = bauwerke[0].id
    const legacyBestand: Array<{ question: string; key: string; numeric: boolean }> = [
      { question: 'CB1', key: 'baujahr_bestand', numeric: true },
      { question: 'CB3', key: 'denkmalschutz', numeric: false },
      { question: 'CB5', key: 'tragstruktur_eingriff', numeric: false },
      { question: 'CB6', key: 'groessere_renovierung', numeric: false },
    ]
    let bridgedAny = false
    for (const { question, key, numeric } of legacyBestand) {
      const answerKey = answerKeyFor(question, bw)
      if (answers[answerKey] !== undefined || answers[modeKeyFor(answerKey)] !== undefined) continue
      if (numeric) {
        const fact = profile.facts[key]?.value
        const assumption = profile.assumptions[key]?.value
        if (typeof fact === 'number') {
          answers[answerKey] = fact
          answers[modeKeyFor(answerKey)] = 'wert'
          bridgedAny = true
        } else if (typeof assumption === 'number') {
          answers[answerKey] = assumption
          answers[modeKeyFor(answerKey)] = 'geschaetzt'
          bridgedAny = true
        }
        continue
      }
      const bool = legacyBoolean(profile, key)
      if (bool !== undefined) {
        answers[answerKey] = bool ? 'ja' : 'nein'
        bridgedAny = true
      } else if (profile.unknowns.includes(key)) {
        // An explicitly-open legacy answer is an answer. Dropping it left
        // `bridgedAny` false, so the C2 gate never opened and the whole
        // Bestand block stayed hidden for a project that had described one.
        answers[answerKey] = 'offen'
        bridgedAny = true
      }
    }
    // A building whose Bestand was described IS a Bestandsgebäude — prefill the
    // gate so the bridged block is visible instead of orphaned behind an
    // unanswered C2.
    const c2Key = answerKeyFor('C2', bw)
    if (bridgedAny && answers[c2Key] === undefined) answers[c2Key] = 'bestand'

    // CB6 sits behind a CB4 measure as well, and legacy profiles have no CB4.
    // Without one the bridged answer renders nowhere and `buildIntakeProfile`
    // drops it on save. The measures are read off the project's own
    // `vorhabensart` rather than invented: v1.0 only ever ASKED A10 when A5
    // included `sanierung`, so the mapping restates what the old catalog
    // already implied.
    const cb4Key = answerKeyFor('CB4', bw)
    const cb6Key = answerKeyFor('CB6', bw)
    if (answers[cb6Key] !== undefined && !isIntakeAnswerProvided(answers[cb4Key])) {
      const vorhaben = profile.facts['vorhabensart']?.value
      const measures = new Set<string>()
      if (Array.isArray(vorhaben)) {
        for (const art of vorhaben) {
          const mapped = LEGACY_VORHABEN_TO_MASSNAHME[String(art)]
          if (mapped) measures.add(mapped)
        }
      }
      // CB6 only asks about the hull, so a bridged answer implies hull work
      // even when `vorhabensart` named nothing that maps.
      if (measures.size === 0) measures.add('huelle_sanierung')
      answers[cb4Key] = [...measures]
    }
  }

  for (const bw of bauwerke) {
    // --- C8 inversion (v1.0 C7 `ne_unter_400`, ja = alle Einheiten bis 400 m²).
    const c8Key = answerKeyFor('C8', bw.id)
    if (answers[c8Key] === undefined) {
      const legacy = profile.facts[`ne_unter_400@${bw.id}`]?.value
      if (typeof legacy === 'boolean') answers[c8Key] = legacy ? 'nein' : 'ja'
      else if (profile.unknowns.includes(`ne_unter_400@${bw.id}`)) answers[c8Key] = 'offen'
    }

    // --- C10 single → multi (`bauweise`): map the legacy single token.
    const c10Key = answerKeyFor('C10', bw.id)
    const c10 = answers[c10Key]
    if (typeof c10 === 'string') {
      const mapped: Record<string, string[]> = {
        massivbau: ['mauerwerk_massivbau'],
        holzbau: ['holzbau'],
        stahl: ['stahlbau'],
        offen: ['offen'],
        // 'hybrid' named no members; the user re-picks and describes the mix.
      }
      const replacement = mapped[c10]
      if (replacement) answers[c10Key] = replacement
      else delete answers[c10Key]
    }

    // --- E2 fusion: four legacy booleans into `technik_weitere`.
    const e2Key = answerKeyFor('E2', bw.id)
    if (answers[e2Key] === undefined) {
      const technik: string[] = []
      if (legacyBoolean(profile, `pv@${bw.id}`)) technik.push('pv')
      if (legacyBoolean(profile, `lueftung@${bw.id}`)) technik.push('lueftung')
      if (legacyBoolean(profile, `kuehlung@${bw.id}`)) technik.push('kuehlung')
      if (legacyBoolean(profile, `versickerung@${bw.id}`)) technik.push('versickerung')
      if (technik.length > 0) answers[e2Key] = technik
      else if (
        LEGACY_TECHNIK_KEYS.every((key) => legacyBoolean(profile, `${key}@${bw.id}`) === false)
      ) {
        // All four answered and all four "no" is the explicit `keine`, not an
        // unanswered question — otherwise the migration puts a module the user
        // completed back on the completion checklist.
        answers[e2Key] = ['keine']
      }
    }
  }

  // --- B4 fusion: legacy Altlast/Baumbestand/Schutzgebiet booleans join the
  // stored `gefahrenzonen` values (already read into B4 — same key, wider
  // vocabulary).
  const b4Additions: string[] = []
  if (legacyBoolean(profile, 'altlast')) b4Additions.push('altlast')
  if (legacyBoolean(profile, 'baumbestand')) b4Additions.push('baumbestand')
  if (legacyBoolean(profile, 'schutzgebiet')) b4Additions.push('schutzgebiet')
  if (b4Additions.length > 0) {
    const current = Array.isArray(answers['B4']) ? (answers['B4'] as string[]) : []
    const merged = [
      ...current.filter((value) => value !== 'keine'),
      ...b4Additions.filter((v) => !current.includes(v)),
    ]
    answers['B4'] = merged
  }

  // --- B6 fusion: Kanal + Trinkwasser + Zufahrt → one Erschließungs-Status.
  // Only when all three were answered; a partial picture stays unanswered
  // rather than guessed.
  if (answers['B6'] === undefined) {
    const kanal = legacyBoolean(profile, 'kanal')
    const wasser = legacyBoolean(profile, 'trinkwasser')
    const zufahrt = legacyBoolean(profile, 'zufahrt_feuerwehr')
    if (kanal !== undefined && wasser !== undefined && zufahrt !== undefined) {
      const yes = [kanal, wasser, zufahrt].filter(Boolean).length
      // Never 'ja' from these three. The new question also covers electricity,
      // which v1.0 never asked, so claiming full servicing would persist a fact
      // nobody stated. Anything short of all three is honestly 'teilweise';
      // all three leaves the electricity question for the user.
      if (yes === 0) answers['B6'] = 'nein'
      else if (yes < 3) answers['B6'] = 'teilweise'
    }
  }

  // --- B7 fusion: Anschlussgebiet beats bare availability.
  if (answers['B7'] === undefined) {
    if (legacyBoolean(profile, 'fernwaerme_zone')) answers['B7'] = 'anschlussgebiet'
    else {
      const fw = legacyBoolean(profile, 'fernwaerme')
      if (fw !== undefined) answers['B7'] = fw ? 'verfuegbar' : 'nicht_verfuegbar'
    }
  }

  // v1.0's A8 (Schutzzone) is deliberately NOT bridged into `B3_bes`.
  //
  // `B3_bes` only renders behind `B2 = ja`, so a bridged value would be
  // invisible for a project with no Bebauungsplan — and then dropped on save,
  // because `buildIntakeProfile` skips a question whose condition is false.
  // Left alone, `schutzzone_altstadt` is owned by no current question, so
  // `mergeIntakeProfile` preserves it as an agent-visible fact. Not bridging
  // keeps it; bridging lost it.

  // --- F4 fusion: legacy Zertifizierung tokens are valid F4 values.
  const zert = profile.facts['zertifizierung']?.value
  if (typeof zert === 'string' && !['keine', 'offen'].includes(zert)) {
    const current = Array.isArray(answers['F4']) ? (answers['F4'] as string[]) : []
    if (!current.includes(zert))
      answers['F4'] = [...current.filter((value) => value !== 'keine'), zert]
  }

  // --- G merges: appended, never overwritten.
  const appendText = (answerKey: string, key: string) => {
    const legacy = profile.facts[key]?.value
    if (typeof legacy !== 'string' || !legacy.trim()) return
    const current = answers[answerKey]
    answers[answerKey] =
      typeof current === 'string' && current.trim() ? `${current}\n\n${legacy}` : legacy
  }
  appendText('G1', 'kontext_grundstueck')
  appendText('G4', 'kontext_sonstiges')
}

/**
 * Title-case a raw snake_case/space-separated profile key as a last-resort human
 * label (e.g. `hohe_gebaeude_details` -> "Hohe Gebaeude Details").
 */
export function humanizeProfileKey(key: string): string {
  return key
    .split('@')[0]
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Resolve a human label for a raw profile fact/goal key (e.g. `fluchtniveau_m`,
 * or a scoped `fluchtniveau_m@bw1`) from the intake question that writes it.
 */
export function labelForProfileKey(definition: ProjectIntakeDefinition, key: string): string {
  const base = key.split('@')[0]
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (target?.key === base) return question.label
  }
  return humanizeProfileKey(key)
}

/**
 * Server-side vocabulary validation (defense-in-depth for the profile-patch
 * flow): reject add/replace operations whose value violates the intake question
 * that owns the key. Scoped keys (`<base>@bw1`) resolve to their base question.
 */
export function validateProfilePatchVocabulary(patch: ProjectProfilePatchOperation[]): void {
  for (const operation of patch) {
    if (operation.op === 'remove') continue
    const key = extractVocabKey(operation.path)
    if (!key) continue
    const question = questionForKey(key)
    if (!question) continue
    assertVocabulary(question, unwrapPatchValue(operation.value))
  }
}

function extractVocabKey(path: string): string | null {
  const parts = path.split('/')
  const section = parts[1]
  if (section === 'facts' || section === 'assumptions' || section === 'goals') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-') return decodeVocabSegment(parts[2])
    if (
      section !== 'goals' &&
      parts.length === 4 &&
      parts[3] === 'value' &&
      parts[2] &&
      parts[2] !== '-'
    ) {
      return decodeVocabSegment(parts[2])
    }
  }
  return null
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  const base = decodeVocabSegment(key).split('@')[0]
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => resolveWriteTarget(question.writesTo)?.key === base
  )
}

function unwrapPatchValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as Record<string, unknown>).value
  }
  return value
}

function assertVocabulary(question: ProjectIntakeQuestion, value: unknown): void {
  const label = question.label
  const shown = JSON.stringify(value)
  switch (question.type) {
    case 'single_select': {
      if (
        typeof value !== 'string' ||
        !question.options?.some((option) => option.value === value)
      ) {
        throw new Error(`Invalid value for "${label}": ${shown} is not an allowed option.`)
      }
      return
    }
    case 'multi_select': {
      const allowed = new Set(question.options?.map((option) => option.value) ?? [])
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string' && allowed.has(item))
      ) {
        throw new Error(
          `Invalid value for "${label}": ${shown} is not a subset of the allowed options.`
        )
      }
      return
    }
    case 'yes_no_open':
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid value for "${label}": expected true or false, got ${shown}.`)
      }
      return
    }
    case 'number_tri':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid value for "${label}": expected a number, got ${shown}.`)
      }
      return
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid value for "${label}": expected text, got ${shown}.`)
      }
      return
    }
    default:
      return
  }
}

function decodeVocabSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

/** Human-readable rendering of a single answer, using option labels where available. */
export function formatIntakeAnswer(
  question: ProjectIntakeQuestion,
  answer: ProjectPrimitiveValue | undefined
): string {
  // yes_no_open facts persist as booleans; render them like a boolean here.
  if (
    question.type === 'boolean' ||
    (question.type === 'yes_no_open' && typeof answer === 'boolean')
  ) {
    return answer ? 'Ja' : answer === false ? 'Nein' : '—'
  }
  if (!isIntakeAnswerProvided(answer)) return '—'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if (
    (question.type === 'single_select' || question.type === 'yes_no_open') &&
    typeof answer === 'string'
  ) {
    return optionLabel(answer)
  }
  if (question.type === 'number_tri' && typeof answer === 'number') {
    return question.unit ? `${answer} ${question.unit}` : String(answer)
  }
  return String(answer)
}
