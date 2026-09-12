import { guardPage, wireSignOut } from "./guard.js";
import {
  getClasses,
  getSubjects,
  getStudents,
  getTeachers,
  getAttendance,
  saveAttendance,
  deleteAttendance,
  addClass,
  addSubject,
  addStudent,
  ApiError
} from "./api.js";
import { initCustomSelect } from "./custom-select.js";
import { showToast, showConfirmModal, getSkeletonTableRows } from "./ui-feedback.js";

wireSignOut(document.getElementById("signout-btn"));

const classSelect = document.getElementById("class-select");
const subjectClassSelect = document.getElementById("subject-class-select");
const studentClassSelect = document.getElementById("student-class-select");
const subjectSelect = document.getElementById("subject-select");
const subjectTeacherSelect = document.getElementById("subject-teacher-select");
const rosterWrap = document.getElementById("roster-wrap");
const historyWrap = document.getElementById("history-wrap");

// Initialize custom selects
const csClass = initCustomSelect(classSelect);
const csSubject = initCustomSelect(subjectSelect);
const csSubjClass = initCustomSelect(subjectClassSelect);
const csStudClass = initCustomSelect(studentClassSelect);
const csSubjTeacher = initCustomSelect(subjectTeacherSelect);

let today = new Date().toISOString().slice(0, 10); // refined from server on load
let roster = []; // [{StudentID, Name, status}]
let subjectsById = {};
let allClasses = [];

guardPage("staff", async (me) => {
  const displayName = me.name ? me.name : me.email;
  document.getElementById("user-name").textContent = displayName;

  // Set avatar initials
  const initials = me.name
    ? me.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()
    : me.email[0].toUpperCase();
  const avatarEl = document.getElementById("user-avatar");
  if (avatarEl) avatarEl.textContent = initials;

  const roleBadge = document.getElementById("role-badge");
  roleBadge.textContent = me.roleLabel || "Teacher";
  if ((me.roleLabel || "").toLowerCase() === "cr") {
    roleBadge.classList.add("is-cr");
  }

  if (me.today) today = me.today;
  document.getElementById("today-label").textContent = formatDisplayDate(today);

  const [classes, teachers] = await Promise.all([getClasses(), getTeachers()]);
  allClasses = classes;
  renderClassOptions();

  subjectTeacherSelect.innerHTML =
    '<option value="">Myself</option>' +
    teachers.map((t) => `<option value="${t.TeacherID}">${t.Name}${t.Role ? " (" + t.Role + ")" : ""}</option>`).join("");
  csSubjTeacher?.sync();
});

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
// Attendance: class -> subject -> roster
// ---------------------------------------------------------------------------

classSelect.addEventListener("change", onClassChange);
subjectSelect.addEventListener("change", () => { loadRoster(); renderHistory(); });

async function onClassChange() {
  const classId = classSelect.value;
  subjectSelect.innerHTML = '<option value="">Select a subject…</option>';
  csSubject?.sync();
  rosterWrap.innerHTML = emptyState("Choose a Class and Subject", "The student roster and roll-call toggles will appear here automatically.");
  historyWrap.innerHTML = `<p class="page-sub" style="margin:0;">Pick a class and subject above to view previous roll records.</p>`;

  if (!classId) return;

  const subjects = await getSubjects({ classId });
  subjectsById = Object.fromEntries(subjects.map((s) => [String(s.SubjectID), s.SubjectName]));
  subjectSelect.innerHTML =
    '<option value="">Select a subject…</option>' +
    subjects.map((s) => `<option value="${s.SubjectID}">${s.SubjectName}</option>`).join("");
  csSubject?.sync();

  if (subjects.length === 1) {
    subjectSelect.value = subjects[0].SubjectID;
    csSubject?.sync();
    await loadRoster();
    await renderHistory();
  }
}

async function loadRoster() {
  const classId = classSelect.value;
  const subjectId = subjectSelect.value;
  if (!classId || !subjectId) return;

  rosterWrap.innerHTML = `
    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Student ID</th><th>Name</th><th>Mark</th></tr></thead>
        <tbody>${getSkeletonTableRows(5, 3)}</tbody>
      </table>
    </div>
  `;

  try {
    const [students, existing] = await Promise.all([
      getStudents({ classId }),
      getAttendance({ subjectId, date: today })
    ]);

    const existingByStudent = Object.fromEntries(existing.map((r) => [String(r.StudentID), r.Status]));

    roster = students.map((s) => ({
      StudentID: s.StudentID,
      Name: s.Name,
      status: existingByStudent.hasOwnProperty(String(s.StudentID)) ? existingByStudent[String(s.StudentID)] : 1
    }));

    renderRoster();
  } catch (err) {
    rosterWrap.innerHTML = emptyState("Couldn't load the roster", describeError(err));
  }
}

function renderRoster() {
  if (!roster.length) {
    rosterWrap.innerHTML = emptyState("No students in this class yet", "Add one in 'Add to the Register' above — it will show up here immediately.");
    return;
  }

  const presentCount = roster.filter((r) => r.status === 1).length;
  const absentCount = roster.length - presentCount;

  const rows = roster.map((r, i) => {
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
          <div class="roll-toggle" data-index="${i}">
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

  rosterWrap.innerHTML = `
    <div class="roster-summary-strip">
      <div class="roster-legend">
        <span><span class="dot present"></span> <strong>${presentCount}</strong> Present</span>
        <span><span class="dot absent"></span> <strong>${absentCount}</strong> Absent</span>
        <span><strong>${roster.length}</strong> Total Students</span>
      </div>
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

    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Student ID</th><th>Name</th><th>Attendance Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="save-roster-footer">
      <div class="lock-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
        </svg>
        <span>Changes for today can be updated anytime before midnight. Previous dates are locked.</span>
      </div>
      <button class="btn btn-primary" id="save-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
        </svg>
        Save Attendance for Today
      </button>
    </div>
  `;

  // Wire individual student status toggles
  rosterWrap.querySelectorAll(".roll-toggle").forEach((toggle) => {
    const index = Number(toggle.dataset.index);
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        roster[index].status = Number(btn.dataset.status);
        renderRoster();
      });
    });
  });

  // Batch actions
  document.getElementById("batch-all-present").addEventListener("click", () => {
    roster.forEach(r => r.status = 1);
    renderRoster();
  });
  document.getElementById("batch-all-absent").addEventListener("click", () => {
    roster.forEach(r => r.status = 0);
    renderRoster();
  });

  document.getElementById("save-btn").addEventListener("click", onSaveClick);
}

