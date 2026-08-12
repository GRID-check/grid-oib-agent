/** IFC/BIM model surfaces: the viewer, the model explorer, the viewer card. */
export const bim = {
  title: 'Model',
  subtitle:
    'The IFC models uploaded to this project. Everything shown here is read from the model itself — the assistant answers questions about the building from the same data.',
  tabs: {
    overview: 'Overview',
    compliance: 'Requirements',
    structure: 'Structure',
    quantities: 'Quantities',
    revisions: 'Revisions',
  },
  loadFailed: {
    title: 'Models could not be loaded',
    description:
      'This project\u2019s model list is temporarily unavailable. That does NOT mean there is no model \u2014 please try again.',
    action: 'Try again',
  },
  empty: {
    title: 'No IFC model yet',
    description:
      'Upload an .ifc file under Files. Grid reads its structure, makes the building queryable in chat, and shows it here in 3D.',
    action: 'Go to files',
  },
  status: {
    pending: 'Queued',
    extracting: 'Reading model…',
    ready: 'Ready',
    failed: 'Could not be read',
  },
  overview: {
    title: 'Model overview',
    project: 'Project',
    site: 'Site',
    building: 'Building',
    schema: 'IFC schema',
    author: 'Author',
    exportedWith: 'Exported with',
    exportedAt: 'Exported on',
    elements: 'Elements',
    spaces: 'Rooms',
    storeys: 'Storeys',
    netFloorArea: 'Net floor area',
    grossFloorArea: 'Gross floor area',
    netVolume: 'Net volume',
    lengthUnit: 'Length unit',
    truncated:
      'This model has more than {limit} elements. Totals are exact; the element list is capped.',
  },
  health: {
    title: 'Model check',
    score: 'Model quality {score}/100',
    clean: 'No findings. Every element is placed, identified and described.',
    affected: '{count} of {total}',
    affectedAbsolute: '{count}',
    severity: {
      error: 'Error',
      warning: 'Warning',
      info: 'Note',
    },
    stage: {
      schema: 'Schema',
      identity: 'Identity',
      spatial: 'Spatial structure',
      properties: 'Property sets',
      complete: 'Completeness',
    },
    rule: {
      'schema-unknown': 'The file declares no IFC schema version',
      'schema-legacy': 'IFC2X3 — superseded by IFC4; some properties cannot be expressed',
      'identity-missing-globalid': 'Elements without a GlobalId',
      'identity-duplicate-globalid': 'GlobalIds used more than once — elements are not unique',
      'identity-malformed-globalid': 'GlobalIds not in the 22-character IFC form',
      'spatial-no-storeys': 'The model contains no storeys',
      'spatial-orphan-elements': 'Elements in no storey — missing from every per-storey figure',
      'spatial-element-above-storey': 'Elements placed on the site or building instead of a storey',
      'spatial-space-without-storey': 'Rooms not assigned to a storey',
      'spatial-storey-without-elevation': 'Storeys without an elevation',
      'spatial-duplicate-storey-elevation': 'Several storeys at the same elevation',
      'properties-no-property-sets': 'Elements with no property set at all',
      'properties-missing-common-pset': 'Elements without their standard property set',
      'properties-vendor-sets-only': 'Only application-specific property sets — no Pset_/Qto_',
      'complete-unnamed-elements': 'Elements without a name',
      'complete-space-without-area': 'Rooms that publish no floor area — area totals are short',
      'complete-no-quantities': 'No element publishes quantities',
      'complete-no-materials': 'Load-bearing elements without a material',
      'complete-no-classifications': 'No element carries a classification',
    },
  },
  tree: {
    title: 'Spatial structure',
    allStoreys: 'All storeys',
    elements: '{count} elements',
  },
  elements: {
    title: 'Elements',
    search: 'Search by name…',
    allTypes: 'All types',
    columns: {
      type: 'Type',
      name: 'Name',
      storey: 'Storey',
      tag: 'Tag',
    },
    empty: 'No element matches this filter.',
    count: '{shown} of {total} elements',
    unnamed: '(unnamed)',
  },
  properties: {
    title: 'Properties',
    none: 'Select an element to see its properties.',
    identity: 'Identity',
    globalId: 'GlobalId',
    ifcType: 'IFC type',
    predefinedType: 'Predefined type',
    objectType: 'Object type',
    typeName: 'Type',
    tag: 'Tag',
    storey: 'Storey',
    materials: 'Materials',
    classifications: 'Classifications',
    quantities: 'Quantities',
    ask: 'Ask the assistant',
    loadFailed: 'The element could not be loaded.',
  },
  compare: {
    title: 'Compare revisions',
    description:
      'Matched by IFC GlobalId, so a re-export that renumbers everything still reports no change.',
    against: 'Compare against',
    none: 'Upload a second revision to compare.',
    run: 'Compare',
    running: 'Comparing…',
    failed: 'The comparison could not be run.',
    added: 'Added',
    removed: 'Removed',
    changed: 'Changed',
    unchanged: 'Unchanged',
    more: '… {count} more',
    truncated: 'At least one revision is capped — the comparison may be incomplete.',
    empty: 'No differences between these two revisions.',
  },
  compliance: {
    title: 'Requirement check',
    description:
      "Runs the OIB rule catalogue against the values the model publishes. Orientation, not a Nachweis: nothing here reads geometry, so escape-route lengths, guardrail heights and fire-compartment sizes are not checked at all.",
    failed: 'The requirement check could not be run.',
    truncatedModel:
      'This model is too large to check in full — the catalogue saw only part of it. Every count below is a count over that part, not over the building.',
    disclaimer:
      'Orientierende Prüfung — no legal advice and no Nachweis. “Not decidable” means the model does not publish the value, not that the building fails.',
    counts: '{passed} met · {failed} not met · {undecidable} not decidable',
    notApplicable: 'Not applicable',
    noElements: 'No affected elements in this model.',
    failures: 'Not met:',
    unknowns: 'Not decidable:',
    showInModel: 'show in model',
    more: '{count} more',
    truncated: 'Further elements are affected — see the counts above.',
    missingFacts:
      'Some rules depend on project data this brief does not carry: {facts}. Those rules stood down rather than guessing.',
    setFacts: 'Set it with the assistant',
    badge: {
      passing: 'Met',
      failing: 'Not met',
      undecidable: 'Not decidable',
      notApplicable: 'Not applicable',
      noElements: 'No elements',
    },
    confirmed: {
      by: 'Confirmed by {who} on {when}',
      stale: 'Older revision',
      staleHint:
        'This confirmation was made against an earlier revision of the model. It still counts as a record, but no longer as cover for the current one.',
      failed: 'The confirmation could not be saved. It is NOT recorded \u2014 please try again.',
      confirm: 'Confirm manually',
      reconfirm: 'Confirm again for this revision',
      withdraw: 'Withdraw',
      save: 'Save confirmation',
      cancel: 'Cancel',
      noteLabel: 'Why this is settled',
      notePlaceholder: 'e.g. checked against the plan, agreed with the fire-safety consultant …',
    },
    card: {
      export: 'Open items as BCF',
      unresolved: '{count} of the requested rule ids are not in the catalogue.',
      none: 'None of the requested requirements are in the catalogue.',
    },
    shoppingList: {
      title: 'What the model is missing',
      description:
        'Add these in your CAD and the requirements above become decidable. This is the list, not a score.',
      count: 'on {count} elements',
    },
    export: {
      action: '{count} open items as BCF',
      hint: 'BCF 2.1 — opens in ArchiCAD, Revit, Solibri or BIMcollab as a task list and selects the affected elements in the model. Requirements you have confirmed arrive marked done.',
    },
  },
  complianceDiff: {
    title: 'What this revision changed',
    description:
      'Runs the requirement check on both revisions and lists only what changed, against {previous}.',
    run: 'Compare requirement status',
    running: 'Comparing…',
    failed: 'The comparison could not be run.',
    unchanged: 'No requirement changed its status between these two revisions.',
    truncated:
      'At least one revision was read only in part, so this comparison covers part of each building — an unchanged status here does not mean nothing changed.',
    counts:
      '{beforePassed}/{beforeFailed}/{beforeUndecidable} → {afterPassed}/{afterFailed}/{afterUndecidable} met/not met/not decidable',
    trend: {
      broken: 'newly not met',
      undecidable: 'no longer decidable',
      moved: 'still not met, different count',
      decidable: 'now decidable and met',
      resolved: 'now met',
    },
  },
  schedule: {
    storeyElided: '{count} more rooms on this storey',
    truncated:
      'This model was read only in part, so the totals below cover the rooms that were stored, not the building.',
    title: 'Room schedule',
    download: 'CSV',
    room: 'Room',
    netArea: 'Net area',
    volume: 'Volume',
    storeyTotal: 'Storey total',
    total: 'Total',
    missing: 'Rooms with no published area: {count} — not included in these totals.',
    storeyMissing: '{count} without area',
    expand: 'Show {count} more rooms',
    collapse: 'Show fewer',
    empty: 'This model contains no rooms (IfcSpace).',
    failed: 'The room schedule could not be loaded.',
  },
  takeoff: {
    showAll: 'Show {count} more groups',
    title: 'Quantity take-off',
    description:
      "Sums the model's own published quantities per element type. Elements that publish nothing are counted separately — a total over an incomplete set is not a total.",
    quantity: 'Quantity',
    byMaterial: 'Split by material',
    group: 'Type',
    elements: 'Elements',
    missing: 'Elements with no published value for this quantity: {count}.',
    rowMissing: '({count} without value)',
    empty: 'No element carries this quantity.',
    failed: 'The take-off could not be computed.',
  },
  profile: {
    title: 'Project data from the model',
    description:
      'Derived from storey elevations and the room mix. Proposals, not measurements — the assistant applies them to the project brief only after you confirm.',
    ask: 'Apply via the assistant',
    empty: 'This model supports no project data.',
    failed: 'The project data could not be derived.',
    key: {
      geschosse_oberirdisch: 'Storeys above ground',
      geschosse_unterirdisch: 'Storeys below ground',
      fluchtniveau: 'Escape level',
      hauptnutzung: 'Main use',
      anzahl_einheiten: 'Units',
    },
    confidence: {
      high: 'High confidence',
      medium: 'Medium confidence',
      low: 'Low confidence',
    },
  },
  timeline: {
    title: 'Revisions',
    description: '{count} revisions of {name}, newest first.',
    revision: 'Upload {index}',
    latest: 'Current',
    compare: 'Compare with {previous}',
    noDelta: 'No comparable figures for this revision.',
    delta: {
      elements: 'Elements',
      spaces: 'Rooms',
      storeys: 'Storeys',
      netFloorArea: 'Net floor area',
      health: 'Model quality',
    },
  },
  element: {
    notFound: 'This element is not in the model.',
  },
  link: {
    copy: 'Copy view link',
    copied: 'Copied',
    failed: 'The link could not be copied',
  },
  /**
   * The full-screen viewer inside Dateien.
   *
   * Six controls and two lists. Every string here is written for someone who
   * has never opened a BIM tool: "See through", not "X-ray context"; "Levels",
   * not "IfcBuildingStorey"; "Show everything", not "Zoom extents".
   */
  stage: {
    dialogLabel: 'Model {name}',
    close: 'Close',
    home: 'Fit the whole model',
    views: 'View',
    advanced: 'Details & checks',
    models: 'Models',
    levels: 'Levels',
    allLevels: 'All levels',
    highlightCapped:
      'A link can carry {shown} of the {total} highlighted elements. The rest are in the model but not marked here.',
    otherModel:
      'This link names “{wanted}”, which is not in this project. Showing “{opened}” instead.',
    showEverything: 'Restore hidden components',
    elevation: '{value} m',
    notReady: 'The model is still being read. This usually takes a few moments.',
    loading: 'Loading model…',
    building: 'Putting the building together…',
    ready: 'The model is on screen',
    rail: {
      show: 'Show panel',
      hide: 'Hide panel',
    },
    selection: {
      close: 'Close',
      loading: 'Loading…',
      about: 'Component',
      hide: 'Hide',
      isolate: 'Isolate',
      technical: 'Technical details',
      ask: 'Ask Piloti about this',
    },
  },
  viewer: {
    canvasLabel: '3D view of the IFC model',
    keyboardHint:
      'Arrow keys orbit, Shift with an arrow pans, plus and minus zoom, F fits the model. While measuring, Enter places a point and Escape cancels. Every element is also listed as text under Details.',
    title: '3D view',
    xray: 'See through',
    view: {
      iso: 'Free',
      top: 'Plan',
      north: 'North',
      south: 'South',
      east: 'East',
      west: 'West',
    },
    projection: {
      parallel: 'Parallel',
      perspective: 'Perspective',
    },
    /** Capturing the view as an image someone will keep. */
    capture: {
      action: 'Save image',
      failed: 'The image could not be captured',
    },
    section: {
      toggle: 'Section',
      height: 'Cut at',
      metres: '{value} m',
      down: 'Looking down',
      up: 'Looking up',
    },
    /**
     * Measuring. `hint` sits in the dock while the tool is live — a measure
     * tool that does not say where the next click goes is a crosshair you have
     * to experiment with.
     */
    measure: {
      toggle: 'Measure',
      horizontal: 'horizontal',
      vertical: 'vertical',
      first: 'Click the first point',
      second: 'Click the second point — Esc cancels',
      clear: 'Clear measurements',
      count: '{count} measurements',
      countOne: '1 measurement',
    },
    unavailable: {
      title: 'The 3D view could not be loaded',
      description:
        'Only the picture is missing — the model is unaffected, and everything read from it is unchanged. A browser whose GPU is blocked, a remote desktop session, or an interrupted download all end here.',
      reason: 'Reason: {message}',
    },
    unsupported: {
      title: '3D view not available in this browser',
      description:
        'The viewer needs WebGPU, which this browser does not provide. The model itself is fine — the assistant can still answer questions about it, and Chrome, Edge or a current Safari will show it.',
    },
  },
  /** The model's own facts, in the file preview's metadata rail. */
  facts: {
    title: 'From the model',
    caption: 'Read from the IFC when it was indexed. An unpublished quantity is left out rather than shown as zero.',
  },
  /**
   * The model as a FILE — what the Dateien preview says while the building is
   * not (yet) showable. Each state is its own sentence: "still being read",
   * "could not be read" and "there is no model" are different answers, and a
   * single "no preview" would hide which one the reader is looking at.
   */
  preview: {
    loading: 'Loading model…',
    extracting: 'Grid is still reading this model. The building appears here as soon as that finishes.',
    extractionFailed:
      'This model could not be read. The file itself is unchanged and can still be downloaded.',
    noModel: 'No model has been read from this file.',
    loadFailed:
      'The models for this project are temporarily unavailable. That does NOT mean this file has no model.',
    noWebGpu:
      'The 3D view needs WebGPU, which this browser does not provide. Everything read from the model — structure, elements, properties and quantities — is available in the model workspace.',
    open: 'Open in model workspace',
  },
  card: {
    openModel: 'Open model',
    openElement: 'Open element {name} in the model',
    openStorey: 'Open storey {name} in the model',
    unresolved: '{count} of the highlighted elements are not in this model.',
    noModel: 'The referenced model is not available in this project.',
    highlights: 'Highlighted',
  },
}
