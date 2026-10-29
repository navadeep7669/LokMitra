ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS language TEXT
    CHECK (language IS NULL OR language IN ('en', 'hi', 'te'));
