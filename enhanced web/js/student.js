import { guardPage, wireSignOut } from "./guard.js";
import { getSubjects, getAttendance } from "./api.js";
import { initCustomSelect } from "./custom-select.js";
import { getSkeletonTableRows } from "./ui-feedback.js";

wireSignOut(document.getElementById("signout-btn"));

const subjectFilter = document.getElementById("subject-filter");
const csSubjectFilter = initCustomSelect(subjectFilter);

let subjectsById = {};
let allRows = [];

guardPage("student", async (me) => {
  const displayName = me.name ? me.name : me.email;
  document.getElementById("user-name").textContent = displayName;

  // Set avatar initials
  const initials = me.name
    ? me.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()
    : me.email[0].toUpperCase();
  const avatarEl = document.getElementById("user-avatar");
  if (avatarEl) avatarEl.textContent = initials;

  const subjects = await getSubjects();
  subjectsById = Object.fromEntries(subjects.map((s) => [String(s.SubjectID), s.SubjectName]));

  subjects.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.SubjectID;
    opt.textContent = s.SubjectName;
    subjectFilter.appendChild(opt);
  });
  csSubjectFilter?.sync();

  subjectFilter.addEventListener("change", render);

  // Show skeleton loading while loading attendance
  document.getElementById("table-wrap").innerHTML = `
    <div class="table-responsive-container">
      <table class="ledger">
        <thead><tr><th>Date</th><th>Subject</th><th>Status</th></tr></thead>
        <tbody>${getSkeletonTableRows(5, 3)}</tbody>
      </table>
    </div>
  `;

  allRows = await getAttendance();
  allRows.sort((a, b) => (a.Date < b.Date ? 1 : -1)); // newest first
  render();
});

function render() {
  const subjectId = subjectFilter.value;
  const rows = subjectId ? allRows.filter((r) => String(r.SubjectID) === subjectId) : allRows;

  renderStats(rows);
  renderTable(rows);
}

function renderStats(rows) {
  const total = rows.length;
  const present = rows.filter((r) => r.Status === 1).length;
  const absent = total - present;
  const pct = total ? Math.round((present / total) * 100) : 0;

  // Visual color for rate
  const rateClass = pct >= 75 ? "present" : pct >= 60 ? "warning" : "absent";

  document.getElementById("stat-row").innerHTML = `
    <div class="stat-card">
      <div class="stat-card-top">
        <span class="stat-label">Total Sessions</span>
        <div class="stat-icon-wrap">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/>
          </svg>
        </div>
      </div>
      <div class="stat-value">${total}</div>
    </div>

    <div class="stat-card present">
      <div class="stat-card-top">
        <span class="stat-label">Attended</span>
        <div class="stat-icon-wrap">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/>
          </svg>
        </div>
      </div>
      <div class="stat-value">${present}</div>
    </div>

    <div class="stat-card absent">
      <div class="stat-card-top">
        <span class="stat-label">Missed</span>
        <div class="stat-icon-wrap">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </div>
      </div>
      <div class="stat-value">${absent}</div>
    </div>

    <div class="stat-card rate">
      <div class="stat-card-top">
        <span class="stat-label">Attendance Rate</span>
        <div class="stat-icon-wrap">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"/>
          </svg>
        </div>
      </div>
      <div class="stat-value" style="color:var(--primary);">${pct}%</div>
    </div>
  `;
}

function renderTable(rows) {
  const wrap = document.getElementById("table-wrap");

  if (!rows.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        </div>
        <h3>No Attendance Recorded Yet</h3>
        <p>Once your instructor or CR marks roll for this course, your records will appear here.</p>
      </div>`;
    return;
  }

  const body = rows.map((r) => `
    <tr>
      <td><strong>${formatDisplayDate(r.Date)}</strong></td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:0.4rem;font-weight:600;">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--primary);"></span>
          ${subjectsById[String(r.SubjectID)] || r.SubjectID}
        </span>
      </td>
      <td>
        <span class="status-pill ${r.Status === 1 ? "present" : "absent"}">
          ${r.Status === 1 ? "Present" : "Absent"}
        </span>
      </td>
    </tr>
  `).join("");

  wrap.innerHTML = `
    <div class="table-responsive-container">
      <table class="ledger">
        <thead>
          <tr><th>Date</th><th>Subject</th><th>Status</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function formatDisplayDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
