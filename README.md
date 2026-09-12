# Attendance Register 2.0

A production-oriented attendance platform built around Firebase Authentication, Firestore, Vercel serverless APIs, and Google Sheets as the human-readable class register.

## Architecture

The application now follows the intended central-backend model:

```text
Browser
  │
  ├── Firebase Authentication
  │
  ▼
Vercel API /api
  │
  ├── Firestore: source of truth for users, classes, memberships,
  │              subjects, requests and attendance
  │
  └── Google APIs
       │
       └── CR-owned Google Sheet: register / reporting surface
```

There is **one central backend**, not one Apps Script deployment per CR. Google OAuth is handled by the Vercel serverless backend. Google refresh tokens are encrypted before being stored in Firestore.

## Roles and authorization

### Student
- Creates an account with email/password or Google.
- Completes profile information.
- Enters a class code and institutional seat number.
- Sends a class enrollment request.
- Waits for CR/teacher approval.
- After approval, sees only their own attendance.

### Teacher
- Creates an account and selects Teacher.
- Enters a class code during setup.
- Access is a request, not an automatic privilege.
- A CR approves the teacher's class membership.
- A CR assigns subjects to the teacher.
- Backend authorization allows the teacher to write attendance only for assigned subjects.

### Class Representative
- Selects Class Representative during setup.
- CR activation requires the configured authorization email and invite code.
- Connects Google through OAuth.
- Links one editable Google Sheet.
- Creates the class and receives a generated eight-character class code.
- Approves teachers and students.
- Creates subjects and assigns teachers.
- Manages the class workspace.

The role selected in the browser is never treated as sufficient authorization. Every API request is authenticated with a Firebase ID token and checked against Firestore membership/assignment data.

## Firestore data model

```text
users/{uid}
  email
  name
  photoURL
  role: student | teacher | cr | pending
  roleStatus: approved | pending | incomplete
  profileCompleted

classes/{classId}
  name
  university
  semester
  department
  batch
  section
  academicYear
  classCode
  crUid
  spreadsheetId
  spreadsheetName
  status

classes/{classId}/members/{uid}
  role: student | teacher | cr
  status: approved | pending
  seatNumber
  name
  fatherName
  email

subjects/{subjectId}
  name
  code
  classId
  teacherUid
  sheetTitle
  sheetId

enrollmentRequests/{requestId}
  uid
  type: student | teacher
  classId
  name
  email
  seatNumber
  status: Pending | Approved | Rejected
  createdAt
  reviewedAt
  reviewedBy
  decisionNote

attendance/{classId_subjectId}/sessions/{YYYY-MM-DD}
  classId
  subjectId
  date
  marks: { uid: 0 | 1 }
  updatedBy
  updatedAt

googleConnections/{uid}
  refreshTokenEncrypted
  scopes
  updatedAt
```

Firestore client access is intentionally denied in `firestore.rules`. All application data access goes through the authenticated Vercel API, which gives one authoritative authorization layer.

## Google Sheets behavior

A CR connects Google once and then links a Sheet they can edit. The backend verifies that:

- the URL is a Google Spreadsheet,
- the file is not trashed,
- the authorized Google account can edit it,
- the Sheet is not already linked to another class.

When a class is created, the backend prepares:

- `Class Info`
- `Students`
- `Subjects`

When a subject is created, its attendance tab is created automatically. Attendance data is stored in Firestore first and synchronized to the CR's Sheet by the server.

The Sheet is not the security boundary. A teacher never receives unrestricted Sheet credentials or direct write access from the browser. The Vercel API verifies the teacher, class membership, subject assignment, date rules, and attendance payload before changing Firestore or the Sheet.

## Attendance rules

- Future dates are rejected.
- Today's attendance can be edited during the day.
- A previous date becomes locked after its first submission.
- Students cannot write attendance.
- Teachers can write only their assigned subjects.
- CRs can manage subjects and attendance for their own classes.
- Attendance writes do not create arbitrary student records.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env.local`.
3. Create a Firebase service account and place its JSON into `FIREBASE_SERVICE_ACCOUNT_JSON` as one line.
4. Enable Firebase Authentication providers:
   - Email/Password
   - Google
5. Create a Firestore database.
6. Deploy `firestore.rules`.
7. Create a Google Cloud OAuth 2.0 Web application client.
8. Add the exact production callback URL:
   `https://YOUR-DOMAIN.com/api/google/callback`
9. Configure the Google OAuth consent screen and request the required Sheets/Drive scopes.
10. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, and `APP_STATE_SECRET` in Vercel.
11. Configure `CR_INVITE_EMAILS` and `CR_INVITE_CODE` for authorized CR onboarding.
12. Deploy the repository to Vercel.

Never commit `.env`, `.env.local`, Firebase service-account JSON, OAuth client secrets, or refresh tokens.

## Vercel environment variables

See `.env.example` for the complete list.

`GOOGLE_TOKEN_ENCRYPTION_KEY` should be a strong secret. The server derives an AES-256-GCM encryption key from it. Refresh tokens are never stored in plaintext.

`APP_ORIGIN` should be set to the production origin, for example `https://attendance.example.com`, to tighten API CORS. Same-origin deployment is recommended.

## Google OAuth production note

Google's OAuth verification requirements depend on the scopes and whether the application is internal or external. The requested Google Sheets and Drive scopes may require consent-screen configuration and Google verification before a public production rollout. This is a Google Cloud deployment requirement, not something that can be completed purely inside the source code.

## Legacy Apps Script

`backend/Code.gs` is retained as a migration/reference implementation for existing deployments. It is **not** the production backend for version 2.0. New deployments should use the Vercel `/api` functions and Firestore model.

Do not create a separate Apps Script deployment for every CR.

## Frontend

The frontend remains plain HTML, CSS, and JavaScript so it can be deployed without a build step. Firebase Auth is loaded from the official CDN ES modules. The application API is same-origin at `/api`.

Main pages:

```text
index.html                 Sign in / account creation
student-onboarding.html    Role and profile setup
student.html               Student attendance dashboard
teacher.html               Teacher / CR dashboard
not-registered.html        Legacy access fallback
```

## Production hardening included

- Server-side Firebase ID-token verification.
- Firestore server-only data access.
- Role and membership authorization on every sensitive operation.
- Subject-level teacher authorization.
- Google refresh-token encryption at rest.
- Short-lived OAuth state records.
- Google Sheet ownership/editability checks.
- Duplicate class-sheet prevention.
- Future-date and locked-date attendance validation.
- Input length and format validation.
- Same-origin API configuration.
- Security response headers and a restrictive Content Security Policy in `vercel.json`.
- No secrets embedded in frontend code.
- Loading, error, empty, and request states in the existing UI.

## Important deployment boundary

The source tree is production-ready from an application architecture and security perspective, but external services still require the operator's credentials and configuration. In particular, Firebase service-account credentials, Firestore, Firebase Auth providers, Google OAuth consent/client configuration, Vercel environment variables, and the CR authorization list must be configured in the respective consoles before a live deployment can authenticate users or access Google Sheets.
