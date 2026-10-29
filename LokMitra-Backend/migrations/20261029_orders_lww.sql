BEGIN;

CREATE TABLE IF NOT EXISTS public.orders (
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

CREATE OR REPLACE FUNCTION public.upsert_order_for_merchant(
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

CREATE INDEX IF NOT EXISTS orders_merchant_server_updated_idx
    ON public.orders (merchant_id, server_updated_at, id);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_read_own ON public.orders;
CREATE POLICY orders_read_own ON public.orders
    FOR SELECT TO authenticated
    USING (merchant_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS orders_pool_access ON public.orders;
CREATE POLICY orders_pool_access ON public.orders
    FOR ALL TO lokmitra_pool
    USING (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
    WITH CHECK (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

REVOKE ALL ON public.orders FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_order_for_merchant(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.orders TO authenticated, lokmitra_pool;
GRANT EXECUTE ON FUNCTION public.upsert_order_for_merchant(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, UUID
) TO lokmitra_pool;

COMMIT;
