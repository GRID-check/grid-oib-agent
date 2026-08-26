-- Rollback for 0068_platform_lessons: drop the three lesson tables.
-- Order: children first (FKs reference platform_lessons).
DROP TABLE IF EXISTS "platform_lesson_events";
DROP TABLE IF EXISTS "platform_lesson_reports";
DROP TABLE IF EXISTS "platform_lessons";
