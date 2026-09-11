import { auth } from "./firebase-init.js";

// Paste your Apps Script deployment's /exec URL here.
export const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxoPZ-7Sgzny-oetbBeOplrP087u82ttr2pblSqgUO-MVRvy1_CNB8SsuAiRgtrvl7iBQ/exec";

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "SERVER_ERROR";
  }
}

async function getIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) throw new ApiError("You're not signed in.", "AUTH_REQUIRED");
  return user.getIdToken(forceRefresh);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

// Apps Script responses bounce through a redirect (script.google.com →
// script.googleusercontent.com). Occasionally the final leg returns an
// HTML error page or an empty body even though the script ran fine.
// This returns a Symbol sentinel for "couldn't parse" so callers can
// distinguish it from a genuine error object.
const UNPARSEABLE = Symbol("unparseable");

async function parseResponseTolerant(response) {
  let text;
  try {
    text = await response.text();
  } catch (e) {
    return UNPARSEABLE;
  }
  if (!text) return UNPARSEABLE;

  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("<")) return UNPARSEABLE; // HTML error page

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return UNPARSEABLE;
  }
}

function handleResponse(response, body) {
  if (!body.success) {
    throw new ApiError(body.error || "Something went wrong.", body.code);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Request pipeline
// ---------------------------------------------------------------------------

async function requestWithToken(makeRequest, tolerateUnparseable) {
  let response = await makeRequest(await getIdToken());
  let parsed = await parseResponseTolerant(response);

  // Only refresh the token if the SERVER told us it was invalid in a
  // well-formed response. A lost/HTML body is NOT an auth failure.
  if (parsed && parsed.success === false && parsed.code === "AUTH_INVALID") {
    response = await makeRequest(await getIdToken(true));
    parsed = await parseResponseTolerant(response);
  }

  // GET-only retry for a stale redirect HTML page.
  if (parsed === UNPARSEABLE && !tolerateUnparseable && response && response.status === 404) {
    await new Promise((r) => setTimeout(r, 250));
    response = await makeRequest(await getIdToken());
    parsed = await parseResponseTolerant(response);
  }

  if (parsed === UNPARSEABLE) {
    if (tolerateUnparseable) {
      // POST whose body got lost in the redirect. Return null; callers
      // should re-sync from a GET rather than retry the write.
      return null;
    }
    throw new ApiError(
      "The server returned an unexpected response. Please try again.",
      "SERVER_UNAVAILABLE"
    );
  }

  return handleResponse(response, parsed);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function apiGet(action, params = {}) {
  return requestWithToken(async (idToken) => {
    const query = new URLSearchParams({ action, idToken, ...params, _: Date.now() });
    return fetch(`${APPS_SCRIPT_URL}?${query.toString()}`, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit"
    });
  }, /* tolerateUnparseable = */ false);
}

export async function apiPost(action, payload = {}) {
  return requestWithToken(
    // The payload is re-serialized on every attempt, so a retry after a
    // token refresh actually sends the NEW token in the body.
    (idToken) => fetch(APPS_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, idToken, ...payload })
    }),
    /* tolerateUnparseable = */ true
  );
}

// getBootstrap() is the ONE call dashboards should make on load — it
// returns identity plus every class/subject/student/teacher in one
// round-trip, instead of six-plus separate ones.
export const getBootstrap = () => apiGet("bootstrap");

export const getMe = () => apiGet("me");
export const getClasses = () => apiGet("classes");
export const getSubjects = (params) => apiGet("subjects", params);
export const getStudents = (params) => apiGet("students", params);
export const getTeachers = () => apiGet("teachers");
export const getAttendance = (params) => apiGet("attendance", params);
export const saveAttendance = (payload) => apiPost("saveAttendance", payload);
export const deleteAttendance = (attendanceId) => apiPost("deleteAttendance", { attendanceId });
export const addStudent = (payload) => apiPost("addStudent", payload);
export const addClass = (payload) => apiPost("addClass", payload);
export const addSubject = (payload) => apiPost("addSubject", payload);

// ---- Register sheet blueprint (subject grid view + row/column actions) ----
export const getSubjectSheet = (subjectId) => apiGet("subjectSheet", { subjectId });
export const deleteSubjectSheetRow = (subjectId, rowNumber) =>
  apiPost("deleteSubjectSheetRow", { subjectId, rowNumber });
export const deleteSubjectSheetColumn = (subjectId, date) =>
  apiPost("deleteSubjectSheetColumn", { subjectId, date });
export const renameSubjectSheetRow = (subjectId, rowNumber, newId, newName) =>
  apiPost("renameSubjectSheetRow", { subjectId, rowNumber, newId, newName });

// ---- Housekeeping: drop Subjects rows whose grid tab has been deleted ----
export const purgeMissingSubjects = () => apiPost("purgeMissingSubjects", {});

export { ApiError };