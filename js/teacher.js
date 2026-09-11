import { guardPage, wireSignOut } from "./guard.js";
import {
  getAttendance,
  saveAttendance,
  deleteAttendance,
  addClass,
  addSubject,
  addStudent,
  getSubjectSheet,
  deleteSubjectSheetRow,
  deleteSubjectSheetColumn,
  renameSubjectSheetRow,
  ApiError
} from "./api.js";
import { initCustomSelect } from "./custom-select.js";
import { showToast, showConfirmModal, getSkeletonTableRows } from "./ui-feedback.js";

const classSelect = document.getElementById("class-select");
const subjectClassSelect = document.getElementById("subject-class-select");
const studentClassSelect = document.getElementById("student-class-select");
const subjectSelect = document.getElementById("subject-select");
const subjectTeacherSelect = document.getElementById("subject-teacher-select");
const dateInput = document.getElementById("attendance-date");
const backfillNotice = document.getElementById("backfill-notice");
const backfillNoticeText = document.getElementById("backfill-notice-text");
const rosterWrap = document.getElementById("roster-wrap");
const historyWrap = document.getElementById("history-wrap");

wireSignOut(document.getElementById("signout-btn"));

const csClass = initCustomSelect(classSelect);
const csSubject = initCustomSelect(subjectSelect);
const csSubjClass = initCustomSelect(subjectClassSelect);
const csStudClass = initCustomSelect(studentClassSelect);
const csSubjTeacher = initCustomSelect(subjectTeacherSelect);

let today = new Date().toISOString().slice(0, 10);

let allClasses = [];
let allSubjects = [];
let allStudents = [];
const attendanceBySubject = {};

let subjectsById = {};
let roster = [];
let isRosterLocked = false;
let searchQuery = "";

// Blueprint state
let bpData = null;
let bpSort = { key: "name", dir: "asc" };
let bpSearch = "";
let bpLoading = false;

guardPage("staff", async (me, boot) => {
  const displayName = me.name ? me.name : me.email;
  document.getElementById("user-name").textContent = displayName;

  const initials = me.name
    ? me.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()
    : me.email[0].toUpperCase();
  const avatarEl = document.getElementById("user-avatar");
  if (avatarEl) avatarEl.textContent = initials;

  const roleBadge = document.getElementById("role-badge");
  roleBadge.textContent = me.roleLabel || "Teacher";
  if ((me.roleLabel || "").toLowerCase() === "cr") roleBadge.classList.add("is-cr");

  if (me.today) today = me.today;
  document.getElementById("today-label").textContent = formatDisplayDate(today);

  dateInput.value = today;
  dateInput.max = today;
  updateBackfillNotice();

  allClasses = boot.classes || [];
  allSubjects = boot.subjects || [];
  allStudents = boot.students || [];
  renderClassOptions();

  const teachers = boot.teachers || [];
  subjectTeacherSelect.innerHTML =
    '<option value="">Myself</option>' +
    teachers.map((t) => `<option value="${t.TeacherID}">${t.Name}${t.Role ? " (" + t.Role + ")" : ""}</option>`).join("");
  csSubjTeacher?.sync();
});

// Called when the server tells us a subject no longer exists. Removes it
// from every cached list and from the subject dropdown so the UI never
// shows a ghost again for the rest of this session.
function evictSubjectFromCaches(subjectId) {
  const sid = String(subjectId);
  allSubjects = allSubjects.filter((s) => String(s.SubjectID) !== sid);
  delete subjectsById[sid];
  delete attendanceBySubject[sid];

  const classId = classSelect.value;
  const subjects = allSubjects.filter((s) => String(s.ClassID) === String(classId));
  subjectsById = Object.fromEntries(subjects.map((s) => [String(s.SubjectID), s.SubjectName]));
  subjectSelect.innerHTML =
    '<option value="">Select a subject…</option>' +
    subjects.map((s) => `<option value="${s.SubjectID}">${s.SubjectName}</option>`).join("");
  csSubject?.sync();

  if (String(subjectSelect.value) === sid) {
    subjectSelect.value = "";
    csSubject?.sync();
    rosterWrap.innerHTML = emptyState("Choose a Class and Subject", "The student roster and roll-call toggles will appear here automatically.");
    resetBlueprint("Pick a class and subject above to see the register sheet blueprint.");
  }
}

