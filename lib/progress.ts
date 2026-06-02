export type StarStatus = "gray" | "gold" | "blue";

export type DailyRecord = {
  workout1: boolean;
  outsideWorkout: boolean;
  strictDiet: boolean;
  waterGallon: boolean;
  read10Pages: boolean;
  progressPhotoUrl: string;
  leetcode30: boolean;
  status: StarStatus;
  /**
   * Set when a day was retroactively checked off by spending an earned
   * blue-star repair token. A repair only fills the five core habits (never
   * LeetCode), so a repaired day tops out at a gold star and can never mint a
   * new token of its own — the economy can't be farmed.
   */
  repaired?: boolean;
  updatedAt?: unknown;
};

export type UserProfile = {
  startDate: string;
  name?: string | null;
  createdAt?: unknown;
  email?: string | null;
  phoneNumber?: string | null;
  timezone?: string;
  fcmTokens?: string[];
  lastSent?: { morning?: string; evening?: string; night?: string };
};

export const coreTaskKeys = [
  "workout1",
  "outsideWorkout",
  "strictDiet",
  "waterGallon",
  "read10Pages",
] as const;

export const emptyDailyRecord: DailyRecord = {
  workout1: false,
  outsideWorkout: false,
  strictDiet: false,
  waterGallon: false,
  read10Pages: false,
  progressPhotoUrl: "",
  leetcode30: false,
  status: "gray",
  repaired: false,
};

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function dayNumberFromStart(startDate: string, dateKey = todayKey()) {
  const start = parseDateKey(startDate);
  const current = parseDateKey(dateKey);
  const diffMs = current.getTime() - start.getTime();
  const day = Math.floor(diffMs / 86_400_000) + 1;
  return Math.min(Math.max(day, 1), 75);
}

export function dateKeyForDay(startDate: string, dayNumber: number) {
  const date = parseDateKey(startDate);
  date.setDate(date.getDate() + dayNumber - 1);
  return todayKey(date);
}

export function calculateStatus(record: DailyRecord): StarStatus {
  const completedCore = coreTaskKeys.every((key) => record[key]);
  const hasPhoto = Boolean(record.progressPhotoUrl);

  if (completedCore && hasPhoto && record.leetcode30) {
    return "blue";
  }

  if (completedCore && hasPhoto) {
    return "gold";
  }

  return "gray";
}

export type TokenStats = {
  /** Blue stars earned the honest way (not via a repair). */
  earned: number;
  /** Repair tokens already spent fixing past days. */
  spent: number;
  /** Repair tokens currently available to spend. */
  available: number;
};

export function tokenStats(progress: Record<string, DailyRecord>): TokenStats {
  let earned = 0;
  let spent = 0;

  for (const record of Object.values(progress)) {
    if (record.repaired) {
      spent += 1;
    } else if (record.status === "blue") {
      earned += 1;
    }
  }

  return { earned, spent, available: Math.max(earned - spent, 0) };
}

/** A day counts toward a streak once it reaches at least a gold star. */
export function isDayComplete(record?: DailyRecord) {
  return Boolean(record) && record!.status !== "gray";
}

/**
 * Longest run of completed days ending on the most recent completed day,
 * walking backward from the current day.
 */
export function currentStreak(
  progress: Record<string, DailyRecord>,
  startDate: string,
  currentDay: number,
) {
  let streak = 0;
  let started = false;

  for (let day = currentDay; day >= 1; day -= 1) {
    const record = progress[dateKeyForDay(startDate, day)];
    if (isDayComplete(record)) {
      streak += 1;
      started = true;
    } else if (started) {
      break;
    } else {
      // Allow today to still be in progress without breaking yesterday's run.
      if (day !== currentDay) break;
    }
  }

  return streak;
}
