-- Reverse 0103: drop the expected-answer text.
--
-- Lossy: what voters wrote about the right answer goes with the column. Export
-- first if it should survive the rollback:
--
--   COPY (SELECT id, expected_answer FROM answer_feedback WHERE expected_answer IS NOT NULL)
--     TO '/tmp/expected_answers.csv' CSV HEADER;
ALTER TABLE "answer_feedback" DROP COLUMN IF EXISTS "expected_answer";
