-- Retire the SMS channel.
--
-- Branded SMS to a Vietnamese number needs a sender-ID registration that only a
-- registered company can obtain, so this system does not send SMS at all and no
-- longer pretends it might. The toggle in Settings promised a capability that
-- did not exist, and every message it queued was written to the server log and
-- then marked delivered.
--
-- Queued SMS rows are marked sent rather than deleted: they are a record of
-- what the system decided to notify somebody about, and that history is worth
-- keeping even though the carrier never existed. Their in-app twins were
-- always enqueued alongside, so no member is left uninformed by this.

UPDATE outbox
   SET sent_at = COALESCE(sent_at, now()),
       attempts = GREATEST(attempts, 1)
 WHERE channel = 'sms';

DELETE FROM feature_flags WHERE key = 'SMS';
