-- ─────────────────────────────────────────────────────────
-- Device registration for push (M5)
-- ─────────────────────────────────────────────────────────

-- push_subscriptions.endpoint is globally unique, but the same browser can be
-- signed into different accounts over time. A plain upsert from the client
-- would hit RLS on the previous owner's row, so registration goes through
-- this function, which moves the endpoint to the caller. The endpoint is an
-- unguessable capability URL known only to that browser/device.
create function public.register_device(
  p_platform     text,
  p_endpoint     text,
  p_p256dh       text,
  p_auth_key     text,
  p_device_label text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.push_subscriptions
    (user_id, platform, endpoint, p256dh, auth_key, device_label, last_seen_at)
  values
    (auth.uid(), p_platform, p_endpoint, p_p256dh, p_auth_key, p_device_label, now())
  on conflict (endpoint) do update set
    user_id      = excluded.user_id,
    platform     = excluded.platform,
    p256dh       = excluded.p256dh,
    auth_key     = excluded.auth_key,
    device_label = excluded.device_label,
    last_seen_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.register_device(text, text, text, text, text) from public, anon;
grant  execute on function public.register_device(text, text, text, text, text) to authenticated;

-- Android bumps last_seen_at every time it reschedules its local alarms. The
-- sweep compares it with tasks.updated_at to decide whether the phone already
-- has an alarm for a reminder (skip server push) or not (send as backup).
-- now() is the server clock, the same clock that writes tasks.updated_at.
create function public.touch_device(p_endpoint text) returns void
language sql security invoker set search_path = '' as $$
  update public.push_subscriptions
     set last_seen_at = now()
   where endpoint = p_endpoint
     and user_id = auth.uid();
$$;

revoke execute on function public.touch_device(text) from public, anon;
grant  execute on function public.touch_device(text) to authenticated;
