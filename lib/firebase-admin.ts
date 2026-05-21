import { cert, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount & { private_key?: string };
    if (parsed.private_key && typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch {
    return null;
  }
}

let cached: App | null = null;

function adminApp(): App | null {
  if (cached) return cached;
  const existing = getApps()[0];
  if (existing) {
    cached = existing;
    return cached;
  }
  const sa = loadServiceAccount();
  if (!sa) return null;
  cached = initializeApp({ credential: cert(sa) });
  return cached;
}

export function adminDb(): Firestore | null {
  const app = adminApp();
  return app ? getFirestore(app) : null;
}

export function adminMessaging(): Messaging | null {
  const app = adminApp();
  return app ? getMessaging(app) : null;
}
