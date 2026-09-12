/**
 * ATTENDANCE MANAGEMENT SYSTEM - BACKEND (Google Apps Script)
 * ============================================================
 * DATA MODEL FOR ATTENDANCE
 * ---------------------------
 * Each Subject has its own grid sheet:
 *
 *      | Student ID | Name       | 2026-09-04 | 2026-09-09 | Total (of 2)
 *      | STU001     | Ali Raza   |     1      |     1      |     2
 *      | STU002     | Sara Khan  |     0      |     1      |     1
 *
 * - Date columns are always kept in chronological (sorted) order,
 *   regardless of the order they were entered in.
 * - "Total (of N)" is always the LAST column and always reflects each
 *   student's total presents out of N sessions held so far. It shifts
 *   right automatically whenever a new date column is inserted.
 *
 * ATTENDANCE LOCK RULE
 * ----------------------
 *  - TODAY's column can be created and re-saved freely, any number of
 *    times, all day.
 *  - Any OTHER date (a "backfill" for a day you missed) can be saved
 *    exactly ONCE - the first save creates that date's column. The
 *    instant it exists, that date is permanently locked, even if you
 *    try to save it again seconds later. Future dates are rejected.
 *  - Once today's date rolls over (becomes yesterday), its column is
 *    locked the same way - nothing is special-cased about "the day it
 *    was created", only whether the date equals the server's current
 *    date right now.
 *
 * SUBJECT LIFECYCLE
 * ------------------
 * A subject is only "live" if its grid sheet tab exists on the
 * spreadsheet. Deleting the tab is the effective way to remove a subject
 * from the app - it disappears from every dropdown and every read.
 * Only addSubject() is allowed to CREATE a grid sheet.
 *
 * PERMISSION MODEL
 * -----------------
 * Two roles only:
 *  - "student" : read-only, sees only their own attendance.
 *  - "staff"   : any row in the Teachers sheet (Role = "Teacher" or "CR" -
 *                cosmetic label, identical permissions). Full access to
 *                every class, subject, student and attendance record.
 *
 * SECURITY MODEL
 * ---------------
 * This web app's /exec URL is public. Every request re-verifies:
 *   1. WHO is calling  -> Firebase ID token, verified against Google via
 *      the Identity Toolkit REST API.
 *   2. WHAT they're allowed to do -> re-derived from the Students/Teachers
 *      sheets on every call, never trusted from the client.
 *
 * SHEETS EXPECTED (header text can have spaces or not - normalized either way)
 * -----------------------------------------------------------------------------
 *  Students   : Student ID | Name | Email | Class ID | Status
 *  Teachers   : Teacher ID | Name | Email | Role
 *  Classes    : Class ID | Class Name | Academic Year
 *  Subjects   : Subject ID | Subject Name | Teacher ID | Class ID
 *  Attendance : (legacy - no longer written to; see migrateOldAttendance())
 *  Settings   : Setting | Value   (optional row: AdminEmails -> comma list)
 *
 * SETUP
 * -----
 *  1. Extensions -> Apps Script -> paste this file as Code.gs
 *  2. Project Settings -> Script Properties -> FIREBASE_API_KEY = <your Firebase Web API key>
 *  3. Run "authorizeExternalRequests" once from the editor and grant the
 *     permission prompt.
 *  4. Deploy -> New deployment -> Web app -> Execute as: Me, Access: Anyone
 *  5. Copy the /exec URL into the frontend's js/api.js
 */

// =====================================================
// CONFIG
// =====================================================

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

const SHEETS = {
  STUDENTS: 'Students',
  TEACHERS: 'Teachers',
  SUBJECTS: 'Subjects',
  CLASSES: 'Classes',
  ATTENDANCE: 'Attendance', // legacy flat log - kept for migration only
  SETTINGS: 'Settings',
  ENROLLMENTS: 'EnrollmentRequests'
};

// Cell background colors for attendance marks (mirrors the CSS palette).
const ATTENDANCE_COLORS = {
  PRESENT: '#d9ead3', // light green
  ABSENT: '#f4cccc'  // light red
};

function authorizeExternalRequests() {
  UrlFetchApp.fetch('https://www.google.com');
}

// =====================================================
// ERRORS
// =====================================================

function AppError(message, code) {
  const err = new Error(message);
  err.code = code || 'SERVER_ERROR';
  return err;
}

// =====================================================
// ENTRY POINTS
// =====================================================

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const actor = authenticate(params.idToken);
    const action = params.action;

    let data;
    switch (action) {
      case 'me':
        data = buildMePayload(actor);
        break;
      case 'bootstrap':
        data = buildBootstrapPayload(actor);
        break;
      case 'classes':
        data = listClasses(actor);
        break;
      case 'subjects':
        data = listSubjects(actor, params);
        break;
      case 'students':
        data = listStudents(actor, params);
        break;
      case 'teachers':
        data = listTeachers(actor);
        break;
      case 'attendance':
        data = listAttendance(actor, params);
        break;
      case 'subjectSheet':
        data = getSubjectSheet(actor, params);
        break;
      case 'enrollment':
        data = getEnrollmentPayload(actor);
        break;
      case 'enrollmentRequests':
        data = getEnrollmentRequestsForActor(actor);
        break;
      default:
        throw AppError('Unknown action "' + action + '".', 'BAD_REQUEST');
    }

    return jsonResponse({ success: true, data: data });

  } catch (error) {
    return errorResponse(error);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw AppError('No POST data received.', 'BAD_REQUEST');
    }

    const body = JSON.parse(e.postData.contents);
    const actor = authenticate(body.idToken);
    const action = body.action;

    lock.waitLock(15000);

    let result;
    switch (action) {
      case 'saveAttendance':
        result = saveAttendance(actor, body);
        break;
      case 'deleteAttendance':
        result = deleteAttendance(actor, body);
        break;
      case 'addClass':
        result = addClass(actor, body);
        break;
      case 'addSubject':
        result = addSubject(actor, body);
        break;
      case 'addStudent':
        result = addStudent(actor, body);
        break;
      case 'deleteSubjectSheetRow':
        result = deleteSubjectSheetRow(actor, body);
        break;
      case 'deleteSubjectSheetColumn':
        result = deleteSubjectSheetColumn(actor, body);
        break;
      case 'renameSubjectSheetRow':
        result = renameSubjectSheetRow(actor, body);
        break;
      case 'purgeMissingSubjects':
        result = purgeMissingSubjects(actor);
        break;
      case 'submitEnrollment':
        result = submitEnrollment(actor, body);
        break;
      case 'reviewEnrollment':
        result = reviewEnrollment(actor, body);
        break;
      default:
        throw AppError('Unknown action "' + action + '".', 'BAD_REQUEST');
    }

    return jsonResponse({ success: true, data: result });

  } catch (error) {
    return errorResponse(error);
  } finally {
    try { lock.releaseLock(); } catch (e2) { /* no-op */ }
  }
}

// =====================================================
// AUTH
// =====================================================

function authenticate(idToken) {
  if (!idToken) throw AppError('You must be signed in.', 'AUTH_REQUIRED');

  const verified = verifyIdTokenCached(idToken);
  const actor = resolveActor(verified.email);

  if (!actor) {
    throw AppError('This account is not available.', 'NOT_REGISTERED');
  }

  actor.email = verified.email;
  actor.uid = verified.uid;
  return actor;
}

