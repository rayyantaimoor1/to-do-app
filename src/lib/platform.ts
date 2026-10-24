import { Capacitor } from "@capacitor/core";

/** Must match capacitor.config.ts `appId` and the Android intent filter. */
export const NATIVE_APP_ID = "com.rayyantaimoor.todo";

/**
 * Where Google OAuth returns to on Android. Google refuses sign-in inside
 * embedded WebViews, so the APK signs in through the system browser and is
 * reopened via this custom-scheme deep link. Add it to Supabase Auth →
 * URL Configuration → Redirect URLs.
 */
export const NATIVE_AUTH_REDIRECT = `${NATIVE_APP_ID}://auth-callback`;

/** Android channel for reminders; FCM messages target the same id. */
export const REMINDER_CHANNEL_ID = "reminders";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Server push to Android needs a Firebase project (google-services.json). */
export const FCM_ENABLED = process.env.NEXT_PUBLIC_FCM_ENABLED === "true";
