BEGIN;

ALTER TABLE public.speech_quota
    ADD COLUMN IF NOT EXISTS device_id_hash TEXT;

-- Existing merchant/day counters cannot be assigned to a specific device.
-- Preserve them under a non-client sentinel; they remain auditable but do not
-- block each device's new per-device quota.
UPDATE public.speech_quota
SET device_id_hash = repeat('0', 64)
WHERE device_id_hash IS NULL;

ALTER TABLE public.speech_quota
    ALTER COLUMN device_id_hash SET NOT NULL;
ALTER TABLE public.speech_quota
    DROP CONSTRAINT IF EXISTS speech_quota_device_id_hash_check;
ALTER TABLE public.speech_quota
    ADD CONSTRAINT speech_quota_device_id_hash_check
        CHECK (device_id_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.speech_quota
    DROP CONSTRAINT IF EXISTS speech_quota_pkey;
ALTER TABLE public.speech_quota
    ADD CONSTRAINT speech_quota_pkey
        PRIMARY KEY (merchant_id, device_id_hash, usage_date);

COMMIT;