function renderClassOptions(selectedId) {
  const opts = '<option value="">Select a class…</option>' +
    allClasses.map((c) => `<option value="${c.ClassID}">${c.ClassName}</option>`).join("");
  [classSelect, subjectClassSelect, studentClassSelect].forEach((sel) => {
    const prev = selectedId !== undefined ? selectedId : sel.value;
    sel.innerHTML = opts;
    if (prev) sel.value = prev;
  });
  csClass?.sync();
  csSubjClass?.sync();
  csStudClass?.sync();
}

// ---------------------------------------------------------------------------
// Attendance: class -> subject -> date -> roster
// ---------------------------------------------------------------------------

classSelect.addEventListener("change", onClassChange);
subjectSelect.addEventListener("change", onSubjectChange);
dateInput.addEventListener("change", () => {
  if (!dateInput.value) dateInput.value = today;
  if (dateInput.value > today) dateInput.value = today;
  updateBackfillNotice();
  buildRosterForSelection();
});

function updateBackfillNotice() {
  const isPast = dateInput.value && dateInput.value !== today;
  if (isPast) {
    backfillNoticeText.textContent =
      `You're marking ${formatDisplayDate(dateInput.value)} — a past date you missed. This can only be saved once, and it locks immediately after.`;
    backfillNotice.style.display = "flex";
  } else {
    backfillNotice.style.display = "none";
  }
}

function onClassChange() {
  const classId = classSelect.value;
  searchQuery = "";
  rosterWrap.innerHTML = emptyState("Choose a Class and Subject", "The student roster and roll-call toggles will appear here automatically.");
  resetBlueprint("Pick a class and subject above to see the register sheet blueprint.");

  if (!classId) {
    subjectSelect.innerHTML = '<option value="">Select a subject…</option>';
    csSubject?.sync();
    return;
  }

  const subjects = allSubjects.filter((s) => String(s.ClassID) === String(classId));
  subjectsById = Object.fromEntries(subjects.map((s) => [String(s.SubjectID), s.SubjectName]));
  subjectSelect.innerHTML =
    '<option value="">Select a subject…</option>' +
    subjects.map((s) => `<option value="${s.SubjectID}">${s.SubjectName}</option>`).join("");
  csSubject?.sync();

  if (subjects.length === 1) {
    subjectSelect.value = subjects[0].SubjectID;
    csSubject?.sync();
    onSubjectChange();
  }
}

async function onSubjectChange() {
  const subjectId = subjectSelect.value;
  searchQuery = "";
  bpSearch = "";

  if (!subjectId) {
    rosterWrap.innerHTML = emptyState("Choose a Class and Subject", "The student roster and roll-call toggles will appear here automatically.");
    resetBlueprint("Pick a class and subject above to see the register sheet blueprint.");
    return;
  }

  // Guard: if the subject isn't in our cached master list any more (e.g. it
  // was deleted while this page was open), evict it immediately instead of
  // waiting for a failed network round-trip.
  const stillExists = allSubjects.some((s) => String(s.SubjectID) === String(subjectId));
  if (!stillExists) {
    evictSubjectFromCaches(subjectId);
    return;
  }

  if (!attendanceBySubject[subjectId]) {
    rosterWrap.innerHTML = `
      <div class="table-responsive-container">
        <table class="ledger">
          <thead><tr><th>Student ID</th><th>Name</th><th>Mark</th></tr></thead>
          <tbody>${getSkeletonTableRows(5, 3)}</tbody>
        </table>
      </div>
    `;
    try {
      attendanceBySubject[subjectId] = await getAttendance({ subjectId });
    } catch (err) {
      rosterWrap.innerHTML = emptyState("Couldn't load attendance", describeError(err));
      if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
        evictSubjectFromCaches(subjectId);
      }
      return;
    }
  }

  buildRosterForSelection();
  loadBlueprint(subjectId);
}

function buildRosterForSelection() {
  const classId = classSelect.value;
  const subjectId = subjectSelect.value;
  const selectedDate = dateInput.value;
  if (!classId || !subjectId || !selectedDate) return;

  const students = allStudents.filter((s) => String(s.ClassID) === String(classId));
  const attendance = attendanceBySubject[subjectId] || [];
  const marksForDate = attendance.filter((r) => r.Date === selectedDate);

  isRosterLocked = selectedDate !== today && marksForDate.length > 0;

  const existingByStudent = Object.fromEntries(marksForDate.map((r) => [String(r.StudentID), r.Status]));
  roster = students.map((s) => ({
    StudentID: s.StudentID,
    Name: s.Name,
    status: existingByStudent.hasOwnProperty(String(s.StudentID)) ? existingByStudent[String(s.StudentID)] : 1
  }));

  renderRoster();
}

