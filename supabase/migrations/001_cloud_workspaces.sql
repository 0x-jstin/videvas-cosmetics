begin;

-- A complete shop snapshot is committed atomically so stock, receipts, and the
-- cash ledger cannot disagree when two devices post at the same time.
create table if not exists public.videvas_workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"version":1,"demo":false,"settings":{"storeName":"Videvas","currency":"XOF"},"products":[],"customers":[],"transactions":[],"movements":[]}'::jsonb,
  revision bigint not null default 0 check (revision between 0 and 9007199254740990),
  updated_at timestamptz not null default now()
);

-- Receipts make retries safe even if the original response was lost, or
-- another device wrote something after the original request succeeded.
create table if not exists public.videvas_operations (
  owner_id uuid not null references public.videvas_workspaces(owner_id) on delete cascade,
  request_id uuid not null,
  revision bigint not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

-- Realtime broadcasts only a revision, not a potentially large shop document.
create table if not exists public.videvas_workspace_changes (
  owner_id uuid primary key references public.videvas_workspaces(owner_id) on delete cascade,
  revision bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.videvas_workspaces enable row level security;
alter table public.videvas_operations enable row level security;
alter table public.videvas_workspace_changes enable row level security;

drop policy if exists "Read own shop" on public.videvas_workspaces;
create policy "Read own shop" on public.videvas_workspaces for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists "Read own revision" on public.videvas_workspace_changes;
create policy "Read own revision" on public.videvas_workspace_changes for select to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.videvas_workspaces, public.videvas_operations, public.videvas_workspace_changes from public, anon, authenticated;
grant select on public.videvas_workspaces, public.videvas_workspace_changes to authenticated;

create or replace function public.videvas_is_integer(value jsonb, minimum bigint, maximum bigint)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'number' and value::text ~ '^-?[0-9]+$'
    then value::text::numeric between minimum and maximum else false end;
$$;

create or replace function public.videvas_validate_state(document jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  batch jsonb;
  collection text;
begin
  if jsonb_typeof(document) is distinct from 'object'
     or document->'version' is distinct from '1'::jsonb
     or jsonb_typeof(document->'demo') is distinct from 'boolean'
     or jsonb_typeof(document->'settings') is distinct from 'object'
     or jsonb_typeof(document->'settings'->'storeName') is distinct from 'string'
     or length(btrim(document->'settings'->>'storeName')) not between 1 and 80
     or coalesce(document->'settings'->>'currency', '') not in ('XOF','USD','GHS','NGN','GMD','GBP','EUR','KES','ZAR','CAD','AUD','INR')
     or octet_length(document::text) > 20000000 then
    raise exception using errcode = '23514', message = 'Invalid shop settings or workspace size.';
  end if;
  foreach collection in array array['products','customers','transactions','movements'] loop
    if jsonb_typeof(document->collection) is distinct from 'array' then
      raise exception using errcode = '23514', message = 'A shop collection is missing or invalid.';
    end if;
    if exists (select 1 from jsonb_array_elements(document->collection) entry
               where jsonb_typeof(entry) <> 'object' or coalesce(entry->>'id', '') = '')
       or (select count(*) from jsonb_array_elements(document->collection)) <>
          (select count(distinct entry->>'id') from jsonb_array_elements(document->collection) entry) then
      raise exception using errcode = '23514', message = 'Shop records need unique identifiers.';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'products') loop
    if coalesce(item->>'name', '') = '' or coalesce(item->>'sku', '') = ''
       or not public.videvas_is_integer(item->'price', 1, 1000000000)
       or not public.videvas_is_integer(item->'cost', 0, 1000000000)
       or not public.videvas_is_integer(item->'reorder', 0, 1000000000)
       or jsonb_typeof(item->'batches') is distinct from 'array' then
      raise exception using errcode = '23514', message = 'A product has invalid amounts or stock.';
    end if;
    for batch in select value from jsonb_array_elements(item->'batches') loop
      if coalesce(batch->>'id', '') = ''
         or not public.videvas_is_integer(batch->'quantity', 0, 1000000000)
         or not public.videvas_is_integer(batch->'cost', 0, 1000000000) then
        raise exception using errcode = '23514', message = 'A stock batch is invalid.';
      end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(document->'transactions') loop
    if coalesce(item->>'type', '') not in ('sale','refund','purchase','expense','income')
       or not public.videvas_is_integer(item->'amount', 1, 1000000000) then
      raise exception using errcode = '23514', message = 'A transaction is invalid.';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'movements') loop
    if not public.videvas_is_integer(item->'quantity', -1000000000, 1000000000) then
      raise exception using errcode = '23514', message = 'A stock movement is invalid.';
    end if;
  end loop;
end;
$$;

create or replace function public.videvas_load_workspace()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  shop public.videvas_workspaces%rowtype;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'Sign in to open your shop.';
  end if;
  insert into public.videvas_workspaces(owner_id) values (actor) on conflict (owner_id) do nothing;
  select * into shop from public.videvas_workspaces where owner_id = actor;
  insert into public.videvas_workspace_changes(owner_id, revision, updated_at)
    values (actor, shop.revision, shop.updated_at) on conflict (owner_id) do nothing;
  return jsonb_build_object('owner_id', actor, 'state', shop.state, 'revision', shop.revision, 'updated_at', shop.updated_at);
end;
$$;

create or replace function public.videvas_save_workspace(
  p_state jsonb, p_expected_revision bigint, p_request_id uuid, p_mode text default 'save'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  shop public.videvas_workspaces%rowtype;
  receipt public.videvas_operations%rowtype;
  digest text;
  collection text;
  prefix jsonb;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'Sign in before saving.';
  end if;
  if p_request_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_mode is null or p_mode not in ('save','replace','import') then
    raise exception using errcode = '23514', message = 'Invalid save request.';
  end if;
  perform public.videvas_validate_state(p_state);
  digest := encode(sha256(convert_to(p_state::text || ':' || p_expected_revision::text || ':' || p_mode, 'UTF8')), 'hex');
  insert into public.videvas_workspaces(owner_id) values (actor) on conflict (owner_id) do nothing;
  select * into shop from public.videvas_workspaces where owner_id = actor for update;
  select * into receipt from public.videvas_operations where owner_id = actor and request_id = p_request_id;
  if found then
    if receipt.fingerprint <> digest then
      raise exception using errcode = 'PT409', message = 'This save request was already used for a different entry.';
    end if;
    return jsonb_build_object('owner_id', actor, 'state', shop.state, 'revision', shop.revision,
      'request_revision', receipt.revision, 'updated_at', shop.updated_at);
  end if;
  if shop.revision <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'Your shop changed on another device. Review the latest records before saving again.';
  end if;
  if p_mode = 'import' and (
    jsonb_array_length(shop.state->'products') + jsonb_array_length(shop.state->'customers') +
    jsonb_array_length(shop.state->'transactions') + jsonb_array_length(shop.state->'movements') > 0
  ) then
    raise exception using errcode = 'PT409', message = 'Import needs an empty cloud workspace. Your cloud records have been kept.';
  end if;
  if p_mode = 'save' then
    foreach collection in array array['transactions','movements'] loop
      select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb) into prefix
        from jsonb_array_elements(p_state->collection) with ordinality entry(value, ordinality)
        where entry.ordinality <= jsonb_array_length(shop.state->collection);
      if prefix <> shop.state->collection then
        raise exception using errcode = '23514', message = 'Posted transactions and stock history cannot be changed.';
      end if;
    end loop;
    if jsonb_array_length(shop.state->'transactions') > 0
       and p_state->'settings'->>'currency' <> shop.state->'settings'->>'currency' then
      raise exception using errcode = '23514', message = 'Start a fresh workspace before changing currency.';
    end if;
  end if;
  update public.videvas_workspaces set state = p_state, revision = shop.revision + 1,
    updated_at = clock_timestamp() where owner_id = actor returning * into shop;
  insert into public.videvas_operations(owner_id, request_id, revision, fingerprint)
    values (actor, p_request_id, shop.revision, digest);
  insert into public.videvas_workspace_changes(owner_id, revision, updated_at)
    values (actor, shop.revision, shop.updated_at) on conflict (owner_id) do update
    set revision = excluded.revision, updated_at = excluded.updated_at;
  return jsonb_build_object('owner_id', actor, 'state', shop.state, 'revision', shop.revision,
    'request_revision', shop.revision, 'updated_at', shop.updated_at);
end;
$$;

revoke all on function public.videvas_is_integer(jsonb,bigint,bigint), public.videvas_validate_state(jsonb),
  public.videvas_load_workspace(), public.videvas_save_workspace(jsonb,bigint,uuid,text) from public, anon, authenticated;
grant execute on function public.videvas_load_workspace(), public.videvas_save_workspace(jsonb,bigint,uuid,text) to authenticated;

-- Readable projections in the dashboard keep the underlying atomic document
-- protected by its owner policy. All writes go through the save function.
create or replace view public.videvas_products with (security_invoker = true) as
  select owner_id, product->>'id' as id, product->>'name' as name, product->>'sku' as sku, product as data
  from public.videvas_workspaces cross join lateral jsonb_array_elements(state->'products') product;
create or replace view public.videvas_customers with (security_invoker = true) as
  select owner_id, customer->>'id' as id, customer->>'name' as name, customer as data
  from public.videvas_workspaces cross join lateral jsonb_array_elements(state->'customers') customer;
create or replace view public.videvas_transactions with (security_invoker = true) as
  select owner_id, entry->>'id' as id, entry->>'type' as type, entry->>'reference' as reference, entry as data
  from public.videvas_workspaces cross join lateral jsonb_array_elements(state->'transactions') entry;
create or replace view public.videvas_stock_movements with (security_invoker = true) as
  select owner_id, movement->>'id' as id, movement as data
  from public.videvas_workspaces cross join lateral jsonb_array_elements(state->'movements') movement;
revoke all on public.videvas_products, public.videvas_customers, public.videvas_transactions, public.videvas_stock_movements from public, anon, authenticated;
grant select on public.videvas_products, public.videvas_customers, public.videvas_transactions, public.videvas_stock_movements to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'videvas_workspace_changes') then
    alter publication supabase_realtime add table public.videvas_workspace_changes;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
