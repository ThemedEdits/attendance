/**
 * ATTENDANCE MANAGEMENT SYSTEM — BACKEND (Google Apps Script)
 * ============================================================
 * SECURITY MODEL
 * --------------
 * This web app's /exec URL is public — anyone can call it directly with
 * curl/Postman, bypassing the frontend entirely. So the frontend is NOT
 * where access control lives. Every single request re-verifies:
 *   1. WHO is calling  -> Firebase ID token, verified against Google
 *      (via the Identity Toolkit REST API — no secret needed beyond
 *      your Firebase Web API key, which is a public client key).
 *   2. WHAT they're allowed to do -> looked up fresh from the
 *      Students / Teachers sheets on every call (never trusted from
 *      the client), then every read/write is filtered or rejected
 *      based on that role + scope.
 * The frontend dashboards are just UI convenience. Nothing the client
 * sends (a role name, a class id, a "isAdmin" flag) is ever trusted.
 *
 * SHEETS EXPECTED (header row, case-sensitive; column order doesn't matter)
 * ---------------------------------------------------------------------------
 *  Students   : StudentID | Name | Email | ClassID
 *  Teachers   : TeacherID | Name | Email | Role | AssignedClassIDs | AssignedSubjectIDs
 *               - Role is free text ("Teacher" or "CR") — display only, both
 *                 have identical permissions, scoped by the two columns below.
 *               - AssignedClassIDs / AssignedSubjectIDs: comma-separated IDs,
 *                 e.g. "CLS001,CLS002". Fill in whichever makes sense — a CR
 *                 might have one ClassID; a subject teacher might list
 *                 several SubjectIDs across classes.
 *  Classes    : ClassID | ClassName
 *  Subjects   : SubjectID | SubjectName | ClassID
 *  Attendance : AttendanceID | Date | SubjectID | StudentID | Status  (0=Absent, 1=Present)
 *  Settings   : Key | Value
 *               - optional row: AdminEmails | "you@school.com,other@school.com"
 *                 grants full, unscoped access to those emails.
 *
 * SETUP
 * -----
 *  1. Open your Sheet -> Extensions -> Apps Script -> replace contents with this file.
 *  2. Project Settings (gear icon) -> Script Properties -> Add property:
 *       FIREBASE_API_KEY = <your Firebase Web API key, from firebaseConfig.apiKey>
 *  3. Deploy -> New deployment -> type: Web app
 *       Execute as: Me
 *       Who has access: Anyone
 *  4. Copy the /exec URL into the frontend's js/api.js (APPS_SCRIPT_URL).
 *  5. Add Email columns to your Students/Teachers sheets matching each
 *     person's Firebase login email exactly (case doesn't matter).
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
  ATTENDANCE: 'Attendance',
  SETTINGS: 'Settings'
};

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
      case 'classes':
        data = listClasses(actor);
        break;
      case 'subjects':
        data = listSubjects(actor, params);
        break;
      case 'students':
        data = listStudents(actor, params);
        break;
      case 'attendance':
        data = listAttendance(actor, params);
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

    lock.waitLock(10000);

    let result;
    switch (action) {
      case 'saveAttendance':
        result = saveAttendance(actor, body);
        break;
      case 'deleteAttendance':
        result = deleteAttendance(actor, body);
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
// AUTH — verify the Firebase ID token, then resolve role
// =====================================================

function authenticate(idToken) {
  if (!idToken) throw AppError('You must be signed in.', 'AUTH_REQUIRED');

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

  const email = user.email.trim().toLowerCase();
  const actor = resolveActor(email);

  if (!actor) {
    throw AppError(
      'This email is not registered. Ask an admin to add it to the Students or Teachers sheet.',
      'NOT_REGISTERED'
    );
  }

  actor.email = email;
  actor.uid = user.localId;
  return actor;
}

function resolveActor(email) {
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
      classIds: splitIds(teacherRow.AssignedClassIDs),
      subjectIds: splitIds(teacherRow.AssignedSubjectIDs)
    };
  }

  const students = getSheetData(SHEETS.STUDENTS);
  const studentRow = students.find(function (s) {
    return String(s.Email || '').trim().toLowerCase() === email;
  });

  if (studentRow) {
    return {
      role: 'student',
      roleLabel: 'Student',
      isAdmin: false,
      studentId: studentRow.StudentID,
      name: studentRow.Name,
      classId: studentRow.ClassID
    };
  }

  if (isAdmin) {
    return { role: 'staff', roleLabel: 'Admin', isAdmin: true, classIds: [], subjectIds: [] };
  }

  return null;
}

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

// =====================================================
// SHEET HELPERS
// =====================================================

function getSheet(sheetName) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw AppError('Sheet "' + sheetName + '" not found.', 'SERVER_ERROR');
  return sheet;
}

function getSheetData(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  const headers = data[0];
  return data.slice(1)
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

// Like getSheetData, but keeps each row's real (1-based) sheet row number
// so write operations can target a specific row.
function getSheetRows(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return { sheet: sheet, headers: [], rows: [] };
  const headers = data[0];
  const rows = data.slice(1)
    .map(function (row, i) {
      const obj = {};
      headers.forEach(function (h, colIndex) { obj[h] = row[colIndex]; });
      return { rowNumber: i + 2, values: obj };
    })
    .filter(function (r) { return Object.values(r.values).join('') !== ''; });
  return { sheet: sheet, headers: headers, rows: rows };
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
    if (r.Key) map[String(r.Key).trim()] = r.Value;
  });
  return map;
}

function formatDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

// =====================================================
// SCOPE HELPERS (who is this staff member allowed to touch)
// =====================================================

function getSubjectIdsInScope(actor) {
  if (actor.isAdmin) return null; // unrestricted
  const subjects = getSheetData(SHEETS.SUBJECTS);
  const bySubject = actor.subjectIds.slice();
  const byClass = subjects
    .filter(function (s) { return actor.classIds.indexOf(String(s.ClassID)) !== -1; })
    .map(function (s) { return String(s.SubjectID); });
  return bySubject.concat(byClass);
}

function getStudentIdsInScope(actor) {
  if (actor.isAdmin) return null;
  if (!actor.classIds.length) return [];
  const students = getSheetData(SHEETS.STUDENTS);
  return students
    .filter(function (s) { return actor.classIds.indexOf(String(s.ClassID)) !== -1; })
    .map(function (s) { return String(s.StudentID); });
}

function assertClassInScope(actor, classId) {
  if (actor.isAdmin || !classId) return;
  if (actor.classIds.indexOf(String(classId)) === -1) {
    throw AppError('You are not assigned to this class.', 'FORBIDDEN');
  }
}

function assertSubjectInScope(actor, subjectId) {
  const subjects = getSheetData(SHEETS.SUBJECTS);
  const subject = subjects.find(function (s) { return String(s.SubjectID) === String(subjectId); });
  if (!subject) throw AppError('Unknown subject "' + subjectId + '".', 'BAD_REQUEST');
  if (actor.isAdmin) return subject;

  const okBySubject = actor.subjectIds.indexOf(String(subjectId)) !== -1;
  const okByClass = actor.classIds.indexOf(String(subject.ClassID)) !== -1;
  if (!okBySubject && !okByClass) {
    throw AppError('You are not assigned to this subject.', 'FORBIDDEN');
  }
  return subject;
}

function assertStudentInScope(actor, studentId, expectedClassId) {
  const students = getSheetData(SHEETS.STUDENTS);
  const student = students.find(function (s) { return String(s.StudentID) === String(studentId); });
  if (!student) throw AppError('Unknown student "' + studentId + '".', 'BAD_REQUEST');

  if (expectedClassId && String(student.ClassID) !== String(expectedClassId)) {
    throw AppError('Student "' + studentId + '" is not in that class.', 'BAD_REQUEST');
  }
  if (!actor.isAdmin) {
    const okByClass = actor.classIds.indexOf(String(student.ClassID)) !== -1;
    if (!okByClass) {
      throw AppError('You are not assigned to this student\'s class.', 'FORBIDDEN');
    }
  }
  return student;
}

// =====================================================
// READ HANDLERS
// =====================================================

function buildMePayload(actor) {
  const payload = {
    email: actor.email,
    role: actor.role,
    roleLabel: actor.roleLabel,
    name: actor.name || ''
  };
  if (actor.role === 'student') {
    payload.studentId = actor.studentId;
    payload.classId = actor.classId;
  } else {
    payload.teacherId = actor.teacherId;
    payload.isAdmin = actor.isAdmin;
    payload.classIds = actor.classIds;
    payload.subjectIds = actor.subjectIds;
  }
  return payload;
}

function listClasses(actor) {
  const classes = getSheetData(SHEETS.CLASSES);

  if (actor.role === 'student') {
    return classes.filter(function (c) { return String(c.ClassID) === String(actor.classId); });
  }

  if (actor.role === 'staff' && !actor.isAdmin) {
    const subjects = getSheetData(SHEETS.SUBJECTS);
    const classIdsFromSubjects = subjects
      .filter(function (s) { return actor.subjectIds.indexOf(String(s.SubjectID)) !== -1; })
      .map(function (s) { return String(s.ClassID); });
    const allowed = actor.classIds.concat(classIdsFromSubjects);
    return classes.filter(function (c) { return allowed.indexOf(String(c.ClassID)) !== -1; });
  }

  return classes; // admin
}

function listSubjects(actor, params) {
  let subjects = getSheetData(SHEETS.SUBJECTS);

  if (params.classId) {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(params.classId); });
  }

  if (actor.role === 'student') {
    subjects = subjects.filter(function (s) { return String(s.ClassID) === String(actor.classId); });
  } else if (actor.role === 'staff' && !actor.isAdmin) {
    subjects = subjects.filter(function (s) {
      const inSubjectScope = actor.subjectIds.indexOf(String(s.SubjectID)) !== -1;
      const inClassScope = actor.classIds.indexOf(String(s.ClassID)) !== -1;
      return inSubjectScope || inClassScope;
    });
  }

  return subjects;
}

function listStudents(actor, params) {
  if (actor.role === 'student') {
    throw AppError('Students cannot list other students.', 'FORBIDDEN');
  }

  let students = getSheetData(SHEETS.STUDENTS);

  if (params.classId) {
    assertClassInScope(actor, params.classId);
    students = students.filter(function (s) { return String(s.ClassID) === String(params.classId); });
  } else if (!actor.isAdmin) {
    if (!actor.classIds.length) {
      throw AppError('Provide a classId to list students.', 'BAD_REQUEST');
    }
    students = students.filter(function (s) { return actor.classIds.indexOf(String(s.ClassID)) !== -1; });
  }

  return students;
}

function listAttendance(actor, params) {
  let rows = getSheetData(SHEETS.ATTENDANCE).map(function (r) {
    return {
      AttendanceID: r.AttendanceID,
      Date: formatDate(r.Date),
      SubjectID: r.SubjectID,
      StudentID: r.StudentID,
      Status: Number(r.Status)
    };
  });

  if (actor.role === 'student') {
    rows = rows.filter(function (r) { return String(r.StudentID) === String(actor.studentId); });
  } else if (!actor.isAdmin) {
    const scopedStudentIds = getStudentIdsInScope(actor);
    const scopedSubjectIds = getSubjectIdsInScope(actor);
    rows = rows.filter(function (r) {
      return scopedStudentIds.indexOf(String(r.StudentID)) !== -1 ||
             scopedSubjectIds.indexOf(String(r.SubjectID)) !== -1;
    });
  }

  if (params.subjectId) {
    rows = rows.filter(function (r) { return String(r.SubjectID) === String(params.subjectId); });
  }
  if (params.classId) {
    const idsInClass = getSheetData(SHEETS.STUDENTS)
      .filter(function (s) { return String(s.ClassID) === String(params.classId); })
      .map(function (s) { return String(s.StudentID); });
    rows = rows.filter(function (r) { return idsInClass.indexOf(String(r.StudentID)) !== -1; });
  }
  if (params.date) {
    rows = rows.filter(function (r) { return r.Date === params.date; });
  }

  return rows;
}

// =====================================================
// WRITE HANDLERS
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

  const subject = assertSubjectInScope(actor, subjectId);

  const records = Array.isArray(body.records) && body.records.length
    ? body.records
    : [{ studentId: body.studentId, status: body.status }];

  if (!records.length) throw AppError('No attendance records provided.', 'VALIDATION_ERROR');

  const sheetInfo = getSheetRows(SHEETS.ATTENDANCE);
  const statusCol = sheetInfo.headers.indexOf('Status') + 1;
  const results = [];

  records.forEach(function (rec) {
    const studentId = String(rec.studentId || '').trim();
    const status = Number(rec.status);

    if (!studentId) throw AppError('studentId is required for every record.', 'VALIDATION_ERROR');
    if (status !== 0 && status !== 1) {
      throw AppError('status must be 0 or 1 for student "' + studentId + '".', 'VALIDATION_ERROR');
    }

    assertStudentInScope(actor, studentId, subject.ClassID);

    const existing = sheetInfo.rows.find(function (r) {
      return formatDate(r.values.Date) === date &&
             String(r.values.SubjectID).trim() === subjectId &&
             String(r.values.StudentID).trim() === studentId;
    });

    if (existing) {
      sheetInfo.sheet.getRange(existing.rowNumber, statusCol).setValue(status);
      results.push({ studentId: studentId, attendanceId: existing.values.AttendanceID, action: 'updated' });
    } else {
      const attendanceId = 'ATT' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
      sheetInfo.sheet.appendRow([attendanceId, date, subjectId, studentId, status]);
      sheetInfo.rows.push({
        rowNumber: sheetInfo.sheet.getLastRow(),
        values: { AttendanceID: attendanceId, Date: date, SubjectID: subjectId, StudentID: studentId, Status: status }
      });
      results.push({ studentId: studentId, attendanceId: attendanceId, action: 'created' });
    }
  });

  return { date: date, subjectId: subjectId, results: results };
}

function deleteAttendance(actor, body) {
  if (actor.role !== 'staff') {
    throw AppError('Only teachers/CRs can delete attendance.', 'FORBIDDEN');
  }

  const attendanceId = String(body.attendanceId || '').trim();
  if (!attendanceId) throw AppError('attendanceId is required.', 'VALIDATION_ERROR');

  const sheetInfo = getSheetRows(SHEETS.ATTENDANCE);
  const row = sheetInfo.rows.find(function (r) { return String(r.values.AttendanceID).trim() === attendanceId; });
  if (!row) throw AppError('Attendance record not found.', 'NOT_FOUND');

  assertSubjectInScope(actor, row.values.SubjectID);

  sheetInfo.sheet.deleteRow(row.rowNumber);
  return { deleted: attendanceId };
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