function getVisibleRoster() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return roster;
  return roster.filter((r) =>
    String(r.StudentID).toLowerCase().includes(q) || String(r.Name).toLowerCase().includes(q)
  );
}

function renderRoster() {
  if (!roster.length) {
    rosterWrap.innerHTML = emptyState("No students in this class yet", "Add one in 'Add to the Register' above — it will show up here immediately.");
    return;
  }
  if (isRosterLocked) { renderLockedRoster(); return; }

  const selectedDate = dateInput.value;
  const isPastDate = selectedDate !== today;

  rosterWrap.innerHTML = `
    <div class="roster-summary-strip">
      <div class="roster-legend" id="roster-legend-counts"></div>
      <div class="batch-actions-wrap">
        <button type="button" class="btn btn-ghost" id="batch-all-present" title="Mark all students present">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" style="color:var(--present);">
            <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
          </svg>
          All Present
        </button>
        <button type="button" class="btn btn-ghost" id="batch-all-absent" title="Mark all students absent">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" style="color:var(--absent);">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
          All Absent
        </button>
      </div>
    </div>

    <div class="field" style="max-width:340px; margin-bottom:1rem;">
      <div class="input-with-icon">
        <span class="input-icon-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        </span>
        <input type="text" id="roster-search" placeholder="Search by seat number or name…" autocomplete="off" />
      </div>
    </div>

    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Student ID</th><th>Name</th><th>Attendance Status</th></tr></thead>
        <tbody id="roster-tbody"></tbody>
      </table>
    </div>

    <div class="save-roster-footer">
      <div class="lock-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
        </svg>
        <span>${isPastDate
      ? "This is a past date you missed — it can be saved once, then it locks for good."
      : "Changes for today can be updated anytime before midnight. Previous dates are locked."}</span>
      </div>
      <button class="btn btn-primary" id="save-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
        </svg>
        ${isPastDate ? `Save Attendance for ${formatDisplayDate(selectedDate)}` : "Save Attendance for Today"}
      </button>
    </div>
  `;

  document.getElementById("roster-search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderRosterRows();
  });

  document.getElementById("batch-all-present").addEventListener("click", () => {
    roster.forEach(r => r.status = 1);
    renderRosterRows();
  });
  document.getElementById("batch-all-absent").addEventListener("click", () => {
    roster.forEach(r => r.status = 0);
    renderRosterRows();
  });

  document.getElementById("save-btn").addEventListener("click", onSaveClick);

  renderRosterRows();
}

