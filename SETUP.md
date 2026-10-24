# Setup & deployment

Everything in M1–M8 is implemented. What's left needs your accounts, keys and devices, so you do it here, in this order. Secrets go into Supabase secrets or gitignored files, **never** into chat or a commit.

Commands assume PowerShell in the project root.

---

## 1. Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). Note the **project ref**, which is the subdomain in `https://<ref>.supabase.co`.
2. Copy `.env.local.example` to `.env.local`. Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Project Settings → API**.
3. Apply the schema. Either paste these into the SQL editor in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_push_devices.sql`

   or use the CLI:

   ```bash
   npx supabase login
   ```
   ```bash
   npx supabase link --project-ref <ref>
   ```
   ```bash
   npx supabase db push
   ```

## 2. Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type *Web application*. Set the authorized redirect URI to `https://<ref>.supabase.co/auth/v1/callback`.
2. Supabase → **Authentication → Sign In / Providers → Google**: enable it and paste in the client ID and secret.
3. Supabase → **Authentication → URL Configuration**:
   - **Site URL**: your production URL (see step 5), e.g. `https://your-app.vercel.app`.
   - **Redirect URLs**: add every one of these:
     - `http://localhost:3000`
     - `http://localhost:4000`
     - `https://your-app.vercel.app`
     - `com.rayyantaimoor.todo://auth-callback` (the Android app)
4. **R5, stay logged in:** under **Authentication → Sessions**, leave *time-boxed sessions* and *inactivity timeout* off. Refresh tokens then renew indefinitely.

Check: `npm run dev`, sign in, refresh the page, and you should still be signed in.

## 3. Web push (M5)

```bash
npx web-push generate-vapid-keys
```

- Put the **public** key in `.env.local` as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.
- The private key only goes into Supabase secrets, below.

Generate a random cron secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the function secrets (after `npx supabase link`):

```bash
npx supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:<your-email> CRON_SECRET=<random>
```

Deploy the sweep. `--no-verify-jwt` is intentional: the function checks `CRON_SECRET` itself.

```bash
npx supabase functions deploy reminder-sweep --no-verify-jwt
```

Schedule it. Open `supabase/cron.sql` and replace `<PROJECT_REF>` and `<CRON_SECRET>` **in the SQL editor only**, without saving them to the file. Then run it.

Trigger it by hand (this is also the M5 dedup test: run it twice, and the second run should report `reminders: 0`):

```powershell
$h = @{ Authorization = "Bearer <CRON_SECRET>" }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/reminder-sweep" -Headers $h
```

## 4. Install on Windows (R1)

Push only works in the production build:

```bash
npm run build
```
```bash
npx serve -s out -l 4000
```

Open `http://localhost:4000` in Edge or Chrome, sign in, and click **Enable reminders**. Then use the install icon in the address bar. For real use, deploy it (step 5) and install from that URL instead.

## 5. Deploy the PWA (Vercel)

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new). The Next.js preset works as-is: `output: 'export'` produces `out/`.
2. Add the `NEXT_PUBLIC_*` variables from `.env.local` in **Project → Settings → Environment Variables**.
3. Add the Vercel URL to the Supabase redirect URLs (step 2.3).

## 6. Android APK (M7)

1. Install [Android Studio](https://developer.android.com/studio). It includes JDK 21 and the SDK. Open it once so it finishes downloading the SDK.
2. Point the build at Android Studio's JDK for this shell:
   ```powershell
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
   ```
3. Create the signing key in the project root. `*.keystore` is gitignored. **Back it up and keep the passwords safe:** if you lose it, you can't ship updates to the installed app.
   ```powershell
   & "$env:JAVA_HOME\bin\keytool.exe" -genkey -v -keystore todo-release.keystore -alias todo -keyalg RSA -keysize 2048 -validity 10000
   ```
4. Create `android/keystore.properties` (also gitignored):
   ```properties
   storeFile=../../todo-release.keystore
   storePassword=<your store password>
   keyAlias=todo
   keyPassword=<your key password>
   ```
5. Build the release APK:
   ```bash
   npm run android:release
   ```
   It is written to `android/app/build/outputs/apk/release/app-release.apk`.
6. Sideload it onto the Pixel. Copy the APK over and open it (allow "install unknown apps"), or with USB debugging on:
   ```bash
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```
7. On first launch, sign in. When you create your first task, allow notifications. Then go to **Settings → This device → Exempt app** so battery optimisation can't delay alarms.

`NEXT_PUBLIC_*` values are baked into the build, so after changing `.env.local`, rebuild the APK.

### Optional: server push to Android (FCM)

Local alarms already cover lead and due reminders offline. FCM adds the overdue nag and the morning digest on the phone, plus a backup for tasks the phone hasn't synced yet.

1. In [Firebase console](https://console.firebase.google.com), create a project, add an Android app with package `com.rayyantaimoor.todo`, and download `google-services.json` to `android/app/`. It's gitignored.
2. **Project settings → Service accounts → Generate new private key**, then store it as a secret:
   ```powershell
   npx supabase secrets set FCM_SERVICE_ACCOUNT="$(Get-Content -Raw .\service-account.json)"
   ```
   Then delete the downloaded JSON file.
3. Set `NEXT_PUBLIC_FCM_ENABLED=true` in `.env.local` and rebuild the APK.

---

## Verification checklist (PLAN.md §1)

| Req | How to check |
|---|---|
| R1 | Installed PWA opens in its own window on Windows |
| R2 | APK installed on the Pixel |
| R3 | "Sign in with Google" works on both devices |
| R4 | Signed in on laptop and phone at the same time |
| R5 | Close and reopen both the next day: still signed in |
| R6 | `supabase/verify_rls.sql`: another user's task is invisible |
| R7 | Day/week/month tasks appear in the right views |
| R8 | A task due in 2 min with scope `day` triggers a push on Windows with the tab closed. On the phone in airplane mode, the local alarm fires on time |
| R9 | Set the digest time 2 minutes ahead in Settings: one digest arrives, and running the sweep again doesn't send a second |
| R10 | Phone reminders fire with the app closed |
| R11 | Add a task on one device and it appears on the other within a second. Add a task in airplane mode, reconnect, and it syncs |

## Behaviour that differs from PLAN.md

- **Android dedup (§6.5).** Capacitor local notifications have no `tag`, so "same tag replaces" can't dedupe an alarm against an FCM message. Instead, after rescheduling alarms the phone reports the newest server `updated_at` it has applied (`touch_device`). The sweep sends lead and due pushes to Android only for tasks changed after that point. Overdue nags and digests always go out.
- **Timezones** use `Intl` instead of Luxon, so the shared `reminders.ts` runs unchanged in Deno and the browser.
- **Quiet hours also apply to the digest.** Settings warns you if the digest time falls inside quiet hours.
- **Sign-out clears the device's local cache.** A different account signing in on the same browser starts clean.
