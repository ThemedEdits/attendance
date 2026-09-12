/**
 * Modern UI Feedback System
 * Toasts, Modals, Dialogs, and Skeleton Loaders
 */

// Toast Container Management
function ensureToastContainer() {
  let container = document.getElementById("toast-root");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-root";
    document.body.appendChild(container);
  }
  container.classList.add("toast-container");
  return container;
}

export function showToast(message, type = "info", duration = 3500) {
  const container = ensureToastContainer();

  const toast = document.createElement("div");
  toast.className = `toast-card toast-${type}`;

  const icons = {
    success: `
      <svg class="toast-icon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
      </svg>`,
    error: `
      <svg class="toast-icon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
      </svg>`,
    warning: `
      <svg class="toast-icon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
      </svg>`,
    info: `
      <svg class="toast-icon" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" />
      </svg>`
  };

  toast.innerHTML = `
    <div class="toast-content">
      ${icons[type] || icons.info}
      <span class="toast-msg">${message}</span>
    </div>
    <button type="button" class="toast-close" aria-label="Close notification">&times;</button>
    <div class="toast-progress">
      <div class="toast-progress-bar" style="animation-duration: ${duration}ms;"></div>
    </div>
  `;

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("is-visible"));

  let timeoutId = setTimeout(() => dismiss(), duration);

  function dismiss() {
    clearTimeout(timeoutId);
    toast.classList.remove("is-visible");
    toast.classList.add("is-leaving");
    toast.addEventListener("transitionend", () => {
      toast.remove();
    }, { once: true });
  }

  toast.querySelector(".toast-close").addEventListener("click", dismiss);
}

// Modal System
function ensureModalRoot() {
  let root = document.getElementById("modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "modal-root";
    document.body.appendChild(root);
  }
  return root;
}

export function showConfirmModal({
  title,
  body,
  summary,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false
}) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();

    const summaryHtml = summary ? `
      <div class="modal-summary-grid">
        <div class="summary-card summary-present">
          <div class="summary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/>
            </svg>
          </div>
          <div class="summary-meta">
            <span class="summary-num">${summary.present}</span>
            <span class="summary-lbl">Present</span>
          </div>
        </div>
        <div class="summary-card summary-absent">
          <div class="summary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </div>
          <div class="summary-meta">
            <span class="summary-num">${summary.absent}</span>
            <span class="summary-lbl">Absent</span>
          </div>
        </div>
      </div>
    ` : "";

    root.innerHTML = `
      <div class="modern-modal-backdrop">
        <div class="modern-modal-dialog" role="dialog" aria-modal="true">
          <div class="modern-modal-header">
            <div class="modal-icon-badge ${danger ? "is-danger" : "is-primary"}">
              ${danger ? `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                </svg>
              ` : `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              `}
            </div>
            <h3 class="modern-modal-title">${title}</h3>
          </div>
          <div class="modern-modal-body">
            <p>${body}</p>
            ${summaryHtml}
          </div>
          <div class="modern-modal-actions">
            <button type="button" class="btn btn-secondary" id="modal-btn-cancel">${cancelLabel}</button>
            <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" id="modal-btn-confirm">${confirmLabel}</button>
          </div>
        </div>
      </div>
    `;

    const backdrop = root.querySelector(".modern-modal-backdrop");
    const dialog = root.querySelector(".modern-modal-dialog");

    // Animate in
    requestAnimationFrame(() => {
      backdrop.classList.add("is-active");
      dialog.classList.add("is-active");
    });

    function finish(result) {
      backdrop.classList.remove("is-active");
      dialog.classList.remove("is-active");
      document.removeEventListener("keydown", onKeyDown);
      setTimeout(() => {
        root.innerHTML = "";
        resolve(result);
      }, 200);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") finish(false);
    }

    document.addEventListener("keydown", onKeyDown);

    root.querySelector("#modal-btn-cancel").addEventListener("click", () => finish(false));
    root.querySelector("#modal-btn-confirm").addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });
  });
}

export function showAlertModal({ title, body, buttonLabel = "Got it" }) {
  return showConfirmModal({
    title,
    body,
    confirmLabel: buttonLabel,
    cancelLabel: "",
    danger: false
  });
}

// Skeleton helpers
export function getSkeletonTableRows(rowCount = 5, colCount = 4) {
  let html = "";
  for (let r = 0; r < rowCount; r++) {
    html += `<tr class="skeleton-row">`;
    for (let c = 0; c < colCount; c++) {
      const width = c === 0 ? "35%" : c === 1 ? "50%" : "25%";
      html += `<td><div class="skeleton-shimmer" style="width:${width};"></div></td>`;
    }
    html += `</tr>`;
  }
  return html;
}
