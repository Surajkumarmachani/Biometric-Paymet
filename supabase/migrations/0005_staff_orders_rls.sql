-- ============================================================================
-- 0005_staff_orders_rls.sql — staff visibility for the store terminal (S4)
--
-- The in-store terminal watches an order over Supabase Realtime, but the only
-- SELECT policy on `orders` matches the CUSTOMER (user_id = auth.jwt()->>'sub').
-- An in-store order is unclaimed (user_id is null) when the associate is
-- watching it, so nothing is delivered to the terminal.
--
-- We add a SECOND permissive SELECT policy: a staff member may read orders for
-- THEIR OWN store. Multiple permissive policies are OR-ed, so customers keep
-- seeing their own orders and staff additionally see their store's orders.
--
-- The `staff` table is deliberately service-role-only (no grant to
-- authenticated). To check membership without exposing that table, the policy
-- calls a SECURITY DEFINER predicate that reads `staff` as the table owner and
-- returns only a boolean.
--
-- Idempotent: safe to apply to a project that already has 0001..0004.
-- ============================================================================

create or replace function public.is_staff_for_store(p_store_id uuid)
  returns boolean
  language sql
  security definer
  set search_path = public
  stable
as $$
  select exists (
    select 1
      from staff s
     where s.clerk_id = (select auth.jwt() ->> 'sub')
       and s.store_id = p_store_id
       and s.active
  );
$$;

-- Callable only by an authenticated session inside the policy check; never by
-- anon, and it returns a boolean, so it cannot be used to enumerate staff.
revoke all on function public.is_staff_for_store(uuid) from public;
grant execute on function public.is_staff_for_store(uuid) to authenticated;

drop policy if exists staff_store_orders on orders;
create policy staff_store_orders on orders
  for select to authenticated
  using (store_id is not null and public.is_staff_for_store(store_id));
