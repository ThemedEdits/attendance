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

export async function apiGet(action, params = {}) {
  return requestWithToken(async (idToken) => {
    const query = new URLSearchParams({ action, idToken, ...params });
    return fetch(`${APPS_SCRIPT_URL}?${query.toString()}`, {
      method: "GET",
      redirect: "follow"
    });
  });
}

export async function apiPost(action, payload = {}) {
  return requestWithToken(async (idToken) => fetch(APPS_SCRIPT_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, idToken, ...payload })
  }));
}

async function requestWithToken(makeRequest) {
  let response = await makeRequest(await getIdToken());
  let body = await parseResponse(response);

  // Firebase tokens expire periodically. Refresh once instead of failing a save or read.
  if (body && !body.success && body.code === "AUTH_INVALID") {
    response = await makeRequest(await getIdToken(true));
    body = await parseResponse(response);
  }

  return handleResponse(response, body);
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const endpointMessage = response.status === 404
      ? "The Apps Script endpoint was not found. Redeploy the web app and update APPS_SCRIPT_URL."
      : `The server returned an unexpected response (HTTP ${response.status}).`;
    throw new ApiError(endpointMessage, "SERVER_UNAVAILABLE");
  }
}

function handleResponse(response, body) {
  if (!body.success) {
    throw new ApiError(body.error || "Something went wrong.", body.code);
  }

  return body.data;
}

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

export { ApiError };