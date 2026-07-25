# To-Do App

Personal task manager with deadline reminders — installs as a PWA on Windows and a native APK on Android. Built for solo use, structured so per-user data isolation and multi-user support are already in place for the future.

**Status:** Planning complete, implementation not started. See [PLAN.md](PLAN.md) for the full spec.

## Features

- **Install anywhere** — PWA on Windows (Chrome/Edge), signed APK on Android via Capacitor. One codebase, both platforms.
- **Google login** — sign in with Gmail. Stays logged in per device until an explicit sign-out.
- **Multi-device** — the same account can be active on your laptop and phone at once, with independent sessions.
- **Real-time sync** — changes on one device appear on the other in ~100–300ms via Supabase Realtime.
- **Offline-first** — full read/write access with no connection; changes queue and sync on reconnect.
- **Deadline reminders** — tasks scoped to day/week/month, with an escalating reminder ladder as the deadline approaches.
- **Daily digest** — one morning notification summarizing everything still outstanding, until it's marked done.
- **Per-user data isolation** — enforced with Postgres Row Level Security, not just in the UI.

## Stack

Next.js (static export) · Supabase (Postgres, Auth, Realtime, pg_cron, Edge Functions) · Capacitor (Android) · Tailwind CSS · Dexie (offline cache)

## Cost

$0/month, running entirely on free tiers.

## Docs

Full architecture, data model, notification logic, build order, and setup commands: [PLAN.md](PLAN.md)
