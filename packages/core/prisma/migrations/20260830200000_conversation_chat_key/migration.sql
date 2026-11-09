-- conversation-phone-unique: rename customer_phone_normalized → chat_key,
-- collapse split 1:1 threads that only differed by remote_jid spelling,
-- unique (whatsapp_connection_id, chat_key), unique (conversation_id, external_message_id),
-- drop message.whatsapp_connection_id, CHECK chat_key ~ '^[0-9]+$' OR LIKE '%@g.us'.
--
-- Documented fixture (task 2.2): connection C has two conversation rows for
-- chat_key 5511999999999 (remote_jid @s.whatsapp.net vs @c.us). After this
-- migration exactly one conversation remains; both messages that do not share
-- external_message_id belong to it; a tag applied on both rows is one
-- conversation_tag on the survivor. Inserting chat_key
-- '5511999999999@s.whatsapp.net' is rejected by the CHECK (would have been
-- legal as customer_phone_normalized under the old unique-only schema).

-- Rename then recompute from JID local part before ':' or '@', digits only.
ALTER TABLE "conversation" RENAME COLUMN "customer_phone_normalized" TO "chat_key";

UPDATE "conversation"
SET "chat_key" = regexp_replace(
  split_part(split_part("remote_jid", '@', 1), ':', 1),
  '[^0-9]',
  '',
  'g'
);

CREATE TEMP TABLE "conversation_merge_map" ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY "whatsapp_connection_id", "chat_key"
      ORDER BY "created_at" ASC, id ASC
    ) AS survivor_id,
    FIRST_VALUE("remote_jid") OVER (
      PARTITION BY "whatsapp_connection_id", "chat_key"
      ORDER BY "last_message_at" DESC, id DESC
    ) AS latest_remote_jid
  FROM "conversation"
)
SELECT id AS absorbee_id, survivor_id, latest_remote_jid
FROM ranked
WHERE id <> survivor_id;

DELETE FROM "message" AS absorbee
USING "conversation_merge_map" AS map
WHERE absorbee."conversation_id" = map.absorbee_id
  AND EXISTS (
    SELECT 1
    FROM "message" AS keep
    WHERE keep."conversation_id" = map.survivor_id
      AND keep."external_message_id" = absorbee."external_message_id"
  );

UPDATE "message" AS row
SET "conversation_id" = map.survivor_id
FROM "conversation_merge_map" AS map
WHERE row."conversation_id" = map.absorbee_id;

UPDATE "outbox_message" AS row
SET "conversation_id" = map.survivor_id
FROM "conversation_merge_map" AS map
WHERE row."conversation_id" = map.absorbee_id;

DELETE FROM "conversation_tag" AS absorbee
USING "conversation_merge_map" AS map
WHERE absorbee."conversation_id" = map.absorbee_id
  AND EXISTS (
    SELECT 1
    FROM "conversation_tag" AS keep
    WHERE keep."conversation_id" = map.survivor_id
      AND keep."tag_id" = absorbee."tag_id"
  );

UPDATE "conversation_tag" AS row
SET "conversation_id" = map.survivor_id
FROM "conversation_merge_map" AS map
WHERE row."conversation_id" = map.absorbee_id;

DELETE FROM "cadastro_prefill_suggestion" AS absorbee
USING "conversation_merge_map" AS map
WHERE absorbee."conversation_id" = map.absorbee_id
  AND EXISTS (
    SELECT 1
    FROM "cadastro_prefill_suggestion" AS keep
    WHERE keep."conversation_id" = map.survivor_id
  );

UPDATE "cadastro_prefill_suggestion" AS row
SET "conversation_id" = map.survivor_id
FROM "conversation_merge_map" AS map
WHERE row."conversation_id" = map.absorbee_id;

UPDATE "cadastro_prefill_job" AS row
SET "conversation_id" = map.survivor_id
FROM "conversation_merge_map" AS map
WHERE row."conversation_id" = map.absorbee_id;

-- Absorbee must be gone before copying latest_remote_jid: the old unique
-- (whatsapp_connection_id, remote_jid) is still in force, and the latest
-- spelling often already sits on the absorbee (@c.us vs @s.whatsapp.net).
DELETE FROM "conversation" AS row
USING "conversation_merge_map" AS map
WHERE row.id = map.absorbee_id;

UPDATE "conversation" AS row
SET "remote_jid" = map.latest_remote_jid
FROM "conversation_merge_map" AS map
WHERE row.id = map.survivor_id;

DROP INDEX "conversation_whatsapp_connection_id_remote_jid_key";

CREATE UNIQUE INDEX "conversation_whatsapp_connection_id_chat_key_key"
  ON "conversation"("whatsapp_connection_id", "chat_key");

ALTER TABLE "conversation" ADD CONSTRAINT "conversation_chat_key_format"
  CHECK ("chat_key" ~ '^[0-9]+$' OR "chat_key" LIKE '%@g.us');

ALTER TABLE "message" DROP CONSTRAINT "message_whatsapp_connection_id_fkey";

DROP INDEX "message_whatsapp_connection_id_external_message_id_key";

ALTER TABLE "message" DROP COLUMN "whatsapp_connection_id";

CREATE UNIQUE INDEX "message_conversation_id_external_message_id_key"
  ON "message"("conversation_id", "external_message_id");