function renderRosterRows() {
  const presentCount = roster.filter((r) => r.status === 1).length;
  const absentCount = roster.length - presentCount;

  const legend = document.getElementById("roster-legend-counts");
  if (legend) {
    legend.innerHTML = `
      <span><span class="dot present"></span> <strong>${presentCount}</strong> Present</span>
      <span><span class="dot absent"></span> <strong>${absentCount}</strong> Absent</span>
      <span><strong>${roster.length}</strong> Total Students</span>
    `;
  }

  const visible = getVisibleRoster();
  const tbody = document.getElementById("roster-tbody");
  if (!tbody) return;

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:2rem 1rem;">No students match "${escapeHtml(searchQuery)}".</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map((r) => {
    const index = roster.indexOf(r);
    const initials = r.Name ? r.Name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() : "?";
    return `
      <tr>
        <td><span class="student-id-code">${r.StudentID}</span></td>
        <td>
          <div class="student-cell">
            <div class="student-avatar">${initials}</div>
            <span style="font-weight:600;">${r.Name}</span>
          </div>
        </td>
        <td>
          <div class="roll-toggle" data-index="${index}">
            <button type="button" class="${r.status === 1 ? "active present" : ""}" data-status="1">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
              </svg>
              Present
            </button>
            <button type="button" class="${r.status === 0 ? "active absent" : ""}" data-status="0">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
              Absent
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".roll-toggle").forEach((toggle) => {
    const index = Number(toggle.dataset.index);
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        roster[index].status = Number(btn.dataset.status);
        renderRosterRows();
      });
    });
  });
}

function renderLockedRoster() {
  const visible = getVisibleRoster();
  const presentCount = roster.filter((r) => r.status === 1).length;
  const absentCount = roster.length - presentCount;

  const rows = visible.map((r) => {
    const initials = r.Name ? r.Name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() : "?";
    return `
      <tr>
        <td><span class="student-id-code">${r.StudentID}</span></td>
        <td>
          <div class="student-cell">
            <div class="student-avatar">${initials}</div>
            <span style="font-weight:600;">${r.Name}</span>
          </div>
        </td>
        <td>
          <span class="status-pill ${r.status === 1 ? "present" : "absent"}">${r.status === 1 ? "Present" : "Absent"}</span>
        </td>
      </tr>
    `;
  }).join("");

  rosterWrap.innerHTML = `
    <div class="error-box" style="background:var(--canvas-alt); color:var(--text-soft); border-color:var(--border); animation:none;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
      </svg>
      <span>${formatDisplayDate(dateInput.value)} was already submitted (${presentCount} present, ${absentCount} absent) and is now permanently locked.</span>
    </div>
    <div class="field" style="max-width:340px; margin:1rem 0;">
      <div class="input-with-icon">
        <span class="input-icon-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        </span>
        <input type="text" id="roster-search" placeholder="Search by seat number or name…" autocomplete="off" />
      </div>
    </div>
    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Student ID</th><th>Name</th><th>Status</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:2rem 1rem;">No students match "${escapeHtml(searchQuery)}".</td></tr>`}</tbody>
      </table>
    </div>
  `;

  const input = document.getElementById("roster-search");
  input.value = searchQuery;
  input.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderLockedRoster();
  });
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

async function onSaveClick() {
  const presentCount = roster.filter((r) => r.status === 1).length;
  const absentCount = roster.length - presentCount;
  const subjectId = subjectSelect.value;
  const subjectName = subjectsById[subjectId] || "this subject";
  const selectedDate = dateInput.value;
  const isPastDate = selectedDate !== today;

  const step1 = await showConfirmModal({
    title: "Review Attendance Roll",
    body: `You are about to save attendance for <strong>${subjectName}</strong> on <strong>${formatDisplayDate(selectedDate)}</strong>.`,
    summary: { present: presentCount, absent: absentCount },
    confirmLabel: "Looks good, continue"
  });
  if (!step1) return;

  const step2 = await showConfirmModal({
    title: "Submit and Sync Register",
    body: isPastDate
      ? `This is a past date — once submitted, it locks immediately and can never be edited again, by anyone. Are you sure this is correct?`
      : "Once submitted, this roll call will be stored in your official register and will lock at the end of the day. Do you want to submit now?",
    confirmLabel: isPastDate ? "Yes, lock it in" : "Yes, save attendance",
    danger: isPastDate
  });
  if (!step2) return;

  const saveBtn = document.getElementById("save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="modern-spinner" style="width:16px;height:16px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:#fff;"></span> Saving to Sheet…`;

  try {
    const result = await saveAttendance({
      date: selectedDate,
      subjectId,
      records: roster.map((r) => ({ studentId: r.StudentID, name: r.Name, status: r.status }))
    });

    // If the response body was lost in the redirect, we don't know if the
    // save landed. Re-fetch the blueprint from the server — it's the only
    // reliable source of truth. Then update the local cache from that.
    if (result === null) {
      showToast("Save may not have completed cleanly — re-syncing from the server.", "warning");
      await loadBlueprint(subjectId);
      // Also refresh the attendance cache used by the roster.
      try {
        attendanceBySubject[subjectId] = await getAttendance({ subjectId });
      } catch (_) { /* non-fatal */ }
    } else {
      // Normal path — update the local cache optimistically.
      const cache = (attendanceBySubject[subjectId] || []).filter((r) => r.Date !== selectedDate);
      roster.forEach((r) => {
        cache.push({
          AttendanceID: `${subjectId}_${r.StudentID}_${selectedDate}`,
          Date: selectedDate,
          SubjectID: subjectId,
          StudentID: r.StudentID,
          Status: r.status
        });
      });
      attendanceBySubject[subjectId] = cache;
      isRosterLocked = isPastDate;

      // If the server skipped any records (student not enrolled on the
      // subject sheet), surface that clearly instead of silently succeeding.
      const skipped = (result && result.results ? result.results : []).filter((x) => x.action === "skipped");
      if (skipped.length) {
        showToast(
          `Saved ${result.results.length - skipped.length} of ${result.results.length} — ${skipped.length} student(s) aren't on this subject's sheet.`,
          "warning"
        );
      } else {
        showToast(`Attendance saved successfully for ${roster.length} student${roster.length === 1 ? "" : "s"}.`, "success");
      }
      await loadBlueprint(subjectId);
    }

    renderRoster();
  } catch (err) {
    showToast(describeError(err), "error");
    if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      evictSubjectFromCaches(subjectId);
    }
    saveBtn.disabled = false;
    saveBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
      </svg>
      ${isPastDate ? `Save Attendance for ${formatDisplayDate(selectedDate)}` : "Save Attendance for Today"}
    `;
  }
}

// ---------------------------------------------------------------------------
// BLUEPRINT — full subject sheet viewer with hover menus, sorting, actions
// ---------------------------------------------------------------------------

function resetBlueprint(msg) {
  bpData = null;
  bpSort = { key: "name", dir: "asc" };
  historyWrap.innerHTML = `<p class="page-sub" style="margin:0;">${msg}</p>`;
}

async function loadBlueprint(subjectId) {
  bpLoading = true;
  renderBlueprintShell();

  try {
    bpData = await getSubjectSheet(subjectId);
    bpLoading = false;

    // Kill the loader the moment we have data, before painting the table.
    const loader = document.getElementById("bp-loading-mount");
    if (loader) loader.innerHTML = "";

    renderBlueprint();
  } catch (err) {
    bpLoading = false;
    const loader = document.getElementById("bp-loading-mount");
    if (loader) loader.innerHTML = "";
    historyWrap.innerHTML = emptyState("Couldn't load the register sheet", describeError(err));
    if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      evictSubjectFromCaches(subjectId);
    }
  }
}

function renderBlueprintShell() {
  historyWrap.innerHTML = `
    <div class="bp-toolbar">
      <div class="bp-toolbar__search">
        <div class="input-with-icon">
          <span class="input-icon-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </span>
          <input type="text" id="bp-search" placeholder="Search student by name or ID…" autocomplete="off" value="${escapeHtml(bpSearch)}" />
        </div>
      </div>
      <div class="bp-toolbar__sort">
        <label class="bp-sort-label">Sort by</label>
        <select id="bp-sort-key">
          <option value="name">Name (A–Z)</option>
          <option value="name-desc">Name (Z–A)</option>
          <option value="id">Student ID</option>
          <option value="total-desc">Most Present</option>
          <option value="total-asc">Most Absent</option>
          <option value="recent">Newest date</option>
        </select>
      </div>
      <div class="bp-toolbar__meta" id="bp-meta"></div>
    </div>

    <div class="bp-scroll-wrap">
      <div id="bp-loading-mount"></div>
      <div id="bp-table-mount"></div>
    </div>
  `;

  document.getElementById("bp-search").addEventListener("input", (e) => {
    bpSearch = e.target.value;
    renderBlueprintTable();
  });

  // Wire the sort dropdown through the same custom-select component used
  // everywhere else, so it matches the rest of the app visually.
  const sortSel = document.getElementById("bp-sort-key");
  sortSel.value = currentSortChoiceValue();
  const csSort = initCustomSelect(sortSel);
  csSort?.sync();
  sortSel.addEventListener("change", (e) => {
    applySortChoice(e.target.value);
    renderBlueprintTable();
  });

  // Show a loader in its own dedicated slot — we remove just this slot
  // once data arrives, leaving the toolbar and mount point untouched.
  document.getElementById("bp-loading-mount").innerHTML =
    `<div class="spinner-row"><span class="modern-spinner"></span><span>Loading register sheet…</span></div>`;
}

function currentSortChoiceValue() {
  if (bpSort.key === "name") return bpSort.dir === "asc" ? "name" : "name-desc";
  if (bpSort.key === "id") return "id";
  if (bpSort.key === "total") return bpSort.dir === "desc" ? "total-desc" : "total-asc";
  if (bpSort.key === "recent") return "recent";
  return "name";
}

function applySortChoice(choice) {
  switch (choice) {
    case "name": bpSort = { key: "name", dir: "asc" }; break;
    case "name-desc": bpSort = { key: "name", dir: "desc" }; break;
    case "id": bpSort = { key: "id", dir: "asc" }; break;
    case "total-desc": bpSort = { key: "total", dir: "desc" }; break;
    case "total-asc": bpSort = { key: "total", dir: "asc" }; break;
    case "recent": bpSort = { key: "recent", dir: "desc" }; break;
  }
}

function renderBlueprint() {
  if (!bpData) return;

  const meta = document.getElementById("bp-meta");
  if (meta) {
    meta.innerHTML = `
      <span class="bp-meta-chip">${bpData.rows.length} students</span>
      <span class="bp-meta-chip">${bpData.dates.length} sessions</span>
    `;
  }

  renderBlueprintTable();
}

function sortedRows() {
  const rows = bpData ? bpData.rows.slice() : [];
  const { key, dir } = bpSort;
  const sign = dir === "asc" ? 1 : -1;

  if (key === "name") {
    rows.sort((a, b) => sign * String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  } else if (key === "id") {
    rows.sort((a, b) => sign * String(a.studentId || "").localeCompare(String(b.studentId || ""), undefined, { numeric: true, sensitivity: "base" }));
  } else if (key === "total") {
    rows.sort((a, b) => sign * (Number(a.total) - Number(b.total)));
  } else if (key === "recent") {
    const recent = (bpData.dates.slice(-5) || []).map((d) => d.date);
    const weight = (r) => recent.reduce((acc, d) => acc + (r.marks[d] === 1 ? 1 : 0), 0);
    rows.sort((a, b) => sign * (weight(a) - weight(b)));
  }
  return rows;
}

function renderBlueprintTable() {
  if (!bpData) return;
  const mount = document.getElementById("bp-table-mount");
  if (!mount) return;

  const q = bpSearch.trim().toLowerCase();
  const filtered = sortedRows().filter((r) => {
    if (!q) return true;
    return String(r.name || "").toLowerCase().includes(q) || String(r.studentId || "").toLowerCase().includes(q);
  });

  if (!bpData.rows.length) {
    mount.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/>
          </svg>
        </div>
        <h3>This register is empty</h3>
        <p>Save your first roll call above and the grid will appear here.</p>
      </div>`;
    return;
  }

  const dateCols = bpData.dates.slice().sort((a, b) => (a.date < b.date ? -1 : 1));

  const headerCells = dateCols.map((d) => {
    const isToday = d.date === today;
    return `
      <th class="bp-col bp-col-date ${isToday ? "is-today" : ""}" data-date="${d.date}">
        <div class="bp-col-inner">
          <span class="bp-col-label">${formatShortDate(d.date)}</span>
          <button type="button" class="bp-kebab bp-kebab--th" data-menu="date" data-date="${d.date}" aria-label="Column actions">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </div>
      </th>
    `;
  }).join("");

  const bodyRows = filtered.map((r) => {
    const initials = r.name ? r.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() : "?";
    const cells = dateCols.map((d) => {
      const v = r.marks[d.date];
      const cls = v === 1 ? "is-present" : v === 0 ? "is-absent" : "is-empty";
      const label = v === 1 ? "1" : v === 0 ? "0" : "–";
      return `<td class="bp-cell ${cls}">${label}</td>`;
    }).join("");

    return `
      <tr class="bp-row" data-row="${r.sheetRowNumber}">
        <td class="bp-cell bp-cell--id">
          <span class="student-id-code">${escapeHtml(r.studentId || "—")}</span>
        </td>
        <td class="bp-cell bp-cell--name">
          <div class="student-cell">
            <div class="student-avatar">${initials}</div>
            <span style="font-weight:600;">${escapeHtml(r.name || "Unnamed")}</span>
          </div>
          <button type="button" class="bp-kebab bp-kebab--row" data-menu="row" data-row="${r.sheetRowNumber}" aria-label="Row actions">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
        </td>
        ${cells}
        <td class="bp-cell bp-cell--total"><strong>${r.total}</strong></td>
      </tr>
    `;
  }).join("");

  mount.innerHTML = `
    <div class="bp-table-container">
      <table class="bp-table">
        <thead>
          <tr>
            <th class="bp-col bp-col-id">Student ID</th>
            <th class="bp-col bp-col-name">Name</th>
            ${headerCells}
            <th class="bp-col bp-col-total">${escapeHtml(bpData.totalHeader || "Total")}</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${!filtered.length ? `<p class="page-sub" style="margin:1rem 0 0; text-align:center;">No students match "${escapeHtml(bpSearch)}".</p>` : ""}
  `;

  mount.querySelectorAll(".bp-kebab--row").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRowMenu(btn, Number(btn.dataset.row));
    });
  });
  mount.querySelectorAll(".bp-kebab--th").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openColumnMenu(btn, btn.dataset.date);
    });
  });
}

