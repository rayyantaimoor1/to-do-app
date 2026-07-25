import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// TODO (M7): swap the default localStorage-based auth storage for a
// Capacitor Preferences-backed adapter so sessions survive app restarts
// on Android. See PLAN.md §5.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
