// Domain model for the sustainable streak tracker.
//
// The app used to model classic 75 Hard: a fixed five-habit checklist that was
// all-or-nothing and broke the streak on a single miss. That brittleness is
// gone. The model below is built around three ideas:
//   1. Every daily floor item is completable even on a bad day.
//   2. Every item advances a real goal (training + LeetCode prep).
//   3. The system bends under disruption instead of resetting to zero.
//
// IMPORTANT: existing history from the original run is preserved. Old daily
// docs used a different set of fields (workout1, strictDiet, ...). We never
// rewrite them — `recordFromData` maps the old fields onto the new shape for
// read-only display, and brand-new days are written with the new fields.

export type LeetcodeLog = {
  name?: string;
  /** two pointers, sliding window, BFS/DFS, DP, etc. */
  pattern?: string;
  note?: string;
};

export type DailyRecord = {
  /** Movement, with one outdoor element (real session or zone-2 walk/mobility). */
  movement: boolean;
  /** At least one LeetCode problem. */
  leetcode: boolean;
  /** Read 10 pages. */
  read: boolean;
  /** Hit the nutrition target for the current phase. */
  nutrition: boolean;
  /** Hydration target met. */
  hydration: boolean;
  /** Hold the lines: stay off passive feeds, no slip-ups. */
  holdLines: boolean;
  /** A travel/chaos day that runs the stripped floor instead of the full one. */
  disruption: boolean;
  /** Optional daily body progress photo. Never gates day-complete. */
  progressPhotoUrl: string;
  /** Optional LeetCode log entry attached to the day. */
  leetcodeLog?: LeetcodeLog;
  /** Whether the day's required floor was satisfied (normalized on read). */
  complete: boolean;
  /** True when this record came from the original (pre-refactor) schema. */
  legacy: boolean;
  /** Legacy display flag from the old repair-token system. */
  repaired?: boolean;
  updatedAt?: unknown;
};

export type Phase = {
  /** e.g. "Lean bulk", "Mini-cut". */
  label: string;
  proteinTarget: number;
  calorieTarget: number;
};

/** An optional, time-boxed intensification. Off by default. */
export type HardBlock = {
  active: boolean;
  days: number;
  startDate: string;
};

/**
 * A streak is an epoch: a span with an id, a start date, an end date (null
 * while active) and an optional label. All day records, photos and logs belong
 * to the epoch whose date range contains their date.
 */
export type Epoch = {
  id: string;
  startDate: string;
  endDate: string | null;
  label?: string;
  createdAt?: unknown;
};

export type UserProfile = {
  startDate: string;
  name?: string | null;
  createdAt?: unknown;
  email?: string | null;
  phoneNumber?: string | null;
  timezone?: string;
  phase?: Phase;
  hardBlock?: HardBlock;
};

export type WeeklyReview = {
  note: string;
  updatedAt?: unknown;
};

export const defaultPhase: Phase = {
  label: "Lean bulk",
  proteinTarget: 180,
  calorieTarget: 2800,
};

export const leetcodePatterns = [
  "Two pointers",
  "Sliding window",
  "Hashing",
  "Binary search",
  "Stack",
  "Linked list",
  "Trees",
  "BFS/DFS",
  "Backtracking",
  "Greedy",
  "Dynamic programming",
  "Graphs",
  "Heap",
  "Intervals",
  "Bit manipulation",
  "Math",
  "Other",
] as const;

export const floorKeys = [
  "movement",
  "leetcode",
  "read",
  "nutrition",
  "hydration",
  "holdLines",
] as const;

/** The stripped floor a disruption day must clear. */
export const disruptionFloorKeys = ["movement", "leetcode", "read", "holdLines"] as const;

export type FloorKey = (typeof floorKeys)[number];

export const emptyDailyRecord: DailyRecord = {
  movement: false,
  leetcode: false,
  read: false,
  nutrition: false,
  hydration: false,
  holdLines: false,
  disruption: false,
  progressPhotoUrl: "",
  complete: false,
  legacy: false,
};