function openRowMenu(anchor, rowNumber) {
  const row = bpData.rows.find((r) => r.sheetRowNumber === rowNumber);
  if (!row) return;

  const items = [
    {
      label: "Rename row…",
      icon: pencilIcon(),
      onClick: async () => {
        const newName = window.prompt("Rename this student in THIS subject sheet only:", row.name || "");
        if (newName === null) return;
        const newId = window.prompt("Student ID (leave blank to keep as-is):", row.studentId || "");
        if (newId === null) return;
        try {
          await renameSubjectSheetRow(bpData.subjectId, rowNumber, newId.trim(), newName.trim());
          showToast("Row renamed in this sheet.", "success");
          loadBlueprint(bpData.subjectId);
        } catch (err) { showToast(describeError(err), "error"); }
      }
    },
    { divider: true },
    {
      label: "Delete row from this sheet",
      icon: trashIcon(),
      danger: true,
      onClick: async () => {
        const ok = await showConfirmModal({
          title: "Delete this row?",
          body: `<strong>${escapeHtml(row.name || "This student")}</strong> will be removed from <strong>${escapeHtml(bpData.subjectName)}</strong>'s register only. The master Students list is not affected.`,
          confirmLabel: "Delete row",
          danger: true
        });
        if (!ok) return;
        try {
          await deleteSubjectSheetRow(bpData.subjectId, rowNumber);
          showToast("Row deleted from this sheet.", "success");
          loadBlueprint(bpData.subjectId);
        } catch (err) { showToast(describeError(err), "error"); }
      }
    }
  ];

  showActionMenu(anchor, items);
}

