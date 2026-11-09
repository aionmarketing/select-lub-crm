-- Documented fixture for conversation-phone-unique task 2.2.
--
-- Against the OLD unique-only schema
--   UNIQUE (whatsapp_connection_id, remote_jid)
--   UNIQUE (whatsapp_connection_id, external_message_id)
-- these two INSERTs succeed (different remote_jid) and leave two inbox rows
-- plus two conversation_tag rows for the same tag. The CHECK does not exist,
-- so chat_key/customer_phone_normalized = '5511999999999@s.whatsapp.net' is
-- also legal (asserted by the live test as a probe INSERT, not stored here).
--
-- After 20260830200000_conversation_chat_key the merge leaves one conversation
-- for (connection, '5511999999999'), both messages (distinct external_message_id)
-- on that row, one conversation_tag, and the CHECK rejects a 1:1 JID stored as chat_key.
--
-- A colliding external_message_id on both conversations cannot be seeded: the old
-- unique message_whatsapp_connection_id_external_message_id_key forbids it.
-- INSERT INTO conversation (..., chat_key)
--   VALUES (..., '5511999999999@s.whatsapp.net'); -- rejected by conversation_chat_key_format

INSERT INTO "unit" ("id", "name", "created_at", "updated_at")
VALUES ('merge-unit', 'merge fixture unit', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

INSERT INTO "whatsapp_connection" ("id", "unit_id", "instance_name", "created_at", "updated_at")
VALUES ('merge-conn', 'merge-unit', 'merge-fixture-inst', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

INSERT INTO "conversation" (
  "id",
  "whatsapp_connection_id",
  "remote_jid",
  "customer_phone_normalized",
  "started_at",
  "last_message_at",
  "created_at",
  "updated_at"
) VALUES
  (
    'surv',
    'merge-conn',
    '5511999999999@s.whatsapp.net',
    '5511999999999',
    TIMESTAMP '2026-01-01 00:00:00',
    TIMESTAMP '2026-01-01 12:00:00',
    TIMESTAMP '2026-01-01 00:00:00',
    TIMESTAMP '2026-01-01 00:00:00'
  ),
  (
    'abs',
    'merge-conn',
    '5511999999999@c.us',
    '5511999999999',
    TIMESTAMP '2026-01-02 00:00:00',
    TIMESTAMP '2026-01-03 12:00:00',
    TIMESTAMP '2026-01-02 00:00:00',
    TIMESTAMP '2026-01-02 00:00:00'
  );

INSERT INTO "message" (
  "id",
  "conversation_id",
  "whatsapp_connection_id",
  "external_message_id",
  "direction",
  "message_type",
  "text_body",
  "provider_timestamp",
  "created_at",
  "updated_at"
) VALUES
  (
    'msg-surv',
    'surv',
    'merge-conn',
    'm-surv',
    'inbound',
    'text',
    'from s.net',
    TIMESTAMP '2026-01-01 12:00:00',
    TIMESTAMP '2026-01-01 12:00:00',
    TIMESTAMP '2026-01-01 12:00:00'
  ),
  (
    'msg-abs',
    'abs',
    'merge-conn',
    'm-abs',
    'inbound',
    'text',
    'from c.us',
    TIMESTAMP '2026-01-03 12:00:00',
    TIMESTAMP '2026-01-03 12:00:00',
    TIMESTAMP '2026-01-03 12:00:00'
  );

INSERT INTO "tag" ("id", "unit_id", "name", "created_at", "updated_at")
VALUES ('tag-1', 'merge-unit', 'merge-tag', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00');

INSERT INTO "conversation_tag" ("id", "conversation_id", "tag_id", "created_at", "updated_at")
VALUES
  ('ct-surv', 'surv', 'tag-1', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
  ('ct-abs', 'abs', 'tag-1', TIMESTAMP '2026-01-02 00:00:00', TIMESTAMP '2026-01-02 00:00:00');
