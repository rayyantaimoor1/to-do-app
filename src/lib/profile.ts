import { supabase } from "@/lib/supabase";
import { db, getMeta, setMeta } from "@/lib/db";

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  timezone: string;
  digest_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

export type ProfileSettings = Pick<
  Profile,
  "timezone" | "digest_time" | "quiet_hours_start" | "quiet_hours_end"
>;

/**
 * Cached in IndexedDB so local alarms (quiet hours) and the settings screen
 * work offline. Lives in the meta table under this key.
 */
export const PROFILE_KEY = "profile";

const COLUMNS =
  "id,email,display_name,timezone,digest_time,quiet_hours_start,quiet_hours_end";

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export async function cachedProfile(): Promise<Profile | null> {
  const raw = await getMeta(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

async function cache(profile: Profile) {
  await setMeta(PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Fetch the profile and cache it. On first login the row still has the
 * column default 'UTC'; replace it with this device's zone — the digest is
 * wrong without it (§5). Later changes are manual (§12 note 4).
 */
export async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(COLUMNS)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  let profile = data as Profile;
  const tz = deviceTimeZone();
  if (profile.timezone === "UTC" && tz !== "UTC") {
    profile = (await updateProfile(userId, { timezone: tz })) ?? profile;
  }
  await cache(profile);
  return profile;
}

export async function updateProfile(
  userId: string,
  patch: Partial<ProfileSettings>,
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) await cache(data as Profile);
  return (data as Profile) ?? null;
}

export async function clearCachedProfile() {
  await db.meta.delete(PROFILE_KEY);
}
