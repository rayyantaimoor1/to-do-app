import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { Preferences } from "@capacitor/preferences";
import { isNative } from "@/lib/platform";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Android WebView storage can be cleared by the OS; Capacitor Preferences is
 * backed by SharedPreferences, so the session survives app restarts (§5).
 */
const preferencesStorage: SupportedStorage = {
  getItem: async (key) => (await Preferences.get({ key })).value,
  setItem: async (key, value) => {
    await Preferences.set({ key, value });
  },
  removeItem: async (key) => {
    await Preferences.remove({ key });
  },
};

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey,
  isNative()
    ? {
        auth: {
          storage: preferencesStorage,
          persistSession: true,
          autoRefreshToken: true,
          // The OAuth callback arrives as a deep link handled in page.tsx,
          // not in the WebView's URL, and PKCE is required for that flow.
          detectSessionInUrl: false,
          flowType: "pkce",
        },
      }
    : undefined,
);
