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

-- After rescheduling its local alarms, Android reports the newest server
-- tasks.updated_at it has applied. The sweep compares that with each task's
-- updated_at to decide whether the phone already has an alarm for a reminder
-- (skip server push) or not (send as backup). Using a server timestamp the
-- phone has actually seen — not now() — means an edit still in flight over
-- Realtime is never mistaken for one the phone has scheduled. Clamped to
-- now() so a bad value can't suppress backups for future edits.
create function public.touch_device(p_endpoint text, p_synced_through timestamptz)
returns void
language sql security invoker set search_path = '' as $$
  update public.push_subscriptions
     set last_seen_at = greatest(last_seen_at, least(p_synced_through, now()))
   where endpoint = p_endpoint
     and user_id = auth.uid();
$$;

revoke execute on function public.touch_device(text, timestamptz) from public, anon;
grant  execute on function public.touch_device(text, timestamptz) to authenticated;
