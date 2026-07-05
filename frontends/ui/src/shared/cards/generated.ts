// AUTO-GENERATED from shared/cards/schemas.json — do not edit; run `npm run generate:cards`

import { z } from 'zod'

export const summaryCardSchema = z.object({ "content": z.union([z.string(), z.null()]).describe("One-paragraph summary").default(null), "key_points": z.union([z.array(z.string()), z.null()]).describe("Bullet points highlighting key facts").default(null), "title": z.string().min(1).describe("Short title for the summary card"), "type": z.literal("summary") }).describe("A concise overview of the answer for the user.")

export const legalBasisCardSchema = z.object({ "article": z.union([z.string(), z.null()]).describe("Relevant article or paragraph number").default(null), "law": z.string().min(1).describe("Name of the law, regulation, or OIB Richtlinie"), "original_text": z.union([z.string(), z.null()]).describe("Literal excerpt from the source, if available").default(null), "section": z.union([z.string(), z.null()]).describe("Relevant section or chapter").default(null), "summary": z.union([z.string(), z.null()]).describe("Plain-language summary of the legal relevance").default(null), "type": z.literal("legal_basis") }).describe("A legal norm, regulation, or OIB Richtlinie that grounds the answer.")

export const projectProfilePatchCardSchema = z.object({ "patch": z.array(z.any()), "preview": z.array(z.any()), "rationale": z.string(), "title": z.string(), "type": z.literal("project_profile_patch").default("project_profile_patch") }).describe("A reviewable patch (add/replace/remove) against a project profile.")

export const buildingSectionCardSchema = z.object({ "markers": z.union([z.array(z.any()), z.null()]).describe("Reference lines: Fluchtniveau, GK/Hochhaus").default(null), "note": z.union([z.string(), z.null()]).describe("Optional clarification").default(null), "reference": z.any().describe("Source of the threshold heights"), "storeys": z.array(z.any()).describe("Storeys bottom-to-top; basements flagged below_grade"), "title": z.string().min(1).describe("Title, e.g. 'Gebäudeschnitt – Höhenprüfung'"), "type": z.literal("building_section") }).describe("A to-scale building cross-section (schematic) drawn from storey heights.\n\nEmit for height/Gebäudeklasse/Fluchtniveau questions where seeing the\nbuilding against threshold lines helps (e.g. 'liege ich unter der GK4-Grenze?\nFluchtniveau bei 9,8 m'). Draws stacked storeys, the ground line, and dashed\nmarker lines (Fluchtniveau, GK/Hochhaus limits) with labels.")

export const stairDiagramCardSchema = z.object({ "comfort_note": z.union([z.string(), z.null()]).describe("Result of the 2×Steigung + Auftritt comfort check").default(null), "reference": z.any().describe("Source of the step-geometry limits"), "riser_count": z.number().int().gt(0).describe("Number of steps in the flight (drawn)"), "riser_height": z.any().describe("Steigung (rise) per step; typical limit <= 18 cm"), "title": z.string().min(1).describe("Title, e.g. 'Treppenlauf – Steigungsverhältnis'"), "tread_depth": z.any().describe("Auftritt (going) per step; typical limit >= 28 cm"), "type": z.literal("stair_diagram"), "width": z.any().describe("Nutzbare Laufbreite; limit depends on Gebäudeklasse") }).describe("A staircase drawn to scale (schematic section) with step-geometry checks.\n\nEmit for stair questions (e.g. 'passt eine Treppe mit 17 Stufen, 18 cm\nSteigung, 27 cm Auftritt, 100 cm breit?'). Draws the step profile to scale\nand checks riser/going/width and the comfort rule (2×Steigung + Auftritt ≈\n59–65 cm) against OIB 4.")

export const dimensionDiagramCardSchema = z.object({ "dimensions": z.array(z.any()).describe("The measured dimensions to annotate on the schematic"), "note": z.union([z.string(), z.null()]).describe("Optional clarification").default(null), "reference": z.any().describe("Source of the dimension limits (e.g. OIB 4 / ÖNORM B 1600)"), "shape": z.enum(["door","ramp","corridor","turning_circle","threshold","parking_space"]).describe("Which schematic template to draw"), "title": z.string().min(1).describe("Title, e.g. 'Rampe – Neigung & Breite'"), "type": z.literal("dimension_diagram") }).describe("A parametric accessibility/geometry schematic with dimension arrows.\n\nEmit for clearance questions (door width, ramp gradient, turning circle,\ncorridor width, threshold). The renderer picks a prebuilt template for\n`shape` and draws each dimension arrow where it is measured, coloured by\nstatus — preventing the Stocklichte-vs-Durchgangslichte misread.")

export const setbackPlanCardSchema = z.object({ "building_depth_m": z.number().gt(0).describe("Building footprint depth in metres"), "building_width_m": z.number().gt(0).describe("Building footprint width in metres"), "parcel_depth_m": z.number().gt(0).describe("Parcel depth in metres (drawn to scale)"), "parcel_width_m": z.number().gt(0).describe("Parcel width in metres (drawn to scale)"), "reference": z.any().describe("Source of the setback requirements"), "sides": z.array(z.any()).describe("Required/actual distance per parcel edge"), "title": z.string().min(1).describe("Title, e.g. 'Abstandsflächen – Lageplan'"), "type": z.literal("setback_plan") }).describe("A top-down site plan (schematic): parcel, footprint, and setback envelopes.\n\nEmit for Abstandsflächen/Bauwich questions ('hält das Gebäude die Abstände\nein?'). Draws the parcel, the required-setback envelope, and the building\nfootprint, with a distance arrow per side coloured by status.")

