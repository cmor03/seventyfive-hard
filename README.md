# 75 hard

A private 75 Hard tracker built with Next.js, Firebase Auth, Firestore, Firebase Storage, and Vercel.

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

The rules scope profile documents, daily records, and progress photos to the authenticated user id.

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
