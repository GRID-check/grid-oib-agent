-- „Nur diese": a plan can confine the reader's own documents to its Grundlage.
--
-- By default a deep research reads every document it can find, and the
-- Grundlage is its focus. With `nur_grundlage` the run may use, of the
-- project's, the Archiv's and the chat's documents, only the Grundlage; norms
-- and laws stay available (ADR-0065). The CHECK keeps the switch from ever
-- meaning "none of the reader's documents": a confinement to nothing is not
-- one a reader can ask for on the plan.

ALTER TABLE "research_plans" ADD COLUMN IF NOT EXISTS "nur_grundlage" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "research_plans" ADD CONSTRAINT "research_plans_nur_has_grundlage"
  CHECK (NOT "nur_grundlage" OR jsonb_array_length("grundlage") > 0);
