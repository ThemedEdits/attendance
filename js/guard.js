import { auth } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getBootstrap, ApiError } from "./api.js";

// requiredRole: "student" | "staff"
// Calls onReady(me, boot) once the user is confirmed signed in AND
// authorized for this page. `boot` is the full bootstrap payload
// (classes/subjects/students/teachers) so pages can render immediately
// without firing off several more separate requests. Otherwise redirects
// to the right place.
export function guardPage(requiredRole, onReady) {
  wireMobileMenu();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }

    try {
      const boot = await getBootstrap();
      const me = boot.me;

      if (me.role !== requiredRole) {
        // Signed in, but this isn't their dashboard — send them to the right one.
        window.location.href = me.role === "student" ? "student.html" : "teacher.html";
        return;
      }

      onReady(me, boot);
    } catch (err) {
      if (err instanceof ApiError && err.code === "NOT_REGISTERED") {
        window.location.href = "not-registered.html";
        return;
      }

      if (err instanceof ApiError && (err.code === "AUTH_INVALID" || err.code === "AUTH_REQUIRED")) {
        // Only an explicit authentication failure should end the Firebase session.
        await signOut(auth);
        window.location.href = "index.html";
        return;
      }

      // Keep the Firebase session when Apps Script or the network is unavailable.
      console.error("Unable to load the current user from the API:", err);
    }
  });
}

export function wireSignOut(buttonEl) {
  if (!buttonEl) return;
  buttonEl.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}

function wireMobileMenu() {
  const toggleBtn = document.getElementById("mobile-menu-btn");
  const navMenu = document.getElementById("app-header-nav");
  if (!toggleBtn || !navMenu || toggleBtn.dataset.wired === "true") return;

  toggleBtn.dataset.wired = "true";
  toggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = navMenu.classList.toggle("is-open");
    toggleBtn.classList.toggle("is-active", isOpen);
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
  });

  document.addEventListener("click", (event) => {
    if (!navMenu.contains(event.target) && !toggleBtn.contains(event.target)) {
      navMenu.classList.remove("is-open");
      toggleBtn.classList.remove("is-active");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      navMenu.classList.remove("is-open");
      toggleBtn.classList.remove("is-active");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
  });
}