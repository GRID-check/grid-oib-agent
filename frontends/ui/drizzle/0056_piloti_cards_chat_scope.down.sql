-- Puts `piloti-cards` back into the scope 0054 seeded.
--
-- Guarded on the scope 0056 wrote, so a row whose scope somebody has since
-- chosen for themselves is left alone: a rollback that overwrites a decision is
-- not a rollback. `created_by = 'system'` is kept as a second gate for
-- consistency with the other seed rollbacks, but the scope is the gate that
-- actually distinguishes an untouched row from a decided one.
--
-- Rolling this back re-states a claim the pipeline still cannot honour — no deep
-- surface emits a card — so this exists to undo the migration, not to enable a
-- feature. The feature is a card channel in deep research, and it is not here.
UPDATE "platform_skills"
   SET "metadata" = jsonb_set("metadata", '{grid-agents}', '"shallow_researcher,deep_researcher"'),
       "updated_at" = now()
 WHERE "name" = 'piloti-cards'
   AND "created_by" = 'system'
   AND "metadata" ->> 'grid-agents' = 'shallow_researcher';
