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
      // Session invalid/expired — sign out and send back to login.
      await signOut(auth);
      window.location.href = "index.html";
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