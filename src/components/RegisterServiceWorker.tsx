"use client";

import { useEffect } from "react";
import { isNative } from "@/lib/platform";

export default function RegisterServiceWorker() {
  useEffect(() => {
    // The APK ships its assets locally and gets push via FCM; a service
    // worker would only add a stale-cache layer there.
    if (isNative() || !("serviceWorker" in navigator)) return;

    // In dev, Turbopack rebuilds change chunk URLs constantly and HMR needs
    // an uncached channel to the server. A service worker sitting in the
    // middle fights both. Register only in production builds.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  }, []);

  return null;
}
