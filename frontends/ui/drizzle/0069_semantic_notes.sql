-- Semantic notes: give BOTH note stores real vectors, and give the lesson
-- register a way to find out whether it is working.
-- (docs/architecture/semantic-notes.md, docs/architecture/platform-failure-learning.md)
--
-- Until now project memory deduplicated with a 200-row token-Jaccard scan and
-- the lesson register matched inside a rank-ordered window. Both are lexical,
-- so both miss the paraphrase they exist to collapse ("der Bauherr wünscht ein
-- Flachdach" vs "Flachdach ist gewünscht" score 0.0), and the memory audit
-- (memory-system-audit-2026-07, F2/F3) named the missing embedding gate as the
-- single most important unbuilt component: "skip it and memory rots".
--
-- The vector lives in the ROW, not in a second store. Chroma was the obvious
-- alternative and is the reason F2 was never built: two stores means a sync
-- job, a drift mode, and a deletion problem, for a candidate set that is in
-- the hundreds per scope. A `real[]` column is transactional with the note,
-- inherits its RLS policy and its cascade, and cannot drift. The crossover
-- where that stops being true, and what to do then, is in the doc.
ALTER TABLE "project_memory"
  ADD COLUMN IF NOT EXISTS "embedding" real[],
  -- The fingerprint of the model that produced the vector. Vectors are only
  -- comparable within one model, and a model swap is a config change away, so
  -- a mismatch here means "not embedded yet" rather than a bad comparison.
  ADD COLUMN IF NOT EXISTS "embedding_model" text,
  ADD COLUMN IF NOT EXISTS "embedded_at" timestamp with time zone;
--> statement-breakpoint
-- How often this note has actually been recalled into a prompt. The
-- reinforcement term `S` in MemoryBank's retention curve (R = e^(-t/S)):
-- each recall both resets the elapsed time and flattens the curve, so a note
-- that keeps proving useful stops decaying. `last_referenced_at` already
-- existed and was write-only; together the two finally make it readable.
ALTER TABLE "project_memory"
  ADD COLUMN IF NOT EXISTS "recall_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_lessons"
  ADD COLUMN IF NOT EXISTS "embedding" real[],
  ADD COLUMN IF NOT EXISTS "embedding_model" text,
  ADD COLUMN IF NOT EXISTS "embedded_at" timestamp with time zone;
--> statement-breakpoint
-- Effectiveness, the honest half. A lesson is injected fleet-wide; nothing so
-- far could say whether it helped, and an unmeasured bandage is indistinguishable
-- from a superstition. Two independent signals are recorded:
--
--   helpful_votes / harmful_votes  — up/down votes cast while this lesson was
--     active. With an always-injected digest, exposure is a function of TIME,
--     so this needs no per-turn exposure table: a vote at T was exposed to
--     every lesson active at T. It is a correlation, labelled as one in the UI.
--
--   the holdout (see platform_retrieval_settings key `lessons.holdout_pct`)
--     — the credible one: a deterministic slice of conversations receives NO
--     lessons, so the two down-vote rates can be compared. Default 0: a
--     product does not degrade a slice of its answers unless an operator
--     deliberately turns measurement on.
ALTER TABLE "platform_lessons"
  ADD COLUMN IF NOT EXISTS "helpful_votes" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "harmful_votes" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Which side of the lessons experiment a vote fell on, stamped at vote time by
-- the same pure function both tiers use to decide injection. Nullable: rows
-- written before the experiment existed, and votes cast while the holdout is
-- off, legitimately have no side.
ALTER TABLE "answer_feedback"
  ADD COLUMN IF NOT EXISTS "lessons_holdout" boolean;
--> statement-breakpoint
-- Serves the effectiveness read: votes in a window, split by holdout side.
CREATE INDEX IF NOT EXISTS "idx_answer_feedback_holdout_created"
  ON "answer_feedback"("created_at") WHERE "lessons_holdout" IS NOT NULL;
--> statement-breakpoint
-- Cosine similarity over two `real[]` vectors — the one definition both note
-- stores compare with.
--
-- Deliberately a plain SQL function and not pgvector: adding an extension
-- changes the database image and every deployment of it, to accelerate a scan
-- over hundreds of rows per scope (one project's memory, the live lesson
-- register). Set-based (`unnest ... WITH ORDINALITY` joined on the index), so
-- it is one pass per pair rather than a PL/pgSQL loop, and IMMUTABLE +
-- PARALLEL SAFE so the planner may hoist and parallelise it.
--
-- NULL rather than an error on a shape mismatch or a zero vector: a note
-- embedded by a different model has a different dimensionality, and the
-- callers already treat NULL as "not comparable, fall back to lexical".
-- The crossover where a real ANN index becomes necessary is documented in
-- docs/architecture/semantic-notes.md.
CREATE OR REPLACE FUNCTION grid_cosine_similarity(a real[], b real[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL THEN NULL
    WHEN array_length(a, 1) IS DISTINCT FROM array_length(b, 1) THEN NULL
    ELSE (
      SELECT CASE WHEN s.na = 0 OR s.nb = 0 THEN NULL ELSE s.dot / (s.na * s.nb) END
      FROM (
        SELECT
          sum(x.v::double precision * y.v::double precision) AS dot,
          sqrt(sum(x.v::double precision * x.v::double precision)) AS na,
          sqrt(sum(y.v::double precision * y.v::double precision)) AS nb
        FROM unnest(a) WITH ORDINALITY AS x(v, i)
        JOIN unnest(b) WITH ORDINALITY AS y(v, i) USING (i)
      ) s
    )
  END
$$;
