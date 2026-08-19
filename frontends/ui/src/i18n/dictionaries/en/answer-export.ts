/**
 * `answerExport` namespace — the chrome of an answer exported as a document.
 *
 * A .docx leaves the product. Nobody is around to explain it, so every word in
 * it that is not the answer itself has to be written down here rather than in
 * the renderer: the file an architect forwards to a Behörde must be in the
 * language they read the answer in, and a hardcoded German heading in a
 * document whose body is English is a defect the reader blames the answer for.
 *
 * `fields` is a FLAT map of the card payload's own field names (the Pydantic
 * models in `src/aiq_agent/cards/models.py`), deliberately not nested per card
 * type: the same names recur across the catalogue — `reference`, `status`,
 * `note`, `label` — and one entry per name is what keeps 27 card types from
 * needing 27 label tables that would then drift apart. A name that is missing
 * here degrades to a humanized form of the field name rather than to nothing,
 * so a card type added upstream still exports with its data intact.
 */
export const answerExport = {
  /** Heading of the whole document when the conversation carries no title. */
  documentTitle: 'Answer',
  /** File-name stem when the conversation carries no title. */
  fileName: 'answer',
  question: 'Question',
  answer: 'Answer',
  project: 'Project',
  createdAt: 'Created on',
  sources: 'Sources',
  findings: 'Findings',
  confidence: 'Confidence',
  /** Introduces the model's own one-clause justification, quoted verbatim. */
  confidenceReason: 'Assistant’s reason',
  confidenceLevels: {
    low: 'low',
    medium: 'medium',
    high: 'high',
  },
  /** Why the confidence was capped (`answerConfidenceCappedReason`). */
  confidenceCapped: {
    ungrounded: 'Capped: the answer is not backed by its sources.',
    quoteUnverified: 'Capped: a quote could not be verified verbatim against the source.',
  },
  /** Page locator in a reference-list entry. */
  page: 'p. {page}',
  /** A stored source that carries no title, file name or citation key. */
  untitledSource: 'Source without a title',
  /**
   * Stands in for a card whose content is fetched live from the project's IFC
   * model. Printed WITH the card's title, never instead of the card: a finding
   * missing from an exported file reads as a finding the answer never made.
   */
  liveCard:
    'This card reads the project’s model live — a document cannot carry the values it shows. Open the answer in Piloti to see them.',
  /** Heading for a card that carries no title of its own. */
  cardTypes: {
    summary: 'Summary',
    legal_basis: 'Legal basis',
    project_profile_patch: 'Proposed change to the project brief',
    memory_proposal: 'Proposed memory entry',
    requirement_checklist: 'Requirement checklist',
    comparison_table: 'Comparison',
    building_section: 'Building section',
    stair_diagram: 'Stair',
    dimension_diagram: 'Dimensions',
    setback_plan: 'Setbacks',
    egress_diagram: 'Escape route',
    daylight_incidence: 'Daylight',
    guardrail_check: 'Guardrail',
    density_check: 'Site density',
    fire_access_plan: 'Fire-brigade access',
    acoustic_check: 'Sound insulation',
    fire_compartment: 'Fire compartments',
    thermal_envelope: 'Thermal envelope',
    energy_performance: 'Energy performance',
    elevator_requirement: 'Elevator',
    parking_requirement: 'Parking provision',
    document_grid: 'Documents',
    verdict_header: 'Verdict',
    condition_tree: 'Decision tree',
    typed_table: 'Table',
    norm_chain: 'Chain of norms',
    key_takeaways: 'Key takeaways',
    callout: 'Note',
    calculation: 'Calculation',
    process_map: 'Procedure',
    document_checklist: 'Required documents',
    deadline_timeline: 'Deadlines',
    change_impact: 'Impact of the change',
    ifc_viewer: 'Model view',
    ifc_compliance: 'Model compliance',
    ifc_schedule: 'Room schedule',
    ifc_element: 'Model element',
    ifc_diff: 'Model changes',
  },
  /** `DimStatus` — the verdict on one checked value. */
  status: {
    pass: 'Meets requirement',
    fail: 'Does not meet requirement',
    warning: 'Check',
    needs_input: 'Input required',
  },
  /** `Provenance` — who is making the claim about a measured value. */
  provenance: {
    declared: 'per model',
    computed: 'measured',
    inferred: 'presumed',
  },
  /** Yes/no for the boolean fields a card carries. */
  boolean: {
    true: 'Yes',
    false: 'No',
  },
  fields: {
    // Shared across most cards
    title: 'Title',
    note: 'Note',
    reference: 'Source',
    label: 'Item',
    status: 'Verdict',
    detail: 'Detail',
    summary: 'Summary',
    content: 'Content',
    kind: 'Type',
    confidence: 'Confidence',
    query: 'Search term',
    // DimensionCheck
    value: 'Actual',
    required: 'Required',
    unit: 'Unit',
    comparator: 'Relation',
    provenance: 'Origin of the value',
    tolerance: 'Tolerance',
    missing: 'What is missing',
    // NormReference
    document: 'Regulation',
    section: 'Clause',
    edition: 'Edition',
    excerpt: 'Quotation',
    // SummaryCard
    key_points: 'Key points',
    // LegalBasisCard
    law: 'Law / directive',
    article: 'Article',
    original_text: 'Original wording',
    /** Which tier of Baurecht the citation is (OIB directive vs RIS statute). */
    lane: 'Source of law',
    // RequirementChecklistCard
    items: 'Requirements',
    // ComparisonTableCard
    options: 'Options',
    rows: 'Criteria',
    values: 'Values',
    highlight_index: 'Favoured option',
    recommendation: 'Recommendation',
    // ProjectProfilePatchCard
    rationale: 'Reason',
    patch: 'Changes',
    preview: 'Preview',
    op: 'Operation',
    path: 'Field',
    // BuildingSectionCard
    storeys: 'Storeys',
    markers: 'Reference lines',
    height_m: 'Height (m)',
    below_grade: 'Below grade',
    // StairDiagramCard
    riser_count: 'Number of steps',
    riser_height: 'Riser',
    tread_depth: 'Going',
    width: 'Width',
    comfort_note: 'Comfort rule',
    // DimensionDiagramCard
    shape: 'Element',
    dimensions: 'Dimensions',
    // SetbackPlanCard
    parcel_width_m: 'Parcel width (m)',
    parcel_depth_m: 'Parcel depth (m)',
    building_width_m: 'Building width (m)',
    building_depth_m: 'Building depth (m)',
    sides: 'Sides',
    side: 'Edge',
    required_m: 'Required (m)',
    actual_m: 'Actual (m)',
    // EgressDiagramCard
    segments: 'Path segments',
    total_length: 'Total length',
    start_label: 'Start',
    exit_label: 'Exit',
    length_m: 'Length (m)',
    turn: 'Turn',
    // DaylightIncidenceCard
    glass_area: 'Glazed area',
    obstruction: 'Obstruction',
    room_floor_area_m2: 'Room floor area (m²)',
    window_head_height_m: 'Window head height (m)',
    window_sill_height_m: 'Sill height (m)',
    distance_m: 'Distance (m)',
    // GuardrailCheckCard
    context: 'Location',
    fall_height: 'Fall height',
    rail_height: 'Railing height',
    max_opening: 'Largest opening',
    bottom_gap: 'Gap at the base',
    has_horizontal_elements_in_climb_zone: 'Climbable horizontals',
    // DensityCheckCard
    coverage: 'Site coverage',
    density: 'Floor-area ratio',
    parcel_area_m2: 'Parcel area (m²)',
    footprint_area_m2: 'Built area (m²)',
    gross_floor_area_m2: 'Gross floor area (m²)',
    // FireAccessPlanCard
    route_width: 'Access-route width',
    walk_distance_to_entrance: 'Reach to the entrance',
    gate_clearance_height: 'Gateway clear height',
    aufstellflaeche: 'Standing area',
    gebaeudeklasse: 'Building class',
    // AcousticCheckCard
    checks: 'Checks',
    check: 'Check',
    metric: 'Metric',
    path_label: 'Separated parts',
    sound_class: 'Sound class',
    // FireCompartmentCard
    compartments: 'Compartments',
    storey_label: 'Storey',
    area: 'Area',
    use: 'Use',
    // ThermalEnvelopeCard
    components: 'Components',
    u_value: 'U-value',
    // EnergyPerformanceCard
    hwb: 'Heating demand',
    fgee: 'Overall energy-efficiency factor',
    energy_class: 'Energy class',
    // ElevatorRequirementCard
    storeys_served: 'Levels served',
    entrance_level_index: 'Entrance level',
    is_required: 'Required',
    requirement_note: 'Why',
    cabin_width: 'Cabin width',
    cabin_depth: 'Cabin depth',
    door_width: 'Clear door width',
    // ParkingRequirementCard
    car_spaces: 'Car parking spaces',
    bicycle_spaces: 'Bicycle spaces',
    basis: 'Basis',
    // DocumentGridCard
    documents: 'Documents',
    file_name: 'File',
    snippet: 'Matching passage',
    page: 'Page',
    /** Which corpus the hit came from — the project's files or the Büroarchiv. */
    source: 'Origin',
    score: 'Relevance',
    // VerdictHeaderCard
    subject: 'Subject',
    verdict: 'Verdict',
    confidence_reason: 'Reason for the confidence',
    // ConditionTreeCard — `question` is the FACTOR the answer forks on
    // ("Gebäudeklasse"), not a question the reader is being asked.
    question: 'Depends on',
    branches: 'Cases',
    condition: 'Condition',
    outcome: 'Outcome',
    active: 'Applies here',
    // TypedTableCard
    columns: 'Columns',
    // NormChainCard
    links: 'Chain of norms',
    rank: 'Rank',
    // KeyTakeawaysCard, CalloutCard
    text: 'Statement',
    // CalculationCard
    steps: 'Steps',
    limit: 'Limit',
    upper: 'Upper bound',
    operands: 'Operands',
    operation: 'Operation',
    /** A multiplier on an operand; on `change_impact`, the one fact that moves. */
    factor: 'Factor',
    /** An operand that is an earlier step's result rather than a figure. */
    step: 'From step',
    // ProcessMapCard
    current_step: 'Stage reached',
    actor: 'Responsible',
    duration: 'Time limit',
    requires: 'Prerequisites',
    produces: 'Result',
    // DocumentChecklistCard
    issuer: 'Issued by',
    requirement: 'Requirement',
    // DeadlineTimelineCard
    deadlines: 'Deadlines',
    period: 'Period',
    starts_from: 'Clock starts',
    consequence: 'If missed',
    // ChangeImpactCard
    consequences: 'Consequences',
    aspect: 'Affects',
    before: 'Before',
    after: 'After',
    direction: 'Effect',
    from_value: 'Value before',
    to_value: 'Value after',
    // AufstellflaechePlan
    length: 'Length',
    distance_to_facade: 'Distance to the facade',
  },
}