async function onSaveClick() {
  const presentCount = roster.filter((r) => r.status === 1).length;
  const absentCount = roster.length - presentCount;
  const subjectName = subjectsById[subjectSelect.value] || "this subject";

  const step1 = await showConfirmModal({
    title: "Review Attendance Roll",
    body: `You are about to save attendance for <strong>${subjectName}</strong> on <strong>${formatDisplayDate(today)}</strong>.`,
    summary: { present: presentCount, absent: absentCount },
    confirmLabel: "Looks good, continue"
  });
  if (!step1) return;

  const step2 = await showConfirmModal({
    title: "Submit and Sync Register",
    body: "Once submitted, this roll call will be stored in your official register and will lock at the end of the day. Do you want to submit now?",
    confirmLabel: "Yes, save attendance",
    danger: false
  });
  if (!step2) return;

  const saveBtn = document.getElementById("save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="modern-spinner" style="width:16px;height:16px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:#fff;"></span> Saving to Sheet…`;

  try {
    await saveAttendance({
      date: today,
      subjectId: subjectSelect.value,
      records: roster.map((r) => ({ studentId: r.StudentID, status: r.status }))
    });
    showToast(`Attendance saved successfully for ${roster.length} student${roster.length === 1 ? "" : "s"}.`, "success");
    await renderHistory();
  } catch (err) {
    showToast(describeError(err), "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
      </svg>
      Save Attendance for Today
    `;
  }
}

async function renderHistory() {
  const subjectId = subjectSelect.value;
  if (!subjectId) return;

  historyWrap.innerHTML = `
    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Date</th><th>Student</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${getSkeletonTableRows(4, 4)}</tbody>
      </table>
    </div>
  `;

  try {
    const rows = await getAttendance({ subjectId });
    rows.sort((a, b) => (a.Date < b.Date ? 1 : -1));

    if (!rows.length) {
      historyWrap.innerHTML = emptyState("No records recorded yet", "Save your first roll call above and historical sessions will be listed here.");
      return;
    }

    const studentNameById = Object.fromEntries(roster.map((r) => [String(r.StudentID), r.Name]));

    const body = rows.slice(0, 50).map((r) => {
      const isToday = r.Date === today;
      return `
        <tr>
          <td>
            <strong>${formatDisplayDate(r.Date)}</strong>
            ${isToday ? ' <span style="display:inline-block;padding:0.15rem 0.45rem;font-size:0.75rem;background:var(--primary-light);color:var(--primary);border-radius:999px;font-weight:700;margin-left:0.4rem;">Today</span>' : ""}
          </td>
          <td>
            <span style="font-weight:600;">${studentNameById[String(r.StudentID)] || r.StudentID}</span>
            <span class="student-id-code" style="margin-left:0.4rem;">${r.StudentID}</span>
          </td>
          <td>
            <span class="status-pill ${r.Status === 1 ? "present" : "absent"}">
              ${r.Status === 1 ? "Present" : "Absent"}
            </span>
          </td>
          <td>
            ${isToday ? `
              <button class="btn btn-ghost" data-id="${r.AttendanceID}" style="color:var(--absent);padding:0.3rem 0.6rem;font-size:0.83rem;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                </svg>
                Remove
              </button>
            ` : `
              <span style="color:var(--text-tertiary);font-size:0.82rem;display:inline-flex;align-items:center;gap:0.3rem;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
                </svg>
                Locked
              </span>
            `}
          </td>
        </tr>
      `;
    }).join("");

    historyWrap.innerHTML = `
      <div class="table-responsive-container">
        <table class="ledger">
          <thead><tr><th>Date</th><th>Student</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;

    historyWrap.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirmModal({
          title: "Remove Attendance Entry?",
          body: "Are you sure you want to remove this record for today? This change will immediately update the database.",
          confirmLabel: "Remove record",
          danger: true
        });
        if (!ok) return;
        try {
          await deleteAttendance(btn.dataset.id);
          showToast("Attendance entry removed.", "success");
          await loadRoster();
          await renderHistory();
        } catch (err) {
          showToast(describeError(err), "error");
        }
      });
    });
  } catch (err) {
    historyWrap.innerHTML = emptyState("Couldn't load history", describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Manage: add class / subject / student — optimistic, no refetch-and-wait
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
    nameInput.value = "";
    flashAdded("subject-added-note");
    showToast(`Subject "${result.subjectName}" successfully added.`, "success");

    // Live-update the attendance section's subject list if it's showing the same class.
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
    seatInput.value = "";
    nameInput.value = "";
    emailInput.value = "";
    flashAdded("student-added-note");
    showToast(`Student "${result.name}" enrolled.`, "success");

    // Live-update the roster if it's showing the same class.
    if (classSelect.value === classId && subjectSelect.value) {
      roster.push({ StudentID: result.studentId, Name: result.name, status: 1 });
      renderRoster();
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

function formatDisplayDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}