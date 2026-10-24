"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { supabase } from "@/lib/supabase";
import { NATIVE_AUTH_REDIRECT, isNative } from "@/lib/platform";
import TaskApp from "@/components/TaskApp";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      },
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  // Android: the system browser returns here via the custom-scheme deep link
  // carrying a PKCE code.
  useEffect(() => {
    if (!isNative()) return;
    const handle = App.addListener("appUrlOpen", async ({ url }) => {
      if (!url.startsWith(NATIVE_AUTH_REDIRECT)) return;
      const params = new URL(url).searchParams;
      const code = params.get("code");
      void Browser.close().catch(() => {});
      if (!code) {
        setAuthError(params.get("error_description") ?? "Sign-in was cancelled");
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) setAuthError(error.message);
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  const signIn = async () => {
    setAuthError(null);
    if (!isNative()) {
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      return;
    }
    // Google blocks OAuth inside embedded WebViews, so open the system
    // browser and come back through the deep link above.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: NATIVE_AUTH_REDIRECT, skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      setAuthError(error?.message ?? "Couldn't start sign-in");
      return;
    }
    await Browser.open({ url: data.url });
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 text-center dark:bg-black">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          To-Do App
        </h1>
        <button
          onClick={signIn}
          className="rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          Sign in with Google
        </button>
        {authError && <p className="text-sm text-red-600">{authError}</p>}
      </div>
    );
  }

  return <TaskApp session={session} />;
}
