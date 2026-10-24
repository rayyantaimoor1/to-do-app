import { supabase } from "@/lib/supabase";
import { getMeta, setMeta, db } from "@/lib/db";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const ENDPOINT_KEY = "push_endpoint";

export type PushState =
  | "unsupported"
  | "needs-production-build"
  | "default"
  | "denied"
  | "enabled";

export function webPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    VAPID_PUBLIC_KEY.length > 0
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** "Windows · Edge", "Android · Chrome", ... shown in the device list. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? "Android"
    : /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? /iPhone|iPad/.test(ua)
          ? "iOS"
          : "macOS"
        : /Linux/.test(ua)
          ? "Linux"
          : "Unknown OS";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${os} · ${browser}`;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  // The service worker is only registered in production builds (see
  // RegisterServiceWorker), so `ready` would hang forever in dev.
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function webPushState(): Promise<PushState> {
  if (!webPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  const reg = await registration();
  if (!reg) return "needs-production-build";
  return (await reg.pushManager.getSubscription()) ? "enabled" : "default";
}

async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON();
  const { error } = await supabase.rpc("register_device", {
    p_platform: "web",
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? null,
    p_auth_key: json.keys?.auth ?? null,
    p_device_label: deviceLabel(),
  });
  if (error) throw error;
  await setMeta(ENDPOINT_KEY, sub.endpoint);
}

/** Ask for permission (if needed), subscribe, and register this device. */
export async function enableWebPush(): Promise<PushState> {
  if (!webPushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  const reg = await registration();
  if (!reg) return "needs-production-build";
  await navigator.serviceWorker.ready;

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));
  await saveSubscription(sub);
  return "enabled";
}

/**
 * On startup, re-register an existing subscription. Push services rotate
 * endpoints, and a sign-in as a different user must move the row over.
 */
export async function refreshWebPush(): Promise<void> {
  if (!webPushSupported() || Notification.permission !== "granted") return;
  if (!navigator.onLine) return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await saveSubscription(sub);
}

/** The endpoint this device registered with, if any (web or FCM). */
export function currentEndpoint(): Promise<string | null> {
  return getMeta(ENDPOINT_KEY);
}

export async function rememberEndpoint(endpoint: string): Promise<void> {
  await setMeta(ENDPOINT_KEY, endpoint);
}

/** Remove this device's subscription — used on sign-out. Best effort. */
export async function unregisterThisDevice(): Promise<void> {
  const endpoint = await currentEndpoint();
  if (endpoint) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    await db.meta.delete(ENDPOINT_KEY);
  }
  if (webPushSupported()) {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  }
}
