"use client";

import {
  Archive,
  BookOpen,
  CalendarDays,
  Camera,
  Check,
  ChevronRight,
  Code,
  Droplets,
  Dumbbell,
  Flag,
  Flame,
  ImageIcon,
  LogOut,
  Phone,
  Plane,
  Plus,
  Salad,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  RecaptchaVerifier,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
  type ConfirmationResult,
  type User,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, db, isFirebaseConfigured, storage } from "@/lib/firebase";
import {
  activeEpoch,
  addDays,
  archivedEpochs,
  dailyToFirestore,
  dateInEpoch,
  dayNumberInEpoch,
  dayState,
  defaultPhase,
  emptyDailyRecord,
  enumerateDateKeys,
  epochRangeEnd,
  epochStats,
  floorKeys,
  hardBlockActive,
  hardBlockRemaining,
  isDayComplete,
  leetcodeEntries,
  leetcodePatterns,
  recordFromData,
  requiredFloorKeys,
  todayKey,
  weekStartKey,
  type DailyRecord,
  type Epoch,
  type FloorKey,
  type HardBlock,
  type LeetcodeLog,
  type Phase,
  type UserProfile,
} from "@/lib/progress";
import { browserTimezone } from "@/lib/messaging";

type ViewMode = "today" | "history" | "archive";
const recaptchaContainerId = "phone-recaptcha-container";
const appVersion = "0.2.0";

type InfoTopic = { title: string; body: string };

const infoTopics = {
  streak: {
    title: "Your streak",
    body: "The number of days you've completed in the current streak. A missed day is recorded but never resets the count to zero — you just pick up where you left off. Only you can end a streak.",
  },
  disruption: {
    title: "Disruption mode",
    body: "For travel or chaotic days. It swaps the full floor for a stripped version: one bout of movement, one LeetCode problem, 10 pages, and holding the lines. A completed disruption day is a fully valid day and advances your streak.",
  },
  floor: {
    title: "The daily floor",
    body: "A short binary checklist designed to be completable even on your worst day. Check every required item and the day is done. The optional progress photo is encouraged but never required.",
  },
} satisfies Record<string, InfoTopic>;

type FloorItem = {
  key: FloorKey;
  title: string;
  hint: string;
  icon: React.ReactNode;
};

function floorItems(phase: Phase): FloorItem[] {
  return [
    {
      key: "movement",
      title: "Movement",
      hint: "Train, or a 30–45 min outdoor walk / zone 2 / mobility",
      icon: <Dumbbell size={20} />,
    },
    {
      key: "leetcode",
      title: "LeetCode",
      hint: "At least one problem",
      icon: <Code size={20} />,
    },
    {
      key: "read",
      title: "Read 10 pages",
      hint: "Any book",
      icon: <BookOpen size={20} />,
    },
    {
      key: "nutrition",
      title: "Nutrition",
      hint: `${phase.label}: ${phase.proteinTarget}g protein · ${phase.calorieTarget} kcal`,
      icon: <Salad size={20} />,
    },
    {
      key: "hydration",
      title: "Hydration",
      hint: "Hit your water target",
      icon: <Droplets size={20} />,
    },
    {
      key: "holdLines",
      title: "Hold the lines",
      hint: "Stay off the feeds, no slip-ups",
      icon: <ShieldCheck size={20} />,
    },
  ];
}

function normalizePhoneNumber(value: string) {
  const trimmed = value.trim();

  if (!trimmed) return "";

  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return digits ? `+${digits}` : "";
}

function isHeicFile(file: File) {
  return /image\/hei[cf]/i.test(file.type) || /\.(hei[cf])$/i.test(file.name);
}

function isAcceptedImage(file: File) {
  return file.type.startsWith("image/") || isHeicFile(file);
}

function fileExtension(file: File) {
  const subtype = file.type.split("/")[1]?.toLowerCase();

  if (subtype) return subtype.replace("jpeg", "jpg");

  return file.name.split(".").pop()?.toLowerCase() || "jpg";
}

async function uploadableImage(file: File) {
  if (!isHeicFile(file)) return file;

  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.88,
  });
  const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
  const filename = file.name.replace(/\.(hei[cf])$/i, ".jpg") || "progress-photo.jpg";

  return new File([jpegBlob], filename, { type: "image/jpeg" });
}

function displayNameLabel(name: string) {
  return name.trim() || "there";
}

function formatRange(start: string, end: string) {
  const fmt = (key: string) =>
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
      new Date(`${key}T00:00:00`),
    );
  return `${fmt(start)} – ${fmt(end)}`;
}