// Verifying a Firebase ID token means an outbound network call to Google
// on every single request - one of the biggest fixed costs per call.
// Since the same token stays valid for up to an hour, cache a successful
// verification for a while so repeat calls in one session skip that
// round-trip entirely. Keyed by a hash of the token, never the token
// itself, so nothing sensitive sits in the cache.
function verifyIdTokenCached(idToken) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  ).slice(0, 40);

  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const apiKey = PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY');
  if (!apiKey) throw AppError('Server is missing FIREBASE_API_KEY. Set it in Script Properties.', 'SERVER_ERROR');

  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw AppError('Your session has expired. Please sign in again.', 'AUTH_INVALID');
  }

  const body = JSON.parse(response.getContentText());
  const user = body.users && body.users[0];
  if (!user || !user.email) {
    throw AppError('Your session has expired. Please sign in again.', 'AUTH_INVALID');
  }

  const result = { email: user.email.trim().toLowerCase(), uid: user.localId };
  cache.put(cacheKey, JSON.stringify(result), 1500); // 25 minutes, safely under token expiry
  return result;
}

function resolveActor(email) {
  ensureEnrollmentInfrastructure();

  const settings = getSettingsMap();
  const adminEmails = splitIds(settings.AdminEmails).map(function (s) { return s.toLowerCase(); });
  const isAdmin = adminEmails.indexOf(email) !== -1;

  const teachers = getSheetData(SHEETS.TEACHERS);
  const teacherRow = teachers.find(function (t) {
    return String(t.Email || '').trim().toLowerCase() === email;
  });

  if (teacherRow) {
    const roleLabel = String(teacherRow.Role || 'Teacher').trim() || 'Teacher';
    return {
      role: 'staff',
      roleLabel: isAdmin ? 'Admin' : roleLabel,
      isAdmin: isAdmin,
      teacherId: teacherRow.TeacherID,
      name: teacherRow.Name,
      assignedClassIds: splitIds(teacherRow.AssignedClassIDs),
      assignedSubjectIds: splitIds(teacherRow.AssignedSubjectIDs)
    };
  }

  const students = getSheetData(SHEETS.STUDENTS);
  const studentRow = students.find(function (s) {
    return String(s.Email || '').trim().toLowerCase() === email && String(s.Status || 'Active').toLowerCase() !== 'pending';
  });

  if (studentRow) {
    return {
      role: 'student',
      roleLabel: 'Student',
      isAdmin: false,
      studentId: studentRow.StudentID,
      name: studentRow.Name,
      seatNumber: studentRow.StudentID,
      classId: studentRow.ClassID
    };
  }

  const request = getLatestEnrollmentRequest(email);
  if (request && String(request.Status || '').toLowerCase() === 'pending') {
    return {
      role: 'applicant',
      roleLabel: 'Awaiting approval',
      isAdmin: false,
      name: request.Name,
      seatNumber: request.SeatNumber,
      requestId: request.RequestID,
      requestedClassId: request.ClassID,
      enrollmentStatus: 'Pending'
    };
  }

  if (isAdmin) {
    return { role: 'staff', roleLabel: 'Admin', isAdmin: true, assignedClassIds: [], assignedSubjectIds: [] };
  }

  return {
    role: 'applicant',
    roleLabel: 'Student setup',
    isAdmin: false,
    name: '',
    enrollmentStatus: request ? String(request.Status || 'Rejected') : 'Not started',
    lastRequest: request || null
  };
}

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

// =====================================================
// ENROLLMENT INFRASTRUCTURE
// =====================================================

const ENROLLMENT_HEADERS = [
  'RequestID', 'Name', 'Email', 'SeatNumber', 'ClassID', 'Status',
  'RequestedAt', 'ReviewedAt', 'ReviewedBy', 'DecisionNote'
];

function setupEnrollmentSystem() {
  ensureEnrollmentInfrastructure();
  const teachers = getSheet(SHEETS.TEACHERS);
  ensureColumns(teachers, ['AssignedClassIDs', 'AssignedSubjectIDs']);
  Logger.log('Enrollment system is ready. EnrollmentRequests was created if it did not exist, and Students/Teachers required columns were added if missing.');
}

function ensureEnrollmentInfrastructure() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.ENROLLMENTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.ENROLLMENTS);
    sheet.getRange(1, 1, 1, ENROLLMENT_HEADERS.length).setValues([ENROLLMENT_HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    ensureColumns(sheet, ENROLLMENT_HEADERS);
  }

  const students = ss.getSheetByName(SHEETS.STUDENTS);
  if (students) ensureColumns(students, ['Status']);
}

function ensureColumns(sheet, requiredHeaders) {
  const current = sheet.getDataRange().getValues()[0] || [];
  const normalized = current.map(normalizeHeader);
  requiredHeaders.forEach(function (header) {
    if (normalized.indexOf(normalizeHeader(header)) === -1) {
      const nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue(header);
      normalized.push(normalizeHeader(header));
    }
  });
}

function getLatestEnrollmentRequest(email) {
  ensureEnrollmentInfrastructure();
  const normalized = String(email || '').trim().toLowerCase();
  const rows = getSheetData(SHEETS.ENROLLMENTS);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].Email || '').trim().toLowerCase() === normalized) return rows[i];
  }
  return null;
}

function getEnrollmentRequestsForActor(actor) {
  if (actor.role !== 'staff') throw AppError('Only teachers and CRs can view enrollment requests.', 'FORBIDDEN');
  ensureEnrollmentInfrastructure();
  const rows = getSheetData(SHEETS.ENROLLMENTS).filter(function (r) {
    return String(r.Status || '').toLowerCase() === 'pending';
  });
  return rows.map(function (r) {
    return {
      RequestID: r.RequestID,
      Name: r.Name,
      Email: r.Email,
      SeatNumber: r.SeatNumber,
      ClassID: r.ClassID,
      Status: r.Status,
      RequestedAt: r.RequestedAt
    };
  });
}

function canManageClass(actor, classId) {
  if (!classId) return false;
  return actor.role === 'staff';
}

function assertCanManageClass(actor, classId) {
  if (!canManageClass(actor, classId)) {
    throw AppError('You are not assigned to this class.', 'FORBIDDEN');
  }
}

// =====================================================
// SHEET HELPERS
// =====================================================

// Memoized per execution: without this, every single getSheetData() /
// getSheet() call re-opens the whole spreadsheet by ID from scratch -
// and a single request (e.g. bootstrap) calls those many times. This
// alone removes most of the redundant work within one request.
let _cachedSpreadsheet = null;
function getSpreadsheet() {
  if (!_cachedSpreadsheet) {
    _cachedSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _cachedSpreadsheet;
}

function getSheet(sheetName) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw AppError('Sheet "' + sheetName + '" not found.', 'SERVER_ERROR');
  return sheet;
}

function normalizeHeader(h) {
  return String(h || '').replace(/[^a-zA-Z0-9]/g, '');
}

