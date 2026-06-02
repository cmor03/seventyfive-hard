"use client";

import {
  BookOpen,
  CalendarDays,
  Camera,
  Check,
  Dumbbell,
  Droplets,
  Flame,
  ImageIcon,
  Info,
  Lock,
  LogOut,
  Phone,
  Salad,
  Save,
  Settings,
  ShieldCheck,
  Star,
  Trophy,
  Upload,
  UserRound,
  Wand2,
  Wind,
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
  type DocumentData,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, db, isFirebaseConfigured, storage } from "@/lib/firebase";
import {
  calculateStatus,
  currentStreak,
  dateKeyForDay,
  dayNumberFromStart,
  emptyDailyRecord,
  isDayComplete,
  todayKey,
  tokenStats,
  type DailyRecord,
  type StarStatus,
  type UserProfile,
} from "@/lib/progress";
import { browserTimezone } from "@/lib/messaging";

type ViewMode = "today" | "progress";
const recaptchaContainerId = "phone-recaptcha-container";
const appVersion = "0.1.0";

type InfoTopic = { title: string; body: string };

const infoTopics = {
  stars: {
    title: "How stars work",
    body: "Gray means the day is still in progress. Earn a gold star by finishing the five core habits and posting a progress photo. Earn a blue star by also doing 30 minutes of LeetCode. Every blue star banks one repair token.",
  },
  streak: {
    title: "Day streak",
    body: "The number of days in a row you've earned at least a gold star. Today still counts as part of the streak until the day ends.",
  },
  blue: {
    title: "Blue stars",
    body: "Days where you finished everything, including 30 minutes of LeetCode. Each blue star banks one repair token you can spend later.",
  },
  gold: {
    title: "Gold stars",
    body: "Days where you finished the five core habits and posted a progress photo, but skipped LeetCode.",
  },
  tokens: {
    title: "Repair tokens",
    body: "You earn one token for every blue star. Spend a token on a past day that already has a photo but that you forgot to fully check off — it fills the five core habits for a gold star. Repaired days never earn new tokens, so the system can't be farmed.",
  },
} satisfies Record<string, InfoTopic>;

type Task = {
  key: keyof Omit<DailyRecord, "progressPhotoUrl" | "status" | "updatedAt" | "repaired">;
  title: string;
  icon: React.ReactNode;
  special?: boolean;
};

const tasks: Task[] = [
  {
    key: "workout1",
    title: "Workout",
    icon: <Dumbbell size={20} />,
  },
  {
    key: "outsideWorkout",
    title: "Outside workout",
    icon: <Wind size={20} />,
  },
  {
    key: "strictDiet",
    title: "Strict diet",
    icon: <Salad size={20} />,
  },
  {
    key: "waterGallon",
    title: "One gallon of water",
    icon: <Droplets size={20} />,
  },
  {
    key: "read10Pages",
    title: "Read 10 pages",
    icon: <BookOpen size={20} />,
  },
  {
    key: "leetcode30",
    title: "LeetCode 30 minutes",
    icon: <Star size={20} />,
    special: true,
  },
];

function recordFromData(data?: DocumentData): DailyRecord {
  return {
    ...emptyDailyRecord,
    ...data,
    status: calculateStatus({ ...emptyDailyRecord, ...data }),
  };
}

