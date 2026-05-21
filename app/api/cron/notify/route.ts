import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminMessaging } from "@/lib/firebase-admin";
import {
  calculateStatus,
  coreTaskKeys,
  dayNumberFromStart,
  emptyDailyRecord,
  type DailyRecord,
  type UserProfile,
} from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TASK_LABELS: Record<(typeof coreTaskKeys)[number], string> = {
  workout1: "your workout",
  outsideWorkout: "your outside workout",
  strictDiet: "stay on your diet",
  waterGallon: "finish your gallon of water",
  read10Pages: "read 10 pages",
};

type Phase = "morning" | "evening" | "night";

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function localParts(tz: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const year = lookup("year");
    const month = lookup("month");
    const day = lookup("day");
    const hourRaw = lookup("hour");
    if (!year || !month || !day || !hourRaw) return null;
    let hour = Number(hourRaw);
    if (hour === 24) hour = 0;
    return { hour, dateKey: `${year}-${month}-${day}` };
  } catch {
    return null;
  }
}

function joinWithAnd(items: string[]) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function missingItems(record: DailyRecord) {
  const missing: string[] = [];
  for (const key of coreTaskKeys) {
    if (!record[key]) missing.push(TASK_LABELS[key]);
  }
  if (!record.progressPhotoUrl) missing.push("take your progress picture");
  return missing;
}

function buildMessage(
  phase: Phase,
  day: number,
  record: DailyRecord,
): { title: string; body: string } | null {
  if (phase === "morning") {
    return {
      title: `Day ${day} of 75 Hard`,
      body: "Good morning. Stack the day — open your tracker when you're ready.",
    };
  }
  if (phase === "evening") {
    const missing = missingItems(record);
    if (missing.length === 0) return null;
    return {
      title: "75 Hard check-in",
      body: `Still on today's list: ${joinWithAnd(missing)}.`,
    };
  }
  const allDone = coreTaskKeys.every((k) => record[k]) && Boolean(record.progressPhotoUrl);
  if (!allDone) return null;
  return {
    title: "Great work",
    body: "Every box checked today. See you again tomorrow.",
  };
}

function phaseForHour(hour: number): Phase | null {
  if (hour === 7) return "morning";
  if (hour === 19) return "evening";
  if (hour === 22) return "night";
  return null;
}

type ProfileWithExtras = UserProfile & {
  timezone?: string;
  fcmTokens?: string[];
  lastSent?: Partial<Record<Phase, string>>;
};

function isFirebaseError(err: unknown): err is { code?: string; errorInfo?: { code?: string } } {
  return typeof err === "object" && err !== null;
}

function isDeadTokenError(err: unknown) {
  if (!isFirebaseError(err)) return false;
  const code = err.errorInfo?.code ?? err.code ?? "";
  return (
    code.includes("registration-token-not-registered") ||
    code.includes("invalid-registration-token") ||
    code.includes("invalid-argument")
  );
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = adminDb();
  const messaging = adminMessaging();
  if (!db || !messaging) {
    return NextResponse.json({ error: "admin SDK not configured" }, { status: 500 });
  }

  const usersSnap = await db.collection("users").get();
  let sent = 0;
  let skipped = 0;

  for (const userDoc of usersSnap.docs) {
    const profile = userDoc.data() as ProfileWithExtras;
    const tz = profile.timezone;
    const tokens = profile.fcmTokens ?? [];
    if (!tz || !profile.startDate || tokens.length === 0) {
      skipped++;
      continue;
    }

    const local = localParts(tz);
    if (!local) {
      skipped++;
      continue;
    }

    const phase = phaseForHour(local.hour);
    if (!phase) {
      skipped++;
      continue;
    }

    if (profile.lastSent?.[phase] === local.dateKey) {
      skipped++;
      continue;
    }

    const dailySnap = await userDoc.ref.collection("daily").doc(local.dateKey).get();
    const record: DailyRecord = {
      ...emptyDailyRecord,
      ...(dailySnap.exists ? (dailySnap.data() as Partial<DailyRecord>) : {}),
    };
    record.status = calculateStatus(record);

    const day = dayNumberFromStart(profile.startDate, local.dateKey);
    const message = buildMessage(phase, day, record);
    if (!message) {
      await userDoc.ref.set(
        { lastSent: { [phase]: local.dateKey } },
        { merge: true },
      );
      skipped++;
      continue;
    }

    const survivingTokens: string[] = [];
    const deadTokens: string[] = [];

    for (const token of tokens) {
      try {
        await messaging.send({
          token,
          notification: { title: message.title, body: message.body },
          webpush: { fcmOptions: { link: "/" } },
        });
        survivingTokens.push(token);
      } catch (err) {
        if (isDeadTokenError(err)) {
          deadTokens.push(token);
        } else {
          survivingTokens.push(token);
        }
      }
    }

    const updates: Record<string, unknown> = {
      lastSent: { [phase]: local.dateKey },
    };
    if (deadTokens.length > 0) {
      updates.fcmTokens = FieldValue.arrayRemove(...deadTokens);
    }
    await userDoc.ref.set(updates, { merge: true });
    sent += survivingTokens.length;
  }

  return NextResponse.json({ ok: true, sent, skipped });
}