function getSheetData(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  const headers = data[0].map(normalizeHeader);
  return data.slice(1)
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function appendRowByHeaders(sheetName, valuesObj) {
  const sheet = getSheet(sheetName);
  const realHeaders = sheet.getDataRange().getValues()[0] || [];
  if (!realHeaders.length) throw AppError('Sheet "' + sheetName + '" has no header row.', 'SERVER_ERROR');
  const row = realHeaders.map(function (h) {
    const key = normalizeHeader(h);
    return valuesObj.hasOwnProperty(key) ? valuesObj[key] : '';
  });
  sheet.appendRow(row);
  return row;
}

function generateSequentialId(sheetName, normalizedIdKey, prefix, padLength) {
  const rows = getSheetData(sheetName);
  let max = 0;
  rows.forEach(function (r) {
    const match = String(r[normalizedIdKey] || '').match(/(\d+)\s*$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  });
  return prefix + String(max + 1).padStart(padLength, '0');
}

function assertEmailNotTaken(email) {
  const students = getSheetData(SHEETS.STUDENTS);
  const teachers = getSheetData(SHEETS.TEACHERS);
  const taken =
    students.some(function (s) { return String(s.Email || '').trim().toLowerCase() === email; }) ||
    teachers.some(function (t) { return String(t.Email || '').trim().toLowerCase() === email; });
  if (taken) throw AppError('That email is already registered to someone else.', 'VALIDATION_ERROR');
}


function getSettingsMap() {
  let rows;
  try {
    rows = getSheetData(SHEETS.SETTINGS);
  } catch (e) {
    return {};
  }
  const map = {};
  rows.forEach(function (r) {
    const key = r.Setting || r.Key;
    if (key) map[String(key).trim()] = r.Value;
  });
  return map;
}

function formatDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function todayString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// =====================================================
// VALIDATION HELPERS
// =====================================================

function assertSubjectExists(subjectId) {
  const subjects = getSheetData(SHEETS.SUBJECTS);
  const subject = subjects.find(function (s) { return String(s.SubjectID) === String(subjectId); });
  if (!subject) throw AppError('Unknown subject "' + subjectId + '".', 'BAD_REQUEST');
  return subject;
}

function assertStudentExists(studentId, expectedClassId) {
  const students = getSheetData(SHEETS.STUDENTS);
  const student = students.find(function (s) { return String(s.StudentID) === String(studentId); });
  if (!student) throw AppError('Unknown student "' + studentId + '".', 'BAD_REQUEST');
  if (expectedClassId && String(student.ClassID) !== String(expectedClassId)) {
    throw AppError('Student "' + studentId + '" is not in that class.', 'BAD_REQUEST');
  }
  return student;
}

// =====================================================
// SUBJECT SHEETS - one grid sheet per subject (students × dates)
// =====================================================

function subjectSheetSuffix(subjectId) {
  return '(' + subjectId + ')';
}

function sanitizeSheetName(name) {
  return String(name).replace(/[\[\]\*\?\/\\:]/g, '').trim().slice(0, 95);
}

function findSubjectSheet(subject) {
  const suffix = subjectSheetSuffix(subject.SubjectID);
  return getSpreadsheet().getSheets().find(function (s) { return s.getName().indexOf(suffix) !== -1; }) || null;
}

// A subject is only "live" if its grid sheet exists on the spreadsheet.
// Deleting the tab is the effective way to remove a subject from the app.
function subjectHasSheet(subject) {
  return !!findSubjectSheet(subject);
}

// Finds the column index (0-based) of the running Total column, or -1.
// Matches any header starting with "total" so "Total (of 12)" still counts.
function findTotalColumnIndex(header) {
  for (let i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase().indexOf('total') === 0) return i;
  }
  return -1;
}

// Finds the column (0-based) for a given date, tolerant of the cell being
// stored as text or as an actual Date. Never looks past the Total column.
function findDateColumnIndex(headerRow, date, totalColIdx) {
  const end = (typeof totalColIdx === 'number' && totalColIdx !== -1) ? totalColIdx : headerRow.length;
  for (let i = 2; i < end; i++) {
    if (formatDate(headerRow[i]) === date) return i;
  }
  return -1;
}

function findStudentRowNumber(grid, studentId) {
  for (let r = 1; r < grid.length; r++) {
    if (String(grid[r][0]) === String(studentId)) return r + 1; // 1-based sheet row
  }
  return -1;
}

// Applies a light green (present=1) or light red (absent=0) background to
// a single attendance cell. Any other value clears the background.
function applyCellColor(sheet, rowNumber, colIndex0, status) {
  const cell = sheet.getRange(rowNumber, colIndex0 + 1);
  if (Number(status) === 1) {
    cell.setBackground(ATTENDANCE_COLORS.PRESENT);
  } else if (Number(status) === 0) {
    cell.setBackground(ATTENDANCE_COLORS.ABSENT);
  } else {
    cell.setBackground(null);
  }
}

// Ensures a "Total (of N)" column exists as the very LAST column. Returns
// its 0-based index. Safe to call repeatedly.
function ensureTotalColumn(sheet) {
  const header = sheet.getDataRange().getValues()[0] || [];
  let totalColIdx = findTotalColumnIndex(header);
  if (totalColIdx !== -1) return totalColIdx;

  const newColIdx = header.length; // append at the very end
  sheet.getRange(1, newColIdx + 1).setValue('Total (of 0)');
  return newColIdx;
}

// Recalculates the Total column's header ("Total (of N)") and every
// student's present-count. Call this after any structural change.
function recomputeTotalsColumn(sheet) {
  let totalColIdx = findTotalColumnIndex(sheet.getDataRange().getValues()[0] || []);
  if (totalColIdx === -1) totalColIdx = ensureTotalColumn(sheet);

  const grid = sheet.getDataRange().getValues();
  const dateColCount = totalColIdx - 2; // columns 2..totalColIdx-1 are dates
  sheet.getRange(1, totalColIdx + 1).setValue('Total (of ' + Math.max(dateColCount, 0) + ')');

  if (grid.length <= 1) return;

  const totals = [];
  for (let r = 1; r < grid.length; r++) {
    let presentCount = 0;
    for (let c = 2; c < totalColIdx; c++) {
      if (Number(grid[r][c]) === 1) presentCount++;
    }
    totals.push([presentCount]);
  }
  sheet.getRange(2, totalColIdx + 1, totals.length, 1).setValues(totals);
}

// Creates the subject's grid sheet (Student ID | Name | Total (of 0)),
// seeded with every current student of that class, if it doesn't exist yet.
function getOrCreateSubjectSheet(subject) {
  let sheet = findSubjectSheet(subject);
  if (sheet) return sheet;

  const name = sanitizeSheetName(subject.SubjectName + ' ' + subjectSheetSuffix(subject.SubjectID));
  sheet = getSpreadsheet().insertSheet(name);
  sheet.getRange(1, 1, 1, 3).setValues([['Student ID', 'Name', 'Total (of 0)']]);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  sheet.getRange('A:A').setNumberFormat('@'); // keep Student IDs as plain text

  const students = getSheetData(SHEETS.STUDENTS).filter(function (s) {
    return String(s.ClassID) === String(subject.ClassID);
  });
  if (students.length) {
    const rows = students.map(function (s) { return [s.StudentID, s.Name, 0]; });
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  return sheet;
}

// Adds a student as a new row to every subject sheet their class already
// has, then recalculates that sheet's Total column.
function syncStudentAcrossSubjectSheets(studentId, name, classId) {
  const subjects = getSheetData(SHEETS.SUBJECTS).filter(function (s) { return String(s.ClassID) === String(classId); });
  subjects.forEach(function (subject) {
    const sheet = getOrCreateSubjectSheet(subject);
    const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues().map(function (r) { return String(r[0]); });
    if (ids.indexOf(String(studentId)) === -1) {
      sheet.appendRow([studentId, name]);
      recomputeTotalsColumn(sheet);
    }
  });
}

// Inserts a brand-new date column in the correct chronological position
// (always before the Total column, and before any later date already
// present), then re-adds a Total column at the end if one didn't exist
// yet. Returns the new column's 0-based index.
function insertDateColumn(sheet, date) {
  const header = sheet.getDataRange().getValues()[0] || [];
  const totalColIdx = findTotalColumnIndex(header);
  const dateColEnd = totalColIdx === -1 ? header.length : totalColIdx;

  let insertBeforeIdx = dateColEnd; // default: right before Total (or at the end)
  for (let i = 2; i < dateColEnd; i++) {
    const colDate = formatDate(header[i]);
    if (colDate && colDate > date) {
      insertBeforeIdx = i;
      break;
    }
  }

  sheet.insertColumnBefore(insertBeforeIdx + 1); // 1-based position
  const cell = sheet.getRange(1, insertBeforeIdx + 1);
  cell.setNumberFormat('@'); // plain text, so it never silently reformats
  cell.setValue(date);

  if (totalColIdx === -1) ensureTotalColumn(sheet);

  return insertBeforeIdx;
}

// =====================================================
// READ HANDLERS
// =====================================================

function buildMePayload(actor) {
  const payload = {
    email: actor.email,
    role: actor.role,
    roleLabel: actor.roleLabel,
    name: actor.name || '',
    today: todayString(),
    enrollmentStatus: actor.enrollmentStatus || ''
  };
  if (actor.role === 'student') {
    payload.studentId = actor.studentId;
    payload.seatNumber = actor.seatNumber || '';
    payload.classId = actor.classId;
  } else if (actor.role === 'staff') {
    payload.teacherId = actor.teacherId;
    payload.isAdmin = actor.isAdmin;
  } else {
    payload.requestId = actor.requestId || '';
    payload.requestedClassId = actor.requestedClassId || '';
    payload.lastRequest = actor.lastRequest || null;
  }
  return payload;
}

// Everything the app needs to boot a dashboard, in ONE round-trip:
// identity, plus the classes, subjects, students, teachers, and enrollment data
// frontend caches this and filters client-side from then on (by class,
// by search, etc.) - no further network calls needed for any of that.
//
// IMPORTANT: subjects whose grid sheet has been deleted are omitted here,
// so a deleted tab disappears from every dropdown immediately.
function buildBootstrapPayload(actor) {
  ensureEnrollmentInfrastructure();
  const payload = { me: buildMePayload(actor) };

  if (actor.role === 'student') {
    payload.classes = listClasses(actor);
    payload.subjects = listSubjects(actor, {});
    return payload;
  }

  if (actor.role === 'applicant') {
    payload.classes = listClasses(actor);
    payload.enrollment = actor.requestId ? getLatestEnrollmentRequest(actor.email) : null;
    return payload;
  }

  payload.classes = listClasses(actor);
  payload.subjects = getSheetData(SHEETS.SUBJECTS).filter(subjectHasSheet);
  payload.students = getSheetData(SHEETS.STUDENTS);
  payload.teachers = getSheetData(SHEETS.TEACHERS).map(function (t) {
    return { TeacherID: t.TeacherID, Name: t.Name, Role: t.Role };
  });
  payload.enrollmentRequests = getEnrollmentRequestsForActor(actor);
  return payload;
}

function listClasses(actor) {
  const classes = getSheetData(SHEETS.CLASSES);
  if (actor.role === 'student') {
    return classes.filter(function (c) { return String(c.ClassID) === String(actor.classId); });
  }
  if (actor.role === 'applicant') return classes;
  return classes;
}

function listSubjects(actor, params) {
  let subjects = getSheetData(SHEETS.SUBJECTS);

  if (params.classId) {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(params.classId); });
  }
  if (actor.role === 'student') {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(actor.classId); });
  }

  // Only return subjects whose grid sheet still exists - deleting the tab
  // is how a subject is removed from the app.
  subjects = subjects.filter(subjectHasSheet);

  return subjects;
}