function statusLabel(status: StarStatus) {
  if (status === "blue") return "Blue star day";
  if (status === "gold") return "Gold star day";
  return "Still in progress";
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
  const [settingsStartDate, setSettingsStartDate] = useState(todayKey());
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [daily, setDaily] = useState<DailyRecord>(emptyDailyRecord);
  const [progress, setProgress] = useState<Record<string, DailyRecord>>({});
  const [view, setView] = useState<ViewMode>("today");
  const [expandedProgressDate, setExpandedProgressDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profileStatus, setProfileStatus] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [info, setInfo] = useState<InfoTopic | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoUploadDateKeyRef = useRef<string | null>(null);
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);

  const currentDateKey = todayKey();
  const displayName = displayNameLabel(profile?.name || user?.displayName || profileName);
  const earliestDataDate = useMemo(() => {
    const keys = Object.keys(progress);
    if (keys.length === 0) return null;
    return keys.reduce((earliest, key) => (key < earliest ? key : earliest));
  }, [progress]);
  const effectiveStartDate = useMemo(() => {
    if (!profile) return todayKey();
    return earliestDataDate ?? profile.startDate;
  }, [earliestDataDate, profile]);
  const currentDay = dayNumberFromStart(effectiveStartDate);
  const visibleDays = useMemo(
    () => Array.from({ length: currentDay }, (_, index) => index + 1),
    [currentDay],
  );
  const visibleDaysNewestFirst = useMemo(() => [...visibleDays].reverse(), [visibleDays]);
  const expandedProgress = useMemo(() => {
    if (!expandedProgressDate) return null;
    const day =
      visibleDays.find(
        (visibleDay) => dateKeyForDay(effectiveStartDate, visibleDay) === expandedProgressDate,
      ) ?? currentDay;
    const item = recordFromData(progress[expandedProgressDate] ?? emptyDailyRecord);

    return { dateKey: expandedProgressDate, day, item };
  }, [currentDay, effectiveStartDate, expandedProgressDate, progress, visibleDays]);

  const tokens = useMemo(() => tokenStats(progress), [progress]);
  const streak = useMemo(
    () => currentStreak(progress, effectiveStartDate, currentDay),
    [progress, effectiveStartDate, currentDay],
  );
  const starCounts = useMemo(() => {
    let blue = 0;
    let gold = 0;
    let complete = 0;
    for (const day of visibleDays) {
      const record = progress[dateKeyForDay(effectiveStartDate, day)];
      if (record?.status === "blue") blue += 1;
      else if (record?.status === "gold") gold += 1;
      if (isDayComplete(record)) complete += 1;
    }
    return { blue, gold, complete };
  }, [progress, effectiveStartDate, visibleDays]);
  const completionPct = Math.round((currentDay / 75) * 100);
  const completedToday = tasks.filter((task) => daily[task.key]).length;
  // Light-hearted "rank" progression to make the grind feel like a journey.
  const rank = useMemo(() => {
    if (currentDay >= 75) return { name: "Legend", tier: 6 };
    if (currentDay >= 60) return { name: "Unbreakable", tier: 5 };
    if (currentDay >= 45) return { name: "Relentless", tier: 4 };
    if (currentDay >= 30) return { name: "Forged", tier: 3 };
    if (currentDay >= 15) return { name: "Locked In", tier: 2 };
    if (currentDay >= 5) return { name: "Igniting", tier: 1 };
    return { name: "Recruit", tier: 0 };
  }, [currentDay]);

  const persistDaily = useCallback(
    async (nextRecord: DailyRecord) => {
      if (!user || !db) return;
      const activeDb = db;
      setSaving(true);
      try {
        const withStatus = {
          ...nextRecord,
          status: calculateStatus(nextRecord),
          updatedAt: serverTimestamp(),
        };
        await setDoc(doc(activeDb, "users", user.uid, "daily", currentDateKey), withStatus, {
          merge: true,
        });
        setDaily(withStatus);
        setProgress((items) => ({ ...items, [currentDateKey]: withStatus }));
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
    if (!user) {
      return;
    }

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
    };

    loadProgress().catch((error: Error) => {
      if (!cancelled) setAuthMessage(error.message);
    });

    return () => {
      cancelled = true;
    };
  }, [profile, user]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    Object.values(progress).forEach((record) => {
      if (record.progressPhotoUrl) {
        const img = new window.Image();
        img.src = record.progressPhotoUrl;
      }
    });
  }, [progress]);

  useEffect(() => {
    if (!user || !db || !profile) return;
    const tz = browserTimezone();
    if (profile.timezone === tz) return;
    const activeDb = db;
    setDoc(doc(activeDb, "users", user.uid), { timezone: tz }, { merge: true }).catch(() => {});
  }, [profile, user]);

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

  useEffect(() => {
    if (!profile) return;
    setSettingsName(profile.name ?? "");
    setSettingsStartDate(profile.startDate);
  }, [profile]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !db || !profile) return;
    const activeDb = db;
    const nextName = settingsName.trim();
    setSettingsSaving(true);
    setSettingsMessage("");

    try {
      const updates: Pick<UserProfile, "name" | "startDate"> = {
        name: nextName,
        startDate: settingsStartDate,
      };
      await setDoc(doc(activeDb, "users", user.uid), updates, { merge: true });
      setProfile({ ...profile, ...updates });
      setProfileName(nextName);
      setStartDate(settingsStartDate);
      setSettingsMessage("Settings saved.");
    } catch (error) {
      setSettingsMessage(readableError(error));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function toggleTask(key: Task["key"]) {
    const nextRecord = { ...daily, [key]: !daily[key] };
    try {
      await persistDaily(nextRecord);
      setAuthMessage("");
    } catch (error) {
      setAuthMessage(readableError(error));
    }
  }

  async function repairDay(dateKey: string) {
    if (!user || !db) return;
    // Repair is only for previous days — today is yours to actually earn.
    if (dateKey >= currentDateKey) {
      setAuthMessage("You can only repair days that have already passed.");
      return;
    }
    const existing = recordFromData(progress[dateKey] ?? emptyDailyRecord);
    // A repair just fixes forgotten check-offs — the photo is the proof you
    // actually showed up that day, so it has to exist first.
    if (!existing.progressPhotoUrl) {
      setAuthMessage("Add a photo from that day before you can repair it.");
      return;
    }
    if (existing.status !== "gray") return;
    if (tokens.available <= 0) {
      setAuthMessage("No repair tokens yet. Earn a blue star to bank one.");
      return;
    }

    const activeDb = db;
    setBusy(true);
    setAuthMessage("");
    try {
      // Fill the five core habits only — never LeetCode, so the day lands on a
      // gold star and can't mint a fresh repair token.
      const repaired: DailyRecord = {
        ...existing,
        workout1: true,
        outsideWorkout: true,
        strictDiet: true,
        waterGallon: true,
        read10Pages: true,
        repaired: true,
        updatedAt: serverTimestamp(),
      };
      repaired.status = calculateStatus(repaired);
      await setDoc(doc(activeDb, "users", user.uid, "daily", dateKey), repaired, {
        merge: true,
      });
      setProgress((items) => ({ ...items, [dateKey]: repaired }));
      setAuthMessage("Day repaired — gold star restored. Streak protected.");
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      setBusy(false);
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
        : recordFromData(progress[targetDateKey] ?? emptyDailyRecord);
    const activeDb = db;
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
      const withStatus = {
        ...existingRecord,
        progressPhotoUrl,
        status: calculateStatus({ ...existingRecord, progressPhotoUrl }),
        updatedAt: serverTimestamp(),
      };
      await setDoc(doc(activeDb, "users", user.uid, "daily", targetDateKey), withStatus, {
        merge: true,
      });
      setProgress((items) => ({ ...items, [targetDateKey]: withStatus }));
      if (targetDateKey === currentDateKey) {
        setDaily(withStatus);
      }
      setAuthMessage(
        targetDateKey === currentDateKey ? "Progress photo saved." : "Past progress photo saved.",
      );
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

  async function handleSignOut() {
    if (!auth) return;
    await signOut(auth);
    setUser(null);
    setProfile(null);
    setProfileStatus("loading");
    setDaily(emptyDailyRecord);
    setProgress({});
    setSettingsOpen(false);
    setSettingsMessage("");
    setExpandedProgressDate(null);
    setConfirmationResult(null);
    setSmsCode("");
  }

  if (!isFirebaseConfigured) {
    return (
      <Shell>
        <section className="auth-card glass-panel">
          <div className="brand-lockup">
            <div className="app-icon">
              <Star size={26} fill="currentColor" />
            </div>
            <p>75 hard</p>
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
              <Star size={26} fill="currentColor" />
            </div>
            <p>75 hard</p>
          </div>
          <h1>Your private 75 Hard command center.</h1>
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
              <Star size={26} fill="currentColor" />
            </div>
            <p>75 hard</p>
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
            <p>75 hard</p>
          </div>
          <h1>When did day one begin?</h1>
          <p className="muted">
            Add your name and start date. The app will calculate the current day automatically.
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

  return (
    <Shell>
      <main className="app-frame">
        <header className="top-bar glass-panel">
          <div className="brand-mini">
            <div className="app-icon">
              <Star size={20} fill="currentColor" />
            </div>
            <div className="brand-mini-copy">
              <p className="greeting">{displayName}</p>
              <span className="rank-chip" data-tier={rank.tier}>
                <Trophy size={12} />
                {rank.name}
              </span>
            </div>
          </div>
          <div className="day-display">
            <span>Day</span>
            <strong>{currentDay}</strong>
            <span>/ 75</span>
          </div>
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
                  <h2 id="settings-title">Profile</h2>
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

                <label htmlFor="settingsStartDate">Start date</label>
                <input
                  className="date-input"
                  id="settingsStartDate"
                  type="date"
                  value={settingsStartDate}
                  onChange={(event) => setSettingsStartDate(event.target.value)}
                  required
                />

                <div className="profile-facts">
                  <div>
                    <span>Signed in</span>
                    <strong>{user.phoneNumber || user.email || "Private account"}</strong>
                  </div>
                  <div>
                    <span>Timezone</span>
                    <strong>{profile.timezone || browserTimezone()}</strong>
                  </div>
                  <div>
                    <span>Current day</span>
                    <strong>{currentDay} of 75</strong>
                  </div>
                </div>

                <button className="primary-button" type="submit" disabled={settingsSaving}>
                  <Save size={18} />
                  {settingsSaving ? "Saving..." : "Save settings"}
                </button>
              </form>
              {settingsMessage ? <p className="settings-status">{settingsMessage}</p> : null}
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

        <nav className="view-tabs glass-panel" aria-label="Primary">
          <button
            className={view === "today" ? "active" : ""}
            type="button"
            onClick={() => {
              setView("today");
              setExpandedProgressDate(null);
            }}
          >
            Today
          </button>
          <button
            className={view === "progress" ? "active" : ""}
            type="button"
            onClick={() => setView("progress")}
          >
            Progress
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
          <section className="daily-layout">
            <div className={`hero-status glass-panel ${daily.status}`}>
              <div className="hero-top">
                <div>
                  <p>{statusLabel(daily.status)}</p>
                  <h1>
                    {daily.status === "blue"
                      ? "Blue looks good on you."
                      : daily.status === "gold"
                      ? "Gold locked. Push for blue."
                      : "Stack the day."}
                  </h1>
                </div>
                <button
                  className={`status-star ${daily.status} ${
                    daily.progressPhotoUrl ? "has-photo" : ""
                  } ${daily.status !== "gray" ? "lit" : ""}`}
                  type="button"
                  aria-label={daily.progressPhotoUrl ? "Replace today's photo" : "Add today's photo"}
                  onClick={() => choosePhotoForDate()}
                  disabled={busy}
                >
                  {daily.progressPhotoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={daily.progressPhotoUrl}
                      alt="Today progress"
                      loading="eager"
                      decoding="async"
                    />
                  ) : (
                    <Star className="status-star-main" size={48} fill="currentColor" />
                  )}
                  <span className="status-star-badge" aria-hidden="true">
                    {daily.progressPhotoUrl ? (
                      <Star size={16} fill="currentColor" />
                    ) : (
                      <Camera size={15} />
                    )}
                  </span>
                </button>
              </div>
              <div className="hero-progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${completionPct}%` }} />
                </div>
                <div className="hero-progress-meta">
                  <span>
                    <Zap size={13} /> {completedToday}/6 tasks today
                  </span>
                  <span>{completionPct}% of 75</span>
                </div>
              </div>
            </div>

            <section className="stats-bar glass-panel" aria-label="Your stats">
              <button className="stat" type="button" onClick={() => setInfo(infoTopics.streak)}>
                <span className="stat-icon streak">
                  <Flame size={30} />
                  <strong className="stat-count">{streak}</strong>
                </span>
                <span className="stat-label">Day streak</span>
              </button>
              <button className="stat" type="button" onClick={() => setInfo(infoTopics.blue)}>
                <span className="stat-icon blue">
                  <Star size={30} fill="currentColor" />
                  <strong className="stat-count">{starCounts.blue}</strong>
                </span>
                <span className="stat-label">Blue stars</span>
              </button>
              <button className="stat" type="button" onClick={() => setInfo(infoTopics.gold)}>
                <span className="stat-icon gold">
                  <Star size={30} fill="currentColor" />
                  <strong className="stat-count">{starCounts.gold}</strong>
                </span>
                <span className="stat-label">Gold stars</span>
              </button>
              <button className="stat" type="button" onClick={() => setInfo(infoTopics.tokens)}>
                <span className="stat-icon token">
                  <Wand2 size={30} />
                  <strong className="stat-count">{tokens.available}</strong>
                </span>
                <span className="stat-label">Repair tokens</span>
              </button>
            </section>

            <section className="task-list glass-panel" aria-label="Daily checklist">
              {tasks.map((task) => (
                <button
                  className={`task-row ${daily[task.key] ? "complete" : ""} ${
                    task.special ? "special" : ""
                  }`}
                  key={task.key}
                  type="button"
                  onClick={() => toggleTask(task.key)}
                >
                  <span className="task-icon">{task.icon}</span>
                  <span className="task-copy">
                    <strong>{task.title}</strong>
                  </span>
                  <span className="check-indicator">{daily[task.key] ? <Check size={17} /> : null}</span>
                </button>
              ))}
            </section>

            <p className="save-state">
              {busy ? "Uploading..." : saving ? "Saving..." : "Saved privately"}
            </p>
            {authMessage ? <p className="save-state">{authMessage}</p> : null}
          </section>
        ) : (
          <section className="progress-view">
            {expandedProgress ? (
              (() => {
                const { dateKey, day, item } = expandedProgress;
                const hasPhoto = Boolean(item.progressPhotoUrl);
                const isPast = dateKey < currentDateKey;
                // Only incomplete past days that already have a proof photo can
                // be repaired; without a photo you must upload one first.
                const incomplete = isPast && item.status === "gray";
                const needsPhoto = incomplete && !hasPhoto;
                const canRepair = incomplete && hasPhoto && tokens.available > 0;
                const lockedRepair = incomplete && hasPhoto && tokens.available <= 0;

                return (
                  <div className="expanded-photo-panel">
                    <div className="expanded-heading">
                      <button
                        className="text-button back-button"
                        type="button"
                        onClick={() => setExpandedProgressDate(null)}
                      >
                        ← All days
                      </button>
                      <span className={`status-pill ${item.status}`}>
                        <Star size={13} fill="currentColor" />
                        {statusLabel(item.status)}
                      </span>
                    </div>

                    <button
                      className={`expanded-photo-view ${item.status}`}
                      type="button"
                      onClick={() => hasPhoto && setExpandedProgressDate(null)}
                      aria-label={`Day ${day} progress`}
                    >
                      {hasPhoto ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.progressPhotoUrl}
                          alt={`Day ${day} progress expanded`}
                          loading="eager"
                          decoding="async"
                        />
                      ) : (
                        <div className="expanded-photo-empty">
                          <ImageIcon size={30} />
                          <span>No progress photo yet</span>
                        </div>
                      )}
                      <span className="expanded-photo-meta">
                        <span>Day {day}</span>
                        {item.repaired ? (
                          <span className="repaired-flag">
                            <Wand2 size={16} /> Repaired
                          </span>
                        ) : (
                          <Star size={30} fill="currentColor" />
                        )}
                      </span>
                    </button>

                    <div className="day-checklist glass-panel">
                      {tasks.map((task) => (
                        <div
                          className={`checklist-row ${item[task.key] ? "done" : ""}`}
                          key={task.key}
                        >
                          <span className="checklist-icon">{task.icon}</span>
                          <span className="checklist-title">{task.title}</span>
                          <span className="checklist-mark">
                            {item[task.key] ? <Check size={15} /> : <X size={14} />}
                          </span>
                        </div>
                      ))}
                      <div className={`checklist-row ${hasPhoto ? "done" : ""}`}>
                        <span className="checklist-icon">
                          <Camera size={20} />
                        </span>
                        <span className="checklist-title">Progress photo</span>
                        <span className="checklist-mark">
                          {hasPhoto ? <Check size={15} /> : <X size={14} />}
                        </span>
                      </div>
                    </div>

                    {item.repaired ? (
                      <div className="repair-banner repaired">
                        <Wand2 size={18} />
                        <p>This day was checked off with a blue-star repair token.</p>
                      </div>
                    ) : needsPhoto ? (
                      <div className="repair-banner locked">
                        <Camera size={18} />
                        <p>Upload a photo from this day first, then you can repair it.</p>
                      </div>
                    ) : canRepair ? (
                      <button
                        className="repair-button"
                        type="button"
                        onClick={() => repairDay(dateKey)}
                        disabled={busy}
                      >
                        <Wand2 size={18} />
                        {busy ? "Repairing..." : "Forgot to check something off"}
                        <span className="repair-cost">
                          <Star size={12} fill="currentColor" /> 1 token
                        </span>
                      </button>
                    ) : lockedRepair ? (
                      <div className="repair-banner locked">
                        <Lock size={18} />
                        <p>Earn a blue star to bank a repair token, then fix this day.</p>
                      </div>
                    ) : null}

                    <button
                      className="secondary-button expanded-upload-button"
                      type="button"
                      onClick={() => choosePhotoForDate(dateKey)}
                      disabled={busy}
                    >
                      <Upload size={18} />
                      {busy ? "Uploading..." : hasPhoto ? "Replace photo" : "Add photo"}
                    </button>
                  </div>
                );
              })()
            ) : (
              <>
                <div className="progress-heading">
                  <div>
                    <p>Progress</p>
                    <h1>Revel a little.</h1>
                  </div>
                </div>

                <div className={`token-strip glass-panel ${tokens.available > 0 ? "charged" : ""}`}>
                  <span className="token-strip-icon">
                    <Wand2 size={18} />
                  </span>
                  <strong>
                    {tokens.available} repair {tokens.available === 1 ? "token" : "tokens"}
                  </strong>
                  <button
                    className="info-button"
                    type="button"
                    aria-label="What are repair tokens?"
                    onClick={() => setInfo(infoTopics.tokens)}
                  >
                    <Info size={16} />
                  </button>
                </div>

                <div className="progress-grid">
                  {visibleDaysNewestFirst.map((day) => {
                    const dateKey = dateKeyForDay(effectiveStartDate, day);
                    const item = progress[dateKey] || emptyDailyRecord;
                    const hasPhoto = Boolean(item.progressPhotoUrl);
                    const isToday = dateKey === currentDateKey;

                    return (
                      <button
                        className={`progress-tile ${item.status} ${
                          hasPhoto ? "has-photo" : "missing-photo"
                        } ${item.repaired ? "repaired" : ""} ${isToday ? "is-today" : ""}`}
                        key={dateKey}
                        type="button"
                        onClick={() => setExpandedProgressDate(dateKey)}
                        aria-label={`Open day ${day}`}
                      >
                        {hasPhoto ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.progressPhotoUrl}
                            alt={`Day ${day} progress`}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <div className="tile-placeholder">
                            <ImageIcon size={22} />
                          </div>
                        )}
                        <div className="tile-scrim" />
                        {item.repaired ? (
                          <span className="tile-repaired" aria-hidden="true">
                            <Wand2 size={13} />
                          </span>
                        ) : null}
                        <div className="tile-meta">
                          <span>Day {day}</span>
                          <Star size={22} fill="currentColor" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        )}
        <footer className="app-version">v{appVersion}</footer>
      </main>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="liquid-sheet" />
      {children}
    </div>
  );
}
