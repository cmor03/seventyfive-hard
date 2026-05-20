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
  Mail,
  Salad,
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
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  setPersistence,
  signInWithEmailLink,
  signOut,
  type User,
} from "firebase/auth";
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

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";

function signInRedirectUrl() {
  return appUrl || window.location.origin;
}

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

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
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
      setSaving(false);
    },
    [currentDateKey, user],
  );

  useEffect(() => {
    if (!auth || !isFirebaseConfigured) {
      setAuthReady(true);
      return;
    }

    const activeAuth = auth;
    setPersistence(activeAuth, browserLocalPersistence);

    const finishEmailLinkSignIn = async () => {
      if (!isSignInWithEmailLink(activeAuth, window.location.href)) return;
      const storedEmail = window.localStorage.getItem("75-hard-email");
      const linkEmail = storedEmail || window.prompt("Confirm your email");

      if (!linkEmail) return;

      await signInWithEmailLink(activeAuth, linkEmail, window.location.href);
      window.localStorage.removeItem("75-hard-email");
      window.history.replaceState({}, document.title, window.location.origin);
    };

    finishEmailLinkSignIn().catch((error: Error) => {
      setAuthMessage(error.message);
    });

    return onAuthStateChanged(activeAuth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

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

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setBusy(true);
    setAuthMessage("");

    await sendSignInLinkToEmail(auth, email, {
      url: signInRedirectUrl(),
      handleCodeInApp: true,
    });

    window.localStorage.setItem("75-hard-email", email);
    setAuthMessage("Check your email for a private sign-in link.");
    setBusy(false);
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
    };
    await setDoc(doc(activeDb, "users", user.uid), nextProfile, { merge: true });
    setProfile(nextProfile);
    setBusy(false);
  }

  async function toggleTask(key: Task["key"]) {
    const nextRecord = { ...daily, [key]: !daily[key] };
    await persistDaily(nextRecord);
  }

  async function uploadPhoto(file?: File) {
    if (!file || !user || !storage) return;
    setBusy(true);
    const extension = file.name.split(".").pop() || "jpg";
    const photoRef = ref(storage, `users/${user.uid}/progress/${currentDateKey}.${extension}`);
    await uploadBytes(photoRef, file, {
      contentType: file.type,
    });
    const progressPhotoUrl = await getDownloadURL(photoRef);
    await persistDaily({ ...daily, progressPhotoUrl });
    setBusy(false);
  }

  async function handleSignOut() {
    if (!auth) return;
    await signOut(auth);
    setUser(null);
    setProfile(null);
    setDaily(emptyDailyRecord);
    setProgress({});
    setExpandedProgressDate(null);
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
            Sign in with a magic link. Your daily photos stay locked to your account.
          </p>
          <form className="auth-form" onSubmit={sendMagicLink}>
            <label htmlFor="email">Email</label>
            <div className="email-field">
              <Mail size={18} />
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Sending..." : "Send sign-in link"}
            </button>
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
                accept="image/*"
                onChange={(event) => uploadPhoto(event.target.files?.[0])}
              />
              <button
                className="secondary-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <Upload size={18} />
                {daily.progressPhotoUrl ? "Replace photo" : "Upload photo"}
              </button>
            </section>

            <p className="save-state">{saving ? "Saving..." : "Saved privately"}</p>
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
