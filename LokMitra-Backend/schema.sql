-- DEPRECATED legacy backend-sync schema. Do not apply for current deployments.
-- The canonical direct-Supabase/RLS schema is ../supabase/schema.sql.
-- LokMitra schema for Supabase Postgres 15.
-- Apply once to a fresh project as the database owner (normally `postgres`).
-- The FastAPI pool connects directly as lokmitra_pool. Set its password
-- outside this file and use that role in DATABASE_URL.

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

GRANT USAGE ON SCHEMA public TO lokmitra_pool;

-- Merchants are provisioned by POST /api/v1/merchants/me from the verified JWT.
CREATE TABLE public.merchants (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    business_name TEXT NOT NULL,
    preferred_language TEXT NOT NULL DEFAULT 'te'
        CHECK (preferred_language IN ('te', 'hi', 'en')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION public.upsert_merchant_profile(
    p_id UUID,
    p_phone_number TEXT,
    p_business_name TEXT,
    p_preferred_language TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_id IS DISTINCT FROM
        nullif(current_setting('app.merchant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'invalid merchant identity'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.merchants
        (id, phone_number, business_name, preferred_language)
    VALUES (p_id, p_phone_number, p_business_name, p_preferred_language)
    ON CONFLICT (id) DO UPDATE
    SET business_name = EXCLUDED.business_name,
        preferred_language = EXCLUDED.preferred_language
    WHERE public.merchants.id = EXCLUDED.id;
END;
$$;

CREATE TABLE public.customers (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    phone_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at BIGINT NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
    updated_by_device UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customers_id_merchant_id_unique UNIQUE (id, merchant_id)
);

CREATE FUNCTION public.upsert_customer_for_merchant(
    p_id UUID,
    p_merchant_id UUID,
    p_display_name TEXT,
    p_phone_number TEXT,
    p_updated_at BIGINT,
    p_updated_by_device UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    saved_id UUID;
BEGIN
    IF p_merchant_id IS DISTINCT FROM
        nullif(current_setting('app.merchant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'invalid merchant identity'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.customers
        (id, merchant_id, display_name, phone_number, updated_at, updated_by_device)
    VALUES (
        p_id, p_merchant_id, p_display_name, p_phone_number,
        p_updated_at, p_updated_by_device
    )
    ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        phone_number = EXCLUDED.phone_number,
        updated_at = EXCLUDED.updated_at,
        updated_by_device = EXCLUDED.updated_by_device,
        server_updated_at = now()
    WHERE public.customers.merchant_id = EXCLUDED.merchant_id
      AND (EXCLUDED.updated_at, EXCLUDED.updated_by_device)
          > (public.customers.updated_at, public.customers.updated_by_device)
    RETURNING id INTO saved_id;

    RETURN saved_id;
END;
$$;

CREATE INDEX customers_merchant_server_updated_idx
    ON public.customers (merchant_id, server_updated_at, id);

CREATE TABLE public.orders (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL,
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    status TEXT NOT NULL CHECK (
        status IN ('New', 'In Progress', 'Ready', 'Completed')
    ),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
    updated_by_device UUID NOT NULL,
    server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orders_id_merchant_id_unique UNIQUE (id, merchant_id),
    CONSTRAINT orders_customer_merchant_fk
        FOREIGN KEY (customer_id, merchant_id)
        REFERENCES public.customers(id, merchant_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.upsert_order_for_merchant(
    p_id UUID,
    p_merchant_id UUID,
    p_customer_id UUID,
    p_description TEXT,
    p_status TEXT,
    p_created_at BIGINT,
    p_is_demo BOOLEAN,
    p_updated_at BIGINT,
    p_updated_by_device UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    saved_id UUID;
BEGIN
    IF p_merchant_id IS DISTINCT FROM
        nullif(current_setting('app.merchant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'invalid merchant identity'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.orders
        (id, merchant_id, customer_id, description, status, created_at,
         is_demo, updated_at, updated_by_device)
    VALUES
        (p_id, p_merchant_id, p_customer_id, p_description, p_status,
         p_created_at, p_is_demo, p_updated_at, p_updated_by_device)
    ON CONFLICT (id) DO UPDATE
    SET customer_id = EXCLUDED.customer_id,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        is_demo = EXCLUDED.is_demo,
        updated_at = EXCLUDED.updated_at,
        updated_by_device = EXCLUDED.updated_by_device,
        server_updated_at = now()
    WHERE public.orders.merchant_id = EXCLUDED.merchant_id
      AND (EXCLUDED.updated_at, EXCLUDED.updated_by_device)
          > (public.orders.updated_at, public.orders.updated_by_device)
    RETURNING id INTO saved_id;

    RETURN saved_id;
END;
$$;

-- Kept separate from merchant profile data and writable only by the API role.
CREATE TABLE public.speech_quota (
    merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
    device_id_hash TEXT NOT NULL CHECK (device_id_hash ~ '^[0-9a-f]{64}$'),
    usage_date DATE NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    PRIMARY KEY (merchant_id, device_id_hash, usage_date)
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
    seq BIGSERIAL NOT NULL UNIQUE,
    merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
    customer_id UUID NOT NULL,
    type TEXT NOT NULL CHECK (
        type IN ('credit_sale', 'payment_received', 'refund', 'payable', 'reversal')
    ),
    amount_paise BIGINT NOT NULL CHECK (
        amount_paise > 0 AND amount_paise <= 1000000000
    ),
    note TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    client_timestamp BIGINT NOT NULL CHECK (client_timestamp >= 0),
    transcript_raw TEXT,
    speech_usage TEXT NOT NULL DEFAULT 'manual'
        CHECK (speech_usage IN (
            'manual', 'browser_speech', 'sarvam_saaras_v3', 'bhashini',
            'sherpa_onnx'
        )),
    vector_clock JSONB
        CHECK (vector_clock IS NULL OR public.valid_vector_clock(vector_clock)),
    confirmed_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    reverses_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT transaction_events_confirmed_check
        CHECK (confirmed_by_user),
    CONSTRAINT transaction_events_id_merchant_id_unique UNIQUE (id, merchant_id),
    CONSTRAINT transaction_events_customer_merchant_fk
        FOREIGN KEY (customer_id, merchant_id)
        REFERENCES public.customers(id, merchant_id) ON DELETE RESTRICT,
    CONSTRAINT transaction_events_reversal_merchant_fk
        FOREIGN KEY (reverses_id, merchant_id)
        REFERENCES public.transaction_events(id, merchant_id) ON DELETE RESTRICT,
    CONSTRAINT transaction_events_reversal_shape_check
        CHECK ((type = 'reversal' AND reverses_id IS NOT NULL)
            OR (type <> 'reversal' AND reverses_id IS NULL))
);

CREATE INDEX customers_merchant_idx
    ON public.customers (merchant_id);
CREATE INDEX transaction_events_merchant_seq_idx
    ON public.transaction_events (merchant_id, seq);
CREATE INDEX transaction_events_merchant_customer_idx
    ON public.transaction_events (merchant_id, customer_id);
CREATE INDEX orders_merchant_server_updated_idx
    ON public.orders (merchant_id, server_updated_at, id);
CREATE UNIQUE INDEX transaction_events_one_reversal_idx
    ON public.transaction_events (merchant_id, reverses_id)
    WHERE reverses_id IS NOT NULL;

-- A reversal must reference an existing, unreversed non-reversal event for
-- the same merchant and customer, with the same amount.
CREATE FUNCTION public.check_transaction_event_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.type <> 'reversal' THEN
        RETURN NEW;
    END IF;

    -- Ledger rows are immutable, so the target needs no mutable-row lock.
    PERFORM 1
      FROM public.transaction_events AS target
     WHERE target.id = NEW.reverses_id
       AND target.merchant_id = NEW.merchant_id
       AND target.customer_id = NEW.customer_id
        AND target.amount_paise = NEW.amount_paise
        AND target.type <> 'reversal';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid reversal target'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_events_reversal_check
    BEFORE INSERT ON public.transaction_events
    FOR EACH ROW EXECUTE FUNCTION public.check_transaction_event_reversal();

CREATE FUNCTION public.reject_transaction_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'transaction_events is append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER transaction_events_append_only
    BEFORE UPDATE OR DELETE ON public.transaction_events
    FOR EACH ROW EXECUTE FUNCTION public.reject_transaction_event_mutation();
CREATE TRIGGER transaction_events_no_truncate
    BEFORE TRUNCATE ON public.transaction_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_transaction_event_mutation();
ALTER TABLE public.transaction_events
    ENABLE ALWAYS TRIGGER transaction_events_append_only;
ALTER TABLE public.transaction_events
    ENABLE ALWAYS TRIGGER transaction_events_no_truncate;
ALTER TABLE public.transaction_events
    ENABLE ALWAYS TRIGGER transaction_events_reversal_check;

ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speech_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY merchants_read_own ON public.merchants
    FOR SELECT TO authenticated
    USING (id = (SELECT auth.uid()));
CREATE POLICY merchants_pool_select ON public.merchants
    FOR SELECT TO lokmitra_pool
    USING (id = nullif(current_setting('app.merchant_id', true), '')::uuid);
CREATE POLICY merchants_pool_insert ON public.merchants
    FOR INSERT TO lokmitra_pool
    WITH CHECK (id = nullif(current_setting('app.merchant_id', true), '')::uuid);

CREATE POLICY customers_read_own ON public.customers
    FOR SELECT TO authenticated
    USING (merchant_id = (SELECT auth.uid()));
CREATE POLICY customers_pool_access ON public.customers
    FOR ALL TO lokmitra_pool
    USING (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
    WITH CHECK (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

CREATE POLICY transaction_events_read_own ON public.transaction_events
    FOR SELECT TO authenticated
    USING (merchant_id = (SELECT auth.uid()));
CREATE POLICY transaction_events_pool_select ON public.transaction_events
    FOR SELECT TO lokmitra_pool
    USING (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
CREATE POLICY transaction_events_pool_insert ON public.transaction_events
    FOR INSERT TO lokmitra_pool
    WITH CHECK (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

CREATE POLICY orders_read_own ON public.orders
    FOR SELECT TO authenticated
    USING (merchant_id = (SELECT auth.uid()));
CREATE POLICY orders_pool_access ON public.orders
    FOR ALL TO lokmitra_pool
    USING (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
    WITH CHECK (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

CREATE POLICY speech_quota_pool_access ON public.speech_quota
    FOR ALL TO lokmitra_pool
    USING (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
    WITH CHECK (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

REVOKE ALL ON public.merchants, public.customers, public.orders, public.speech_quota,
    public.transaction_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_merchant_profile(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_customer_for_merchant(
    UUID, UUID, TEXT, TEXT, BIGINT, UUID
)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_order_for_merchant(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.merchants, public.customers, public.transaction_events
    TO authenticated;
GRANT SELECT ON public.orders TO authenticated;

GRANT SELECT, INSERT ON public.merchants TO lokmitra_pool;
GRANT EXECUTE ON FUNCTION public.upsert_merchant_profile(UUID, TEXT, TEXT, TEXT)
    TO lokmitra_pool;
GRANT EXECUTE ON FUNCTION public.upsert_customer_for_merchant(
    UUID, UUID, TEXT, TEXT, BIGINT, UUID
)
    TO lokmitra_pool;
GRANT EXECUTE ON FUNCTION public.upsert_order_for_merchant(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, UUID
) TO lokmitra_pool;
GRANT SELECT, INSERT ON public.customers TO lokmitra_pool;
GRANT SELECT ON public.orders TO lokmitra_pool;
GRANT SELECT, INSERT, UPDATE ON public.speech_quota TO lokmitra_pool;
GRANT SELECT, INSERT ON public.transaction_events TO lokmitra_pool;
GRANT USAGE, SELECT ON SEQUENCE public.transaction_events_seq_seq
    TO lokmitra_pool;
REVOKE ALL ON SEQUENCE public.transaction_events_seq_seq
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON public.transaction_events
    FROM lokmitra_pool, PUBLIC, anon, authenticated, service_role;

CREATE VIEW public.customer_balances
WITH (security_invoker = true)
AS
SELECT
    c.id,
    c.merchant_id,
    c.display_name,
    c.phone_number,
    COALESCE(SUM(e.amount_paise) FILTER (WHERE e.type = 'credit_sale'), 0)
        - COALESCE(SUM(e.amount_paise) FILTER (WHERE e.type = 'payment_received'), 0)
        AS owed_paise,
    COALESCE(SUM(e.amount_paise) FILTER (WHERE e.type = 'refund'), 0)
        AS refund_paise,
    COALESCE(SUM(e.amount_paise) FILTER (WHERE e.type = 'payable'), 0)
        AS payable_paise
FROM public.customers AS c
LEFT JOIN public.transaction_events AS e
    ON e.customer_id = c.id
   AND e.merchant_id = c.merchant_id
   AND NOT EXISTS (
       SELECT 1
       FROM public.transaction_events AS reversal
       WHERE reversal.merchant_id = e.merchant_id
         AND reversal.reverses_id = e.id
   )
GROUP BY c.id, c.merchant_id, c.display_name, c.phone_number;

REVOKE ALL ON public.customer_balances
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.customer_balances TO lokmitra_pool, authenticated;

-- Account erasure is not a merchant API operation. It requires a separate,
-- documented process that addresses immutable ledger retention and audit.
