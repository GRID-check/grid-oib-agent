-- Removes the seeded card guidance only if it is untouched platform seed data.
-- A row somebody has since edited is theirs, and a down-migration is not the
-- place to discard it.
DELETE FROM "platform_skills" WHERE "name" = 'piloti-cards' AND "created_by" = 'system';
