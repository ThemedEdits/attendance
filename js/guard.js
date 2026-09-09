import { auth } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMe, ApiError } from "./api.js";

// requiredRole: "student" | "staff"
// Calls onReady(me) once the user is confirmed signed in AND authorized
// for this page. Otherwise redirects to the right place.
export function guardPage(requiredRole, onReady) {
  wireMobileMenu();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }

    try {
      const me = await getMe();

      if (me.role !== requiredRole) {
        // Signed in, but this isn't their dashboard — send them to the right one.
        window.location.href = me.role === "student" ? "student.html" : "teacher.html";
        return;
      }

      onReady(me);
    } catch (err) {
      if (err instanceof ApiError && err.code === "NOT_REGISTERED") {
        window.location.href = "not-registered.html";
        return;
      }

      if (err instanceof ApiError && (err.code === "AUTH_INVALID" || err.code === "AUTH_REQUIRED")) {
        // Only an explicit auth failure should end the Firebase session.
        await signOut(auth);
        window.location.href = "index.html";
        return;
      }

      // Keep the Firebase session when the API itself is unavailable.
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

// Mobile header hamburger menu handler
export function wireMobileMenu() {
  const toggleBtn = document.getElementById("mobile-menu-btn");
  const navMenu = document.getElementById("app-header-nav");
  if (!toggleBtn || !navMenu) return;

  // Avoid duplicate listeners
  if (toggleBtn.dataset.wired === "true") return;
  toggleBtn.dataset.wired = "true";

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = navMenu.classList.toggle("is-open");
    toggleBtn.classList.toggle("is-active", isOpen);
    toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  document.addEventListener("click", (e) => {
    if (!navMenu.contains(e.target) && !toggleBtn.contains(e.target)) {
      navMenu.classList.remove("is-open");
      toggleBtn.classList.remove("is-active");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navMenu.classList.contains("is-open")) {
      navMenu.classList.remove("is-open");
      toggleBtn.classList.remove("is-active");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
  });
}
