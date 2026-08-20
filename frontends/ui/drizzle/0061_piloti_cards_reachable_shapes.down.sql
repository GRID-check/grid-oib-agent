-- Put `piloti-cards` back to the five shapes 0054 inlined.
--
-- Guarded on the md5 of the body 0060 wrote — the same hash the forward
-- migration guards on, because neither direction touches the body — so a row
-- whose prose somebody has edited through the dashboard is left exactly as it
-- is in both directions. Not guarded on `created_by`: the dashboard patches
-- `body` and never `created_by`, so an edited row still reads `system` and that
-- column cannot tell an untouched row from an owned one.
--
-- The metadata gate is the second half of the same idea, and it is what makes
-- this a rollback rather than an overwrite: only a row still carrying exactly
-- what 0061 wrote is reverted. A row whose card preferences somebody has since
-- chosen for themselves keeps them.
--
-- Rolling this back costs nothing per turn and gives back 958 tokens of shapes
-- on every research turn — it also puts `typed_table` and `process_map` back
-- behind a `describe_card` round trip, which is the reachability gap 0061
-- exists to close. Roll back for the token budget, not for correctness.
UPDATE "platform_skills"
   SET "metadata" = jsonb_set(
         "metadata",
         '{grid-cards}',
         '"verdict_header,condition_tree,key_takeaways,callout,follow_ups"'
       ),
       "updated_at" = now()
 WHERE "name" = 'piloti-cards'
   AND "created_by" = 'system'
   AND md5("body") = '9662a746c7e877a70e5c814b4cbdecca'  -- pragma: allowlist secret
   AND "metadata" ->> 'grid-cards'
       = 'verdict_header,condition_tree,typed_table,key_takeaways,callout,process_map,follow_ups';
