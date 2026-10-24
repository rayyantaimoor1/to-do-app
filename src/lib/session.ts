import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import { clearLocalData } from "@/lib/sync";
import { unregisterThisDevice } from "@/lib/push";
import { cancelAllAlarms } from "@/lib/notifications";

/** Writes made on this device that haven't reached Supabase yet. */
export function unsyncedChanges(): Promise<number> {
  return db.outbox.count();
}

/**
 * Sign out this device, or every device (§5 "Sign out everywhere").
 *
 * Push registrations are removed while the session is still valid (RLS
 * needs it), so a signed-out device stops receiving that user's reminders.
 * "Everywhere" removes every device's registration, since revoking refresh
 * tokens alone wouldn't stop the cron sweep from pushing to them.
 */
export async function signOut(scope: "local" | "global"): Promise<void> {
  try {
    if (scope === "global") {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user.id;
      if (userId) {
        await supabase.from("push_subscriptions").delete().eq("user_id", userId);
      }
    }
    await unregisterThisDevice();
  } catch (err) {
    // Offline or already expired — signing out must still work.
    console.warn("Couldn't remove push registration:", err);
  }

  const { error } = await supabase.auth.signOut({ scope });
  // A global sign-out has to reach the server; a local one can't fail in a
  // way that matters (supabase-js clears the local session regardless).
  if (error && scope === "global") throw error;

  await cancelAllAlarms().catch(() => {});
  await clearLocalData();
}
