-- Down for 0081: `grid-agents: researcher` goes back to `shallow_researcher`.
--
-- Unguarded by author, unlike the seed rollbacks (0056, 0062): those undo a
-- DECISION about scope and must leave a row somebody has since decided for
-- themselves alone. This one undoes a RENAME. Code before 0081 knows only
-- `shallow_researcher`, so a row left on the new spelling — including one a
-- member chose in the editor after the rename — would read to it as an
-- allowlist of unknown names, i.e. as no restriction at all, and a chat-only
-- skill would leak into deep research. Rolling back has to move every row.
--
-- `\mresearcher\M` cannot fire inside `deep_researcher`: `_` is a word
-- character, so the position before `researcher` there is not a word boundary.
UPDATE "platform_skills"
   SET "metadata" = jsonb_set(
         "metadata",
         '{grid-agents}',
         to_jsonb(regexp_replace("metadata" ->> 'grid-agents', '\mresearcher\M', 'shallow_researcher', 'g'))
       ),
       "updated_at" = now()
 WHERE "metadata" ->> 'grid-agents' ~ '\mresearcher\M';
--> statement-breakpoint
UPDATE "skills"
   SET "metadata" = jsonb_set(
         "metadata",
         '{grid-agents}',
         to_jsonb(regexp_replace("metadata" ->> 'grid-agents', '\mresearcher\M', 'shallow_researcher', 'g'))
       ),
       "updated_at" = now()
 WHERE "metadata" ->> 'grid-agents' ~ '\mresearcher\M';