function listStudents(actor, params) {
  if (actor.role === 'student') {
    throw AppError('Students cannot list other students.', 'FORBIDDEN');
  }
  let students = getSheetData(SHEETS.STUDENTS);
  if (params.classId) {
    assertCanManageClass(actor, String(params.classId));
    students = students.filter(function (s) { return String(s.ClassID) === String(params.classId); });
  }
  return students;
}

function listTeachers(actor) {
  if (actor.role === 'student') {
    throw AppError('Students cannot list teachers.', 'FORBIDDEN');
  }
  return getSheetData(SHEETS.TEACHERS).map(function (t) {
    return { TeacherID: t.TeacherID, Name: t.Name, Role: t.Role };
  });
}

// Reads every marked cell out of one subject's grid sheet, as flat records.
// Skips the Total column entirely.
function readSubjectSheetRecords(subject) {
  const sheet = findSubjectSheet(subject);
  if (!sheet) return []; // no attendance ever marked for this subject yet

  const grid = sheet.getDataRange().getValues();
  if (grid.length < 2) return [];
  const header = grid[0];
  const totalColIdx = findTotalColumnIndex(header);
  const dateColEnd = totalColIdx === -1 ? header.length : totalColIdx;
  const records = [];

  for (let col = 2; col < dateColEnd; col++) {
    const date = formatDate(header[col]);
    if (!date) continue;
    for (let r = 1; r < grid.length; r++) {
      const studentId = grid[r][0];
      if (!studentId) continue;
      const cell = grid[r][col];
      if (cell === '' || cell === null || cell === undefined) continue; // not marked
      records.push({
        AttendanceID: subject.SubjectID + '_' + studentId + '_' + date,
        Date: date,
        SubjectID: subject.SubjectID,
        StudentID: String(studentId),
        Status: Number(cell)
      });
    }
  }
  return records;
}

function listAttendance(actor, params) {
  let subjects = getSheetData(SHEETS.SUBJECTS);

  if (params.subjectId) {
    subjects = subjects.filter(function (s) { return String(s.SubjectID) === String(params.subjectId); });
  }
  if (params.classId) {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(params.classId); });
  }
  if (actor.role === 'student') {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(actor.classId); });
  } else if (actor.role === 'staff' && !actor.isAdmin) {
    subjects = subjects.filter(function (s) { return canManageClass(actor, String(s.ClassID || '')); });
  }

  // Skip any subject whose sheet has been deleted.
  subjects = subjects.filter(subjectHasSheet);

  let rows = [];
  subjects.forEach(function (subject) {
    rows = rows.concat(readSubjectSheetRecords(subject));
  });

  if (actor.role === 'student') {
    rows = rows.filter(function (r) { return String(r.StudentID) === String(actor.studentId); });
  }
  if (params.date) {
    rows = rows.filter(function (r) { return r.Date === params.date; });
  }

  return rows;
}

