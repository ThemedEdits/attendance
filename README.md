# Attendance Register

A free-stack attendance app: **Firebase Auth** for sign-in, a **Google Sheet** as the
only database, a **Google Apps Script** web app as the secure API in between, and a
plain HTML/CSS/JS frontend deployed on **Vercel**. No paid services required.

```
Browser (Vercel static site)
   │  Firebase ID token on every request
   ▼
Google Apps Script Web App  ──►  Google Sheet (Students / Teachers / Subjects /
   (verifies token + role,           Classes / Attendance / Settings)
    enforces every permission)
```

## Why the backend looks the way it does

Your Apps Script `/exec` URL is public. Anyone can call it directly with curl,
bypassing your frontend entirely — so the frontend **cannot** be where access
control lives. `backend/Code.gs` re-checks on every single request:

1. **Who is calling** — the Firebase ID token sent from the browser is verified
   against Google itself (via the Identity Toolkit REST API), so it can't be
   forged or replayed with a different email.
2. **What they're allowed to touch** — the verified email is looked up fresh in
   your Students/Teachers sheet on every call. A student can only ever read
   their own rows. A teacher/CR can only read or write attendance for the
   classes/subjects listed against their row — never anyone else's.

Nothing the client sends (a role, a class id, an "isAdmin" flag) is ever
trusted — it's always re-derived from the sheet, server-side.

## 1. Update your Google Sheet

Your `Attendance` sheet already matches what the backend expects. Add/confirm
these columns (exact header spelling, any column order) on the other five
sheets:

| Sheet      | Columns |
|------------|---------|
| `Students` | `StudentID`, `Name`, `Email`, `ClassID` |
| `Teachers` | `TeacherID`, `Name`, `Email`, `Role`, `AssignedClassIDs`, `AssignedSubjectIDs` |
| `Classes`  | `ClassID`, `ClassName` |
| `Subjects` | `SubjectID`, `SubjectName`, `ClassID` |
| `Attendance` | `AttendanceID`, `Date`, `SubjectID`, `StudentID`, `Status` (already exists) |
| `Settings` | `Key`, `Value` (optional row: `AdminEmails` → `you@school.com,other@school.com`) |

Notes:
- **`Email`** must exactly match the email each person uses to sign in
  (case doesn't matter — it's lower-cased before comparing).
- **`Role`** in Teachers is just a label ("Teacher" or "CR") shown in the UI —
  permissions come entirely from the two `AssignedClassIDs`/`AssignedSubjectIDs`
  columns, so a CR is simply a Teacher row scoped to one class.
- **`AssignedClassIDs`** / **`AssignedSubjectIDs`** are comma-separated, e.g.
  `CLS001,CLS002`. Fill in whichever fits — a CR usually gets one ClassID; a
  subject teacher might list several SubjectIDs across different classes.
- Row 12 in your screenshot (`ATT...` with Student ID `v`) looks like test/typo
  data — worth deleting before going live.

## 2. Update the Apps Script backend

1. Open your Sheet → **Extensions → Apps Script**.
2. Replace the existing script with the contents of `backend/Code.gs`.
3. **Project Settings** (gear icon, left sidebar) → **Script Properties** → **Add script property**:
   - Name: `FIREBASE_API_KEY`
   - Value: `AIzaSyBDBeX8TJnUoyG2l-23bMko6q8pMgiC40E` (your Firebase Web API key —
     this is a public client key, safe to store here; it's used only to ask
     Google "is this ID token valid, and whose is it?")
4. **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the new `/exec` URL. If it's different from the one already in
   `js/api.js`, update `APPS_SCRIPT_URL` there.
   - Every time you edit `Code.gs`, use **Deploy → Manage deployments → Edit → New version**
     so the live `/exec` URL picks up your changes (saving alone isn't enough).

## 3. Firebase Auth

Already set up on your end (Email/Password + Google providers enabled, config
already dropped into `js/firebase-init.js`). Nothing else to do here — sign-up
is open to anyone with an email, but access to any data is still gated by
whether that email is on your Students/Teachers sheet.

## 4. Deploy the frontend to Vercel

1. Push this folder to a GitHub repo (or drag-and-drop it into the Vercel
   dashboard).
2. In Vercel: **New Project → Import** your repo.
3. Framework preset: **Other** (it's static HTML/CSS/JS — no build step, no
   environment variables needed).
4. Deploy. That's it — `vercel.json` and `.vercelignore` are already set up.

## 5. Test it

- Add yourself to the `Teachers` sheet with your real login email, `Role = CR`,
  and `AssignedClassIDs` set to one real `ClassID`.
- Sign in on the deployed site → you should land on **Mark attendance**, only
  see that one class, and be able to save a roll call.
- Add a student row with your (or a test account's) email → sign in with that
  account → you should land on **Your attendance**, view-only, filtered to
  only that student's own records.
- Try signing in with an email that's on neither sheet → you should land on
  the "not registered" page.

## File map

```
index.html            Sign in / sign up
student.html + js      Student dashboard (view own attendance)
teacher.html + js      Teacher/CR dashboard (mark, edit, delete attendance)
not-registered.html    Shown when a signed-in email isn't on the sheet
css/styles.css         Shared design system
js/firebase-init.js    Firebase app + auth setup
js/api.js              Calls to the Apps Script backend (attaches ID token)
js/guard.js            Redirects based on session + role before showing a page
backend/Code.gs        The Apps Script — paste into your Sheet's script editor
```

## A couple of things worth knowing

- **Free tier limits**: Apps Script web apps have daily quotas (URL Fetch
  calls, execution time) on a personal Google account — generous for a single
  school, but worth knowing about if usage grows a lot.
- **Firebase free (Spark) plan** covers Email/Password and Google sign-in with
  no cost at normal usage.
- **Vercel free (Hobby) plan** is enough for a static site like this.
- If you ever want an "admin" who can see everything regardless of assigned
  scope, add their email to `Settings!AdminEmails` — no code changes needed.
