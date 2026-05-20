export type StarStatus = "gray" | "gold" | "blue";

export type DailyRecord = {
  workout1: boolean;
  workout2: boolean;
  outsideWorkout: boolean;
  strictDiet: boolean;
  waterGallon: boolean;
  read10Pages: boolean;
  progressPhotoUrl: string;
  leetcode30: boolean;
  status: StarStatus;
  updatedAt?: unknown;
};

export type UserProfile = {
  startDate: string;
  createdAt?: unknown;
  email?: string | null;
  phoneNumber?: string | null;
};

export const coreTaskKeys = [
  "workout1",
  "workout2",
  "outsideWorkout",
  "strictDiet",
  "waterGallon",
  "read10Pages",
] as const;

export const emptyDailyRecord: DailyRecord = {
  workout1: false,
  workout2: false,
  outsideWorkout: false,
  strictDiet: false,
  waterGallon: false,
  read10Pages: false,
  progressPhotoUrl: "",
  leetcode30: false,
  status: "gray",
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
