# 75 hard

A private 75 Hard tracker built with Next.js, Firebase Auth, Firestore, Firebase Storage, and Vercel.

## Local Setup

1. Create a Firebase project.
2. Enable Firebase Authentication with Email link sign-in.
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

Also add your Vercel domain to Firebase Authentication authorized domains so email-link sign-in can complete.
