-- Reverse 0089: drop the shelves and unshelve every skill.
--
-- Removing a shelf never removes the books: both FKs are ON DELETE SET NULL,
-- so the down migration only drops the columns and the table. Category
-- assignments made after the cutover disappear with the columns, exactly as
-- reversing any curated arrangement does — the skills themselves are untouched.

ALTER TABLE "platform_skills" DROP COLUMN IF EXISTS "category_id";
--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "category_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "skill_categories";
