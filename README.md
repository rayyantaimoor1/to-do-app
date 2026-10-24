# To-Do App

Personal task manager with deadline reminders. It installs as a PWA on Windows and as a native APK on Android. It's built for solo use, but per-user data isolation and multi-user support are already in place.

**Status:** All milestones M1–M8 are implemented. To deploy (Supabase, Google OAuth, push keys, Android signing), follow [SETUP.md](SETUP.md). The full spec is in [PLAN.md](PLAN.md).

## Features

- **Install anywhere.** PWA on Windows (Chrome/Edge), signed APK on Android via Capacitor. One codebase covers both platforms.
- **Google login.** Sign in with Gmail and stay signed in per device until you sign out. Settings also has "Sign out everywhere".
- **Multi-device.** The same account can be active on your laptop and phone at once, with independent sessions.
- **Real-time sync.** Changes on one device appear on the other in about 100–300ms via Supabase Realtime.
- **Offline-first.** Full read/write access without a connection. Changes queue and sync on reconnect.
- **Deadline reminders.** Tasks are scoped to day, week or month, with an escalating reminder ladder as the deadline approaches. Android uses exact local alarms that fire offline; Windows uses web push.
- **Daily digest.** One morning notification summarizes everything still outstanding. Quiet hours are configurable.
- **Per-user data isolation.** Enforced with Postgres Row Level Security, not just in the UI.
- **Desktop keyboard shortcuts.** Press `?` in the app to see them. Search covers every view.

## Stack

Next.js (static export) · Supabase (Postgres, Auth, Realtime, pg_cron, Edge Functions) · Capacitor (Android) · Tailwind CSS · Dexie (offline cache)

## Development

```bash
npm install
```
```bash
npm run dev
```

- `npm run build` writes the static export to `out/`.
- `npm run android:sync` builds and copies it into `android/`.
- `npm run android:release` builds the signed APK (see SETUP.md).

## Cost

$0/month, running entirely on free tiers.
