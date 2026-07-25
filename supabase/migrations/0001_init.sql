-- ─────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────
create table profiles (
  id                uuid primary key references auth.users on delete cascade,
  email             text,
  display_name      text,
  timezone          text not null default 'UTC',
  digest_time       time not null default '08:00',
  quiet_hours_start time not null default '22:00',
  quiet_hours_end   time not null default '07:00',
  created_at        timestamptz not null default now()
);

-- auto-create a profile row when a user signs up
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────────────────────────────────────────────────────
-- tasks
-- ─────────────────────────────────────────────────────────
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  title        text not null check (length(trim(title)) > 0),
  notes        text,
  scope        text not null check (scope in ('day','week','month')),
  due_at       timestamptz not null,
  priority     smallint not null default 1 check (priority between 0 and 2),
  status       text not null default 'open' check (status in ('open','done')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_due_idx on tasks (user_id, status, due_at);
create index tasks_sweep_idx on tasks (status, due_at) where status = 'open';

-- ─────────────────────────────────────────────────────────
-- push_subscriptions — one row per device
-- ─────────────────────────────────────────────────────────
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  platform     text not null check (platform in ('web','android')),
  device_label text,
  endpoint     text not null unique,
  p256dh       text,
  auth_key     text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index push_user_idx on push_subscriptions (user_id);

-- ─────────────────────────────────────────────────────────
-- notification_log — dedup + rate limiting
-- ─────────────────────────────────────────────────────────
create table notification_log (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users on delete cascade,
  task_id  uuid references tasks on delete cascade,
  kind     text not null,
  fire_key text not null,
  sent_at  timestamptz not null default now(),
  unique (user_id, fire_key)
);

create index notif_recent_idx on notification_log (user_id, sent_at desc);

-- ─────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────
create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

-- ─────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────
alter table profiles            enable row level security;
alter table tasks               enable row level security;
alter table push_subscriptions  enable row level security;
alter table notification_log    enable row level security;

create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own tasks" on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own devices" on push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notifications" on notification_log
  for select using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────
-- Realtime
-- ─────────────────────────────────────────────────────────
alter publication supabase_realtime add table tasks;
