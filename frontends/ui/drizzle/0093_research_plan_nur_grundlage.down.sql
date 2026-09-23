-- Reverse 0093: plans stop confining the reader's documents; every run reads what it finds again.

ALTER TABLE "research_plans" DROP CONSTRAINT IF EXISTS "research_plans_nur_has_grundlage";
--> statement-breakpoint
ALTER TABLE "research_plans" DROP COLUMN IF EXISTS "nur_grundlage";
