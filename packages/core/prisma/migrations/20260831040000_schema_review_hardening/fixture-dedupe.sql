-- Duplicate shapes that the pre-hardening schema accepts. Prior migrations
-- already unique-index conversation_tag open rows, so drop that index first.
DROP INDEX "conversation_tag_open_apply_key";

INSERT INTO "unit" ("id", "name", "created_at", "updated_at") VALUES
  ('srh-unit', 'SRH scratch', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

INSERT INTO "customer" ("id", "name", "origin", "status", "created_at", "updated_at") VALUES
  ('srh-cust-a', 'Cust A', 'whatsapp', 'active', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('srh-cust-b', 'Cust B', 'whatsapp', 'active', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('srh-cust-c', 'Cust C', 'whatsapp', 'active', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

-- Duplicate normalized: keep the primary (ph-keep), delete ph-lose.
INSERT INTO "customer_phone" ("id", "customer_id", "raw", "normalized", "is_primary", "created_at", "updated_at") VALUES
  ('ph-lose', 'srh-cust-a', '11999999999', '5511999999999', false, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('ph-keep', 'srh-cust-a', '11 99999-9999', '5511999999999', true, TIMESTAMP '2026-01-02 00:00:00', TIMESTAMP '2026-01-02 00:00:00');

-- Double primary, different numbers: keep newest updated_at as the only primary.
INSERT INTO "customer_phone" ("id", "customer_id", "raw", "normalized", "is_primary", "created_at", "updated_at") VALUES
  ('ph-stale', 'srh-cust-b', '11888888888', '5511888888888', true, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('ph-fresh', 'srh-cust-b', '11777777777', '5511777777777', true, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-03 00:00:00');

-- Duplicate normalized, neither primary: keep oldest (ph-old).
INSERT INTO "customer_phone" ("id", "customer_id", "raw", "normalized", "is_primary", "created_at", "updated_at") VALUES
  ('ph-old', 'srh-cust-c', '11666666666', '5511666666666', false, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('ph-newer', 'srh-cust-c', '11 66666-6666', '5511666666666', false, TIMESTAMP '2026-01-02 00:00:00', TIMESTAMP '2026-01-02 00:00:00');

-- Duplicate normalized email: keep the primary.
INSERT INTO "customer_email" ("id", "customer_id", "raw", "normalized", "is_primary", "created_at", "updated_at") VALUES
  ('em-lose', 'srh-cust-a', 'A@Example.com', 'a@example.com', false, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('em-keep', 'srh-cust-a', 'a@example.com', 'a@example.com', true, TIMESTAMP '2026-01-02 00:00:00', TIMESTAMP '2026-01-02 00:00:00');

INSERT INTO "whatsapp_connection" ("id", "unit_id", "instance_name", "created_at", "updated_at") VALUES
  ('srh-conn', 'srh-unit', 'srh-scratch', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

INSERT INTO "conversation" (
  "id", "whatsapp_connection_id", "remote_jid", "chat_key",
  "started_at", "last_message_at", "created_at", "updated_at"
) VALUES (
  'srh-conv', 'srh-conn', '5511999999999@s.whatsapp.net', '5511999999999',
  TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00',
  TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'
);

INSERT INTO "tag" ("id", "unit_id", "name", "created_at", "updated_at") VALUES
  ('srh-tag', 'srh-unit', 'Orcamento', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

-- Duplicate open tag rows: keep oldest (ct-old), close ct-extra.
INSERT INTO "conversation_tag" (
  "id", "conversation_id", "tag_id", "assigned_at", "removed_at", "created_at", "updated_at"
) VALUES
  ('ct-old', 'srh-conv', 'srh-tag', TIMESTAMP '2026-01-01 00:00:00', NULL, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('ct-extra', 'srh-conv', 'srh-tag', TIMESTAMP '2026-01-02 00:00:00', NULL, TIMESTAMP '2026-01-02 00:00:00', TIMESTAMP '2026-01-02 00:00:00');

INSERT INTO "service" (
  "id", "customer_id", "unit_id", "odometer_km", "origin", "created_at", "updated_at"
) VALUES (
  'srh-svc', 'srh-cust-a', 'srh-unit', 49999.6, 'omie',
  TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'
);