// =====================================================
// BLUEPRINT VIEW - read + row/column mutations on a subject's grid sheet
// =====================================================

// Returns the ENTIRE subject grid as a structured object the frontend can
// render directly: header row, per-student row, per-date columns, and the
// running total column. This is a "blueprint" of the actual Google Sheet.
function getSubjectSheet(actor, params) {
  const subjectId = String(params.subjectId || '').trim();
  if (!subjectId) throw AppError('subjectId is required.', 'BAD_REQUEST');

  const subject = assertSubjectExists(subjectId);
  if (actor.role === 'student' && String(subject.ClassID) !== String(actor.classId)) {
    throw AppError('You can only view your own class.', 'FORBIDDEN');
  }
  if (actor.role === 'staff') assertCanManageClass(actor, subject.ClassID);

  const sheet = findSubjectSheet(subject);
  if (!sheet) {
    throw AppError(
      'This subject no longer exists. It may have been deleted. Refresh the page and pick another subject.',
      'NOT_FOUND'
    );
  }

  const grid = sheet.getDataRange().getValues();
  if (grid.length === 0) {
    return {
      subjectId: subject.SubjectID,
      subjectName: subject.SubjectName,
      classId: subject.ClassID,
      headers: [],
      dates: [],
      totalHeader: 'Total (of 0)',
      rows: [],
      today: todayString()
    };
  }

  const header = grid[0];
  const totalColIdx = findTotalColumnIndex(header);
  const dateColEnd = totalColIdx === -1 ? header.length : totalColIdx;

  // Dates (sorted left→right as stored).
  const dates = [];
  for (let c = 2; c < dateColEnd; c++) {
    const d = formatDate(header[c]);
    if (d) dates.push({ colIndex: c, date: d });
  }

  // Rows - skip empty ones. Students only see their own row.
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const studentId = String(grid[r][0] || '').trim();
    const name = String(grid[r][1] || '').trim();
    if (!studentId && !name) continue;

    if (actor.role === 'student') {
      const matchesId = String(studentId) === String(actor.studentId);
      const matchesName = name && actor.name && name.toLowerCase() === String(actor.name).toLowerCase();
      if (!matchesId && !matchesName) continue;
    }

    const marks = {};
    for (let c = 2; c < dateColEnd; c++) {
      const d = formatDate(header[c]);
      if (!d) continue;
      const v = grid[r][c];
      marks[d] = (v === '' || v === null || v === undefined) ? null : Number(v);
    }

    const total = totalColIdx !== -1 ? Number(grid[r][totalColIdx]) || 0 : 0;

    rows.push({
      sheetRowNumber: r + 1, // 1-based
      studentId: studentId,
      name: name,
      marks: marks,
      total: total
    });
  }

  return {
    subjectId: subject.SubjectID,
    subjectName: subject.SubjectName,
    classId: subject.ClassID,
    headers: header.map(String),
    dates: dates,
    totalColIdx: totalColIdx,
    totalHeader: totalColIdx !== -1 ? String(header[totalColIdx]) : 'Total (of 0)',
    rows: rows,
    today: todayString()
  };
}

// Deletes a single student's row from THIS subject sheet only. The
// Students master sheet is never touched.
function deleteSubjectSheetRow(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can modify the sheet.', 'FORBIDDEN');

  const subjectId = String(body.subjectId || '').trim();
  const rowNumber = Number(body.rowNumber);
  if (!subjectId) throw AppError('subjectId is required.', 'VALIDATION_ERROR');
  if (!rowNumber || rowNumber < 2) throw AppError('Invalid row.', 'BAD_REQUEST');

  const subject = assertSubjectExists(subjectId);
  assertCanManageClass(actor, subject.ClassID);
  const sheet = findSubjectSheet(subject);
  if (!sheet) throw AppError('This subject no longer exists.', 'NOT_FOUND');

  const lastRow = sheet.getLastRow();
  if (rowNumber > lastRow) throw AppError('Row no longer exists.', 'NOT_FOUND');
  if (rowNumber === 1) throw AppError('Cannot delete the header row.', 'FORBIDDEN');

  sheet.deleteRow(rowNumber);
  recomputeTotalsColumn(sheet);
  return { deleted: true, subjectId: subjectId, rowNumber: rowNumber };
}

// Deletes a whole date column (a session) from THIS subject sheet only.
// Refuses if it's today - today is freely editable, but structural
// deletion is not allowed for the live session.
function deleteSubjectSheetColumn(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can modify the sheet.', 'FORBIDDEN');

  const subjectId = String(body.subjectId || '').trim();
  const date = String(body.date || '').trim();
  if (!subjectId) throw AppError('subjectId is required.', 'VALIDATION_ERROR');
  if (!date) throw AppError('date is required.', 'VALIDATION_ERROR');

  const today = todayString();
  if (date === today) {
    throw AppError('Today\'s column cannot be deleted. Clear individual marks instead.', 'FORBIDDEN');
  }

  const subject = assertSubjectExists(subjectId);
  assertCanManageClass(actor, subject.ClassID);
  const sheet = findSubjectSheet(subject);
  if (!sheet) throw AppError('This subject no longer exists.', 'NOT_FOUND');

  const header = sheet.getDataRange().getValues()[0] || [];
  const totalColIdx = findTotalColumnIndex(header);
  const colIdx = findDateColumnIndex(header, date, totalColIdx);
  if (colIdx === -1) throw AppError('That date column no longer exists.', 'NOT_FOUND');

  sheet.deleteColumn(colIdx + 1); // 1-based
  recomputeTotalsColumn(sheet);
  return { deleted: true, subjectId: subjectId, date: date };
}

// Renames a student row (both the ID and Name cells) in THIS subject
// sheet only. The Students master sheet is never touched.
function renameSubjectSheetRow(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can modify the sheet.', 'FORBIDDEN');

  const subjectId = String(body.subjectId || '').trim();
  const rowNumber = Number(body.rowNumber);
  const newId = String(body.newId || '').trim();
  const newName = String(body.newName || '').trim();

  if (!subjectId) throw AppError('subjectId is required.', 'VALIDATION_ERROR');
  if (!rowNumber || rowNumber < 2) throw AppError('Invalid row.', 'BAD_REQUEST');
  if (!newId && !newName) throw AppError('Nothing to rename.', 'VALIDATION_ERROR');

  const subject = assertSubjectExists(subjectId);
  assertCanManageClass(actor, subject.ClassID);
  const sheet = findSubjectSheet(subject);
  if (!sheet) throw AppError('This subject no longer exists.', 'NOT_FOUND');
  if (rowNumber > sheet.getLastRow()) throw AppError('Row no longer exists.', 'NOT_FOUND');

  if (newId) {
    sheet.getRange(rowNumber, 1).setNumberFormat('@').setValue(newId);
  }
  if (newName) {
    sheet.getRange(rowNumber, 2).setValue(newName);
  }
  return { renamed: true, subjectId: subjectId, rowNumber: rowNumber };
}

