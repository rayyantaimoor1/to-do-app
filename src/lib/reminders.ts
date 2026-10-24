// The reminder ladder lives with the edge function so Deno can bundle it;
// the app imports the very same file. Never copy its logic here — the local
// alarm and the server push must agree on fire_key or dedup breaks (§6.5).
export * from "../../supabase/functions/_shared/reminders";