function newEpochId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [authMessage, setAuthMessage] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileName, setProfileName] = useState("");
  const [startDate, setStartDate] = useState(todayKey());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsName, setSettingsName] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [phaseDraft, setPhaseDraft] = useState<Phase>(defaultPhase);
  const [hardBlockDraft, setHardBlockDraft] = useState<HardBlock>({
    active: false,
    days: 14,
    startDate: todayKey(),
  });
  const [daily, setDaily] = useState<DailyRecord>(emptyDailyRecord);
  const [progress, setProgress] = useState<Record<string, DailyRecord>>({});
  const [progressLoaded, setProgressLoaded] = useState(false);
  const [epochs, setEpochs] = useState<Epoch[]>([]);
  const [epochsLoaded, setEpochsLoaded] = useState(false);
  const [epochReloadKey, setEpochReloadKey] = useState(0);
  const [view, setView] = useState<ViewMode>("today");
  const [browseEpochId, setBrowseEpochId] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profileStatus, setProfileStatus] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [info, setInfo] = useState<InfoTopic | null>(null);

  // Migration / new-streak flow.
  const [needsMigration, setNeedsMigration] = useState(false);
  const [migrationEnd, setMigrationEnd] = useState(todayKey());
  const [migrationLabel, setMigrationLabel] = useState("Original 75 Hard");
  const [newStreakLabel, setNewStreakLabel] = useState("");
  const [newStreakStart, setNewStreakStart] = useState(todayKey());

  // Weekly review. Reviews are keyed by the Monday of the week they cover and
  // belong to whichever epoch contains that date, so archived streaks keep their
  // recaps. The recap surfaces as a Sunday/Monday pop-up, not an inline panel.
  const [reviews, setReviews] = useState<Record<string, { note: string }>>({});
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  const [recapNote, setRecapNote] = useState("");
  const recapPromptedRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoUploadDateKeyRef = useRef<string | null>(null);
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);
  const bootstrapRef = useRef(false);

  const currentDateKey = todayKey();
  const displayName = displayNameLabel(profile?.name || user?.displayName || profileName);
  const phase = profile?.phase ?? defaultPhase;

  const earliestDataDate = useMemo(() => {
    const keys = Object.keys(progress);
    if (keys.length === 0) return null;
    return keys.reduce((earliest, key) => (key < earliest ? key : earliest));
  }, [progress]);
  const latestDataDate = useMemo(() => {
    const keys = Object.keys(progress);
    if (keys.length === 0) return null;
    return keys.reduce((latest, key) => (key > latest ? key : latest));
  }, [progress]);

  const active = useMemo(() => activeEpoch(epochs), [epochs]);
  const archived = useMemo(() => archivedEpochs(epochs), [epochs]);
  const browseEpoch = useMemo(
    () => (browseEpochId ? epochs.find((epoch) => epoch.id === browseEpochId) ?? null : null),
    [browseEpochId, epochs],
  );
  const viewedEpoch = browseEpoch ?? active;
  const isBrowsingArchive = Boolean(browseEpoch);

  const stats = useMemo(
    () => (active ? epochStats(progress, active, currentDateKey) : null),
    [active, progress, currentDateKey],
  );
  const viewedStats = useMemo(
    () => (viewedEpoch ? epochStats(progress, viewedEpoch, currentDateKey) : null),
    [viewedEpoch, progress, currentDateKey],
  );

  const hardBlockOn = hardBlockActive(profile?.hardBlock, currentDateKey);
  const hardBlockLeft = hardBlockRemaining(profile?.hardBlock, currentDateKey);
  // A hard block forces the full floor — disruption mode is paused while it runs.
  const effectiveDisruption = daily.disruption && !hardBlockOn;
  const requiredKeys = requiredFloorKeys({ disruption: effectiveDisruption });
  const completedToday = requiredKeys.filter((key) => daily[key]).length;
  const todayComplete = isDayComplete({ ...daily, disruption: effectiveDisruption });
  const completionPct = requiredKeys.length
    ? Math.round((completedToday / requiredKeys.length) * 100)
    : 0;
  const currentDay = active ? dayNumberInEpoch(active.startDate, currentDateKey) : 0;

  const items = useMemo(() => floorItems(phase), [phase]);
  const visibleItems = useMemo(
    () => items.filter((item) => requiredKeys.includes(item.key as never)),
    [items, requiredKeys],
  );

  const epochLeetcode = useMemo(
    () => (viewedEpoch ? leetcodeEntries(progress, viewedEpoch, currentDateKey) : []),
    [progress, viewedEpoch, currentDateKey],
  );

  // Weekly reviews that fall inside the streak currently being viewed (works for
  // archived epochs too), newest first.
  const viewedReviews = useMemo(() => {
    if (!viewedEpoch) return [];
    return Object.entries(reviews)
      .filter(([weekStart]) => dateInEpoch(viewedEpoch, weekStart, currentDateKey))
      .map(([weekStart, value]) => ({ weekStart, note: value.note }))
      .filter((entry) => entry.note.trim().length > 0)
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  }, [reviews, viewedEpoch, currentDateKey]);

  // The week to review: on Sunday it's the week ending today; on Monday it's
  // last week. Any other day, there's nothing to prompt.
  const recapWeekStart = useMemo(() => {
    const dow = new Date(`${currentDateKey}T00:00:00`).getDay();
    if (dow === 0) return weekStartKey(currentDateKey);
    if (dow === 1) return weekStartKey(addDays(currentDateKey, -1));
    return null;
  }, [currentDateKey]);

  const recapStats = useMemo(
    () =>
      recapWeekStart
        ? epochStats(
            progress,
            { id: "recap", startDate: recapWeekStart, endDate: addDays(recapWeekStart, 6) },
            currentDateKey,
          )
        : null,
    [progress, recapWeekStart, currentDateKey],
  );

  const persistDay = useCallback(
    async (dateKey: string, nextRecord: DailyRecord) => {
      if (!user || !db) return;
      const activeDb = db;
      setSaving(true);
      try {
        const complete = isDayComplete(nextRecord);
        const normalized: DailyRecord = { ...nextRecord, complete, legacy: false };
        await setDoc(
          doc(activeDb, "users", user.uid, "daily", dateKey),
          { ...dailyToFirestore(normalized), updatedAt: serverTimestamp() },
          { merge: true },
        );
        setProgress((items) => ({ ...items, [dateKey]: normalized }));
        if (dateKey === currentDateKey) setDaily(normalized);
      } finally {
        setSaving(false);
      }
    },
    [currentDateKey, user],
  );

  useEffect(() => {
    if (!auth || !isFirebaseConfigured) {
      setAuthReady(true);
      return;
    }

    const activeAuth = auth;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    setPersistence(activeAuth, browserLocalPersistence)
      .then(() => {
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(activeAuth, (nextUser) => {
          setUser(nextUser);
          setAuthReady(true);
        });
      })
      .catch((error: Error) => {
        setAuthMessage(error.message);
        setAuthReady(true);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    setPhoneNumber(user.phoneNumber ?? "");
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    const loadProfileAndToday = async () => {
      if (!user || !db) {
        setProfile(null);
        setProfileStatus("loading");
        return;
      }
      const activeDb = db;
      setProfileStatus("loading");

      try {
        const profileSnap = await getDoc(doc(activeDb, "users", user.uid));
        if (cancelled) return;

        if (profileSnap.exists()) {
          const nextProfile = profileSnap.data() as UserProfile;
          setProfile(nextProfile);
          setProfileName(nextProfile.name ?? "");
          setStartDate(nextProfile.startDate);
          setProfileStatus("ready");
        } else {
          setProfile(null);
          setProfileStatus("missing");
        }

        const todaySnap = await getDoc(doc(activeDb, "users", user.uid, "daily", currentDateKey));
        if (cancelled) return;
        setDaily(recordFromData(todaySnap.data()));
      } catch (error) {
        if (cancelled) return;
        setProfileStatus("error");
        setAuthMessage(readableError(error));
      }
    };

    loadProfileAndToday();

    return () => {
      cancelled = true;
    };
  }, [currentDateKey, user, reloadKey]);

  useEffect(() => {
    let cancelled = false;

    const loadProgress = async () => {
      if (!user || !db || !profile) return;
      const activeDb = db;

      const snapshot = await getDocs(collection(activeDb, "users", user.uid, "daily"));
      if (cancelled) return;

      const records: Record<string, DailyRecord> = {};
      snapshot.forEach((entry) => {
        records[entry.id] = recordFromData(entry.data());
      });
      setProgress(records);
      setProgressLoaded(true);
    };

    loadProgress().catch((error: Error) => {
      if (!cancelled) setAuthMessage(error.message);
    });

    return () => {
      cancelled = true;
    };
  }, [profile, user]);

  useEffect(() => {
    let cancelled = false;

    const loadEpochs = async () => {
      if (!user || !db || !profile) return;
      const activeDb = db;
      const snapshot = await getDocs(collection(activeDb, "users", user.uid, "epochs"));
      if (cancelled) return;
      const list: Epoch[] = [];
      snapshot.forEach((entry) => {
        const data = entry.data();
        list.push({
          id: entry.id,
          startDate: data.startDate,
          endDate: data.endDate ?? null,
          label: data.label ?? "",
          createdAt: data.createdAt,
        });
      });
      setEpochs(list);
      setEpochsLoaded(true);
    };

    loadEpochs().catch((error: Error) => {
      if (!cancelled) setAuthMessage(error.message);
    });

    return () => {
      cancelled = true;
    };
  }, [profile, user, epochReloadKey]);

  // Bootstrap / migration. Runs once everything is loaded and there are no
  // epochs yet. With existing history we ask for confirmation; a fresh account
  // gets a single active epoch silently.
  useEffect(() => {
    if (!user || !db || !profile || !epochsLoaded || !progressLoaded) return;
    if (epochs.length > 0) return;
    if (bootstrapRef.current) return;

    if (Object.keys(progress).length > 0) {
      setMigrationEnd(latestDataDate ?? currentDateKey);
      setNeedsMigration(true);
    } else {
      bootstrapRef.current = true;
      const activeDb = db;
      setDoc(doc(activeDb, "users", user.uid, "epochs", newEpochId()), {
        startDate: profile.startDate || currentDateKey,
        endDate: null,
        label: "",
        createdAt: serverTimestamp(),
      })
        .then(() => setEpochReloadKey((key) => key + 1))
        .catch((error: Error) => setAuthMessage(error.message));
    }
  }, [
    user,
    profile,
    epochsLoaded,
    progressLoaded,
    epochs,
    progress,
    latestDataDate,
    currentDateKey,
  ]);

  useEffect(() => {
    if (!user || !db || !profile) return;
    const tz = browserTimezone();
    if (profile.timezone === tz) return;
    const activeDb = db;
    setDoc(doc(activeDb, "users", user.uid), { timezone: tz }, { merge: true }).catch(() => {});
  }, [profile, user]);

  useEffect(() => {
    if (!profile) return;
    setSettingsName(profile.name ?? "");
    setPhaseDraft(profile.phase ?? defaultPhase);
    setHardBlockDraft(
      profile.hardBlock ?? { active: false, days: 14, startDate: currentDateKey },
    );
  }, [profile, currentDateKey]);

  // Load every saved weekly review so they can be shown alongside their epoch
  // (including archived ones).
  useEffect(() => {
    let cancelled = false;
    const loadReviews = async () => {
      if (!user || !db || !profile) return;
      const activeDb = db;
      const snapshot = await getDocs(collection(activeDb, "users", user.uid, "reviews"));
      if (cancelled) return;
      const map: Record<string, { note: string }> = {};
      snapshot.forEach((entry) => {
        map[entry.id] = { note: entry.data().note ?? "" };
      });
      setReviews(map);
      setReviewsLoaded(true);
    };
    loadReviews().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, profile]);

  // Surface the recap pop-up once per week, only if it hasn't been saved or
  // dismissed for that week.
  useEffect(() => {
    if (recapPromptedRef.current) return;
    if (!active || !reviewsLoaded || !recapWeekStart) return;
    if (reviews[recapWeekStart]) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(`recap-dismissed-${recapWeekStart}`) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed) return;
    recapPromptedRef.current = true;
    setRecapNote("");
    setRecapOpen(true);
  }, [active, reviewsLoaded, recapWeekStart, reviews]);

  function readableError(error: unknown) {
    if (error instanceof FirebaseError) {
      if (error.code === "auth/operation-not-allowed") {
        return "Phone sign-in is not enabled in Firebase Authentication.";
      }

      if (error.code === "auth/invalid-phone-number") {
        return "Enter the phone number in international format, like +1 555 123 4567.";
      }

      if (error.code === "auth/invalid-app-credential" || error.code === "auth/captcha-check-failed") {
        return "Firebase rejected the phone verification. Check that this domain is authorized and reCAPTCHA can run.";
      }

      if (error.code === "auth/too-many-requests" || error.code === "auth/quota-exceeded") {
        return "Firebase temporarily blocked SMS sends for this number or project. Try again later or use a test number.";
      }

      return `${error.message} (${error.code})`;
    }

    if (error instanceof Error) return error.message;
    return "Something went wrong. Please try again.";
  }

  function getRecaptchaVerifier() {
    if (!auth) return null;
    if (recaptchaVerifierRef.current) return recaptchaVerifierRef.current;

    recaptchaVerifierRef.current = new RecaptchaVerifier(auth, recaptchaContainerId, {
      size: "invisible",
    });

    return recaptchaVerifierRef.current;
  }

  async function sendSmsCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setBusy(true);
    setAuthMessage("");

    try {
      const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
      if (normalizedPhoneNumber.length < 8) {
        throw new Error("Enter a valid phone number.");
      }

      setPhoneNumber(normalizedPhoneNumber);
      const verifier = getRecaptchaVerifier();
      if (!verifier) throw new Error("Phone sign-in is not ready yet.");
      const result = await signInWithPhoneNumber(auth, normalizedPhoneNumber, verifier);
      setConfirmationResult(result);
      setAuthMessage(`Verification code sent to ${normalizedPhoneNumber}.`);
    } catch (error) {
      recaptchaVerifierRef.current?.clear();
      recaptchaVerifierRef.current = null;
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSmsCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmationResult) return;
    setBusy(true);
    setAuthMessage("");

    try {
      await confirmationResult.confirm(smsCode);
      setConfirmationResult(null);
      setSmsCode("");
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !db) return;
    const activeDb = db;
    setBusy(true);
    try {
      const profileRef = doc(activeDb, "users", user.uid);
      const existingSnap = await getDoc(profileRef);

      if (existingSnap.exists()) {
        const existingProfile = existingSnap.data() as UserProfile;
        setProfile(existingProfile);
        setProfileName(existingProfile.name ?? "");
        setStartDate(existingProfile.startDate);
        setProfileStatus("ready");
        setAuthMessage("");
        return;
      }

      const nextProfile: UserProfile = {
        name: profileName.trim(),
        startDate,
        createdAt: serverTimestamp(),
        email: user.email,
        phoneNumber: user.phoneNumber,
        timezone: browserTimezone(),
        phase: defaultPhase,
      };
      await setDoc(profileRef, nextProfile, { merge: true });
      setProfile(nextProfile);
      setProfileName(nextProfile.name ?? "");
      setProfileStatus("ready");
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !db || !profile) return;
    const activeDb = db;
    const nextName = settingsName.trim();
    setSettingsSaving(true);
    setSettingsMessage("");

    try {
      const updates: Partial<UserProfile> = {
        name: nextName,
        phase: phaseDraft,
        hardBlock: hardBlockDraft,
      };
      await setDoc(doc(activeDb, "users", user.uid), updates, { merge: true });
      setProfile({ ...profile, ...updates });
      setProfileName(nextName);
      setSettingsMessage("Settings saved.");
    } catch (error) {
      setSettingsMessage(readableError(error));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function toggleFloor(key: FloorKey, dateKey = currentDateKey) {
    const current =
      dateKey === currentDateKey ? daily : progress[dateKey] ?? { ...emptyDailyRecord };
    try {
      await persistDay(dateKey, { ...current, [key]: !current[key] });
      setAuthMessage("");
    } catch (error) {
      setAuthMessage(readableError(error));
    }
  }

  async function setDisruption(value: boolean, dateKey = currentDateKey) {
    const current =
      dateKey === currentDateKey ? daily : progress[dateKey] ?? { ...emptyDailyRecord };
    try {
      await persistDay(dateKey, { ...current, disruption: value });
      setAuthMessage("");
    } catch (error) {
      setAuthMessage(readableError(error));
    }
  }

  async function saveLeetcodeLog(log: LeetcodeLog, dateKey = currentDateKey) {
    const current =
      dateKey === currentDateKey ? daily : progress[dateKey] ?? { ...emptyDailyRecord };
    const cleaned: LeetcodeLog = {
      name: log.name?.trim() || "",
      pattern: log.pattern || "",
      note: log.note?.trim() || "",
    };
    try {
      await persistDay(dateKey, { ...current, leetcodeLog: cleaned });
      setAuthMessage("Problem logged.");
    } catch (error) {
      setAuthMessage(readableError(error));
    }
  }

  async function uploadPhoto(file?: File, targetDateKey = currentDateKey) {
    if (!file || !user || !db || !storage) return;
    if (!isAcceptedImage(file)) {
      setAuthMessage("Please choose an image file.");
      return;
    }

    const existingRecord =
      targetDateKey === currentDateKey
        ? daily
        : progress[targetDateKey] ?? { ...emptyDailyRecord };
    setBusy(true);
    setAuthMessage("");

    try {
      const imageFile = await uploadableImage(file);
      const extension = fileExtension(imageFile);
      const photoRef = ref(storage, `users/${user.uid}/progress/${targetDateKey}.${extension}`);
      await uploadBytes(photoRef, imageFile, {
        contentType: imageFile.type || "image/jpeg",
        customMetadata: {
          date: targetDateKey,
          originalType: file.type || "unknown",
          convertedFromHeic: `${isHeicFile(file)}`,
        },
      });
      const progressPhotoUrl = await getDownloadURL(photoRef);
      const nextRecord: DailyRecord = { ...existingRecord, progressPhotoUrl };
      await persistDay(targetDateKey, nextRecord);
      setAuthMessage("Progress photo saved.");
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      photoUploadDateKeyRef.current = null;
      setBusy(false);
    }
  }

  function choosePhotoForDate(dateKey = currentDateKey) {
    photoUploadDateKeyRef.current = dateKey;
    fileInputRef.current?.click();
  }

  async function runMigration() {
    if (!user || !db || !profile) return;
    const activeDb = db;
    setBusy(true);
    setAuthMessage("");
    try {
      const start = earliestDataDate ?? profile.startDate;
      const end = migrationEnd;
      // Keep today inside the new active streak; never overlap the archive.
      const activeStart = end >= currentDateKey ? addDays(end, 1) : currentDateKey;

      await setDoc(doc(activeDb, "users", user.uid, "epochs", newEpochId()), {
        startDate: start,
        endDate: end,
        label: migrationLabel.trim() || "Original 75 Hard",
        createdAt: serverTimestamp(),
      });
      await setDoc(doc(activeDb, "users", user.uid, "epochs", newEpochId()), {
        startDate: activeStart,
        endDate: null,
        label: newStreakLabel.trim(),
        createdAt: serverTimestamp(),
      });

      setNeedsMigration(false);
      setEpochReloadKey((key) => key + 1);
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function endCurrentStreak() {
    if (!user || !db || !active) return;
    const activeDb = db;
    setBusy(true);
    try {
      await setDoc(
        doc(activeDb, "users", user.uid, "epochs", active.id),
        { endDate: currentDateKey },
        { merge: true },
      );
      setSettingsOpen(false);
      setView("today");
      setEpochReloadKey((key) => key + 1);
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function startNewStreak() {
    if (!user || !db || active) return;
    const activeDb = db;
    setBusy(true);
    try {
      await setDoc(doc(activeDb, "users", user.uid, "epochs", newEpochId()), {
        startDate: newStreakStart,
        endDate: null,
        label: newStreakLabel.trim(),
        createdAt: serverTimestamp(),
      });
      setNewStreakLabel("");
      setNewStreakStart(currentDateKey);
      setEpochReloadKey((key) => key + 1);
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveRecap() {
    if (!user || !db || !recapWeekStart) return;
    const activeDb = db;
    const note = recapNote.trim();
    setBusy(true);
    try {
      await setDoc(
        doc(activeDb, "users", user.uid, "reviews", recapWeekStart),
        { note, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setReviews((current) => ({ ...current, [recapWeekStart]: { note } }));
      setRecapOpen(false);
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  function dismissRecap() {
    if (recapWeekStart) {
      try {
        localStorage.setItem(`recap-dismissed-${recapWeekStart}`, "1");
      } catch {
        // Ignore storage failures — worst case the prompt reappears next open.
      }
    }
    setRecapOpen(false);
  }

  async function handleSignOut() {
    if (!auth) return;
    await signOut(auth);
    setUser(null);
    setProfile(null);
    setProfileStatus("loading");
    setDaily(emptyDailyRecord);
    setProgress({});
    setProgressLoaded(false);
    setEpochs([]);
    setEpochsLoaded(false);
    setReviews({});
    setReviewsLoaded(false);
    setRecapOpen(false);
    recapPromptedRef.current = false;
    bootstrapRef.current = false;
    setSettingsOpen(false);
    setSettingsMessage("");
    setExpandedDate(null);
    setBrowseEpochId(null);
    setConfirmationResult(null);
    setSmsCode("");
  }

  if (!isFirebaseConfigured) {
    return (
      <Shell>
        <section className="auth-card glass-panel">
          <div className="brand-lockup">
            <div className="app-icon">
              <Flame size={26} fill="currentColor" />
            </div>
            <p>streak</p>
          </div>
          <h1>Connect Firebase to unlock your private tracker.</h1>
          <p className="muted">
            Add your Firebase web config to Vercel or <code>.env.local</code>, then restart the app.
          </p>
          <code className="config-list">
            NEXT_PUBLIC_FIREBASE_API_KEY
            <br />
            NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
            <br />
            NEXT_PUBLIC_FIREBASE_PROJECT_ID
            <br />
            NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
            <br />
            NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
            <br />
            NEXT_PUBLIC_FIREBASE_APP_ID
          </code>
        </section>
      </Shell>
    );
  }

  if (!authReady) {
    return (
      <Shell>
        <div className="loading-orb" aria-label="Loading" />
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <section className="auth-card glass-panel">
          <div className="brand-lockup">
            <div className="app-icon">
              <Flame size={26} fill="currentColor" />
            </div>
            <p>streak</p>
          </div>
          <h1>Your private training &amp; prep streak.</h1>
          <p className="muted">
            Sign in with your phone number. Your daily photos stay locked to your account.
          </p>
          <form className="auth-form" onSubmit={confirmationResult ? confirmSmsCode : sendSmsCode}>
            <label htmlFor={confirmationResult ? "smsCode" : "phoneNumber"}>
              {confirmationResult ? "Verification code" : "Phone number"}
            </label>
            <div className="email-field">
              {confirmationResult ? <ShieldCheck size={18} /> : <Phone size={18} />}
              <input
                id={confirmationResult ? "smsCode" : "phoneNumber"}
                type="tel"
                inputMode="tel"
                autoComplete={confirmationResult ? "one-time-code" : "tel"}
                placeholder={confirmationResult ? "123456" : "+1 555 123 4567"}
                value={confirmationResult ? smsCode : phoneNumber}
                onChange={(event) =>
                  confirmationResult ? setSmsCode(event.target.value) : setPhoneNumber(event.target.value)
                }
                onBlur={() => {
                  if (!confirmationResult) setPhoneNumber(normalizePhoneNumber(phoneNumber));
                }}
                required
              />
            </div>
            <div id={recaptchaContainerId} />
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Working..." : confirmationResult ? "Verify code" : "Send code"}
            </button>
            {confirmationResult ? (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmationResult(null);
                  setSmsCode("");
                  setAuthMessage("");
                }}
              >
                Use a different number
              </button>
            ) : null}
          </form>
          {authMessage ? <p className="system-message">{authMessage}</p> : null}
        </section>
      </Shell>
    );
  }

  if (profileStatus === "loading") {
    return (
      <Shell>
        <div className="loading-orb" aria-label="Loading" />
      </Shell>
    );
  }

  if (profileStatus === "error") {
    return (
      <Shell>
        <section className="auth-card glass-panel">
          <div className="brand-lockup">
            <div className="app-icon">
              <Flame size={26} fill="currentColor" />
            </div>
            <p>streak</p>
          </div>
          <h1>We couldn&apos;t load your tracker.</h1>
          <p className="muted">
            Your progress is safe. This is usually a network hiccup — try again.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </button>
          {authMessage ? <p className="system-message">{authMessage}</p> : null}
        </section>
      </Shell>
    );
  }

  if (!profile) {
    return (
      <Shell>
        <section className="auth-card glass-panel">
          <div className="brand-lockup">
            <div className="app-icon">
              <CalendarDays size={26} />
            </div>
            <p>streak</p>
          </div>
          <h1>When did this streak begin?</h1>
          <p className="muted">
            Add your name and start date. Everything else is set up for you.
          </p>
          <form className="auth-form" onSubmit={saveProfile}>
            <label htmlFor="profileName">Name</label>
            <div className="email-field">
              <UserRound size={18} />
              <input
                id="profileName"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                required
              />
            </div>
            <label htmlFor="startDate">Start date</label>
            <input
              className="date-input"
              id="startDate"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
            />
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Saving..." : "Start tracking"}
            </button>
          </form>
        </section>
      </Shell>
    );
  }

  if (needsMigration) {
    const start = earliestDataDate ?? profile.startDate;
    const dayCount = Object.keys(progress).length;
    return (
      <Shell>
        <section className="auth-card glass-panel migration-card">
          <div className="brand-lockup">
            <div className="app-icon">
              <Archive size={24} />
            </div>
            <p>Preserve your history</p>
          </div>
          <h1>Archive your original run.</h1>
          <p className="muted">
            Found <strong>{dayCount} days</strong> of history starting{" "}
            {formatRange(start, latestDataDate ?? start).split(" – ")[0]}. We&apos;ll save it as your
            first archived streak — nothing is deleted or rewritten — and start a fresh streak with
            the new rules.
          </p>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              runMigration();
            }}
          >
            <label htmlFor="migrationLabel">Archive label</label>
            <div className="email-field">
              <Flag size={18} />
              <input
                id="migrationLabel"
                type="text"
                value={migrationLabel}
                onChange={(event) => setMigrationLabel(event.target.value)}
                placeholder="Original 75 Hard"
              />
            </div>
            <label htmlFor="migrationEnd">End date of the original run</label>
            <input
              className="date-input"
              id="migrationEnd"
              type="date"
              value={migrationEnd}
              min={start}
              onChange={(event) => setMigrationEnd(event.target.value)}
              required
            />
            <p className="muted small">
              Defaults to your last logged day ({latestDataDate ?? start}). Adjust if you want.
            </p>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Archiving..." : "Archive & start fresh"}
            </button>
          </form>
          {authMessage ? <p className="system-message">{authMessage}</p> : null}
        </section>
      </Shell>
    );
  }

  const expanded = expandedDate
    ? (() => {
        const record = progress[expandedDate] ?? { ...emptyDailyRecord };
        const day = viewedEpoch
          ? dayNumberInEpoch(viewedEpoch.startDate, expandedDate)
          : 0;
        const editable =
          !isBrowsingArchive &&
          !record.legacy &&
          expandedDate <= currentDateKey &&
          Boolean(active) &&
          Boolean(active && dateInEpoch(active, expandedDate, currentDateKey));
        return { dateKey: expandedDate, day, record, editable };
      })()
    : null;

  return (
    <Shell>
      <main className="app-frame">
        <header className="top-bar glass-panel">
          <div className="brand-mini">
            <div className="app-icon">
              <Flame size={20} fill="currentColor" />
            </div>
            <div className="brand-mini-copy">
              <p className="greeting">{displayName}</p>
              {active ? (
                <span className="rank-chip" data-tier={Math.min(Math.floor(currentDay / 15), 6)}>
                  <Trophy size={12} />
                  {active.label?.trim() || "Current streak"}
                </span>
              ) : (
                <span className="rank-chip" data-tier={0}>
                  <Trophy size={12} />
                  No active streak
                </span>
              )}
            </div>
          </div>
          {active ? (
            <div className="day-display">
              <span>Day</span>
              <strong>{currentDay}</strong>
            </div>
          ) : null}
          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="Open settings"
              type="button"
              onClick={() => {
                setSettingsMessage("");
                setSettingsOpen(true);
              }}
            >
              <Settings size={19} />
            </button>
          </div>
        </header>

        {settingsOpen ? (
          <div className="settings-scrim" role="presentation" onClick={() => setSettingsOpen(false)}>
            <section
              className="settings-menu glass-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="settings-heading">
                <div>
                  <p>Settings</p>
                  <h2 id="settings-title">Your setup</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close settings"
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>

              <form className="settings-form" onSubmit={saveSettings}>
                <label htmlFor="settingsName">Name</label>
                <div className="email-field">
                  <UserRound size={18} />
                  <input
                    id="settingsName"
                    type="text"
                    autoComplete="name"
                    placeholder="Your name"
                    value={settingsName}
                    onChange={(event) => setSettingsName(event.target.value)}
                  />
                </div>

                <div className="settings-section-title">
                  <Target size={15} /> Current phase
                </div>
                <label htmlFor="phaseLabel">Phase</label>
                <div className="email-field">
                  <Salad size={18} />
                  <input
                    id="phaseLabel"
                    type="text"
                    placeholder="Lean bulk, Mini-cut, ..."
                    value={phaseDraft.label}
                    onChange={(event) =>
                      setPhaseDraft((draft) => ({ ...draft, label: event.target.value }))
                    }
                  />
                </div>
                <div className="field-row">
                  <div className="field-col">
                    <label htmlFor="phaseProtein">Protein (g)</label>
                    <input
                      className="date-input"
                      id="phaseProtein"
                      type="number"
                      inputMode="numeric"
                      value={phaseDraft.proteinTarget}
                      onChange={(event) =>
                        setPhaseDraft((draft) => ({
                          ...draft,
                          proteinTarget: Number(event.target.value) || 0,
                        }))
                      }
                    />
                  </div>
                  <div className="field-col">
                    <label htmlFor="phaseCalories">Calories</label>
                    <input
                      className="date-input"
                      id="phaseCalories"
                      type="number"
                      inputMode="numeric"
                      value={phaseDraft.calorieTarget}
                      onChange={(event) =>
                        setPhaseDraft((draft) => ({
                          ...draft,
                          calorieTarget: Number(event.target.value) || 0,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="settings-section-title">
                  <Zap size={15} /> Hard-block mode
                </div>
                <label className="toggle-line">
                  <span>
                    Run a stricter, time-boxed block
                    <span className="muted small"> — forces the full floor every day</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={hardBlockDraft.active}
                    onChange={(event) =>
                      setHardBlockDraft((draft) => ({ ...draft, active: event.target.checked }))
                    }
                  />
                </label>
                {hardBlockDraft.active ? (
                  <div className="field-row">
                    <div className="field-col">
                      <label htmlFor="hbDays">Length (days)</label>
                      <input
                        className="date-input"
                        id="hbDays"
                        type="number"
                        inputMode="numeric"
                        value={hardBlockDraft.days}
                        onChange={(event) =>
                          setHardBlockDraft((draft) => ({
                            ...draft,
                            days: Number(event.target.value) || 1,
                          }))
                        }
                      />
                    </div>
                    <div className="field-col">
                      <label htmlFor="hbStart">Start</label>
                      <input
                        className="date-input"
                        id="hbStart"
                        type="date"
                        value={hardBlockDraft.startDate}
                        onChange={(event) =>
                          setHardBlockDraft((draft) => ({
                            ...draft,
                            startDate: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                ) : null}

                <div className="profile-facts">
                  <div>
                    <span>Signed in</span>
                    <strong>{user.phoneNumber || user.email || "Private account"}</strong>
                  </div>
                  <div>
                    <span>Timezone</span>
                    <strong>{profile.timezone || browserTimezone()}</strong>
                  </div>
                </div>

                <button className="primary-button" type="submit" disabled={settingsSaving}>
                  <Save size={18} />
                  {settingsSaving ? "Saving..." : "Save settings"}
                </button>
              </form>
              {settingsMessage ? <p className="settings-status">{settingsMessage}</p> : null}

              {active ? (
                <button
                  className="secondary-button danger-button"
                  type="button"
                  onClick={endCurrentStreak}
                  disabled={busy}
                >
                  <Flag size={18} />
                  End current streak &amp; archive it
                </button>
              ) : null}

              <button className="secondary-button signout-button" type="button" onClick={handleSignOut}>
                <LogOut size={18} />
                Sign out
              </button>
            </section>
          </div>
        ) : null}

        {info ? (
          <div className="settings-scrim" role="presentation" onClick={() => setInfo(null)}>
            <section
              className="info-window glass-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="info-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="info-heading">
                <h2 id="info-title">{info.title}</h2>
                <button
                  className="icon-button"
                  aria-label="Close"
                  type="button"
                  onClick={() => setInfo(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="info-body">{info.body}</p>
            </section>
          </div>
        ) : null}

        {recapOpen && recapWeekStart ? (
          <div className="settings-scrim" role="presentation" onClick={dismissRecap}>
            <section
              className="recap-window glass-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="recap-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="info-heading">
                <div>
                  <p className="eyebrow">Weekly recap</p>
                  <h2 id="recap-title">
                    {formatRange(recapWeekStart, addDays(recapWeekStart, 6))}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Dismiss"
                  type="button"
                  onClick={dismissRecap}
                >
                  <X size={18} />
                </button>
              </div>
              {recapStats ? (
                <div className="recap-stats">
                  <div>
                    <strong>{recapStats.completed}</strong>
                    <span>Completed</span>
                  </div>
                  <div>
                    <strong>{recapStats.disruptionDays}</strong>
                    <span>Disruption</span>
                  </div>
                  <div>
                    <strong>{recapStats.missed}</strong>
                    <span>Misses</span>
                  </div>
                </div>
              ) : null}
              <textarea
                className="review-input"
                placeholder="A short note on the week — what worked, what to adjust."
                value={recapNote}
                onChange={(event) => setRecapNote(event.target.value)}
                rows={3}
              />
              <div className="recap-actions">
                <button className="text-button" type="button" onClick={dismissRecap}>
                  Skip this week
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={saveRecap}
                  disabled={busy}
                >
                  <Save size={16} /> Save recap
                </button>
              </div>
            </section>
          </div>
        ) : null}

        <nav className="view-tabs glass-panel" aria-label="Primary">
          <button
            className={view === "today" ? "active" : ""}
            type="button"
            onClick={() => {
              setView("today");
              setExpandedDate(null);
              setBrowseEpochId(null);
            }}
          >
            Today
          </button>
          <button
            className={view === "history" ? "active" : ""}
            type="button"
            onClick={() => {
              setView("history");
              setExpandedDate(null);
              setBrowseEpochId(null);
            }}
          >
            History
          </button>
          <button
            className={view === "archive" ? "active" : ""}
            type="button"
            onClick={() => {
              setView("archive");
              setExpandedDate(null);
            }}
          >
            Archive
          </button>
        </nav>

        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*,.heic,.heif"
          onChange={(event) =>
            uploadPhoto(event.target.files?.[0], photoUploadDateKeyRef.current ?? currentDateKey)
          }
        />

        {view === "today" ? (
          !active ? (
            <section className="daily-layout">
              <div className="empty-streak glass-panel">
                <Flame size={32} />
                <h1>No active streak.</h1>
                <p className="muted">Start a new one whenever you&apos;re ready.</p>
                <label htmlFor="newStreakStart">Start date</label>
                <input
                  className="date-input"
                  id="newStreakStart"
                  type="date"
                  value={newStreakStart}
                  onChange={(event) => setNewStreakStart(event.target.value)}
                />
                <label htmlFor="newStreakLabel">Label (optional)</label>
                <div className="email-field">
                  <Flag size={18} />
                  <input
                    id="newStreakLabel"
                    type="text"
                    placeholder="e.g. Spring block"
                    value={newStreakLabel}
                    onChange={(event) => setNewStreakLabel(event.target.value)}
                  />
                </div>
                <button
                  className="primary-button"
                  type="button"
                  onClick={startNewStreak}
                  disabled={busy}
                >
                  <Plus size={18} />
                  Start new streak
                </button>
              </div>
            </section>
          ) : (
            <section className="daily-layout">
              <div className={`hero-status glass-panel ${todayComplete ? "blue" : "gray"}`}>
                <div className="hero-top">
                  <div>
                    <p>{todayComplete ? "Done for the day" : "Stack the day"}</p>
                    <h1>
                      {todayComplete
                        ? "You're free. Go live."
                        : effectiveDisruption
                        ? "Disruption day — keep the floor."
                        : "One item at a time."}
                    </h1>
                  </div>
                  <button
                    className={`status-star ${todayComplete ? "blue lit" : "gray"} ${
                      daily.progressPhotoUrl ? "has-photo" : ""
                    }`}
                    type="button"
                    aria-label={daily.progressPhotoUrl ? "Replace today's photo" : "Add today's photo"}
                    onClick={() => choosePhotoForDate()}
                    disabled={busy}
                  >
                    {daily.progressPhotoUrl ? (
                      <Image
                        src={daily.progressPhotoUrl}
                        alt="Today progress"
                        fill
                        sizes="120px"
                        style={{ objectFit: "cover" }}
                        priority
                      />
                    ) : todayComplete ? (
                      <Check className="status-star-main" size={44} />
                    ) : (
                      <Camera className="status-star-main" size={40} />
                    )}
                    <span className="status-star-badge" aria-hidden="true">
                      <Camera size={15} />
                    </span>
                  </button>
                </div>
                <div className="hero-progress">
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${completionPct}%` }} />
                  </div>
                  <div className="hero-progress-meta">
                    <span>
                      <Zap size={13} /> {completedToday}/{requiredKeys.length} floor items
                    </span>
                    <span>{daily.progressPhotoUrl ? "Photo saved" : "Photo optional"}</span>
                  </div>
                </div>
              </div>

              {hardBlockOn ? (
                <div className="mode-banner hardblock glass-panel">
                  <Zap size={17} />
                  <span>
                    Hard block active — {hardBlockLeft} {hardBlockLeft === 1 ? "day" : "days"} left.
                    Full floor required.
                  </span>
                </div>
              ) : (
                <button
                  className={`mode-banner disruption glass-panel ${
                    daily.disruption ? "on" : ""
                  }`}
                  type="button"
                  onClick={() => setDisruption(!daily.disruption)}
                  disabled={saving}
                >
                  <Plane size={17} />
                  <span>
                    {daily.disruption
                      ? "Disruption mode on — stripped floor."
                      : "Travel or chaos today? Switch to disruption mode."}
                  </span>
                  <span className={`mini-switch ${daily.disruption ? "on" : ""}`} aria-hidden="true">
                    <span />
                  </span>
                </button>
              )}

              <section className="stats-bar glass-panel" aria-label="Your stats">
                <button className="stat" type="button" onClick={() => setInfo(infoTopics.streak)}>
                  <span className="stat-icon streak">
                    <Flame size={30} />
                    <strong className="stat-count">{stats?.completed ?? 0}</strong>
                  </span>
                  <span className="stat-label">Streak</span>
                </button>
                <button className="stat" type="button" onClick={() => setInfo(infoTopics.disruption)}>
                  <span className="stat-icon blue">
                    <Plane size={26} />
                    <strong className="stat-count">{stats?.disruptionDays ?? 0}</strong>
                  </span>
                  <span className="stat-label">Disruption</span>
                </button>
                <button className="stat" type="button" onClick={() => setView("history")}>
                  <span className="stat-icon gold">
                    <CalendarDays size={26} />
                    <strong className="stat-count">{stats?.lengthDays ?? 0}</strong>
                  </span>
                  <span className="stat-label">Days in</span>
                </button>
                <button className="stat" type="button" onClick={() => setView("history")}>
                  <span className="stat-icon token">
                    <X size={26} />
                    <strong className="stat-count">{stats?.missed ?? 0}</strong>
                  </span>
                  <span className="stat-label">Misses</span>
                </button>
              </section>

              <section className="task-list glass-panel" aria-label="Daily floor">
                {visibleItems.map((item) => (
                  <div key={item.key} className="task-block">
                    <button
                      className={`task-row ${daily[item.key] ? "complete" : ""}`}
                      type="button"
                      onClick={() => toggleFloor(item.key)}
                    >
                      <span className="task-icon">{item.icon}</span>
                      <span className="task-copy">
                        <strong>{item.title}</strong>
                        <span className="task-hint">{item.hint}</span>
                      </span>
                      <span className="check-indicator">
                        {daily[item.key] ? <Check size={17} /> : null}
                      </span>
                    </button>
                    {item.key === "leetcode" ? (
                      <LeetcodeLogEditor
                        value={daily.leetcodeLog}
                        onSave={(log) => saveLeetcodeLog(log)}
                        disabled={saving || busy}
                      />
                    ) : null}
                  </div>
                ))}
              </section>

              <p className="save-state">
                {busy ? "Uploading..." : saving ? "Saving..." : "Saved privately"}
              </p>
              {authMessage ? <p className="save-state">{authMessage}</p> : null}
            </section>
          )
        ) : null}

        {view === "history" ? (
          <HistoryView
            epoch={viewedEpoch}
            progress={progress}
            today={currentDateKey}
            stats={viewedStats}
            leetcode={epochLeetcode}
            reviews={viewedReviews}
            isArchiveBrowse={isBrowsingArchive}
            onBackToArchive={() => {
              setBrowseEpochId(null);
              setView("archive");
            }}
            onOpenDay={setExpandedDate}
          />
        ) : null}

        {view === "archive" ? (
          <section className="progress-view">
            <div className="progress-heading">
              <div>
                <p>Archive</p>
                <h1>Past streaks.</h1>
              </div>
            </div>
            {archived.length === 0 ? (
              <div className="empty-streak glass-panel">
                <Archive size={28} />
                <p className="muted">No archived streaks yet. Ended streaks land here.</p>
              </div>
            ) : (
              <div className="archive-list">
                {archived.map((epoch) => {
                  const epochStat = epochStats(progress, epoch, currentDateKey);
                  return (
                    <button
                      key={epoch.id}
                      className="archive-row glass-panel"
                      type="button"
                      onClick={() => {
                        setBrowseEpochId(epoch.id);
                        setView("history");
                        setExpandedDate(null);
                      }}
                    >
                      <div className="archive-row-main">
                        <strong>{epoch.label?.trim() || "Streak"}</strong>
                        <span className="muted small">
                          {formatRange(epoch.startDate, epoch.endDate ?? currentDateKey)}
                        </span>
                      </div>
                      <div className="archive-row-meta">
                        <span>{epochStat.lengthDays} days</span>
                        <span className="muted small">{epochStat.completed} completed</span>
                      </div>
                      <ChevronRight size={18} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {expanded ? (
          <DayDetail
            dateKey={expanded.dateKey}
            day={expanded.day}
            record={expanded.record}
            editable={expanded.editable}
            phase={phase}
            busy={busy}
            onClose={() => setExpandedDate(null)}
            onToggle={(key) => toggleFloor(key, expanded.dateKey)}
            onPhoto={() => choosePhotoForDate(expanded.dateKey)}
            onSaveLeetcode={(log) => saveLeetcodeLog(log, expanded.dateKey)}
          />
        ) : null}

        <footer className="app-version">v{appVersion}</footer>
      </main>
    </Shell>
  );
}

function LeetcodeLogEditor({
  value,
  onSave,
  disabled,
}: {
  value?: LeetcodeLog;
  onSave: (log: LeetcodeLog) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(value?.name ?? "");
  const [pattern, setPattern] = useState(value?.pattern ?? "");
  const [note, setNote] = useState(value?.note ?? "");

  useEffect(() => {
    setName(value?.name ?? "");
    setPattern(value?.pattern ?? "");
    setNote(value?.note ?? "");
  }, [value]);

  const hasLog = Boolean(value?.name || value?.pattern || value?.note);

  return (
    <div className="leetcode-log">
      <button
        type="button"
        className="leetcode-log-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <Code size={14} />
        {hasLog ? (
          <span className="leetcode-log-summary">
            {value?.name || "Logged"}
            {value?.pattern ? ` · ${value.pattern}` : ""}
          </span>
        ) : (
          <span>Log the problem (optional)</span>
        )}
        <ChevronRight size={15} className={open ? "rotated" : ""} />
      </button>
      {open ? (
        <div className="leetcode-log-fields">
          <input
            type="text"
            placeholder="Problem name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <select value={pattern} onChange={(event) => setPattern(event.target.value)}>
            <option value="">Pattern…</option>
            {leetcodePatterns.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="One-line note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => {
              onSave({ name, pattern, note });
              setOpen(false);
            }}
          >
            <Save size={15} /> Save log
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HistoryView({
  epoch,
  progress,
  today,
  stats,
  leetcode,
  reviews,
  isArchiveBrowse,
  onBackToArchive,
  onOpenDay,
}: {
  epoch: Epoch | null;
  progress: Record<string, DailyRecord>;
  today: string;
  stats: ReturnType<typeof epochStats> | null;
  leetcode: ReturnType<typeof leetcodeEntries>;
  reviews: { weekStart: string; note: string }[];
  isArchiveBrowse: boolean;
  onBackToArchive: () => void;
  onOpenDay: (dateKey: string) => void;
}) {
  if (!epoch) {
    return (
      <section className="progress-view">
        <div className="empty-streak glass-panel">
          <CalendarDays size={28} />
          <p className="muted">No active streak to show. Start one from the Today tab.</p>
        </div>
      </section>
    );
  }

  const end = epochRangeEnd(epoch, today);
  const days = enumerateDateKeys(epoch.startDate, end).reverse();

  return (
    <section className="progress-view">
      {isArchiveBrowse ? (
        <button className="text-button back-button" type="button" onClick={onBackToArchive}>
          ← Archive
        </button>
      ) : null}
      <div className="progress-heading">
        <div>
          <p>History</p>
          <h1>{isArchiveBrowse ? epoch.label?.trim() || "Streak" : "Current streak"}</h1>
          <span className="heading-sub muted small">{formatRange(epoch.startDate, end)}</span>
        </div>
      </div>

      {stats ? (
        <div className="history-stats glass-panel">
          <div>
            <strong>{stats.completed}</strong>
            <span>Completed</span>
          </div>
          <div>
            <strong>{stats.disruptionDays}</strong>
            <span>Disruption</span>
          </div>
          <div>
            <strong>{stats.missed}</strong>
            <span>Misses</span>
          </div>
          <div>
            <strong>{stats.photos}</strong>
            <span>Photos</span>
          </div>
        </div>
      ) : null}

      <div className="legend">
        <span>
          <i className="dot complete" /> Complete
        </span>
        <span>
          <i className="dot disruption" /> Disruption
        </span>
        <span>
          <i className="dot miss" /> Miss
        </span>
      </div>

      <div className="day-grid">
        {days.map((dateKey) => {
          const record = progress[dateKey];
          const state = dayState(record, dateKey, today);
          const day = dayNumberInEpoch(epoch.startDate, dateKey);
          const hasPhoto = Boolean(record?.progressPhotoUrl);
          return (
            <button
              key={dateKey}
              className={`day-cell ${state} ${hasPhoto ? "has-photo" : ""}`}
              type="button"
              onClick={() => onOpenDay(dateKey)}
              aria-label={`Day ${day}`}
            >
              {hasPhoto ? (
                <Image
                  src={record!.progressPhotoUrl}
                  alt={`Day ${day}`}
                  fill
                  sizes="(max-width: 760px) 25vw, 120px"
                  style={{ objectFit: "cover" }}
                />
              ) : null}
              <span className="day-cell-scrim" />
              <span className="day-cell-num">{day}</span>
              {state === "disruption" ? (
                <span className="day-cell-badge">
                  <Plane size={11} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {reviews.length > 0 ? (
        <div className="leetcode-history glass-panel">
          <div className="settings-section-title">
            <Sparkles size={15} /> Weekly recaps
          </div>
          <ul className="review-list">
            {reviews.map((review) => (
              <li key={review.weekStart}>
                <span className="review-week">
                  Week of {formatRange(review.weekStart, addDays(review.weekStart, 6))}
                </span>
                <p>{review.note}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {leetcode.length > 0 ? (
        <div className="leetcode-history glass-panel">
          <div className="settings-section-title">
            <Code size={15} /> LeetCode log
          </div>
          <ul className="leetcode-entries">
            {leetcode.map((entry) => (
              <li key={entry.dateKey}>
                <span className="leetcode-entry-date">{entry.dateKey.slice(5)}</span>
                <span className="leetcode-entry-name">{entry.name || "Problem"}</span>
                {entry.pattern ? (
                  <span className="leetcode-entry-pattern">{entry.pattern}</span>
                ) : null}
                {entry.note ? <span className="leetcode-entry-note">{entry.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function DayDetail({
  dateKey,
  day,
  record,
  editable,
  phase,
  busy,
  onClose,
  onToggle,
  onPhoto,
  onSaveLeetcode,
}: {
  dateKey: string;
  day: number;
  record: DailyRecord;
  editable: boolean;
  phase: Phase;
  busy: boolean;
  onClose: () => void;
  onToggle: (key: FloorKey) => void;
  onPhoto: () => void;
  onSaveLeetcode: (log: LeetcodeLog) => void;
}) {
  const hasPhoto = Boolean(record.progressPhotoUrl);
  const items = floorItems(phase);
  // Show the floor that applied to that day (stripped on disruption days).
  const keys = record.disruption ? requiredFloorKeys({ disruption: true }) : floorKeys;
  const shown = items.filter((item) => keys.includes(item.key as never));
  const complete = isDayComplete(record);

  return (
    <div className="settings-scrim" role="presentation" onClick={onClose}>
      <section
        className="day-detail glass-panel"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="expanded-heading">
          <button className="text-button back-button" type="button" onClick={onClose}>
            ← Close
          </button>
          <span className={`status-pill ${complete ? (record.disruption ? "disruption" : "complete") : "miss"}`}>
            {record.disruption ? <Plane size={13} /> : <Check size={13} />}
            {complete ? (record.disruption ? "Disruption day" : "Complete") : "Incomplete"}
          </span>
        </div>

        <div className={`expanded-photo-view ${complete ? "complete" : "miss"}`}>
          {hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={record.progressPhotoUrl} alt={`Day ${day}`} loading="eager" decoding="async" />
          ) : (
            <div className="expanded-photo-empty">
              <ImageIcon size={30} />
              <span>No progress photo</span>
            </div>
          )}
          <span className="expanded-photo-meta">
            <span>Day {day}</span>
            <span className="muted small">{dateKey}</span>
          </span>
        </div>

        <div className="day-checklist glass-panel">
          {shown.map((item) =>
            editable ? (
              <button
                key={item.key}
                className={`checklist-row interactive ${record[item.key] ? "done" : ""}`}
                type="button"
                onClick={() => onToggle(item.key)}
              >
                <span className="checklist-icon">{item.icon}</span>
                <span className="checklist-title">{item.title}</span>
                <span className="checklist-mark">
                  {record[item.key] ? <Check size={15} /> : <X size={14} />}
                </span>
              </button>
            ) : (
              <div className={`checklist-row ${record[item.key] ? "done" : ""}`} key={item.key}>
                <span className="checklist-icon">{item.icon}</span>
                <span className="checklist-title">{item.title}</span>
                <span className="checklist-mark">
                  {record[item.key] ? <Check size={15} /> : <X size={14} />}
                </span>
              </div>
            ),
          )}
        </div>

        {record.leetcodeLog && (record.leetcodeLog.name || record.leetcodeLog.note) ? (
          <div className="day-leetcode glass-panel">
            <Code size={15} />
            <div>
              <strong>{record.leetcodeLog.name || "LeetCode"}</strong>
              {record.leetcodeLog.pattern ? <span> · {record.leetcodeLog.pattern}</span> : null}
              {record.leetcodeLog.note ? (
                <p className="muted small">{record.leetcodeLog.note}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {editable ? (
          <>
            <LeetcodeLogEditor
              value={record.leetcodeLog}
              onSave={onSaveLeetcode}
              disabled={busy}
            />
            <button
              className="secondary-button expanded-upload-button"
              type="button"
              onClick={onPhoto}
              disabled={busy}
            >
              <Camera size={18} />
              {busy ? "Uploading..." : hasPhoto ? "Replace photo" : "Add photo"}
            </button>
          </>
        ) : null}
      </section>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="liquid-sheet" />
      <div className="shell-scroll">{children}</div>
    </div>
  );
}
