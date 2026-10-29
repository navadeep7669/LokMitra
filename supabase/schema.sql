-- Apply once to a dedicated Supabase project as its database owner.
-- The browser uses only the Supabase anon/publishable key; RLS binds all
-- business rows to auth.uid(). The backend connects as lokmitra_pool only
-- for the per-user AI request quota.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lokmitra_pool') THEN
        CREATE ROLE lokmitra_pool
            LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE lokmitra_pool
    WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO authenticated, lokmitra_pool;

CREATE TABLE public.customers (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    aliases TEXT[] NOT NULL DEFAULT '{}',
    language TEXT CHECK (language IS NULL OR language IN ('en', 'hi', 'te')),
    phone_number TEXT CHECK (phone_number IS NULL OR length(phone_number) <= 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at BIGINT NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
    updated_by_device UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    server_ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, merchant_id)
);

CREATE FUNCTION public.valid_vector_clock(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) <> 'object' THEN FALSE
        ELSE (
            SELECT count(*) <= 20
            FROM jsonb_object_keys(value)
        )
        AND NOT EXISTS (
            SELECT 1
            FROM jsonb_each(value) AS entry(key, counter)
            WHERE jsonb_typeof(counter) <> 'number'
               OR counter::text !~ '^(0|[1-9][0-9]*)$'
        )
    END
$$;

CREATE TABLE public.transaction_events (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE RESTRICT,
    customer_id UUID NOT NULL,
    type TEXT NOT NULL CHECK (
        type IN ('credit_sale', 'payment_received', 'refund', 'payable')
    ),
    amount_paise BIGINT NOT NULL CHECK (
        amount_paise > 0 AND amount_paise <= 1000000000
    ),
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    occurred_at TIMESTAMPTZ NOT NULL,
    client_timestamp BIGINT NOT NULL CHECK (client_timestamp >= 0),
    transcript_raw TEXT CHECK (transcript_raw IS NULL OR length(transcript_raw) <= 2000),
    reverses_id UUID,
    vector_clock JSONB,
    speech_usage TEXT NOT NULL DEFAULT 'manual'
        CHECK (speech_usage IN (
            'manual', 'browser_speech', 'local_stt',
            'sarvam_saaras_v3', 'bhashini', 'sherpa_onnx'
        )),
    confirmed_by_user BOOLEAN NOT NULL CHECK (confirmed_by_user),
    status TEXT NOT NULL DEFAULT 'CONFIRMED'
        CHECK (status IN ('CONFIRMED', 'VOIDED')),
    server_ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, merchant_id),
    CHECK (
        vector_clock IS NULL OR public.valid_vector_clock(vector_clock)
    ),
    FOREIGN KEY (customer_id, merchant_id)
        REFERENCES public.customers(id, merchant_id) ON DELETE RESTRICT
);

CREATE TABLE public.orders (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL,
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
    status TEXT NOT NULL CHECK (
        status IN ('New', 'In Progress', 'Ready', 'Completed')
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
    updated_by_device UUID NOT NULL,
    server_ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (customer_id, merchant_id)
        REFERENCES public.customers(id, merchant_id) ON DELETE RESTRICT
);

CREATE INDEX customers_owner_cursor_idx
    ON public.customers (merchant_id, server_ts, id);
CREATE INDEX events_owner_cursor_idx
    ON public.transaction_events (merchant_id, server_ts, id);
CREATE INDEX orders_owner_cursor_idx
    ON public.orders (merchant_id, server_ts, id);

CREATE FUNCTION public.set_server_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.server_ts := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER customers_set_server_ts
    BEFORE INSERT OR UPDATE ON public.customers
    FOR EACH ROW EXECUTE FUNCTION public.set_server_timestamp();
CREATE TRIGGER events_set_server_ts
    BEFORE INSERT OR UPDATE ON public.transaction_events
    FOR EACH ROW EXECUTE FUNCTION public.set_server_timestamp();
CREATE TRIGGER orders_set_server_ts
    BEFORE INSERT OR UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.set_server_timestamp();

CREATE FUNCTION public.protect_confirmed_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.status = 'VOIDED' THEN
        RAISE EXCEPTION 'voided transactions are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.type IS DISTINCT FROM OLD.type THEN
        RAISE EXCEPTION 'confirmed transaction fields are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'CONFIRMED' AND NEW.status = 'VOIDED') THEN
        RAISE EXCEPTION 'confirmed transactions may only be voided'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_events_protect_confirmed
    BEFORE UPDATE ON public.transaction_events
    FOR EACH ROW EXECUTE FUNCTION public.protect_confirmed_transaction();

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_user_scope ON public.customers
    FOR ALL TO authenticated
    USING (merchant_id = (SELECT auth.uid()))
    WITH CHECK (merchant_id = (SELECT auth.uid()));
CREATE POLICY events_user_select ON public.transaction_events
    FOR SELECT TO authenticated
    USING (merchant_id = (SELECT auth.uid()));
CREATE POLICY events_user_insert ON public.transaction_events
    FOR INSERT TO authenticated
    WITH CHECK (
        merchant_id = (SELECT auth.uid())
        AND status = 'CONFIRMED'
        AND confirmed_by_user
    );
CREATE POLICY events_user_void ON public.transaction_events
    FOR UPDATE TO authenticated
    USING (merchant_id = (SELECT auth.uid()) AND status = 'CONFIRMED')
    WITH CHECK (merchant_id = (SELECT auth.uid()) AND status = 'VOIDED');
CREATE POLICY orders_user_scope ON public.orders
    FOR ALL TO authenticated
    USING (merchant_id = (SELECT auth.uid()))
    WITH CHECK (merchant_id = (SELECT auth.uid()));

REVOKE ALL ON public.customers, public.transaction_events, public.orders
    FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.customers, public.orders TO authenticated;
GRANT SELECT, INSERT ON public.transaction_events TO authenticated;
GRANT UPDATE (status) ON public.transaction_events TO authenticated;

CREATE TABLE public.speech_quota (
    merchant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_id_hash TEXT NOT NULL CHECK (user_id_hash ~ '^[0-9a-f]{64}$'),
    usage_date DATE NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    PRIMARY KEY (merchant_id, user_id_hash, usage_date)
);
ALTER TABLE public.speech_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speech_quota FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.speech_quota FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY speech_quota_backend_scope ON public.speech_quota
    FOR ALL TO lokmitra_pool
    USING (
        merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    )
    WITH CHECK (
        merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    );
GRANT SELECT, INSERT, UPDATE ON public.speech_quota TO lokmitra_pool;

REVOKE ALL ON FUNCTION public.set_server_timestamp()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_confirmed_transaction()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.valid_vector_clock(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valid_vector_clock(JSONB) TO authenticated;
