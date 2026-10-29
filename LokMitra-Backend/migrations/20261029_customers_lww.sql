BEGIN;

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0
        CHECK (updated_at >= 0),
    ADD COLUMN IF NOT EXISTS updated_by_device UUID NOT NULL
        DEFAULT '00000000-0000-0000-0000-000000000000',
    ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.customers
SET updated_at = GREATEST(
        updated_at,
        floor(extract(epoch FROM created_at) * 1000)::BIGINT
    ),
    server_updated_at = created_at;

CREATE INDEX IF NOT EXISTS customers_merchant_server_updated_idx
    ON public.customers (merchant_id, server_updated_at, id);

DROP FUNCTION IF EXISTS public.upsert_customer_for_merchant(
    UUID, UUID, TEXT, TEXT
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

REVOKE ALL ON FUNCTION public.upsert_customer_for_merchant(
    UUID, UUID, TEXT, TEXT, BIGINT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_customer_for_merchant(
    UUID, UUID, TEXT, TEXT, BIGINT, UUID
) TO lokmitra_pool;

COMMIT;
