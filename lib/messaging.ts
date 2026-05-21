import { arrayUnion, doc, setDoc } from "firebase/firestore";
import { getApps, initializeApp } from "firebase/app";
import { auth, db } from "@/lib/firebase";

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: string; needsInstall?: boolean };

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
}

export async function pushSupported() {
  if (typeof window === "undefined") return false;
  if (!("Notification" in window)) return false;
  if (!("serviceWorker" in navigator)) return false;
  try {
    const { isSupported } = await import("firebase/messaging");
    return await isSupported();
  } catch {
    return false;
  }
}

export async function registerPush(): Promise<RegisterResult> {
  if (!(await pushSupported())) {
    return { ok: false, reason: "This browser does not support web push notifications." };
  }

  if (isIos() && !isStandalone()) {
    return {
      ok: false,
      needsInstall: true,
      reason:
        "On iPhone or iPad, install the app first. Tap the share icon in Safari and choose Add to Home Screen, then reopen 75 Hard from the home screen to enable reminders.",
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "Notification permission was not granted." };
  }

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    return { ok: false, reason: "Missing NEXT_PUBLIC_FIREBASE_VAPID_KEY." };
  }

  const swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;

  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const { getMessaging, getToken } = await import("firebase/messaging");
  const messaging = getMessaging(app);

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: swReg,
  });

  if (!token) {
    return { ok: false, reason: "Could not retrieve a push token." };
  }

  if (!auth?.currentUser || !db) {
    return { ok: false, reason: "Sign in before enabling notifications." };
  }

  await setDoc(
    doc(db, "users", auth.currentUser.uid),
    {
      fcmTokens: arrayUnion(token),
      timezone: browserTimezone(),
    },
    { merge: true },
  );

  return { ok: true };
}