// Removes rows from the Subjects master sheet whose grid sheet has been
// deleted. Frees the subject ID so it can be reused by addSubject later.
// Safe to run repeatedly.
function purgeMissingSubjects(actor) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can do this.', 'FORBIDDEN');

  const sheet = getSheet(SHEETS.SUBJECTS);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { removed: 0 };

  const headers = data[0].map(normalizeHeader);
  const idIdx = headers.indexOf('SubjectID');
  if (idIdx === -1) throw AppError('Subjects sheet has no SubjectID header.', 'SERVER_ERROR');

  // Walk from bottom up so deletions don't shift later indices.
  let removed = 0;
  for (let r = data.length - 1; r >= 1; r--) {
    const subjectId = String(data[r][idIdx] || '').trim();
    if (!subjectId) continue;
    const subject = { SubjectID: subjectId };
    if (!findSubjectSheet(subject)) {
      sheet.deleteRow(r + 1);
      removed++;
    }
  }
  return { removed: removed };
}

// =====================================================
// STUDENT SELF-ENROLLMENT
// =====================================================

function getEnrollmentPayload(actor) {
  if (actor.role !== 'applicant') {
    return { status: actor.role === 'student' ? 'Approved' : 'Staff', request: null, classes: listClasses(actor) };
  }
  return {
    status: actor.enrollmentStatus || 'Not started',
    request: getLatestEnrollmentRequest(actor.email),
    classes: listClasses(actor)
  };
}

function assertSeatNumberAvailable(seatNumber, ignoreRequestId) {
  const target = String(seatNumber || '').trim().toLowerCase();
  const students = getSheetData(SHEETS.STUDENTS);
  const takenStudent = students.some(function (s) {
    const studentId = String(s.StudentID || '').trim().toLowerCase();
    const legacySeatNumber = String(s.SeatNumber || '').trim().toLowerCase();
    return target && (studentId === target || legacySeatNumber === target);
  });
  if (takenStudent) throw AppError('That seat number is already registered.', 'VALIDATION_ERROR');

  const requests = getSheetData(SHEETS.ENROLLMENTS);
  const takenRequest = requests.some(function (r) {
    return String(r.Status || '').toLowerCase() === 'pending' &&
      String(r.RequestID || '') !== String(ignoreRequestId || '') &&
      String(r.SeatNumber || '').trim().toLowerCase() === target;
  });
  if (takenRequest) throw AppError('That seat number is already being requested.', 'VALIDATION_ERROR');
}

function submitEnrollment(actor, body) {
  if (actor.role !== 'applicant') throw AppError('This account does not need student enrollment.', 'FORBIDDEN');
  ensureEnrollmentInfrastructure();

  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const seatNumber = String(body.seatNumber || '').trim();
  const classId = String(body.classId || '').trim();
  const email = String(actor.email || '').trim().toLowerCase();

  if (name.length < 2) throw AppError('Enter your full name.', 'VALIDATION_ERROR');
  if (name.length > 80) throw AppError('Name is too long.', 'VALIDATION_ERROR');
  if (!seatNumber || seatNumber.length > 40) throw AppError('Enter a valid seat number.', 'VALIDATION_ERROR');
  if (!classId) throw AppError('Choose the class you want to join.', 'VALIDATION_ERROR');

  const classes = getSheetData(SHEETS.CLASSES);
  if (!classes.some(function (c) { return String(c.ClassID) === classId; })) {
    throw AppError('That class is not available.', 'BAD_REQUEST');
  }

  const students = getSheetData(SHEETS.STUDENTS);
  if (students.some(function (s) { return String(s.Email || '').trim().toLowerCase() === email; })) {
    throw AppError('This email is already enrolled as a student.', 'VALIDATION_ERROR');
  }
  const teachers = getSheetData(SHEETS.TEACHERS);
  if (teachers.some(function (t) { return String(t.Email || '').trim().toLowerCase() === email; })) {
    throw AppError('This email is already registered as staff.', 'VALIDATION_ERROR');
  }

  const latest = getLatestEnrollmentRequest(email);
  if (latest && String(latest.Status || '').toLowerCase() === 'pending') {
    throw AppError('You already have a pending enrollment request.', 'ALREADY_PENDING');
  }

  assertSeatNumberAvailable(seatNumber, '');

  const requestId = generateSequentialId(SHEETS.ENROLLMENTS, 'RequestID', 'REQ', 4);
  appendRowByHeaders(SHEETS.ENROLLMENTS, {
    RequestID: requestId,
    Name: name,
    Email: email,
    SeatNumber: seatNumber,
    ClassID: classId,
    Status: 'Pending',
    RequestedAt: new Date(),
    ReviewedAt: '',
    ReviewedBy: '',
    DecisionNote: ''
  });

  return { requestId: requestId, name: name, seatNumber: seatNumber, classId: classId, status: 'Pending' };
}

function reviewEnrollment(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers and CRs can review enrollment requests.', 'FORBIDDEN');
  ensureEnrollmentInfrastructure();

  const requestId = String(body.requestId || '').trim();
  const decision = String(body.decision || '').trim().toLowerCase();
  const note = String(body.note || '').trim().slice(0, 240);
  if (!requestId) throw AppError('Request ID is required.', 'VALIDATION_ERROR');
  if (['approve', 'reject'].indexOf(decision) === -1) throw AppError('Invalid enrollment decision.', 'VALIDATION_ERROR');

  const sheet = getSheet(SHEETS.ENROLLMENTS);
  const grid = sheet.getDataRange().getValues();
  const headers = grid[0].map(normalizeHeader);
  const requestIdx = headers.indexOf('RequestID');
  const statusIdx = headers.indexOf('Status');
  const classIdx = headers.indexOf('ClassID');
  if (requestIdx === -1 || statusIdx === -1 || classIdx === -1) throw AppError('Enrollment sheet is missing required columns.', 'SERVER_ERROR');

  let rowNumber = -1;
  let request = null;
  for (let r = 1; r < grid.length; r++) {
    if (String(grid[r][requestIdx]).trim() === requestId) {
      rowNumber = r + 1;
      request = {};
      headers.forEach(function (h, i) { request[h] = grid[r][i]; });
      break;
    }
  }
  if (rowNumber === -1) throw AppError('Enrollment request not found.', 'NOT_FOUND');
  if (String(request.Status || '').toLowerCase() !== 'pending') {
    throw AppError('This request has already been reviewed.', 'ALREADY_REVIEWED');
  }

  const classId = String(request.ClassID || '').trim();
  assertCanManageClass(actor, classId);

  if (decision === 'reject') {
    updateSheetRowByHeaders(sheet, rowNumber, {
      Status: 'Rejected',
      ReviewedAt: new Date(),
      ReviewedBy: actor.email,
      DecisionNote: note
    });
    return { requestId: requestId, status: 'Rejected' };
  }

  const email = String(request.Email || '').trim().toLowerCase();
  const name = String(request.Name || '').trim();
  const seatNumber = String(request.SeatNumber || '').trim();

  const existingStudent = getSheetData(SHEETS.STUDENTS).some(function (s) {
    return String(s.Email || '').trim().toLowerCase() === email;
  });
  if (existingStudent) throw AppError('This email is already enrolled.', 'VALIDATION_ERROR');
  assertSeatNumberAvailable(seatNumber, requestId);

  const studentId = seatNumber;
  appendRowByHeaders(SHEETS.STUDENTS, {
    StudentID: studentId,
    Name: name,
    Email: email,
    ClassID: classId,
    Status: 'Active'
  });
  syncStudentAcrossSubjectSheets(studentId, name, classId);

  updateSheetRowByHeaders(sheet, rowNumber, {
    Status: 'Approved',
    ReviewedAt: new Date(),
    ReviewedBy: actor.email,
    DecisionNote: note
  });

  return { requestId: requestId, status: 'Approved', studentId: studentId, name: name, seatNumber: seatNumber, classId: classId };
}

