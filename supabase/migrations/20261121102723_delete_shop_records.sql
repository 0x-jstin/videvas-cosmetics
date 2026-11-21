begin;

-- Compute the only permitted change for a record deletion from the locked,
-- saved document. This helper has no table privileges and is not a public RPC.
create or replace function public.videvas_state_after_delete(document jsonb, transaction_id text)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  target jsonb;
  next_state jsonb := document;
  remaining_transactions jsonb;
  remaining_movements jsonb;
  removed_movements jsonb;
  products jsonb := '[]'::jsonb;
  product jsonb;
  batch jsonb;
  batches jsonb;
  quantity numeric;
  change numeric;
  label text;
begin
  select value into target from jsonb_array_elements(document->'transactions')
    where value->>'id' = transaction_id;
  if target is null then
    raise exception using errcode = '23514', message = 'This entry no longer exists. Refresh your workspace.';
  end if;
  if target->>'type' not in ('sale','payment','purchase','refund','expense','income') then
    raise exception using errcode = '23514', message = 'This entry cannot be deleted.';
  end if;
  if exists (select 1 from jsonb_array_elements(document->'transactions') t where t->>'saleId' = transaction_id) then
    raise exception using errcode = '23514', message = 'Delete this sale’s refund first, then delete the sale.';
  end if;
  label := case when target->>'type' = 'purchase' then 'restock' else target->>'type' end;
  select coalesce(jsonb_agg(t.value order by t.ordinality), '[]'::jsonb) into remaining_transactions
    from jsonb_array_elements(document->'transactions') with ordinality t(value, ordinality)
    where t.value->>'id' <> transaction_id;
  select coalesce(jsonb_agg(m.value order by m.ordinality), '[]'::jsonb) into remaining_movements
    from jsonb_array_elements(document->'movements') with ordinality m(value, ordinality)
    where m.value->>'transactionId' is distinct from transaction_id;
  select coalesce(jsonb_agg(m.value order by m.ordinality), '[]'::jsonb) into removed_movements
    from jsonb_array_elements(document->'movements') with ordinality m(value, ordinality)
    where m.value->>'transactionId' = transaction_id;
  next_state := jsonb_set(jsonb_set(next_state, '{transactions}', remaining_transactions), '{movements}', remaining_movements);

  for product in select value from jsonb_array_elements(document->'products') loop
    batches := '[]'::jsonb;
    for batch in select value from jsonb_array_elements(product->'batches') loop
      select coalesce(sum((m->>'quantity')::numeric), 0) into change
        from jsonb_array_elements(removed_movements) m
        where m->>'batchId' = batch->>'id' and m->>'productId' = product->>'id';
      quantity := (batch->>'quantity')::numeric - change;
      if quantity < 0 then
        raise exception using errcode = '23514', message = 'This ' || label || ' cannot be deleted because its stock has been sold or removed. Delete the related sales or restore the stock first.';
      end if;
      if quantity > 1000000000 or quantity <> trunc(quantity) then
        raise exception using errcode = '23514', message = 'Deleting this entry would exceed the stock limit.';
      end if;
      batch := jsonb_set(batch, '{quantity}', to_jsonb(quantity));
      -- Remove an unused restock batch, but keep batches referenced by other
      -- sales, returns, or adjustments so their history remains intact.
      if target->>'type' = 'purchase' and quantity = 0
         and exists (select 1 from jsonb_array_elements(target->'lines') l where l->>'batchId' = batch->>'id')
         and not exists (select 1 from jsonb_array_elements(remaining_movements) m where m->>'batchId' = batch->>'id')
         and not exists (
           select 1 from jsonb_array_elements(remaining_transactions) t,
             jsonb_array_elements(coalesce(t->'lines', '[]'::jsonb)) l
           where l->>'batchId' = batch->>'id'
              or exists (select 1 from jsonb_array_elements(coalesce(l->'allocations', '[]'::jsonb)) a where a->>'batchId' = batch->>'id')
         ) then
        continue;
      end if;
      batches := batches || jsonb_build_array(batch);
    end loop;
    products := products || jsonb_build_array(jsonb_set(product, '{batches}', batches));
  end loop;
  next_state := jsonb_set(next_state, '{products}', products);
  begin
    perform public.videvas_validate_state(next_state);
  exception when check_violation then
    if sqlerrm like 'Payment exceeds%' or sqlerrm like 'Customer tab refund does not match%' then
      raise exception using errcode = '23514', message = 'Later customer payments or refunds depend on this entry. Delete those dependent entries first.';
    end if;
    raise;
  end;
  return next_state;
end;
$$;

-- Retain the existing owner check, row lock, revision check, and retry receipt.
-- Ordinary saves still cannot edit history; delete mode must exactly match the
-- server-computed removal of one record and its stock movements.
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
  deleted_ids text[];
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'Sign in before saving.';
  end if;
  if p_request_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_mode is null or p_mode not in ('save','replace','import','delete') then
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
  elsif p_mode = 'delete' then
    select array_agg(t->>'id') into deleted_ids from jsonb_array_elements(shop.state->'transactions') t
      where not exists (select 1 from jsonb_array_elements(p_state->'transactions') n where n->>'id' = t->>'id');
    if coalesce(array_length(deleted_ids, 1), 0) <> 1 then
      raise exception using errcode = '23514', message = 'Delete one existing record at a time.';
    end if;
    if p_state is distinct from public.videvas_state_after_delete(shop.state, deleted_ids[1]) then
      raise exception using errcode = '23514', message = 'Deletion must only remove the selected record and reverse its stock movements.';
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

revoke all on function public.videvas_state_after_delete(jsonb,text),
  public.videvas_save_workspace(jsonb,bigint,uuid,text) from public, anon, authenticated;
grant execute on function public.videvas_save_workspace(jsonb,bigint,uuid,text) to authenticated;
notify pgrst, 'reload schema';

commit;
