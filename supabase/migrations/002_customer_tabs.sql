begin;

-- Validate tabs in posting order. Payments are customer-owned receipts;
-- they never allocate money to individual sales. Existing paid sales stay settled.
create or replace function public.videvas_validate_customer_tabs(document jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  original jsonb;
  customer_id text;
  entry_type text;
  on_account boolean;
  amount numeric;
  balance numeric;
  cash_refund numeric;
  balances jsonb := '{}'::jsonb;
  sales jsonb := '{}'::jsonb;
  refunds jsonb := '{}'::jsonb;
begin
  for item in select value from jsonb_array_elements(document->'customers') loop
    if item ? 'vip' and jsonb_typeof(item->'vip') is distinct from 'boolean' then
      raise exception using errcode = '23514', message = 'Invalid customer VIP status.';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'transactions') loop
    entry_type := item->>'type';
    customer_id := item->>'customerId';
    if item ? 'onAccount' and (jsonb_typeof(item->'onAccount') is distinct from 'boolean'
       or entry_type not in ('sale','refund')) then
      raise exception using errcode = '23514', message = 'Invalid customer tab entry.';
    end if;
    on_account := coalesce((item->>'onAccount')::boolean, false);
    if (item ? 'customerId' or on_account or entry_type = 'payment') and
       (jsonb_typeof(item->'customerId') is distinct from 'string'
        or entry_type not in ('sale','refund','payment')
        or not exists (select 1 from jsonb_array_elements(document->'customers') c
                       where c->>'id' = customer_id)) then
      raise exception using errcode = '23514', message = 'Customer tab profile is missing or invalid.';
    end if;
    amount := (item->>'amount')::numeric;
    if document->'settings'->>'currency' = 'XOF' and mod(amount, 100) <> 0 then
      raise exception using errcode = '23514', message = 'Amounts must use whole francs.';
    end if;
    balance := coalesce((balances->>customer_id)::numeric, 0);
    if entry_type = 'sale' then
      sales := jsonb_set(sales, array[item->>'id'], item);
      if on_account then
        if item->>'method' is distinct from 'Customer tab' then
          raise exception using errcode = '23514', message = 'Invalid customer tab sale.';
        end if;
        balance := balance + amount;
      end if;
    elsif entry_type = 'payment' then
      if item ? 'saleId' or item ? 'lines' then
        raise exception using errcode = '23514', message = 'Payments belong to a customer tab without a sale link.';
      end if;
      balance := balance - amount;
    elsif entry_type = 'refund' then
      original := sales->(item->>'saleId');
      if original is null or refunds ? (item->>'saleId')
         or original->'amount' is distinct from item->'amount'
         or original->'cost' is distinct from item->'cost'
         or original->'customerId' is distinct from item->'customerId'
         or original->'lines' is distinct from item->'lines'
         or coalesce((original->>'onAccount')::boolean, false) <> on_account then
        raise exception using errcode = '23514', message = 'Invalid sale refund.';
      end if;
      refunds := jsonb_set(refunds, array[item->>'saleId'], 'true'::jsonb);
      if on_account then
        if not public.videvas_is_integer(item->'cashAmount', 0, 1000000000) then
          raise exception using errcode = '23514', message = 'Invalid customer tab cash refund.';
        end if;
        cash_refund := (item->>'cashAmount')::numeric;
        if cash_refund <> greatest(0, amount - balance)
           or (cash_refund = 0 and item->>'method' is distinct from 'Customer tab')
           or (document->'settings'->>'currency' = 'XOF' and mod(cash_refund, 100) <> 0) then
          raise exception using errcode = '23514', message = 'Customer tab refund does not match the outstanding balance.';
        end if;
        balance := balance - amount + cash_refund;
      end if;
    end if;
    if not (on_account and entry_type = 'refund') and item ? 'cashAmount' then
      raise exception using errcode = '23514', message = 'Unexpected cash amount in transaction.';
    end if;
    if not (on_account and (entry_type = 'sale' or (entry_type = 'refund' and cash_refund = 0)))
       and coalesce(item->>'method', '') not in ('Cash','Card','Bank transfer','Mobile money') then
      raise exception using errcode = '23514', message = 'Invalid payment method.';
    end if;
    if balance < 0 or balance > 9007199254740991 then
      raise exception using errcode = '23514', message = 'Payment exceeds the customer outstanding balance.';
    end if;
    if customer_id is not null then balances := jsonb_set(balances, array[customer_id], to_jsonb(balance)); end if;
  end loop;
end;
$$;

-- The complete shape validator is replaced below so older installations also
-- accept customer payment entries, while retaining all original checks.

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
    if coalesce(item->>'type', '') not in ('sale','refund','purchase','expense','income','payment')
       or not public.videvas_is_integer(item->'amount', 1, 1000000000) then
      raise exception using errcode = '23514', message = 'A transaction is invalid.';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'movements') loop
    if not public.videvas_is_integer(item->'quantity', -1000000000, 1000000000) then
      raise exception using errcode = '23514', message = 'A stock movement is invalid.';
    end if;
  end loop;
  perform public.videvas_validate_customer_tabs(document);
end;
$$;

revoke all on function public.videvas_validate_customer_tabs(jsonb) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