function updateSheetRowByHeaders(sheet, rowNumber, valuesObj) {
  const headers = sheet.getDataRange().getValues()[0] || [];
  headers.forEach(function (h, i) {
    const key = normalizeHeader(h);
    if (valuesObj.hasOwnProperty(key)) sheet.getRange(rowNumber, i + 1).setValue(valuesObj[key]);
  });
}

// =====================================================
// WRITE HANDLERS - register (Classes / Subjects / Students)
// =====================================================

function addClass(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers and CRs can add classes.', 'FORBIDDEN');

  const className = String(body.className || '').trim();
  const academicYear = String(body.academicYear || '').trim();
  if (!className) throw AppError('Class name is required.', 'VALIDATION_ERROR');

  const classId = generateSequentialId(SHEETS.CLASSES, 'ClassID', 'CLS', 3);
  appendRowByHeaders(SHEETS.CLASSES, { ClassID: classId, ClassName: className, AcademicYear: academicYear });

  // A non-admin who creates a class is automatically assigned to it so the
  // class is immediately usable for attendance and enrollment approvals.
  if (!actor.isAdmin && actor.teacherId) {
    addClassAssignmentToTeacher(actor.teacherId, classId);
  }

  return { classId: classId, className: className, academicYear: academicYear };
}

function addClassAssignmentToTeacher(teacherId, classId) {
  const sheet = getSheet(SHEETS.TEACHERS);
  ensureColumns(sheet, ['AssignedClassIDs']);
  const grid = sheet.getDataRange().getValues();
  const headers = grid[0].map(normalizeHeader);
  const idIdx = headers.indexOf('TeacherID');
  const classesIdx = headers.indexOf('AssignedClassIDs');
  if (idIdx === -1 || classesIdx === -1) return;

  for (let r = 1; r < grid.length; r++) {
    if (String(grid[r][idIdx]).trim() !== String(teacherId).trim()) continue;
    const ids = splitIds(grid[r][classesIdx]);
    if (ids.indexOf(String(classId)) === -1) ids.push(String(classId));
    sheet.getRange(r + 1, classesIdx + 1).setValue(ids.join(','));
    return;
  }
}

function addSubject(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can add subjects.', 'FORBIDDEN');

  const subjectName = String(body.subjectName || '').trim();
  const classId = String(body.classId || '').trim();
  const teacherId = String(body.teacherId || actor.teacherId || '').trim();

  assertCanManageClass(actor, classId);

  if (!subjectName) throw AppError('Subject name is required.', 'VALIDATION_ERROR');
  if (!classId) throw AppError('Class is required.', 'VALIDATION_ERROR');

  const classes = getSheetData(SHEETS.CLASSES);
  if (!classes.some(function (c) { return String(c.ClassID) === classId; })) {
    throw AppError('Unknown class "' + classId + '".', 'BAD_REQUEST');
  }
  if (teacherId) {
    const teachers = getSheetData(SHEETS.TEACHERS);
    if (!teachers.some(function (t) { return String(t.TeacherID) === teacherId; })) {
      throw AppError('Unknown teacher "' + teacherId + '".', 'BAD_REQUEST');
    }
  }

  const subjectId = generateSequentialId(SHEETS.SUBJECTS, 'SubjectID', 'SUB', 3);
  appendRowByHeaders(SHEETS.SUBJECTS, {
    SubjectID: subjectId,
    SubjectName: subjectName,
    TeacherID: teacherId,
    ClassID: classId
  });

  // Only place in the codebase allowed to CREATE a grid sheet.
  getOrCreateSubjectSheet({ SubjectID: subjectId, SubjectName: subjectName, ClassID: classId });

  return { subjectId: subjectId, subjectName: subjectName, classId: classId, teacherId: teacherId };
}

function addStudent(actor, body) {
  if (actor.role !== 'staff') throw AppError('Only teachers/CRs can add students.', 'FORBIDDEN');

  const seatNumber = String(body.seatNumber || '').trim();
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const classId = String(body.classId || '').trim();

  if (!seatNumber) throw AppError('Seat number is required.', 'VALIDATION_ERROR');
  if (!name) throw AppError('Student name is required.', 'VALIDATION_ERROR');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw AppError('A valid email is required.', 'VALIDATION_ERROR');
  }
  if (!classId) throw AppError('Class is required.', 'VALIDATION_ERROR');

  const classes = getSheetData(SHEETS.CLASSES);
  if (!classes.some(function (c) { return String(c.ClassID) === classId; })) {
    throw AppError('Unknown class "' + classId + '".', 'BAD_REQUEST');
  }

  assertCanManageClass(actor, classId);
  assertEmailNotTaken(email);
  assertSeatNumberAvailable(seatNumber, '');

  const studentId = seatNumber;
  appendRowByHeaders(SHEETS.STUDENTS, {
    StudentID: studentId,
    Name: name,
    Email: email,
    ClassID: classId,
    Status: 'Active'
  });

  syncStudentAcrossSubjectSheets(studentId, name, classId);

  return { studentId: studentId, name: name, email: email, classId: classId };
}

// =====================================================
// WRITE HANDLERS - Attendance (today freely editable; any other
// date is a one-time backfill that locks the instant it's saved)
// =====================================================