export const egressDiagramCardSchema = z.object({ "exit_label": z.union([z.string(), z.null()]).describe("Label for the path end/exit").default("Treppenhaus"), "reference": z.any().describe("Source of the escape-length limit (OIB 2)"), "segments": z.array(z.any()).describe("Path runs from the worst-case point to the exit, in order"), "start_label": z.union([z.string(), z.null()]).describe("Label for the path start").default("ungünstigster Punkt"), "title": z.string().min(1).describe("Title, e.g. 'Fluchtweg – Gehweglänge'"), "total_length": z.any().describe("Sum of segment lengths vs the OIB limit (e.g. <= 40 m)"), "type": z.literal("egress_diagram") }).describe("A schematic escape-route (Fluchtweg) path with the total length checked.\n\nEmit for escape-route-length questions ('ist der Fluchtweg mit 12 m + 26 m\nzulässig?'). Draws the path segment-by-segment from the worst-case point to\nthe exit and checks the total against the OIB 2 limit (typically 40 m).")

export const dimensionCheckSchema = z.object({ "comparator": z.union([z.enum(["<=",">="]), z.null()]).describe("How actual must relate to required").default(null), "label": z.string().min(1).describe("What is measured, e.g. 'lichte Durchgangsbreite'"), "required": z.union([z.number(), z.null()]).describe("OIB limit for this dimension").default(null), "status": z.enum(["pass","fail","warning","needs_input"]).describe("Verdict for this dimension"), "unit": z.string().describe("Unit for both value and required, e.g. 'cm', 'm', '%'").default("cm"), "value": z.union([z.number(), z.null()]).describe("Actual measurement (drawn); null if unknown").default(null) }).describe("One measured dimension drawn on a schematic and checked against a limit.\n\n`value` is the project's actual measurement (drawn to scale); `required` is\nthe OIB limit. If `value` is unknown, leave it null and set status\n'needs_input'.")

export const egressSegmentSchema = z.object({ "label": z.string().min(1).describe("Segment label, e.g. 'Raum → Gang', 'Gang → Treppenhaus'"), "length_m": z.number().gt(0).describe("Run length in metres (drawn to scale)"), "turn": z.enum(["straight","left","right"]).describe("Turn AFTER this run").default("straight") }).describe("One straight run of an escape path, drawn end-to-end with the next.")

export const normReferenceSchema = z.object({ "document": z.string().min(1).describe("Regulation name, e.g. 'OIB-Richtlinie 2', 'ÖNORM B 1600'"), "edition": z.union([z.string(), z.null()]).describe("Edition/year, e.g. 'Ausgabe Mai 2023'").default(null), "excerpt": z.union([z.string(), z.null()]).describe("Literal quoted sentence grounding the value (<= ~200 chars)").default(null), "section": z.union([z.string(), z.null()]).describe("Clause/table, e.g. 'Pkt. 5.1.1', 'Tabelle 1b'").default(null) }).describe("A verifiable pointer into a regulation (the atom of grounding).\n\nEvery required value MUST carry one so the architect can verify it against\nthe source. Never fabricate a reference.")

export const projectProfilePatchOperationSchema = z.object({ "op": z.enum(["add","replace","remove"]), "path": z.string(), "value": z.any().default(null) }).describe("A JSON Patch operation targeting a project profile section.")

export const projectProfilePatchPreviewItemSchema = z.object({ "after": z.string(), "before": z.string(), "label": z.string() }).describe("A before/after preview for a single patched field.")

export const sectionMarkerSchema = z.object({ "height_m": z.number().describe("Height above ground datum in metres"), "kind": z.enum(["fluchtniveau","threshold","reference"]).describe("Styling role").default("reference"), "label": z.string().min(1).describe("What the line marks, e.g. 'Fluchtniveau', 'GK4-Grenze'") }).describe("A horizontal reference line at a given height in the section.")

export const sectionStoreySchema = z.object({ "below_grade": z.boolean().describe("True for basements/underground storeys").default(false), "height_m": z.number().gt(0).describe("Clear storey height in metres (drawn to scale)"), "label": z.string().min(1).describe("Storey label, e.g. 'EG', '1.OG', 'KG'") }).describe("One storey in a building cross-section, drawn as a band to scale.")

export const setbackSideSchema = z.object({ "actual_m": z.union([z.number(), z.null()]).describe("Actual distance in metres; null if unknown").default(null), "required_m": z.number().describe("Required setback in metres (OIB/Bauordnung)"), "side": z.enum(["front","back","left","right"]).describe("Which edge"), "status": z.enum(["pass","fail","warning","needs_input"]).describe("Verdict for this side") }).describe("A required distance from the building footprint to one parcel edge.")

export const gridCardSchema = z.discriminatedUnion('type', [
  summaryCardSchema,
  legalBasisCardSchema,
  projectProfilePatchCardSchema,
  buildingSectionCardSchema,
  stairDiagramCardSchema,
  dimensionDiagramCardSchema,
  setbackPlanCardSchema,
  egressDiagramCardSchema,
  dimensionCheckSchema,
  egressSegmentSchema,
  normReferenceSchema,
  projectProfilePatchOperationSchema,
  projectProfilePatchPreviewItemSchema,
  sectionMarkerSchema,
  sectionStoreySchema,
  setbackSideSchema,
])
