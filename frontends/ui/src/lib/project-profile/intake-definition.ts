import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
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
  op: 'equals' | 'includes_any' | 'not_empty'
  value?: string | string[]
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

const VORHABEN_BESTAND = ['zubau', 'umbau', 'sanierung', 'nutzungsaenderung', 'abbruch']

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
  version: 4,
  stages: [
    // ------------------------------------------------------------------ A
    {
      id: 'A',
      title: 'Projektbasis',
      scope: 'projekt',
      description: 'Stammdaten, Standort und Art des Vorhabens — die Grundweichen des gesamten Fragebaums.',
      questions: [
        {
          id: 'A1',
          label: 'Projektname / interne Nummer',
          type: 'text',
          required: true,
          placeholder: 'z. B. WHA Quellenstraße / P-2026-014',
          writesTo: '/facts/project_name/value',
        },
        {
          id: 'A2_adr',
          label: 'Adresse / Gemeinde',
          type: 'text',
          required: true,
          placeholder: 'Straße, PLZ Ort',
          why: 'Aus der Gemeinde folgen örtliche Vorschriften wie Fernwärme-Anschlussgebiete, Schutzzonen oder Baumschutz.',
          writesTo: '/facts/standort_adresse/value',
        },
        {
          id: 'A2_land',
          label: 'Bundesland',
          type: 'single_select',
          required: true,
          why: 'Bestimmt die zuständige Bauordnung, den dort geltenden OIB-Stand und die anwendbaren Landesgesetze.',
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
          help: 'Land und Region/Stadt, z. B. „Bayern, Deutschland“ — damit Piloti das anwendbare Recht einordnen kann.',
          type: 'text',
          conditions: [{ param: 'A2_land', op: 'equals', value: 'ausserhalb_oesterreichs' }],
          writesTo: '/facts/standort_details/value',
        },
        {
          id: 'A3',
          label: 'Katastralgemeinde & Grundstücksnummer',
          type: 'text',
          optional: true,
          placeholder: 'z. B. KG 01207, GSt-Nr. 1234/5',
          writesTo: '/facts/katastralgemeinde/value',
        },
        {
          id: 'A4',
          label: 'Aktuelle Projektphase',
          type: 'single_select',
          why: 'Steuert die Erwartung an die Antwortgüte: in frühen Phasen werden Schätzwerte aktiv angeboten, vor der Einreichung an offene Schätzungen erinnert.',
          options: [
            { value: 'grundlagenermittlung', label: 'Grundlagenermittlung' },
            { value: 'vorentwurf', label: 'Vorentwurf' },
            { value: 'entwurf', label: 'Entwurf' },
            { value: 'einreichplanung', label: 'Einreichplanung' },
            { value: 'ausfuehrungsplanung', label: 'Ausführungsplanung' },
          ],
          writesTo: '/facts/projektphase/value',
        },
        {
          id: 'A5',
          label: 'Art des Vorhabens',
          type: 'multi_select',
          required: true,
          why: 'Grundweiche des Fragebaums; entscheidend für Bewilligungs- oder Anzeigepflicht nach der Landes-Bauordnung.',
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
        {
          id: 'A6',
          label: 'Baujahr des Bestands (ca.)',
          type: 'number_tri',
          placeholder: 'z. B. 1962',
          why: 'Bestandsschutz und sinngemäße Anwendung der OIB-Richtlinien hängen am Errichtungszeitpunkt.',
          conditions: [{ param: 'A5', op: 'includes_any', value: VORHABEN_BESTAND }],
          writesTo: '/facts/baujahr_bestand/value',
        },
        {
          id: 'A7',
          label: 'Steht das Objekt unter Denkmalschutz?',
          type: 'yes_no_open',
          why: 'Löst das Verfahren nach dem Denkmalschutzgesetz aus und eröffnet Ausnahmen, etwa bei Energie- und Barrierefreiheitsanforderungen.',
          conditions: [{ param: 'A5', op: 'includes_any', value: VORHABEN_BESTAND }],
          writesTo: '/facts/denkmalschutz/value',
        },
        {
          id: 'A8',
          label: 'Lage in einer Schutzzone / einem Altstadterhaltungsgebiet?',
          type: 'yes_no_open',
          conditions: [{ param: 'A5', op: 'includes_any', value: VORHABEN_BESTAND }],
          writesTo: '/facts/schutzzone_altstadt/value',
        },
        {
          id: 'A9',
          label: 'Ist ein Eingriff in die Tragstruktur geplant?',
          type: 'yes_no_open',
          why: 'Relevanz der OIB-Richtlinie 1 und der statischen Vorbemessung; oft bewilligungsauslösend.',
          conditions: [{ param: 'A5', op: 'includes_any', value: ['umbau', 'sanierung'] }],
          writesTo: '/facts/tragstruktur_eingriff/value',
        },
        {
          id: 'A10',
          label: 'Handelt es sich um eine „größere Renovierung“ (mehr als 25 % der Gebäudehülle)?',
          type: 'yes_no_open',
          why: 'Ab dieser Schwelle greifen die Renovierungsanforderungen der OIB-Richtlinie 6.',
          conditions: [{ param: 'A5', op: 'includes_any', value: ['sanierung'] }],
          writesTo: '/facts/groessere_renovierung/value',
        },
        {
          id: 'A11',
          label: 'Bauherrschaft',
          type: 'single_select',
          optional: true,
          options: [
            { value: 'privat', label: 'privat' },
            { value: 'gewerblich', label: 'gewerblich' },
            { value: 'oeffentliche_hand', label: 'öffentliche Hand' },
            { value: 'bautraeger', label: 'Bauträger' },
          ],
          writesTo: '/facts/bauherrschaft/value',
        },
      ],
    },
    // ------------------------------------------------------------------ B
    {
      id: 'B',
      title: 'Grundstück & Widmung',
      scope: 'grundstueck',
      description: 'Flächenwidmungs- und Bebauungsplan-Kennwerte, Gefahrenzonen und Erschließung. Jede Kennzahl einzeln offen lassbar.',
      questions: [
        {
          id: 'B1',
          label: 'Flächenwidmung',
          type: 'single_select',
          optional: true,
          why: 'Die Widmung entscheidet über die Zulässigkeit der geplanten Nutzung nach dem Raumordnungsrecht des Landes.',
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
          id: 'B1_orig',
          label: 'Originalbezeichnung lt. Flächenwidmungsplan',
          type: 'text',
          optional: true,
          placeholder: 'z. B. W II g 12m',
          writesTo: '/facts/flaechenwidmung_orig/value',
        },
        {
          id: 'B2',
          label: 'Liegt ein Bebauungsplan vor?',
          type: 'yes_no_open',
          writesTo: '/facts/bebauungsplan/value',
        },
        {
          id: 'B2_upl',
          label: 'Bebauungsplan / Flächenwidmungsplan ablegen',
          type: 'upload',
        },
        {
          id: 'B3_hoehe',
          label: 'Bauklasse / max. Gebäudehöhe',
          type: 'number_tri',
          unit: 'm',
          why: 'Höhenvorgaben der Landes-Bauordnung; Grundlage der Zulässigkeitsprüfung des Entwurfs.',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/max_gebaeudehoehe/value',
        },
        {
          id: 'B3_weise',
          label: 'Bebauungsweise',
          type: 'single_select',
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
          label: 'Bebauungsdichte (GFZ / GRZ / %)',
          type: 'number_tri',
          placeholder: 'z. B. 1.5',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/bebauungsdichte/value',
        },
        {
          id: 'B3_flucht',
          label: 'Baufluchtlinien / Baugrenzen relevant?',
          type: 'yes_no_open',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/baufluchtlinien/value',
        },
        {
          id: 'B3_bes',
          label: 'Besondere Bestimmungen des Bebauungsplans',
          type: 'text',
          optional: true,
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/bebauungsplan_besonderes/value',
        },
        {
          id: 'B4',
          label: 'Gefahrenzonen am Grundstück',
          type: 'multi_select',
          optional: true,
          why: 'Bauverbote und -beschränkungen der Landes-Bauordnung, Wasserrecht sowie Einwirkungsszenarien nach OIB-Richtlinie 1.',
          options: [
            { value: 'hw_hq30', label: 'Hochwasser HQ30' },
            { value: 'hw_hq100', label: 'Hochwasser HQ100' },
            { value: 'wildbach_gelb', label: 'Wildbach/Lawine – gelbe Zone' },
            { value: 'wildbach_rot', label: 'Wildbach/Lawine – rote Zone' },
            { value: 'rutschung', label: 'Rutschung / Steinschlag' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/gefahrenzonen/value',
        },
        {
          id: 'B5',
          label: 'Altlast oder Verdachtsfläche?',
          type: 'yes_no_open',
          writesTo: '/facts/altlast/value',
        },
        {
          id: 'B6',
          label: 'Lärmsituation am Standort',
          type: 'single_select',
          optional: true,
          why: 'Der standortbezogene Außenlärmpegel bestimmt die Anforderungen an Außenbauteile nach OIB-Richtlinie 5.',
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
          id: 'B6_tag',
          label: 'Beurteilungspegel Tag (falls bekannt)',
          type: 'number_tri',
          unit: 'dB',
          optional: true,
          writesTo: '/facts/laerm_tag/value',
        },
        {
          id: 'B6_nacht',
          label: 'Beurteilungspegel Nacht (falls bekannt)',
          type: 'number_tri',
          unit: 'dB',
          optional: true,
          writesTo: '/facts/laerm_nacht/value',
        },
        { id: 'B7_kanal', label: 'Öffentlicher Kanal vorhanden?', type: 'yes_no_open', writesTo: '/facts/kanal/value' },
        { id: 'B7_wasser', label: 'Trinkwassernetz vorhanden?', type: 'yes_no_open', writesTo: '/facts/trinkwasser/value' },
        { id: 'B7_fw', label: 'Fernwärme verfügbar?', type: 'yes_no_open', writesTo: '/facts/fernwaerme/value' },
        { id: 'B7_fwzone', label: 'Lage im Fernwärme-Anschlussgebiet?', type: 'yes_no_open', writesTo: '/facts/fernwaerme_zone/value' },
        {
          id: 'B7_zufahrt',
          label: 'Ausreichende Zufahrt (inkl. Feuerwehr)?',
          type: 'yes_no_open',
          why: 'Feuerwehrzufahrt nach OIB-Richtlinie 2; Erschließungsanforderungen der Landes-Bauordnung.',
          writesTo: '/facts/zufahrt_feuerwehr/value',
        },
        {
          id: 'B8',
          label: 'Anbau an Nachbargebäude oder Bebauung nahe der Grundgrenze geplant?',
          type: 'yes_no_open',
          why: 'Brandwände nach OIB-Richtlinie 2 sowie Abstandsbestimmungen der Landes-Bauordnung.',
          writesTo: '/facts/anbau_grundgrenze/value',
        },
        { id: 'B9', label: 'Geschützter Baumbestand betroffen?', type: 'yes_no_open', writesTo: '/facts/baumbestand/value' },
        {
          id: 'B10',
          label: 'Lage in einem Schutzgebiet (Naturschutz, Natura 2000, Landschaftsschutz)?',
          type: 'yes_no_open',
          writesTo: '/facts/schutzgebiet/value',
        },
      ],
    },
    // ------------------------------------------------------------------ C
    {
      id: 'C',
      title: 'Bauwerke',
      scope: 'bauwerk',
      repeatable: true,
      description: 'Geometrie und Bauweise je Bauwerk. Daraus leitet das System später die Gebäudeklasse ab.',
      questions: [
        {
          id: 'C1',
          label: 'Bauwerkstyp',
          type: 'single_select',
          why: 'Kleinstgebäude sind von vielen OIB-Anforderungen ausgenommen; sonstige Bauwerke erhalten ein reduziertes Regelset.',
          options: [
            { value: 'gebaeude', label: 'Gebäude' },
            { value: 'klein', label: 'Kleinstgebäude ≤ 15 m² BGF' },
            { value: 'sonstig', label: 'sonstiges Bauwerk (Flugdach, Stützmauer, Werbeanlage …)' },
          ],
          writesTo: '/facts/bauwerkstyp/value',
        },
        {
          id: 'C2',
          label: 'Anzahl oberirdischer Geschoße',
          type: 'number_tri',
          why: 'Kernparameter der Gebäudeklasse; außerdem relevant für die Aufzugspflicht.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/geschosse_oberirdisch/value',
        },
        {
          id: 'C3',
          label: 'Anzahl unterirdischer Geschoße',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/geschosse_unterirdisch/value',
        },
        {
          id: 'C4',
          label: 'Fluchtniveau',
          type: 'number_tri',
          unit: 'm',
          why: 'Kernparameter der Gebäudeklasse; über 22 m gilt das Gebäude als Hochhaus (OIB-Richtlinie 2.3).',
          hint: 'Höhendifferenz zwischen der Fußbodenoberkante des höchstgelegenen Geschoßes mit Aufenthaltsräumen und dem tiefsten Punkt des angrenzenden Geländes.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/fluchtniveau_m/value',
        },
        {
          id: 'C5',
          label: 'Brutto-Grundfläche der oberirdischen Geschoße (gesamt)',
          type: 'number_tri',
          unit: 'm²',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/bgf_oberirdisch/value',
        },
        {
          id: 'C6',
          label: 'Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten)',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/nutzungseinheiten/value',
        },
        {
          id: 'C7',
          label: 'Sind alle Nutzungseinheiten ≤ 400 m² BGF (oberirdisch)?',
          type: 'yes_no_open',
          why: 'Abgrenzungskriterium zwischen den Gebäudeklassen 2, 3 und 4.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/ne_unter_400/value',
        },
        {
          id: 'C8',
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
          id: 'C9',
          label: 'Tragstruktur / Bauweise',
          type: 'single_select',
          why: 'Feuerwiderstandsanforderungen der OIB-Richtlinie 2 hängen an Gebäudeklasse und Bauweise; Sonderregeln für den Holzbau.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          options: [
            { value: 'massivbau', label: 'Massivbau' },
            { value: 'holzbau', label: 'Holzbau' },
            { value: 'stahl', label: 'Stahl' },
            { value: 'hybrid', label: 'Hybrid' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/bauweise/value',
        },
        {
          id: 'C10',
          label: 'Konditionierung',
          type: 'single_select',
          why: 'Die OIB-Richtlinie 6 gilt nur für konditionierte Gebäude; daran hängt auch die Energieausweispflicht.',
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
          id: 'C11',
          label: 'Aufzug geplant?',
          type: 'yes_no_open',
          hint: 'Die Aufzugspflicht wird später aus Geschoßanzahl und Landesrecht abgeleitet und gegen diese Angabe geprüft.',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/aufzug/value',
        },
        {
          id: 'C12',
          label: 'Feuerstätten / Rauchfänge geplant?',
          type: 'yes_no_open',
          conditions: [{ param: 'C1', op: 'equals', value: 'gebaeude' }],
          writesTo: '/facts/feuerstaetten/value',
        },
        {
          id: 'C_GK_CONFIRM',
          label: 'Gebäudeklasse',
          type: 'info_placeholder',
          derives: 'gebaeudeklasse',
          hint: 'Die Gebäudeklasse ermittelt das System automatisch aus Geschoßanzahl, Fluchtniveau, Grundfläche und Nutzungseinheiten und legt sie Ihnen hier zur Bestätigung vor. Sind Angaben noch offen, wird eine Bandbreite angezeigt (z. B. „GK 4 oder GK 5“).',
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
      description: 'Nutzungsmix je Bauwerk. Jede gewählte Nutzung erzeugt eine Zone mit generischen und nutzungsspezifischen Kennzahlen.',
      questions: [
        {
          id: 'D0',
          label: 'Welche Nutzungen enthält dieses Bauwerk?',
          type: 'multi_select',
          why: 'Jede Nutzung aktiviert eigene Regelwerke – von OIB-Teilrichtlinien über Gewerberecht bis zum Veranstaltungsrecht.',
          hint: 'Mehrfachauswahl — je Nutzung folgen Kennzahlen.',
          options: NUTZUNGEN,
          writesTo: '/facts/nutzungen/value',
        },
        {
          id: 'DX1',
          label: 'Ist das Bauwerk (teilweise) öffentlich zugänglich / mit Publikumsverkehr?',
          type: 'yes_no_open',
          why: 'Aktiviert die Barrierefreiheitsanforderungen der OIB-Richtlinie 4 und das Bundes-Behindertengleichstellungsgesetz.',
          writesTo: '/facts/publikumsverkehr/value',
        },
        {
          id: 'DX2',
          label: 'Ist das Bauwerk (teilweise) Arbeitsstätte?',
          type: 'yes_no_open',
          why: 'Arbeitsstätten unterliegen zusätzlich dem ArbeitnehmerInnenschutzgesetz und der Arbeitsstättenverordnung.',
          hint: 'Im echten System aus den Nutzungen vorgeschlagen — hier bestätigen.',
          writesTo: '/facts/arbeitsstaette/value',
        },
      ],
      zoneCommon: [
        { id: 'D_fl', label: 'Fläche der Zone (BGF)', type: 'number_tri', unit: 'm²', writesTo: '/facts/zone_flaeche/value' },
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
            { id: 'D_we', label: 'Anzahl Wohneinheiten', type: 'number_tri', writesTo: '/facts/wohneinheiten/value' },
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
            { id: 'D_an', label: 'Max. gleichzeitig anwesende Arbeitnehmer:innen', type: 'number_tri', writesTo: '/facts/arbeitnehmer/value' },
          ],
        },
        handel: {
          questions: [
            { id: 'D_vkf', label: 'Verkaufsfläche', type: 'number_tri', unit: 'm²', writesTo: '/facts/verkaufsflaeche/value' },
            { id: 'D_ekz', label: 'Teil eines Einkaufszentrums?', type: 'yes_no_open', writesTo: '/facts/einkaufszentrum/value' },
          ],
        },
        gastro: {
          questions: [
            { id: 'D_plaetze', label: 'Max. Verabreichungsplätze / Personen', type: 'number_tri', writesTo: '/facts/verabreichungsplaetze/value' },
          ],
        },
        beherbergung: {
          questions: [
            { id: 'D_betten', label: 'Anzahl Gästebetten', type: 'number_tri', writesTo: '/facts/gaestebetten/value' },
          ],
        },
        versammlung: {
          questions: [
            { id: 'D_pers', label: 'Max. gleichzeitig anwesende Personen', type: 'number_tri', writesTo: '/facts/personen_max/value' },
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
            { id: 'D_kinder', label: 'Anzahl Kinder / Schüler:innen', type: 'number_tri', writesTo: '/facts/anzahl_kinder/value' },
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
            { id: 'D_gefstoffe', label: 'Lagerung / Verwendung gefährlicher Stoffe?', type: 'yes_no_open', writesTo: '/facts/gefaehrliche_stoffe/value' },
            { id: 'D_brandlast', label: 'Brandlastintensive Nutzung?', type: 'yes_no_open', writesTo: '/facts/brandlast/value' },
          ],
        },
        garage: {
          questions: [
            { id: 'D_stp', label: 'Anzahl Pkw-Stellplätze', type: 'number_tri', writesTo: '/facts/stellplaetze/value' },
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
            { id: 'D_garagenfl', label: 'Nutzfläche der Garage', type: 'number_tri', unit: 'm²', writesTo: '/facts/garagenflaeche/value' },
            { id: 'D_lade', label: 'E-Ladepunkte geplant?', type: 'yes_no_open', writesTo: '/facts/e_ladepunkte/value' },
          ],
        },
        landwirtschaft: {
          questions: [{ id: 'D_tiere', label: 'Tierhaltung?', type: 'yes_no_open', writesTo: '/facts/tierhaltung/value' }],
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
          why: 'Nach dem Erneuerbare-Wärme-Gesetz sind fossile Systeme im Neubau unzulässig – das System warnt bei Konflikten.',
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
          id: 'E2',
          label: 'PV-Anlage geplant?',
          type: 'yes_no_open',
          why: 'Mehrere Landes-Bauordnungen enthalten PV-Verpflichtungen für Neubau und größere Renovierung.',
          writesTo: '/facts/pv/value',
        },
        { id: 'E3', label: 'Mechanische Lüftungsanlage geplant?', type: 'yes_no_open', writesTo: '/facts/lueftung/value' },
        { id: 'E4', label: 'Aktive Kühlung geplant?', type: 'yes_no_open', writesTo: '/facts/kuehlung/value' },
        {
          id: 'E5',
          label: 'Anlagentechnischer Brandschutz angedacht',
          type: 'multi_select',
          optional: true,
          why: 'Häufig Kompensationsmaßnahmen – verknüpft das Projekt mit den TRVB-Richtlinien.',
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
          id: 'E6',
          label: 'Regenwasserbewirtschaftung / Versickerung am Grundstück?',
          type: 'yes_no_open',
          writesTo: '/facts/versickerung/value',
        },
      ],
    },
    // ------------------------------------------------------------------ F
    {
      id: 'F',
      title: 'Verfahren & Sonderrecht',
      scope: 'projekt',
      description: 'Behördenverfahren, Förderungen und Sonderthemen — im Zielsystem großteils vorbelegt, hier bestätigen.',
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
          hint: 'Vorbelegt aus Gefahrenzonen (B4) und Versickerung (E6).',
          writesTo: '/facts/wasserrecht/value',
        },
        {
          id: 'F4',
          label: 'Förderung angestrebt?',
          type: 'multi_select',
          optional: true,
          why: 'Förderrichtlinien der Länder enthalten oft strengere technische Anforderungen als das Gesetzesminimum.',
          options: [
            { value: 'wohnbaufoerderung', label: 'Wohnbauförderung des Landes' },
            { value: 'sanierungsfoerderung', label: 'Sanierungsförderung' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/foerderung/value',
        },
        {
          id: 'F5',
          label: 'Gebäudezertifizierung angestrebt?',
          type: 'single_select',
          optional: true,
          options: [
            { value: 'klimaaktiv', label: 'klimaaktiv' },
            { value: 'oegni_dgnb', label: 'ÖGNI / DGNB' },
            { value: 'leed_breeam', label: 'LEED / BREEAM' },
            { value: 'keine', label: 'keine' },
            { value: 'offen', label: 'noch offen' },
          ],
          writesTo: '/facts/zertifizierung/value',
        },
        {
          id: 'F6',
          label: 'Schad- und Störstofferkundung / Rückbaukonzept relevant?',
          type: 'yes_no_open',
          why: 'Recycling-Baustoffverordnung und Abfallrecht beim Abbruch.',
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
      description: 'Geführter Freitext: alles, was der Assistent über die Zahlen hinaus wissen sollte. Alle Felder optional — je mehr Kontext, desto besser.',
      questions: [
        {
          id: 'G1',
          label: 'Projektbeschreibung & Entwurfsidee',
          type: 'textarea',
          optional: true,
          placeholder: 'Was ist das Projekt in 3–10 Sätzen? Städtebauliche Setzung, architektonisches Konzept, Materialität …',
          writesTo: '/facts/kontext_beschreibung/value',
        },
        {
          id: 'G2',
          label: 'Besonderheiten von Grundstück & Umfeld',
          type: 'textarea',
          optional: true,
          placeholder: 'Topografie, Nachbarschaft, Bestandsstrukturen, Erschließung, Orientierung …',
          writesTo: '/facts/kontext_grundstueck/value',
        },
        {
          id: 'G3',
          label: 'Ziele & Prioritäten der Bauherrschaft',
          type: 'textarea',
          optional: true,
          placeholder: 'Kosten- und Terminrahmen, Nachhaltigkeitsambition, Flexibilität, besondere Wünsche …',
          writesTo: '/facts/kontext_ziele/value',
        },
        {
          id: 'G4',
          label: 'Bekannte Konfliktpunkte & Risiken',
          type: 'textarea',
          optional: true,
          placeholder: 'Nachbarn, Behördenvorgespräche, technische Risiken, Widmungskonflikte …',
          writesTo: '/facts/kontext_konflikte/value',
        },
        {
          id: 'G5',
          label: 'Geplante Sonderlösungen / Abweichungen',
          type: 'textarea',
          optional: true,
          placeholder: 'Wo wird voraussichtlich vom Standard abgewichen, z. B. Brandschutzkonzept mit Kompensationsmaßnahmen?',
          writesTo: '/facts/kontext_sonderloesungen/value',
        },
        {
          id: 'G6',
          label: 'Sonstiges',
          type: 'textarea',
          optional: true,
          placeholder: 'Alles, was der Assistent sonst noch wissen sollte.',
          writesTo: '/facts/kontext_sonstiges/value',
        },
      ],
    },
    // ------------------------------------------------------------------ H
    {
      id: 'H',
      title: 'Zusammenfassung',
      scope: 'projekt',
      description: 'Ihre Angaben im Überblick. Prüfen Sie alles, bevor das Projektprofil an Piloti übergeben wird.',
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

/**
 * Whether a question is currently relevant given the answers collected so far.
 * Conditions are AND-combined. `param` is resolved within `instanceId`'s scope
 * (a bauwerk question's condition on a bauwerk param reads that building's
 * answer), falling back to the project-global answer for non-bauwerk params.
 */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string,
): boolean {
  const conditions = question.conditions
  if (!conditions || conditions.length === 0) return true
  return conditions.every((cond) => evaluateSingleCondition(cond, answers, instanceId))
}

function evaluateSingleCondition(
  cond: ProjectIntakeCondition,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string,
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
      const needles = Array.isArray(cond.value) ? cond.value : cond.value !== undefined ? [cond.value] : []
      if (Array.isArray(answer)) return answer.some((v) => needles.includes(String(v)))
      return typeof answer === 'string' && needles.includes(answer)
    }
    case 'equals':
    default: {
      if (Array.isArray(answer)) return cond.value !== undefined && answer.includes(cond.value as string)
      return answer === cond.value
    }
  }
}

/** All questions across every stage (including zone questions), in definition order. */
export function flattenIntakeQuestions(definition: ProjectIntakeDefinition): ProjectIntakeQuestion[] {
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
  questionId: string,
): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === questionId)
}

/**
 * The distinct scope instances (bauwerke) implied by the current answer state.
 * Reconstructed from `@bwN`-suffixed keys plus any stored bauwerk names, so an
 * edit session can rebuild the building list the same way the wizard held it.
 */
export function bauwerkeFromAnswers(answers: Record<string, ProjectPrimitiveValue>): BauwerkInstance[] {
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
  definition: ProjectIntakeDefinition | null | undefined,
): Record<string, ProjectPrimitiveValue> {
  if (!definition) return answers
  const bauwerke = bauwerkeFromAnswers(answers)
  let current = answers
  let changedAny = false

  for (;;) {
    let changedThisPass = false
    let next: Record<string, ProjectPrimitiveValue> | null = null

    const dropIfOrphaned = (question: ProjectIntakeQuestion, answerKey: string, instanceId?: string) => {
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
  answers: Record<string, ProjectPrimitiveValue>,
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

function addFact(ctx: BuildContext, target: WriteTarget, storageKey: string, value: ProjectPrimitiveValue): void {
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
  options?: { projectName?: string; bauwerke?: BauwerkInstance[] },
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
      value: { value: projectName, confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
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

  for (const key of ctx.unknowns) {
    ctx.patch.push({ op: 'add', path: '/unknowns/-', value: key })
  }

  return applyProjectProfilePatch(emptyProjectProfile(), ctx.patch)
}

function emitStageForBauwerk(
  ctx: BuildContext,
  stage: ProjectIntakeStage,
  bw: BauwerkInstance,
  answers: Record<string, ProjectPrimitiveValue>,
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
    const zoneQuestions = [...(stage.zoneCommon ?? []), ...(stage.zoneDefinitions?.[use]?.questions ?? [])]
    for (const question of zoneQuestions) {
      const target = resolveWriteTarget(question.writesTo)
      if (!target) continue
      const answerKey = answerKeyFor(question.id, bw.id, use)
      emitAnswer(ctx, question, answerKey, instanceStorageKey(target.key, bw.id, use), target, answers)
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
  definition: ProjectIntakeDefinition,
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
    ...Object.fromEntries(Object.entries(previous.assumptions).filter(([key]) => !isIntakeFact(key) && !isIntakeGoal(key))),
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
  definition: ProjectIntakeDefinition,
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
            const zoneQs = [...(stage.zoneCommon ?? []), ...(stage.zoneDefinitions?.[use]?.questions ?? [])]
            for (const q of zoneQs) {
              const target = resolveWriteTarget(q.writesTo)
              if (target) readInto(q, answerKeyFor(q.id, bw.id, use), instanceStorageKey(target.key, bw.id, use))
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

  return { answers, bauwerke }
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
    if (section !== 'goals' && parts.length === 4 && parts[3] === 'value' && parts[2] && parts[2] !== '-') {
      return decodeVocabSegment(parts[2])
    }
  }
  return null
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  const base = decodeVocabSegment(key).split('@')[0]
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => resolveWriteTarget(question.writesTo)?.key === base,
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
      if (typeof value !== 'string' || !question.options?.some((option) => option.value === value)) {
        throw new Error(`Invalid value for "${label}": ${shown} is not an allowed option.`)
      }
      return
    }
    case 'multi_select': {
      const allowed = new Set(question.options?.map((option) => option.value) ?? [])
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && allowed.has(item))) {
        throw new Error(`Invalid value for "${label}": ${shown} is not a subset of the allowed options.`)
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
  answer: ProjectPrimitiveValue | undefined,
): string {
  // yes_no_open facts persist as booleans; render them like a boolean here.
  if (question.type === 'boolean' || (question.type === 'yes_no_open' && typeof answer === 'boolean')) {
    return answer ? 'Ja' : answer === false ? 'Nein' : '—'
  }
  if (!isIntakeAnswerProvided(answer)) return '—'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if ((question.type === 'single_select' || question.type === 'yes_no_open') && typeof answer === 'string') {
    return optionLabel(answer)
  }
  if (question.type === 'number_tri' && typeof answer === 'number') {
    return question.unit ? `${answer} ${question.unit}` : String(answer)
  }
  return String(answer)
}
