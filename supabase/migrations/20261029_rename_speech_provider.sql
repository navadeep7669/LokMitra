ALTER TABLE public.transaction_events
    DROP CONSTRAINT IF EXISTS transaction_events_speech_usage_check;

UPDATE public.transaction_events
SET speech_usage = 'local_stt'
WHERE speech_usage = 'vexyl_stt';

ALTER TABLE public.transaction_events
    ADD CONSTRAINT transaction_events_speech_usage_check
    CHECK (speech_usage IN (
        'manual', 'browser_speech', 'local_stt',
        'sarvam_saaras_v3', 'bhashini', 'sherpa_onnx'
    ));