// ---------------------------------------------------------------------------
// Date helpers (all keys are local-time "YYYY-MM-DD" strings).
// ---------------------------------------------------------------------------

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

export function addDays(dateKey: string, amount: number) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + amount);
  return todayKey(date);
}

export function daysBetween(startKey: string, endKey: string) {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** 1-based day number within an epoch, where the start date is day 1. */
export function dayNumberInEpoch(startDate: string, dateKey = todayKey()) {
  return Math.max(daysBetween(startDate, dateKey) + 1, 1);
}

export function enumerateDateKeys(startKey: string, endKey: string) {
  const keys: string[] = [];
  if (endKey < startKey) return keys;
  let cursor = startKey;
  // Guard against accidental runaway loops on malformed input.
  for (let i = 0; i < 100_000 && cursor <= endKey; i += 1) {
    keys.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return keys;
}

/** Monday of the week containing `dateKey`. Used to key weekly reviews. */
export function weekStartKey(dateKey = todayKey()) {
  const date = parseDateKey(dateKey);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return todayKey(date);
}

// ---------------------------------------------------------------------------
// Record normalization (forward-compatible reads of legacy docs).
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>;

const NEW_KEYS = [
  "movement",
  "read",
  "nutrition",
  "hydration",
  "holdLines",
  "leetcode",
  "disruption",
  "complete",
];

const OLD_KEYS = [
  "workout1",
  "outsideWorkout",
  "strictDiet",
  "waterGallon",
  "read10Pages",
  "leetcode30",
  "status",
];

function hasAnyKey(data: RawRecord, keys: string[]) {
  return keys.some((key) => data[key] !== undefined);
}

/** Returns the first defined key as a boolean, else false. */
function pickBool(data: RawRecord, ...keys: string[]) {
  for (const key of keys) {
    if (data[key] !== undefined) return Boolean(data[key]);
  }
  return false;
}

export function recordFromData(data?: RawRecord): DailyRecord {
  if (!data) return { ...emptyDailyRecord };

  const legacy = !hasAnyKey(data, NEW_KEYS) && hasAnyKey(data, OLD_KEYS);

  const base: DailyRecord = {
    movement: pickBool(data, "movement", "workout1") || pickBool(data, "outsideWorkout"),
    leetcode: pickBool(data, "leetcode", "leetcode30"),
    read: pickBool(data, "read", "read10Pages"),
    nutrition: pickBool(data, "nutrition", "strictDiet"),
    hydration: pickBool(data, "hydration", "waterGallon"),
    holdLines: pickBool(data, "holdLines"),
    disruption: pickBool(data, "disruption"),
    progressPhotoUrl: typeof data.progressPhotoUrl === "string" ? data.progressPhotoUrl : "",
    leetcodeLog: (data.leetcodeLog as LeetcodeLog | undefined) ?? undefined,
    complete: false,
    legacy,
    repaired: data.repaired === true,
    updatedAt: data.updatedAt,
  };

  if (legacy) {
    // Preserve the original day's completion judgment exactly. Old days counted
    // once they reached at least a gold star (status !== "gray").
    base.complete = typeof data.status === "string" && data.status !== "gray";
  } else {
    base.complete = computeComplete(base);
  }

  return base;
}

export function requiredFloorKeys(record: Pick<DailyRecord, "disruption">) {
  return record.disruption ? disruptionFloorKeys : floorKeys;
}

function computeComplete(record: DailyRecord) {
  return requiredFloorKeys(record).every((key) => Boolean(record[key]));
}

/**
 * A day counts toward the streak when its required floor is met. Legacy days
 * use their preserved completion; live days are recomputed from their toggles
 * so the UI always reflects the current state.
 */
export function isDayComplete(record?: DailyRecord) {
  if (!record) return false;
  if (record.legacy) return record.complete;
  return requiredFloorKeys(record).every((key) => Boolean(record[key]));
}

/** The writeable subset of a day, using the new schema only. */
export function dailyToFirestore(record: DailyRecord) {
  const payload: RawRecord = {
    movement: record.movement,
    leetcode: record.leetcode,
    read: record.read,
    nutrition: record.nutrition,
    hydration: record.hydration,
    holdLines: record.holdLines,
    disruption: record.disruption,
    progressPhotoUrl: record.progressPhotoUrl,
    complete: isDayComplete(record),
  };
  if (record.leetcodeLog) payload.leetcodeLog = record.leetcodeLog;
  return payload;
}

// ---------------------------------------------------------------------------
// Epochs.
// ---------------------------------------------------------------------------

export function activeEpoch(epochs: Epoch[]) {
  return epochs.find((epoch) => epoch.endDate === null) ?? null;
}

export function archivedEpochs(epochs: Epoch[]) {
  return epochs
    .filter((epoch) => epoch.endDate !== null)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export function epochRangeEnd(epoch: Epoch, today = todayKey()) {
  return epoch.endDate ?? today;
}

export function dateInEpoch(epoch: Epoch, dateKey: string, today = todayKey()) {
  return dateKey >= epoch.startDate && dateKey <= epochRangeEnd(epoch, today);
}

export function recordsForEpoch(
  progress: Record<string, DailyRecord>,
  epoch: Epoch,
  today = todayKey(),
) {
  const result: Record<string, DailyRecord> = {};
  for (const [dateKey, record] of Object.entries(progress)) {
    if (dateInEpoch(epoch, dateKey, today)) result[dateKey] = record;
  }
  return result;
}

export type DayState = "complete" | "disruption" | "miss" | "today" | "future";

export function dayState(
  record: DailyRecord | undefined,
  dateKey: string,
  today = todayKey(),
): DayState {
  if (isDayComplete(record)) return record!.disruption ? "disruption" : "complete";
  if (dateKey > today) return "future";
  if (dateKey === today) return "today";
  return "miss";
}

export type EpochStats = {
  lengthDays: number;
  completed: number;
  missed: number;
  disruptionDays: number;
  photos: number;
};

export function epochStats(
  progress: Record<string, DailyRecord>,
  epoch: Epoch,
  today = todayKey(),
): EpochStats {
  const keys = enumerateDateKeys(epoch.startDate, epochRangeEnd(epoch, today));
  let completed = 0;
  let missed = 0;
  let disruptionDays = 0;
  let photos = 0;

  for (const key of keys) {
    const record = progress[key];
    if (isDayComplete(record)) {
      completed += 1;
      if (record!.disruption) disruptionDays += 1;
    } else if (key < today) {
      // A past day that was never completed is a recorded miss. It never resets
      // the streak — the count simply doesn't grow for that day.
      missed += 1;
    }
    if (record?.progressPhotoUrl) photos += 1;
  }

  return { lengthDays: keys.length, completed, missed, disruptionDays, photos };
}

export type LeetcodeEntry = LeetcodeLog & { dateKey: string };

export function leetcodeEntries(
  progress: Record<string, DailyRecord>,
  epoch?: Epoch,
  today = todayKey(),
): LeetcodeEntry[] {
  const entries: LeetcodeEntry[] = [];
  for (const [dateKey, record] of Object.entries(progress)) {
    if (epoch && !dateInEpoch(epoch, dateKey, today)) continue;
    const log = record.leetcodeLog;
    if (log && (log.name || log.pattern || log.note)) {
      entries.push({ dateKey, ...log });
    }
  }
  return entries.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

// ---------------------------------------------------------------------------
// Hard-block mode (optional, off by default).
// ---------------------------------------------------------------------------

export function hardBlockActive(hardBlock: HardBlock | undefined, today = todayKey()) {
  if (!hardBlock?.active) return false;
  const end = addDays(hardBlock.startDate, hardBlock.days - 1);
  return today >= hardBlock.startDate && today <= end;
}

export function hardBlockRemaining(hardBlock: HardBlock | undefined, today = todayKey()) {
  if (!hardBlockActive(hardBlock, today)) return 0;
  const end = addDays(hardBlock!.startDate, hardBlock!.days - 1);
  return daysBetween(today, end) + 1;
}