function openColumnMenu(anchor, date) {
  const isToday = date === today;
  const items = [];

  if (isToday) {
    items.push({
      label: "Jump to today's roll call",
      icon: checkIcon(),
      onClick: () => {
        dateInput.value = today;
        updateBackfillNotice();
        buildRosterForSelection();
        document.getElementById("attendance-section").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    items.push({
      label: "Today's column is locked from deletion",
      icon: lockIcon(),
      disabled: true
    });
  } else {
    items.push({
      label: "Mark this date (backfill)",
      icon: pencilIcon(),
      onClick: () => {
        dateInput.value = date;
        updateBackfillNotice();
        buildRosterForSelection();
        document.getElementById("attendance-section").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    items.push({ divider: true });
    items.push({
      label: "Delete this session column",
      icon: trashIcon(),
      danger: true,
      onClick: async () => {
        const ok = await showConfirmModal({
          title: "Delete this session?",
          body: `The column for <strong>${formatDisplayDate(date)}</strong> will be removed from <strong>${escapeHtml(bpData.subjectName)}</strong>'s register. Totals will be recalculated.`,
          confirmLabel: "Delete session",
          danger: true
        });
        if (!ok) return;
        try {
          await deleteSubjectSheetColumn(bpData.subjectId, date);
          showToast("Session column deleted.", "success");
          delete attendanceBySubject[bpData.subjectId];
          loadBlueprint(bpData.subjectId);
        } catch (err) { showToast(describeError(err), "error"); }
      }
    });
  }

  showActionMenu(anchor, items);
}

let _openMenuEl = null;
function showActionMenu(anchor, items) {
  closeActionMenu();

  const menu = document.createElement("div");
  menu.className = "bp-menu";
  menu.setAttribute("role", "menu");

  items.forEach((it) => {
    if (it.divider) {
      const d = document.createElement("div");
      d.className = "bp-menu__divider";
      menu.appendChild(d);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bp-menu__item" + (it.danger ? " is-danger" : "") + (it.disabled ? " is-disabled" : "");
    btn.setAttribute("role", "menuitem");
    if (it.disabled) btn.disabled = true;
    btn.innerHTML = `${it.icon || ""}<span>${it.label}</span>`;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeActionMenu();
      if (it.disabled) return;
      try { await it.onClick(); } catch (err) { showToast(describeError(err), "error"); }
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  _openMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const menuW = menu.offsetWidth || 220;
  const menuH = menu.offsetHeight || 160;
  let left = r.right - menuW;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  if (top + menuH > window.innerHeight - 8) top = r.top - menuH - 6;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  requestAnimationFrame(() => menu.classList.add("is-open"));

  setTimeout(() => {
    document.addEventListener("click", onDocClickClose, { once: true });
    document.addEventListener("keydown", onEscClose);
    window.addEventListener("scroll", closeActionMenu, { once: true, passive: true });
  }, 0);
}

function onDocClickClose(e) {
  if (!_openMenuEl) return;
  if (!_openMenuEl.contains(e.target)) closeActionMenu();
}
function onEscClose(e) { if (e.key === "Escape") closeActionMenu(); }

function closeActionMenu() {
  if (_openMenuEl) {
    _openMenuEl.remove();
    _openMenuEl = null;
  }
  document.removeEventListener("keydown", onEscClose);
}

function pencilIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z"/></svg>`;
}
function trashIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`;
}
function checkIcon() {
  return `<svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/></svg>`;
}
function lockIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>`;
}

// ---------------------------------------------------------------------------
// Manage: add class / subject / student
// ---------------------------------------------------------------------------

document.getElementById("add-class-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("new-class-name");
  const yearInput = document.getElementById("new-class-year");
  const className = nameInput.value.trim();
  if (!className) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.innerHTML = `<span class="modern-spinner" style="width:14px;height:14px;border-width:2px;border-top-color:currentColor;"></span> Adding…`;
  try {
    const result = await addClass({ className, academicYear: yearInput.value.trim() });
    allClasses.push({ ClassID: result.classId, ClassName: result.className });
    renderClassOptions();
    nameInput.value = "";
    yearInput.value = "";
    flashAdded("class-added-note");
    showToast(`Class "${result.className}" successfully registered.`, "success");
  } catch (err) {
    showToast(describeError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
      </svg>
      Add class
    `;
  }
});

document.getElementById("add-subject-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("new-subject-name");
  const subjectName = nameInput.value.trim();
  const classId = subjectClassSelect.value;
  const teacherId = subjectTeacherSelect.value;

  if (!classId) { showToast("Please select a target class first.", "warning"); return; }
  if (!subjectName) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.innerHTML = `<span class="modern-spinner" style="width:14px;height:14px;border-width:2px;border-top-color:currentColor;"></span> Adding…`;
  try {
    const result = await addSubject({ subjectName, classId, teacherId });
    allSubjects.push({ SubjectID: result.subjectId, SubjectName: result.subjectName, ClassID: result.classId, TeacherID: result.teacherId });
    attendanceBySubject[result.subjectId] = [];

    nameInput.value = "";
    flashAdded("subject-added-note");
    showToast(`Subject "${result.subjectName}" successfully added.`, "success");

    if (classSelect.value === classId) {
      subjectsById[result.subjectId] = result.subjectName;
      const opt = document.createElement("option");
      opt.value = result.subjectId;
      opt.textContent = result.subjectName;
      subjectSelect.appendChild(opt);
      csSubject?.sync();
    }
  } catch (err) {
    showToast(describeError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
      </svg>
      Add subject
    `;
  }
});

document.getElementById("add-student-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const seatInput = document.getElementById("new-student-seat");
  const nameInput = document.getElementById("new-student-name");
  const emailInput = document.getElementById("new-student-email");
  const seatNumber = seatInput.value.trim();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const classId = studentClassSelect.value;

  if (!classId) { showToast("Please select a target class first.", "warning"); return; }
  if (!seatNumber || !name || !email) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.innerHTML = `<span class="modern-spinner" style="width:14px;height:14px;border-width:2px;border-top-color:currentColor;"></span> Adding…`;
  try {
    const result = await addStudent({ seatNumber, name, email, classId });
    allStudents.push({ StudentID: result.studentId, Name: result.name, Email: result.email, ClassID: result.classId, Status: "Active" });

    seatInput.value = "";
    nameInput.value = "";
    emailInput.value = "";
    flashAdded("student-added-note");
    showToast(`Student "${result.name}" enrolled.`, "success");

    if (classSelect.value === classId && subjectSelect.value && !isRosterLocked) {
      buildRosterForSelection();
    }
  } catch (err) {
    showToast(describeError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
      </svg>
      Add student
    `;
  }
});

function flashAdded(id) {
  const el = document.getElementById(id);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
      </div>
      <h3>${title}</h3>
      <p>${body}</p>
    </div>
  `;
}

function describeError(err) {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatDisplayDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function formatShortDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}