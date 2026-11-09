-- conversation.source_type is TEXT with no constraint. Every writer is typed to
-- AD / ORGANIC / UNKNOWN, but the reports read path filed any other string
-- under UNKNOWN while the origin filter compared the raw column, so the origin
-- table and its own drill-through would disagree about such a row. Owner
-- decision 2026-09-24: the database refuses the value instead.
--
-- Not NOT VALID: existing rows are validated here, so a stray value on a
-- deployed database fails this migration loudly rather than surviving it.
ALTER TABLE "conversation"
  ADD CONSTRAINT "conversation_source_type_check"
  CHECK ("source_type" IN ('AD', 'ORGANIC', 'UNKNOWN'));
