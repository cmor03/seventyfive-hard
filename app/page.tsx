"use client";

import {
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Dumbbell,
  Droplets,
  ImageIcon,
  LogOut,
  Phone,
  Salad,
  ShieldCheck,
  Sparkles,
  Star,
  Upload,
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
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type DocumentData,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, db, isFirebaseConfigured, storage } from "@/lib/firebase";
import {
  calculateStatus,
  dateKeyForDay,
  dayNumberFromStart,
  emptyDailyRecord,
  todayKey,
  type DailyRecord,
  type StarStatus,
  type UserProfile,
} from "@/lib/progress";

type ViewMode = "today" | "progress";
const recaptchaContainerId = "phone-recaptcha-container";

type Task = {
  key: keyof Omit<DailyRecord, "progressPhotoUrl" | "status" | "updatedAt">;
  title: string;
  detail: string;
  icon: React.ReactNode;
  special?: boolean;
};

const tasks: Task[] = [
  {
    key: "workout1",
    title: "45 min workout",
    detail: "First training block",
    icon: <Dumbbell size={20} />,
  },
  {
    key: "workout2",
    title: "45 min workout",
    detail: "Second training block",
    icon: <Dumbbell size={20} />,
  },
  {
    key: "outsideWorkout",
    title: "One workout outside",
    detail: "Fresh air required",
    icon: <Sparkles size={20} />,
  },
  {
    key: "strictDiet",
    title: "Strict diet",
    detail: "No alcohol. No cheat days.",
    icon: <Salad size={20} />,
  },
  {
    key: "waterGallon",
    title: "One gallon of water",
    detail: "Hydration complete",
    icon: <Droplets size={20} />,
  },
  {
    key: "read10Pages",
    title: "Read 10 pages",
    detail: "Physical or focused reading",
    icon: <CalendarDays size={20} />,
  },
  {
    key: "leetcode30",
    title: "LeetCode 30 minutes",
    detail: "Blue star accelerator",
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

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [authMessage, setAuthMessage] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [startDate, setStartDate] = useState(todayKey());
  const [daily, setDaily] = useState<DailyRecord>(emptyDailyRecord);
  const [progress, setProgress] = useState<Record<string, DailyRecord>>({});
  const [view, setView] = useState<ViewMode>("today");
  const [expandedProgressDate, setExpandedProgressDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);

  const currentDateKey = todayKey();
  const currentDay = profile ? dayNumberFromStart(profile.startDate) : 1;
  const visibleDays = useMemo(
    () => Array.from({ length: currentDay }, (_, index) => index + 1),
    [currentDay],
  );
  const expandedProgress = useMemo(() => {
    if (!expandedProgressDate || !profile) return null;
    const day =
      visibleDays.find((visibleDay) => dateKeyForDay(profile.startDate, visibleDay) === expandedProgressDate) ??
      currentDay;
    const item = progress[expandedProgressDate];

    if (!item?.progressPhotoUrl) return null;

    return { dateKey: expandedProgressDate, day, item };
  }, [currentDay, expandedProgressDate, profile, progress, visibleDays]);

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
    const loadProfileAndToday = async () => {
      if (!user || !db) {
        setProfile(null);
        return;
      }
      const activeDb = db;

      const profileRef = doc(activeDb, "users", user.uid);
      const profileSnap = await getDoc(profileRef);

      if (profileSnap.exists()) {
        const nextProfile = profileSnap.data() as UserProfile;
        setProfile(nextProfile);
        setStartDate(nextProfile.startDate);
      } else {
        setProfile(null);
      }

      const todaySnap = await getDoc(doc(activeDb, "users", user.uid, "daily", currentDateKey));
      setDaily(recordFromData(todaySnap.data()));
    };

    loadProfileAndToday().catch((error: Error) => {
      setAuthMessage(error.message);
    });
  }, [currentDateKey, user]);

  useEffect(() => {
    const loadProgress = async () => {
      if (!user || !db || !profile) return;
      const activeDb = db;

      const dayEntries = await Promise.all(
        visibleDays.map(async (day) => {
          const dateKey = dateKeyForDay(profile.startDate, day);
          const snapshot = await getDoc(doc(activeDb, "users", user.uid, "daily", dateKey));
          return [dateKey, recordFromData(snapshot.data())] as const;
        }),
      );

      setProgress(Object.fromEntries(dayEntries));
    };

    loadProgress().catch((error: Error) => {
      setAuthMessage(error.message);
    });
  }, [profile, user, visibleDays]);

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
    const nextProfile: UserProfile = {
      startDate,
      createdAt: serverTimestamp(),
      email: user.email,
      phoneNumber: user.phoneNumber,
    };
    await setDoc(doc(activeDb, "users", user.uid), nextProfile, { merge: true });
    setProfile(nextProfile);
    setBusy(false);
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

  async function uploadPhoto(file?: File) {
    if (!file || !user || !storage) return;
    if (!isAcceptedImage(file)) {
      setAuthMessage("Please choose an image file.");
      return;
    }

    setBusy(true);
    setAuthMessage("");

    try {
      const imageFile = await uploadableImage(file);
      const extension = fileExtension(imageFile);
      const photoRef = ref(storage, `users/${user.uid}/progress/${currentDateKey}.${extension}`);
      await uploadBytes(photoRef, imageFile, {
        contentType: imageFile.type || "image/jpeg",
        customMetadata: {
          date: currentDateKey,
          originalType: file.type || "unknown",
          convertedFromHeic: `${isHeicFile(file)}`,
        },
      });
      const progressPhotoUrl = await getDownloadURL(photoRef);
      await persistDaily({ ...daily, progressPhotoUrl });
      setAuthMessage("Progress photo saved.");
    } catch (error) {
      setAuthMessage(readableError(error));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setBusy(false);
    }
  }

  async function handleSignOut() {
    if (!auth) return;
    await signOut(auth);
    setUser(null);
    setProfile(null);
    setDaily(emptyDailyRecord);
    setProgress({});
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
            The app will calculate the current day automatically from this date.
          </p>
          <form className="auth-form" onSubmit={saveProfile}>
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
          <button className="icon-button" aria-label="Previous view" type="button">
            <ChevronLeft size={20} />
          </button>
          <div className="day-display">
            <span>Day</span>
            <strong>{currentDay}</strong>
            <span>of 75</span>
          </div>
          <button className="icon-button" aria-label="Sign out" type="button" onClick={handleSignOut}>
            <LogOut size={19} />
          </button>
        </header>

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

        {view === "today" ? (
          <section className="daily-layout">
            <div className={`hero-status glass-panel ${daily.status}`}>
              <div>
                <p>{statusLabel(daily.status)}</p>
                <h1>{daily.status === "blue" ? "Blue looks good on you." : "Stack the day."}</h1>
              </div>
              <div className="status-star" aria-hidden="true">
                <Star size={58} fill="currentColor" />
              </div>
            </div>

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
                    <span>{task.detail}</span>
                  </span>
                  <span className="check-indicator">{daily[task.key] ? <Check size={17} /> : null}</span>
                </button>
              ))}
            </section>

            <section className="photo-panel glass-panel">
              <div className="photo-copy">
                <Camera size={21} />
                <div>
                  <h2>Progress picture</h2>
                  <p>Required for gold and blue stars.</p>
                </div>
              </div>
              {daily.progressPhotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="today-photo" src={daily.progressPhotoUrl} alt="Today progress" />
              ) : (
                <button
                  className="photo-placeholder"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon size={26} />
                  <span>Add today’s photo</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="image/*,.heic,.heif"
                onChange={(event) => uploadPhoto(event.target.files?.[0])}
              />
              <button
                className="secondary-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <Upload size={18} />
                {busy ? "Uploading..." : daily.progressPhotoUrl ? "Replace photo" : "Upload photo"}
              </button>
            </section>

            <p className="save-state">{saving ? "Saving..." : "Saved privately"}</p>
            {authMessage ? <p className="save-state">{authMessage}</p> : null}
          </section>
        ) : (
          <section className="progress-view">
            <div className="progress-heading">
              <div>
                <p>Progress</p>
                <h1>Revel a little.</h1>
              </div>
              <button className="icon-button" aria-label="Next view" type="button">
                <ChevronRight size={20} />
              </button>
            </div>
            {expandedProgress ? (
              <button
                className={`expanded-photo-view ${expandedProgress.item.status}`}
                type="button"
                onClick={() => setExpandedProgressDate(null)}
                aria-label={`Collapse day ${expandedProgress.day} progress photo`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={expandedProgress.item.progressPhotoUrl}
                  alt={`Day ${expandedProgress.day} progress expanded`}
                />
                <span className="expanded-photo-meta">
                  <span>Day {expandedProgress.day}</span>
                  <Star size={32} fill="currentColor" />
                </span>
              </button>
            ) : (
              <div className="progress-grid">
                {visibleDays.map((day) => {
                  const dateKey = dateKeyForDay(profile.startDate, day);
                  const item = progress[dateKey] || emptyDailyRecord;
                  const hasPhoto = Boolean(item.progressPhotoUrl);

                  return (
                    <button
                      className={`progress-tile ${item.status} ${hasPhoto ? "has-photo" : "missing-photo"}`}
                      key={dateKey}
                      type="button"
                      onClick={() => {
                        if (hasPhoto) setExpandedProgressDate(dateKey);
                      }}
                      disabled={!hasPhoto}
                      aria-label={
                        hasPhoto
                          ? `Expand day ${day} progress photo`
                          : `Day ${day} has no progress photo yet`
                      }
                    >
                      {hasPhoto ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.progressPhotoUrl} alt={`Day ${day} progress`} />
                      ) : (
                        <div className="tile-placeholder">
                          <ImageIcon size={22} />
                        </div>
                      )}
                      <div className="tile-scrim" />
                      <div className="tile-meta">
                        <span>Day {day}</span>
                        <Star size={24} fill="currentColor" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
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