function saveAttendance(actor, body) {
  if (actor.role !== 'staff') {
    throw AppError('Only teachers/CRs can mark attendance.', 'FORBIDDEN');
  }

  const date = String(body.date || '').trim();
  const subjectId = String(body.subjectId || '').trim();
  if (!date) throw AppError('Date is required.', 'VALIDATION_ERROR');
  if (!subjectId) throw AppError('Subject is required.', 'VALIDATION_ERROR');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw AppError('Date must be in YYYY-MM-DD format.', 'VALIDATION_ERROR');

  const today = todayString();
  if (date > today) {
    throw AppError('You cannot mark attendance for a future date.', 'VALIDATION_ERROR');
  }

  const subject = assertSubjectExists(subjectId);
  assertCanManageClass(actor, subject.ClassID);

  // A subject whose sheet tab has been deleted is gone - do NOT silently
  // recreate it here. Only addSubject() is allowed to create a grid sheet.
  const sheet = findSubjectSheet(subject);
  if (!sheet) {
    throw AppError(
      'This subject no longer exists. It may have been deleted. Refresh the page and pick another subject.',
      'NOT_FOUND'
    );
  }

  const records = Array.isArray(body.records) && body.records.length
    ? body.records
    : [{ name: body.name, status: body.status }];
  if (!records.length) throw AppError('No attendance records provided.', 'VALIDATION_ERROR');

    // Each record must carry a studentId (preferred) or a name. We match the
  // subject sheet by studentId first, falling back to name only if the
  // studentId isn't present on the sheet. We NEVER auto-create rows here -
  // the Students master sheet is the source of truth, and students are
  // added via addStudent() which syncs them across every subject sheet.
  const allStudents = getSheetData(SHEETS.STUDENTS);
  const nameById = {};
  allStudents.forEach(function (s) {
    if (s.StudentID) nameById[String(s.StudentID)] = String(s.Name || '').trim();
  });

  records.forEach(function (rec) {
    const status = Number(rec.status);
    let studentId = String(rec.studentId || '').trim();
    let name = String(rec.name || '').trim();

    // If only a name was provided, try to resolve the studentId.
    if (!studentId && name) {
      const found = allStudents.find(function (s) {
        return String(s.Name || '').trim().toLowerCase() === name.toLowerCase();
      });
      if (found) studentId = String(found.StudentID);
    }
    // If only a studentId was provided, resolve the display name.
    if (!name && studentId) {
      name = nameById[studentId] || '';
    }

    if (!studentId && !name) {
      throw AppError('Each record needs a studentId or a name.', 'VALIDATION_ERROR');
    }
    if (status !== 0 && status !== 1) {
      throw AppError('status must be 0 or 1 for "' + (name || studentId) + '".', 'VALIDATION_ERROR');
    }

    rec.studentId = studentId;
    rec.name = name;
  });

  let grid = sheet.getDataRange().getValues();
  let header = grid[0];
  let totalColIdx = findTotalColumnIndex(header);
  let dateCol = findDateColumnIndex(header, date, totalColIdx);

  if (dateCol !== -1) {
    if (date !== today) {
      throw AppError('This date has already been submitted and is locked.', 'FORBIDDEN');
    }
  } else {
    dateCol = insertDateColumn(sheet, date);
    grid = sheet.getDataRange().getValues();
    header = grid[0];
  }

  const results = [];
  records.forEach(function (rec) {
    const studentId = String(rec.studentId || '').trim();
    const name = String(rec.name || '').trim();
    const status = Number(rec.status);

    // Prefer matching by Student ID (column A). Fall back to Name (column B).
    let rowNumber = -1;
    if (studentId) {
      for (let r = 1; r < grid.length; r++) {
        if (String(grid[r][0]).trim() === studentId) { rowNumber = r + 1; break; }
      }
    }
    if (rowNumber === -1 && name) {
      for (let r = 1; r < grid.length; r++) {
        if (String(grid[r][1]).trim().toLowerCase() === name.toLowerCase()) {
          rowNumber = r + 1;
          break;
        }
      }
    }

    if (rowNumber === -1) {
      // Attendance writes NEVER create rows. The student must already exist
      // on this sheet - either they're enrolled in the class, or they were
      // manually added by a staff member.
      results.push({
        studentId: studentId,
        name: name,
        action: 'skipped',
        reason: 'not_enrolled'
      });
      return;
    }

    sheet.getRange(rowNumber, dateCol + 1).setValue(status);
    applyCellColor(sheet, rowNumber, dateCol, status);
    results.push({ studentId: studentId, name: name, action: 'saved' });
  });

  recomputeTotalsColumn(sheet);

  return { date: date, subjectId: subjectId, results: results };
}

// "Deleting" a mark just clears that student's cell - only ever allowed
// for today's column, same lock rule as saving.
function deleteAttendance(actor, body) {
  if (actor.role !== 'staff') {
    throw AppError('Only teachers/CRs can remove attendance.', 'FORBIDDEN');
  }

  const attendanceId = String(body.attendanceId || '').trim();
  if (!attendanceId) throw AppError('attendanceId is required.', 'VALIDATION_ERROR');

  const parts = attendanceId.split('_');
  if (parts.length < 3) throw AppError('Invalid record reference.', 'BAD_REQUEST');
  const date = parts[parts.length - 1];
  const studentId = parts[parts.length - 2];
  const subjectId = parts.slice(0, parts.length - 2).join('_');

  const today = todayString();
  if (date !== today) {
    throw AppError('This record is from a previous day and can no longer be changed.', 'FORBIDDEN');
  }

  const subject = assertSubjectExists(subjectId);
  assertCanManageClass(actor, subject.ClassID);
  const sheet = findSubjectSheet(subject);
  if (!sheet) throw AppError('This subject no longer exists.', 'NOT_FOUND');

  const grid = sheet.getDataRange().getValues();
  const header = grid[0];
  const totalColIdx = findTotalColumnIndex(header);

  const dateCol = findDateColumnIndex(header, date, totalColIdx);
  if (dateCol === -1) throw AppError('Record not found.', 'NOT_FOUND');

  const rowNumber = findStudentRowNumber(grid, studentId);
  if (rowNumber === -1) throw AppError('Record not found.', 'NOT_FOUND');

  sheet.getRange(rowNumber, dateCol + 1).clearContent();
  applyCellColor(sheet, rowNumber, dateCol, '');
  recomputeTotalsColumn(sheet);
  return { deleted: attendanceId };
}

// =====================================================
// ONE-TIME MIGRATION (optional - run manually from the editor)
// =====================================================

function migrateOldAttendance() {
  let oldRows;
  try {
    oldRows = getSheetData(SHEETS.ATTENDANCE);
  } catch (e) {
    Logger.log('No legacy Attendance sheet found - nothing to migrate.');
    return;
  }

  const subjects = getSheetData(SHEETS.SUBJECTS);
  const bySubject = {};
  oldRows.forEach(function (r) {
    const subjectId = String(r.SubjectID || '').trim();
    if (!subjectId) return;
    bySubject[subjectId] = bySubject[subjectId] || [];
    bySubject[subjectId].push(r);
  });

  Object.keys(bySubject).forEach(function (subjectId) {
    const subject = subjects.find(function (s) { return String(s.SubjectID) === subjectId; });
    if (!subject) return;

    const sheet = getOrCreateSubjectSheet(subject);
    bySubject[subjectId].forEach(function (r) {
      const date = formatDate(r.Date);
      const studentId = String(r.StudentID).trim();
      const status = Number(r.Status);
      if (!date || !studentId || (status !== 0 && status !== 1)) return;

      let grid = sheet.getDataRange().getValues();
      let header = grid[0];
      const totalColIdx = findTotalColumnIndex(header);
      let dateCol = findDateColumnIndex(header, date, totalColIdx);
      if (dateCol === -1) {
        dateCol = insertDateColumn(sheet, date);
        grid = sheet.getDataRange().getValues();
      }
      const rowNumber = findStudentRowNumber(grid, studentId);
      if (rowNumber !== -1) {
        sheet.getRange(rowNumber, dateCol + 1).setValue(status);
        applyCellColor(sheet, rowNumber, dateCol, status);
      }
    });

    recomputeTotalsColumn(sheet);
  });

  Logger.log('Migration complete.');
}

// =====================================================
// RESPONSE HELPERS
// =====================================================

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(error) {
  return jsonResponse({
    success: false,
    error: (error && error.message) || 'Something went wrong.',
    code: (error && error.code) || 'SERVER_ERROR'
  });
}