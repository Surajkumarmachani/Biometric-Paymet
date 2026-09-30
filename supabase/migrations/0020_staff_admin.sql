-- ============================================================================
-- 0020 — admins manage staff from the app (the /staff/team page).
--
-- Until now the only way to grant a role was scripts/make-staff.mts against the
-- database. app.admin_set_staff is the one door for changing anyone's access,
-- and every rule lives here so no route, page or future client can skip one:
--
--   * only an ACTIVE ADMIN may change access
--   * nobody changes their OWN access (another admin must)
--   * the target must be a known user (signed in at least once)
--   * the store must exist and be active
--   * there is always at least one active admin afterwards
--   * every change writes an audit row, in the same transaction
--
-- Concurrency: every call first locks the active-admin rows. Two admins
-- demoting each other at the same moment therefore run one after the other,
-- and the second finds its actor is no longer an admin — never zero admins.
-- ============================================================================

create or replace function app.admin_set_staff(
  p_actor    text,
  p_target   text,
  p_store_id uuid,
  p_role     staff_role,
  p_active   boolean
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_before staff;
  v_after  staff;
  v_admins int;
begin
  -- Serialise every access change behind the admin rows (see header).
  perform 1 from staff where role = 'admin' and active for update;

  if not exists (select 1 from staff where clerk_id = p_actor and role = 'admin' and active) then
    raise exception 'only an active admin can change staff access' using errcode = '42501';
  end if;

  if p_actor = p_target then
    raise exception 'you cannot change your own access; ask another admin' using errcode = '42501';
  end if;

  if not exists (select 1 from app_users where clerk_id = p_target) then
    raise exception 'unknown user: they must sign in to the site once first' using errcode = '22023';
  end if;

  if not exists (select 1 from stores where id = p_store_id and active) then
    raise exception 'unknown or inactive store' using errcode = '22023';
  end if;

  select * into v_before from staff where clerk_id = p_target for update;

  insert into staff (clerk_id, store_id, role, active)
       values (p_target, p_store_id, p_role, p_active)
  on conflict (clerk_id) do update
     set store_id = excluded.store_id,
         role     = excluded.role,
         active   = excluded.active
  returning * into v_after;

  select count(*) into v_admins from staff where role = 'admin' and active;
  if v_admins = 0 then
    raise exception 'there must always be at least one active admin' using errcode = '42501';
  end if;

  insert into auth_audit_log (user_id, event, outcome, detail)
  values (
    p_actor, 'staff_access_changed', 'success',
    jsonb_build_object(
      'target', p_target,
      'before', case when v_before.clerk_id is null then null else jsonb_build_object(
                  'role', v_before.role, 'store_id', v_before.store_id, 'active', v_before.active) end,
      'after',  jsonb_build_object(
                  'role', v_after.role, 'store_id', v_after.store_id, 'active', v_after.active)
    )
  );

  return jsonb_build_object(
    'clerk_id', v_after.clerk_id,
    'role',     v_after.role,
    'store_id', v_after.store_id,
    'active',   v_after.active,
    'created',  v_before.clerk_id is null
  );
end
$$;

revoke all on function app.admin_set_staff(text, text, uuid, staff_role, boolean) from public;
grant execute on function app.admin_set_staff(text, text, uuid, staff_role, boolean) to service_role;
