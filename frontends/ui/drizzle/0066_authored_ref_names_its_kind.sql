-- The identifier a machine-authored row carries now says WHAT KIND it is.
--
-- ## What was wrong
--
-- 0063 created `authored_by_run_id` and documented it, in the column comment and
-- in the schema file, as "the backend async job id of the run". For the first
-- producer that was true. It stopped being true the moment there were three:
--
--   | producer       | what `authored_by_run_id` actually held                  |
--   |----------------|----------------------------------------------------------|
--   | deep_research  | a backend async job id (the `aiq_api` job store)          |
--   | diagram_svg    | `{chat message id}-{hash of the diagram source}`          |
--   | diagram_pdf    | `{chat message id}-{hash of the diagram source}`          |
--
-- The second and third are not job ids and never were: `diagramRunId()` in the
-- browser builds them from the answer the diagram was drawn in plus an FNV-1a
-- of the source, so that one message holding two diagrams files two documents.
-- That is a perfectly good identity. It is simply not the identity the column
-- says it holds, and nothing in the row said so.
--
-- ## Why this is worse than an inaccurate comment
--
-- The value feeds a REGISTERED AUDIT TARGET. `fileGeneratedDocument` emits
-- `document.generated` with an agent actor, and `lib/audit/service.ts` appends
-- the second target `{type: 'agent_run', id: <this column>}` for every such
-- event — a target type that WorkOS validates against `schemas.mjs`. So for two
-- of three producers the trail asserted, in a structured field an auditor
-- filters on, that a string which is not a job id is a job id. An auditor
-- resolving it looks up a run that does not exist and gets nothing back: a
-- silent dead end in the one record that answers "what wrote this document, in
-- which run, on whose authority".
--
-- 0063 has a name for a row like that. It says a machine-written document
-- nobody can trace back is "an audit trail in appearance only", and that
-- appearing to have one is worse than having none. A row that names an
-- identifier without naming what the identifier IS cannot be resolved, so it is
-- the same failure one level down — and it was introduced by the change that
-- added the second producer, not by 0063.
--
-- ## The shape: a value and its kind, not a second slot
--
--   `authored_by_run_id` → `authored_by_ref`   (renamed; same data, honest name)
--   `authored_by_ref_kind`                     (new; `agent_run`, `answer_artifact`)
--
-- The kind is a growable TUPLE in TypeScript with no CHECK on its value in the
-- database, which is the arrangement `authored_by` and `scope` already have and
-- for the same stated reason: the next kind of reference is an entry in a tuple
-- and a compile error at every exhaustive switch, not a migration held after
-- production rows exist.
--
-- It is also DERIVED, not passed in. `GENERATED_DOCUMENT_PRODUCER_REF_KINDS` in
-- `lib/documents/generated.ts` maps each producer to the kind it files under, so
-- the one filing path reads the kind off the producer and no call site can state
-- one. A producer is a KIND OF DELIVERABLE (0063's words), and the kind of
-- identity a deliverable is filed under is a property of the deliverable, not a
-- choice its caller re-makes each time. That is what stops the two columns from
-- disagreeing the way the column and its comment did.
--
-- ## Alternatives rejected, and why
--
-- **A second column `authored_by_source_ref`, with a CHECK that exactly one of
-- the two is non-null.** This was the reviewed proposal and it is the one this
-- migration deliberately does not implement. Two named slots is the BOOLEAN of
-- reference kinds, and 0063 already argued that case in the other direction for
-- `authored_by`: *"a two-value flag is what forces the next producer to be a
-- migration plus an argument about what `agent` used to mean."* A third kind of
-- reference — a scheduled fire, an inbound partner request, a BCF round-trip —
-- would be a third column, a rewritten CHECK, a rewritten index and an audit of
-- every reader, where here it is one tuple member.
--
-- It also costs the idempotency index its best property. 0064 and 0065 both
-- argue, at length, that the unique index must be EXACTLY the probe's WHERE
-- clause — narrower rejects rows the probe accepts, wider admits duplicates the
-- probe was meant to prevent — and `documents.spec.ts` reads both sources and
-- fails when they drift. Over two mutually-exclusive columns that index becomes
-- either a COALESCE expression (which no longer *is* the probe's columns, so the
-- property that test pins stops being checkable) or two partial indexes (two
-- objects enforcing one rule, each of which can be dropped without the other
-- noticing). Neither is worth buying.
--
-- And it enforces nothing about WHICH slot a producer uses: nothing in a
-- two-column shape stops `deep_research` writing into the source-ref column. The
-- kind-derived-from-producer arrangement above is the part that actually makes
-- the wrong pairing unrepresentable, and it needs one column, not two.
--
-- **A discriminator beside the existing name** (`authored_by_ref_kind` added,
-- `authored_by_run_id` kept). Resolves the ambiguity and leaves the lie: a
-- column name is the first thing a reader of the table trusts, and this one
-- would still say "run id" over a value that is not one for two producers out of
-- three. The rename is catalog-only and instant; keeping a wrong name to avoid
-- it is paying forever to save once.
--
-- **Leave the column; fix only the audit emit** so `agent_run` is used only when
-- the ref really is a run. That fixes the symptom the review found and leaves
-- the cause: the column means two things, so every future reader — a support
-- query, an export, a join written by somebody who was not here — re-derives
-- the same ambiguity, and the next one may not notice.
--
-- ## The backfill, and why there is one this time
--
-- 0063 needed none: every pre-existing row meant exactly what the new default
-- said. This one is different. `authored_by_ref_kind` has NO default that is
-- true of existing rows, because the answer differs per row — and it is
-- knowable, exactly and without guessing, from `authored_by_producer`, which
-- 0063 added for precisely this class of question ("recovering the producer from
-- run ids afterwards is archaeology").
--
-- So the backfill is a CASE over the producer, and the guard below refuses to
-- run if any machine-authored row names a producer this migration has no kind
-- for. That is the 0063/0064 pattern applied to a backfill rather than to an
-- index: a migration that cannot know an answer must stop and say so, never
-- write a plausible one. A wrong `authored_by_ref_kind` is worse than a missing
-- column, because it is a false statement in the record this whole change exists
-- to make truthful.
--
-- Human rows are untouched: `authored_by = 'user'` rows keep a NULL kind, which
-- is what the CHECK below permits and what the partial indexes already exclude.
--
-- ## The index is rebuilt under its new name, not renamed
--
-- `ALTER INDEX ... RENAME` would have done this for free: Postgres rewrites an
-- index's definition when a column it covers is renamed, so the old index would
-- have kept working and only its NAME — which says "run" — needed changing. It
-- is deliberately not what happens below, and the reason is worth stating
-- because the cheap option is the tempting one.
--
-- A renamed index has its definition spread across two files: 0065 says which
-- columns, 0066 says what it is called. Nobody reading the migrations to learn
-- the CURRENT rule can find it in one place, and `documents.spec.ts` — which
-- pins the index's columns against `findDocumentAuthoredByRef`'s WHERE clause,
-- because 0064 is right that they must be the same columns or one of them is
-- wrong — would have to reconstruct DDL to check it. A rule that can only be
-- read by reconstruction is a rule that stops being checked.
--
-- So the price is the one 0064 and 0065 already accepted for this same table and
-- wrote down: a plain `CREATE UNIQUE INDEX` takes a SHARE lock and reads the
-- whole of `documents`, which is a write pause proportional to its length, and
-- CONCURRENTLY cannot run inside the transaction the migration runner wraps each
-- file in. The new index is created BEFORE the old one is dropped, so a failure
-- here leaves the old one standing and the rule enforced throughout.
--
-- The kind is deliberately NOT added to that index, and this is the one place
-- where a wider key would look like extra safety. It would be the exact failure
-- 0064 names: the kind is a function of the producer, and the producer is
-- already in the key, so `(…, ref, producer)` already determines the kind.
-- Adding it would put a column in the index that the probe does not filter on,
-- and 0064's rule is that the two must be the same columns or one of them is
-- wrong.
--
-- ## Locks
--
-- `RENAME COLUMN` and `ADD COLUMN` with no default are catalog-only; the index
-- build is the one statement here that reads the table (see above). The backfill
-- is a single UPDATE over the machine-authored rows,
-- which are the small minority the partial index `documents_agent_authored_idx`
-- exists because of. The CHECK is added NOT VALID and validated separately, as
-- 0063 did, so the ACCESS EXCLUSIVE lock covers the catalog update only and the
-- scan runs under SHARE UPDATE EXCLUSIVE.
--
-- ## RLS
--
-- Nothing to do. `documents` was secured by 0031, and renaming a column or
-- adding one does not move a table across the tenant boundary. Deliberately
-- absent from `rls-coverage.spec.ts`'s BOUNDARY_MIGRATIONS, like 0063–0065.

-- ---------------------------------------------------------------------------
-- 1. Refuse to guess a kind this migration does not know (see the header)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  unknown_producers text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO unknown_producers
  FROM (
    SELECT format('producer %L (%s documents)', "authored_by_producer", count(*)) AS entry
    FROM "documents"
    WHERE "authored_by" <> 'user'
      AND "authored_by_producer" IS NOT NULL
      AND "authored_by_producer" NOT IN ('deep_research', 'diagram_svg', 'diagram_pdf')
    GROUP BY "authored_by_producer"
  ) AS unknowns;

  IF unknown_producers IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot apply migration 0066: machine-authored documents name a producer whose reference kind this migration does not know.\n  %\nEvery producer must be listed in the backfill below with the kind of identifier it files under, because the whole point of authored_by_ref_kind is that the record says what its identifier IS. Add the producer to this migration rather than letting it be backfilled with a plausible guess: a wrong kind is a false statement in the one record that answers what wrote this document and in which run.',
      unknown_producers;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The honest name, and the index restated under it (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents" RENAME COLUMN "authored_by_run_id" TO "authored_by_ref";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_authored_ref_producer_per_project"
  ON "documents" ("organization_id", "project_id", "authored_by_ref", "authored_by_producer")
  WHERE "authored_by" <> 'user';

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_documents_authored_run_producer_per_project";

-- ---------------------------------------------------------------------------
-- 3. What kind of identifier that is
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "authored_by_ref_kind" text;

--> statement-breakpoint
UPDATE "documents"
SET "authored_by_ref_kind" = CASE "authored_by_producer"
  WHEN 'deep_research' THEN 'agent_run'
  WHEN 'diagram_svg' THEN 'answer_artifact'
  WHEN 'diagram_pdf' THEN 'answer_artifact'
END
WHERE "authored_by" <> 'user'
  AND "authored_by_ref" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. A row no person wrote names its producer, its reference AND what that
--    reference is (0063's constraint, widened by the third answer)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_authorship_requires_provenance";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_authorship_requires_provenance"
  CHECK (
    "authored_by" = 'user'
    OR ("authored_by_producer" IS NOT NULL
        AND "authored_by_ref" IS NOT NULL
        AND "authored_by_ref_kind" IS NOT NULL)
  )
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_authorship_requires_provenance";

-- ---------------------------------------------------------------------------
-- 5. What the columns mean, in the catalog
-- ---------------------------------------------------------------------------
--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_ref" IS
  'The identifier of the thing that produced an authored_by <> user document; NULL for everything a person uploaded. Read it WITH authored_by_ref_kind, which says what kind of identifier it is — it was called authored_by_run_id until 0066 and documented as a backend job id, which was true only while there was one producer. Required together with authored_by_producer and authored_by_ref_kind (documents_authorship_requires_provenance).';

--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_ref_kind" IS
  'What kind of identifier authored_by_ref holds: agent_run (a backend async job id in the aiq_api job store) or answer_artifact (one artifact inside one chat answer, {message id}-{hash of its source}). NULL for everything a person uploaded. Derived from authored_by_producer by the one filing path, never chosen at a call site. No CHECK on the value, so a further kind is a TypeScript change — the arrangement authored_by and scope already have. It is also the WorkOS audit target TYPE the document.generated event carries, so a kind added here owes an entry in lib/audit/schemas.mjs.';

--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_producer" IS
  'What wrote an authored_by <> user document, as a producer identifier (deep_research, diagram_svg, diagram_pdf), never a display label. NULL for everything a person uploaded. Separate from authored_by_ref because a reference only identifies the producer while there is exactly one, and recovering it later from pruned job history is archaeology. It also DERIVES authored_by_ref_kind, which is why the pairing cannot disagree. Restated here because 0063 wrote this comment naming authored_by_run_id, a column this migration renamed — a comment naming a column that does not exist is the same failure one row down in the same catalog.';

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_authored_ref_producer_per_project" IS
  'One machine-authored document per (organization, project, reference, producer). The columns are exactly the WHERE clause of findDocumentAuthoredByRef, because an index narrower than that probe rejects rows the probe would accept, and an index wider than it admits duplicates the probe was meant to prevent. authored_by_ref_kind is deliberately NOT in the key: it is a function of authored_by_producer, which is already in it, so adding it would be a column the probe does not filter on. Partial on authored_by <> ''user'' because 0063''s CHECK deliberately allows a HUMAN row to carry a reference as well, and two people saving one run''s artefact into one project must not collide. Restates uniq_documents_authored_run_producer_per_project (0065) under the renamed column, so the current rule is readable in one file rather than reconstructed from a rename.';
