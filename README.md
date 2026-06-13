# streak

A private, sustainable training &amp; interview-prep streak tracker built with
Next.js, Firebase Auth, Firestore, Firebase Storage, and Vercel. It grew out of
a classic 75 Hard tracker and keeps the part that worked — a short binary daily
checklist that produces a clean "done for the day" state — while rebuilding the
rules to bend under disruption instead of resetting to zero.

## What it tracks

- **Daily floor** (binary toggles, each completable on a bad day): Movement
  (with an outdoor element), one LeetCode problem, read 10 pages, hit the
  current nutrition phase target, hydration, and "hold the lines." Check them
  all and the day is complete.
- **Optional progress photo** per day. Encouraged, never required to complete a
  day. Stored in Firebase Storage and attached to the day.
- **Disruption mode** for travel/chaos: swaps the full floor for a stripped one
  (movement, LeetCode, 10 pages, hold the lines). A completed disruption day is
  a fully valid day and advances the streak.
- **Streaks as epochs**: a streak has a start, an end (null while active), and an
  optional label. Only you end one ("End current streak" archives it; "Start new
  streak" begins the next). A missed day is recorded but never resets the streak.
- **Phase-aware nutrition**: configure your current phase (e.g. lean bulk,
  mini-cut) with protein and calorie targets; the nutrition toggle is about
  hitting that target.
- **History & archive**: a per-streak calendar distinguishing complete,
  disruption, and missed days, a LeetCode log, and an optional weekly review.
  Past streaks live in the Archive and stay out of the main view.
- **Hard-block mode** (optional, off by default): a time-boxed intensification
  that forces the full floor for N days.

### Migrating existing data

Existing daily records from the original 75 Hard run are never deleted or
rewritten. On first load after upgrading, the app detects your history and walks
you through archiving it as your first streak (you set/confirm its end date),
then starts a fresh streak. Epoch membership is derived from date ranges, so the
migration adds new `epochs` documents without touching any existing `daily` doc.

## Local Setup

1. Create a Firebase project.
2. Enable Firebase Authentication with Phone sign-in.
3. Create a Firestore database.
4. Enable Firebase Storage.
5. Copy `.env.local.example` to `.env.local` and fill in your Firebase web app config.
6. Run the app:

```bash
npm install
npm run dev
```

## Firebase Rules

Deploy the included rules after choosing your Firebase project:

```bash
firebase deploy --only firestore:rules,storage
```

The rules scope profile documents, daily records, streak epochs, weekly reviews,
and progress photos to the authenticated user id. Redeploy `firestore:rules`
after upgrading so the new `epochs` and `reviews` subcollections are covered.

## Vercel

Add these environment variables in Vercel before deploying:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`

Also add your Vercel domain to Firebase Authentication authorized domains so phone sign-in can complete.

## Reminders (web push)

The app can send three daily push notifications:

- 7am local time: "Day X of 75 Hard."
- 7pm local time: a check-in listing any remaining items.
- 10pm local time: a "great work" message when every item is done.

### Firebase setup

1. In the Firebase console open **Project settings → Cloud Messaging → Web push certificates** and generate a key pair. Copy the public key into `NEXT_PUBLIC_FIREBASE_VAPID_KEY`.
2. Open **Project settings → Service accounts** and click **Generate new private key**. Paste the entire JSON into `FIREBASE_SERVICE_ACCOUNT_JSON` on Vercel (escape newlines in the private key as `\n` or keep them literal — both work).
3. Set a random string in `CRON_SECRET`. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to `/api/cron/notify`.

### Vercel cron

`vercel.json` schedules `/api/cron/notify` to run hourly. On the Hobby tier crons run only once per day, which covers only one of the three slots — use a Pro project, or trigger the endpoint externally (cron-job.org, GitHub Actions, etc.) with the same bearer token to get all three.

### iOS users

iOS Safari requires the app to be installed before push works. In Safari, tap the share icon and choose **Add to Home Screen**, reopen 75 Hard from the home screen, then tap **Enable reminders** on the Today tab. macOS Safari, Chrome, Firefox, and Android Chrome all work without installing.
