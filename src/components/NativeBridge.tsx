"use client";

import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import type { PluginListenerHandle } from "@capacitor/core";
import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import { PROFILE_KEY } from "@/lib/profile";
import { currentEndpoint } from "@/lib/push";
import { FCM_ENABLED, REMINDER_CHANNEL_ID, isNative } from "@/lib/platform";
import {
  createReminderChannel,
  notificationId,
  syncAlarms,
} from "@/lib/notifications";

/**
 * Android-only glue (renders nothing). Keeps the OS alarm queue in step with
 * the local task cache — every create/edit/complete/delete, every Realtime
 * event and every reconnect reconcile lands in Dexie, so watching Dexie
 * covers all of them (§6.6).
 */
export default function NativeBridge({
  onOpenUrl,
}: {
  onOpenUrl: (url: string) => void;
}) {
  const native = isNative();
  const openRef = useRef(onOpenUrl);
  useEffect(() => {
    openRef.current = onOpenUrl;
  }, [onOpenUrl]);

  // A cheap fingerprint of everything that affects alarms: open tasks and
  // the cached profile (quiet hours).
  const fingerprint = useLiveQuery(async () => {
    if (!native) return "";
    const tasks = await db.tasks.toArray();
    const profile = await db.meta.get(PROFILE_KEY);
    return (
      tasks.map((t) => `${t.id}|${t.status}|${t.due_at}|${t.updated_at}`).join(",") +
      `#${profile?.value ?? ""}`
    );
  }, [native]);

  useEffect(() => {
    if (!native || fingerprint === undefined) return;
    const timer = setTimeout(async () => {
      void syncAlarms(await currentEndpoint());
    }, 800);
    return () => clearTimeout(timer);
  }, [native, fingerprint]);

  useEffect(() => {
    if (!native) return;
    void createReminderChannel().catch((err) =>
      console.error("Couldn't create notification channel:", err),
    );

    const handles: Promise<PluginListenerHandle>[] = [
      // Supabase's refresh timer doesn't run reliably while the WebView is
      // backgrounded; hand control to the app lifecycle instead.
      App.addListener("appStateChange", async ({ isActive }) => {
        if (isActive) {
          void supabase.auth.startAutoRefresh();
          void syncAlarms(await currentEndpoint());
        } else {
          void supabase.auth.stopAutoRefresh();
        }
      }),
      LocalNotifications.addListener(
        "localNotificationActionPerformed",
        ({ notification }) => {
          const url = notification.extra?.url;
          if (typeof url === "string") openRef.current(url);
        },
      ),
    ];

    if (FCM_ENABLED) {
      handles.push(
        // FCM doesn't display notification messages while the app is in the
        // foreground; show it ourselves.
        PushNotifications.addListener("pushNotificationReceived", (n) => {
          const tag = (n.data?.tag as string | undefined) ?? n.id;
          void LocalNotifications.schedule({
            notifications: [
              {
                id: notificationId(`push:${tag}`),
                title: n.title ?? "To-Do App",
                body: n.body ?? "",
                channelId: REMINDER_CHANNEL_ID,
                extra: { url: n.data?.url },
              },
            ],
          });
        }),
        PushNotifications.addListener(
          "pushNotificationActionPerformed",
          ({ notification }) => {
            const url = notification.data?.url;
            if (typeof url === "string") openRef.current(url);
          },
        ),
      );
    }

    return () => {
      handles.forEach((h) => void h.then((x) => x.remove()));
    };
  }, [native]);

  return null;
}
