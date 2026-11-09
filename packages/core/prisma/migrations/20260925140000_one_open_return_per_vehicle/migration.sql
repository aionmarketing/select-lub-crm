-- At most one OPEN vehicle_return per vehicle, enforced by the database (owner
-- rulings, 2026-09-25). services/vehicle-returns already requires it; nothing
-- enforced it. Two reconciles racing (the read and the create are separate
-- transactions) could each open the vehicle's return, and unarchiving could
-- reopen an old return beside a newer one. The reconcile now opens with
-- ON CONFLICT DO NOTHING against this index, and supersedes archived returns
-- once a newer service arrives.
--
-- Existing duplicates are handled first, in the same statement as the index, so
-- this migration either applies completely or changes nothing:
--
-- 1. OPEN returns from DIFFERENT services on one vehicle need judgment: the
--    stale one must be superseded and its un-sent reminders stopped under
--    scheduling's rules (outbox rows included), which SQL here would have to
--    re-implement. That includes a vehicle whose returns' services were
--    unlinked from it: the reconcile visits vehicles holding an OPEN return even
--    with no service, and supersedes those. So the migration refuses, naming
--    the vehicles and the exact commands: `pnpm db:reconcile-returns` (the
--    reconcile every import runs,
--    and NOT an Omie import, which without credentials reads the fake source),
--    `prisma migrate resolve --rolled-back` for this migration, then
--    `pnpm db:migrate` again. The script applies the module grants itself,
--    because db:migrate stops at this failure before its own grants step.
--
-- 2. OPEN returns from the SAME service are the same return twice (the race).
--    The oldest by created_at, then id, is kept. Nothing here ranks returns by
--    their service's date: a vehicle whose OPEN returns come from more than one
--    service is refused in (1), so the only choice this SQL makes is between
--    copies of one return.
--    Each extra's reminder messages move to the kept one, so an attendant's
--    reminders keep firing instead of being stopped, and the extra becomes
--    SUPERSEDED, its row kept for history as the spec requires.
--
-- ARCHIVED + OPEN pairs on one service (earlier imports reopened archived
-- returns) are left alone: the index covers OPEN rows only, and the OPEN one is
-- what attendants have been working from.
DO $$
DECLARE
  cross_service text;
BEGIN
  SELECT string_agg(vehicle_id, ', ' ORDER BY vehicle_id)
    INTO cross_service
    FROM (
      SELECT vehicle_id
        FROM "vehicle_return"
       WHERE status = 'OPEN'
       GROUP BY vehicle_id
      HAVING count(DISTINCT source_service_id) > 1
    ) AS v;
  IF cross_service IS NOT NULL THEN
    RAISE EXCEPTION 'one_open_return_per_vehicle: vehicle(s) % have OPEN returns from different services, and nothing was changed. With DATABASE_URL set to the same database (production DIRECT_URL) in the shell, run in order: (1) pnpm db:reconcile-returns  -- applies the module grants, supersedes the stale returns and stops their un-sent reminders; (2) pnpm --filter @select-lub/core exec prisma migrate resolve --rolled-back 20260925140000_one_open_return_per_vehicle --schema prisma/schema  -- Prisma recorded this migration as failed; (3) pnpm db:migrate', cross_service;
  END IF;

  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (PARTITION BY vehicle_id ORDER BY created_at, id) AS kept
      FROM "vehicle_return"
     WHERE status = 'OPEN'
  )
  UPDATE "return_reminder_message" AS m
     SET vehicle_return_id = r.kept
    FROM ranked AS r
   WHERE r.id <> r.kept
     AND m.vehicle_return_id = r.id;

  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (PARTITION BY vehicle_id ORDER BY created_at, id) AS kept
      FROM "vehicle_return"
     WHERE status = 'OPEN'
  )
  UPDATE "vehicle_return" AS v
     SET status = 'SUPERSEDED',
         updated_at = NOW()
    FROM ranked AS r
   WHERE r.id <> r.kept
     AND v.id = r.id;

  CREATE UNIQUE INDEX "vehicle_return_one_open_per_vehicle"
      ON "vehicle_return" ("vehicle_id")
   WHERE status = 'OPEN';
END $$;
