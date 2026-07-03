export type ProjectIntakeQuestionType = 'single_select' | 'multi_select' | 'boolean' | 'number' | 'text'

export interface ProjectIntakeOption {
  value: string
  label: string
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  type: ProjectIntakeQuestionType
  options?: ProjectIntakeOption[]
  condition?: { field: string; equals?: string; oneOf?: string[] }
  writesTo?: string
}

export interface ProjectIntakeStage {
  id: string
  title: string
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}

export const v1IntakeDefinition: ProjectIntakeDefinition = {
  version: 1,
  stages: [
    {
      id: 'core',
      title: 'Project Core Information',
      questions: [
        {
          id: 'project_name',
          label: 'Project Name',
          type: 'text',
          writesTo: '/facts/project_name/value',
        },
        {
          id: 'hauptnutzung',
          label: 'Main Use',
          type: 'single_select',
          options: [
            { value: 'wohnen', label: 'Wohnen' },
            { value: 'buero', label: 'Büro' },
            { value: 'beherbergung', label: 'Beherbergung' },
            { value: 'versammlung', label: 'Versammlung' },
            { value: 'gesundheit', label: 'Gesundheit' },
            { value: 'landwirtschaft', label: 'Landwirtschaft' },
            { value: 'produzierend', label: 'Produzierend' },
            { value: 'lager', label: 'Lager' },
            { value: 'sonstiges', label: 'Sonstiges' },
          ],
          writesTo: '/facts/hauptnutzung/value',
        },
        {
          id: 'anzahl_betten',
          label: 'Number of Beds',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'beherbergung' },
          writesTo: '/facts/anzahl_betten/value',
        },
        {
          id: 'anzahl_einheiten',
          label: 'Number of Units',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'wohnen' },
          writesTo: '/facts/anzahl_einheiten/value',
        },
        {
          id: 'sicherheitskategorie',
          label: 'Safety Category',
          type: 'single_select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          condition: { field: 'hauptnutzung', oneOf: ['beherbergung', 'gesundheit'] },
          writesTo: '/facts/sicherheitskategorie/value',
        },
      ],
    },
    {
      id: 'classification',
      title: 'Classification',
      questions: [
        {
          id: 'widmung',
          label: 'Zoning',
          type: 'single_select',
          options: [
            { value: 'bauland', label: 'Bauland' },
            { value: 'verkehrsflaeche', label: 'Verkehrsfläche' },
            { value: 'freiland', label: 'Freiland' },
            { value: 'kerngebiet', label: 'Kerngebiet' },
            { value: 'gemischt', label: 'Gemischt' },
          ],
          writesTo: '/facts/widmung/value',
        },
        {
          id: 'gebaeudeklasse',
          label: 'Building Class',
          type: 'single_select',
          options: [
            { value: 'GK1', label: 'GK1' },
            { value: 'GK2', label: 'GK2' },
            { value: 'GK3', label: 'GK3' },
            { value: 'GK4', label: 'GK4' },
            { value: 'GK5', label: 'GK5' },
          ],
          writesTo: '/facts/gebaeudeklasse/value',
        },
        {
          id: 'bauweise',
          label: 'Construction Method',
          type: 'single_select',
          options: [
            { value: 'offen', label: 'Offen' },
            { value: 'gekuppelt', label: 'Gekuppelt' },
            { value: 'geschlossen', label: 'Geschlossen' },
          ],
          writesTo: '/facts/bauweise/value',
        },
        {
          id: 'hohe_gebaeude_details',
          label: 'High Building Details',
          type: 'text',
          condition: { field: 'gebaeudeklasse', oneOf: ['GK4', 'GK5'] },
          writesTo: '/facts/hohe_gebaeude_details/value',
        },
      ],
    },
    {
      id: 'building',
      title: 'Building Details',
      questions: [
        {
          id: 'geschosse_oberirdisch',
          label: 'Above-ground Floors',
          type: 'number',
          writesTo: '/facts/geschosse_oberirdisch/value',
        },
        {
          id: 'geschosse_unterirdisch',
          label: 'Below-ground Floors',
          type: 'number',
          writesTo: '/facts/geschosse_unterirdisch/value',
        },
        {
          id: 'fluchtniveau',
          label: 'Escape Level',
          type: 'single_select',
          options: [
            { value: '<=7m', label: '≤ 7m' },
            { value: '7-11m', label: '7-11m' },
            { value: '11-22m', label: '11-22m' },
            { value: '>22m', label: '> 22m' },
          ],
          writesTo: '/facts/fluchtniveau/value',
        },
      ],
    },
    {
      id: 'regulatory',
      title: 'Regulatory Context',
      questions: [
        {
          id: 'grundgrenze',
          label: 'Ground Boundary',
          type: 'boolean',
          writesTo: '/facts/grundgrenze/value',
        },
        {
          id: 'fluchtlinie',
          label: 'Building Line',
          type: 'boolean',
          writesTo: '/facts/fluchtlinie/value',
        },
        {
          id: 'schutzzone',
          label: 'Protection Zone',
          type: 'boolean',
          writesTo: '/facts/schutzzone/value',
        },
        {
          id: 'abweichender_bebauungsplan',
          label: 'Deviating Development Plan',
          type: 'boolean',
          writesTo: '/facts/abweichender_bebauungsplan/value',
        },
        {
          id: 'bestand_neubau',
          label: 'Existing or New Building',
          type: 'single_select',
          options: [
            { value: 'bestand', label: 'Bestand' },
            { value: 'neubau', label: 'Neubau' },
            { value: 'zu_und_umbau', label: 'Zu- und Umbau' },
          ],
          writesTo: '/facts/bestand_neubau/value',
        },
        {
          id: 'bestandsalter',
          label: 'Existing Building Age',
          type: 'single_select',
          options: [
            { value: '<10', label: '< 10 Jahre' },
            { value: '10-30', label: '10-30 Jahre' },
            { value: '30-50', label: '30-50 Jahre' },
            { value: '>50', label: '> 50 Jahre' },
          ],
          condition: { field: 'bestand_neubau', equals: 'bestand' },
          writesTo: '/facts/bestandsalter/value',
        },
      ],
    },
    {
      id: 'goals',
      title: 'Goals & Output',
      questions: [
        {
          id: 'primary_goal',
          label: 'Primary Goal',
          type: 'text',
          writesTo: '/goals/primary_goal',
        },
        {
          id: 'output_format',
          label: 'Output Format',
          type: 'single_select',
          options: [
            { value: 'design_constraints', label: 'Design Constraints' },
            { value: 'compliance_checklist', label: 'Compliance Checklist' },
            { value: 'full_report', label: 'Full Report' },
          ],
          writesTo: '/facts/output_format/value',
        },
      ],
    },
  ],
}

export const projectIntakeDefinitionV1 = v1IntakeDefinition
