import type { CapacitorConfig } from "@capacitor/cli";

// appId must match NATIVE_APP_ID in src/lib/platform.ts and the deep-link
// scheme in android/app/src/main/AndroidManifest.xml.
const config: CapacitorConfig = {
  appId: "com.rayyantaimoor.todo",
  appName: "To-Do",
  // `next build` with output: 'export' writes the static app here.
  webDir: "out",
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_notify",
      iconColor: "#4338CA",
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
