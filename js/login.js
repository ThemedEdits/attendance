import { auth, googleProvider } from "./firebase-init.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMe, ApiError } from "./api.js";
import { showAlertModal, showToast } from "./ui-feedback.js";

const form = document.getElementById("auth-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const submitBtn = document.getElementById("submit-btn");
const modeToggle = document.getElementById("mode-toggle");
const segmentSignin = document.getElementById("segment-signin");
const segmentSignup = document.getElementById("segment-signup");
const googleBtn = document.getElementById("google-btn");
const forgotLink = document.getElementById("forgot-link");
const errorBox = document.getElementById("error-box");
const heading = document.getElementById("form-heading");
const togglePasswordBtn = document.getElementById("toggle-password-btn");
const eyeIcon = document.getElementById("eye-icon");
const toggleConfirmPasswordBtn = document.getElementById("toggle-confirm-password-btn");
const confirmEyeIcon = document.getElementById("confirm-eye-icon");
const confirmPasswordField = document.getElementById("confirm-password-field");
const confirmPasswordInput = document.getElementById("confirm-password");
const passwordStrength = document.getElementById("password-strength");
const passwordStrengthFill = document.getElementById("password-strength-fill");
const passwordStrengthLabel = document.getElementById("password-strength-label");
const passwordRules = document.getElementById("password-rules");
const forgotRow = document.getElementById("forgot-row");
const signupSecurityNote = document.getElementById("signup-security-note");
const signinOnly = [...document.querySelectorAll(".signin-only")];
const authHelpBtn = document.getElementById("auth-help-btn");

let mode = "signin";
let routing = false;

function openHelpModal() {
  const root = document.getElementById("modal-root");
  if (!root || root.querySelector(".auth-help-backdrop")) return;

  root.innerHTML = `
    <div class="modern-modal-backdrop auth-help-backdrop is-active">
      <section class="modern-modal-dialog auth-help-dialog is-active" role="dialog" aria-modal="true" aria-labelledby="auth-help-title">
        <div class="modern-modal-header auth-help-header">
          <div class="modal-icon-badge is-primary">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M9.75 9a2.25 2.25 0 1 1 3.72 1.7c-.8.66-1.47 1.08-1.47 2.3"></path>
              <path d="M12 16.5h.01"></path>
            </svg>
          </div>
          <div>
            <h2 class="modern-modal-title" id="auth-help-title">How Attendance Register works</h2>
            <p class="auth-help-lead">A complete guide for students, teachers, and class representatives.</p>
          </div>
          <button type="button" class="auth-help-close" id="auth-help-close" aria-label="Close help dialog">×</button>
        </div>

        <div class="auth-help-content">
          <section class="auth-help-section">
            <h3>1. What this system does</h3>
            <p>Attendance Register connects Firebase Authentication, Google Sheets, and this web interface. Students request access to a class, staff approve them, teachers record attendance, and students can view their own attendance history.</p>
          </section>

          <section class="auth-help-section">
            <h3>2. Creating a student account</h3>
            <ol>
              <li>Choose <strong>Create account</strong> on this page.</li>
              <li>Enter an email address you can access.</li>
              <li>Create a password with at least 8 characters, including uppercase, lowercase, a number, and a special character.</li>
              <li>Confirm the password and submit the form.</li>
              <li>You will be taken to student setup. Your password is handled by Firebase and is never saved in Google Sheets.</li>
            </ol>
          </section>

          <section class="auth-help-section">
            <h3>3. Requesting class access</h3>
            <ol>
              <li>Enter your full name and your exact institutional seat number.</li>
              <li>Choose your class from the available list.</li>
              <li>Submit the access request once.</li>
              <li>Your request appears to the teacher or CR responsible for the class.</li>
              <li>While waiting, you can return and check the request status. A pending request cannot be duplicated for the same account.</li>
            </ol>
            <p class="auth-help-note"><strong>Important:</strong> your seat number is your Student ID. It is the unique value used in the Students sheet and attendance registers.</p>
          </section>

          <section class="auth-help-section">
            <h3>4. What staff do</h3>
            <ol>
              <li>Choose Teacher or Class Representative during profile setup and complete the authorization flow.</li>
              <li>Review pending enrollment requests in the teacher dashboard.</li>
              <li>Approve a request to add the student to the Students sheet and relevant subject registers, or reject it with an optional note.</li>
              <li>CRs connect their Google account and class Sheet, then create the class workspace, subjects, and roster.</li>
              <li>Use the class and subject selectors to open the attendance register.</li>
            </ol>
          </section>

          <section class="auth-help-section">
            <h3>5. Marking attendance</h3>
            <ol>
              <li>Select a class, subject, and date.</li>
              <li>Students start as present by default. Search by Student ID or name, then tap a row to change its status.</li>
              <li>Use All Present or All Absent for quick changes.</li>
              <li>Review the present and absent totals, then save.</li>
              <li>Today’s attendance may be updated during the day. A past date can be submitted once and then becomes locked.</li>
            </ol>
          </section>

          <section class="auth-help-section">
            <h3>6. Viewing attendance as a student</h3>
            <p>After approval, sign in with the same account. You will see the subjects in your class, your attendance totals, your attendance rate, and the dates on which you were present or absent. Students cannot edit attendance or view other students’ records.</p>
          </section>

          <section class="auth-help-section">
            <h3>7. How the data is organized</h3>
            <ul>
              <li><strong>Students:</strong> Student ID, name, email, class, and status.</li>
              <li><strong>Teachers:</strong> staff identity and role information.</li>
              <li><strong>Classes:</strong> the classes available for enrollment.</li>
              <li><strong>Subjects:</strong> subjects connected to classes and their register tabs.</li>
              <li><strong>EnrollmentRequests:</strong> pending, approved, or rejected class requests.</li>
              <li><strong>Subject register tabs:</strong> each subject’s students, dates, attendance marks, and totals.</li>
            </ul>
          </section>

          <section class="auth-help-section">
            <h3>8. Security and privacy</h3>
            <p>Firebase verifies the signed-in identity. The Vercel backend verifies the Firebase token again before reading or changing data. Passwords never enter Google Sheets. Students only receive their own attendance data, while class and subject permissions are enforced server-side.</p>
          </section>

          <section class="auth-help-section">
            <h3>9. Common questions</h3>
            <details><summary>Why can’t I see my class?</summary><p>Classes must be created and published by staff. If you already submitted a request, wait for staff approval or ask your teacher to confirm the class exists.</p></details>
            <details><summary>Why is my request still pending?</summary><p>A teacher or CR must review it. Refresh the status from student setup, or contact the staff member responsible for your class.</p></details>
            <details><summary>Why does a staff dashboard look empty?</summary><p>Confirm that your profile is approved, that your class membership is approved, and that the production API environment is configured. Then refresh the page.</p></details>
            <details><summary>What if I entered the wrong seat number?</summary><p>Ask staff to reject the request, then submit a new request with the exact seat number. Seat numbers must be unique.</p></details>
            <details><summary>What if I forgot my password?</summary><p>Use Forgot password on the sign-in form. Firebase will send a reset link to your email.</p></details>
          </section>
        </div>

        <div class="modern-modal-actions auth-help-actions">
          <button type="button" class="btn btn-primary" id="auth-help-done">Close guide</button>
        </div>
      </section>
    </div>
  `;

  const backdrop = root.querySelector(".auth-help-backdrop");
  const close = () => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKeyDown);
    authHelpBtn?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);
  root.querySelector("#auth-help-close").addEventListener("click", close);
  root.querySelector("#auth-help-done").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  root.querySelector("#auth-help-close").focus();
}

authHelpBtn?.addEventListener("click", openHelpModal);

function setError(message) {
  if (!message) {
    errorBox.innerHTML = "";
    errorBox.hidden = true;
    return;
  }
  errorBox.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
    </svg>
    <span>${message}</span>
  `;
  errorBox.hidden = false;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.innerHTML = isLoading
    ? `<span class="modern-spinner" style="width:16px;height:16px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:#fff;"></span> Please wait…`
    : (mode === "signin" ? "Sign in" : "Create account");
}

function setMode(newMode) {
  mode = newMode;
  const signup = mode === "signup";
  heading.textContent = signup ? "Create your account" : "Sign in";
  submitBtn.textContent = signup ? "Create account" : "Sign in";
  modeToggle.textContent = signup ? "Already have an account? Sign in" : "Need an account? Sign up";
  if (segmentSignin) segmentSignin.classList.toggle("is-active", !signup);
  if (segmentSignup) segmentSignup.classList.toggle("is-active", signup);
  if (confirmPasswordField) confirmPasswordField.hidden = !signup;
  if (passwordStrength) passwordStrength.hidden = !signup;
  if (signupSecurityNote) signupSecurityNote.hidden = !signup;
  if (forgotRow) forgotRow.hidden = signup;
  signinOnly.forEach((el) => { el.hidden = signup; });
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  setError(null);
  updatePasswordStrength();
}

modeToggle.addEventListener("click", (e) => {
  e.preventDefault();
  setMode(mode === "signin" ? "signup" : "signin");
});

if (segmentSignin) {
  segmentSignin.addEventListener("click", () => setMode("signin"));
}
if (segmentSignup) {
  segmentSignup.addEventListener("click", () => setMode("signup"));
}

// Show / Hide password
if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    eyeIcon.innerHTML = isPassword ? `
      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    ` : `
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
    `;
  });
}

if (toggleConfirmPasswordBtn) {
  toggleConfirmPasswordBtn.addEventListener("click", () => {
    const isPassword = confirmPasswordInput.type === "password";
    confirmPasswordInput.type = isPassword ? "text" : "password";
    confirmEyeIcon.innerHTML = isPassword ? `
      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    ` : `
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
    `;
  });
}

function getPasswordChecks(password) {
  return {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password)
  };
}

function isStrongPassword(password) {
  const checks = getPasswordChecks(password);
  return Object.values(checks).every(Boolean);
}

function updatePasswordStrength() {
  if (!passwordStrength || mode !== "signup") return;
  const checks = getPasswordChecks(passwordInput.value);
  const score = Object.values(checks).filter(Boolean).length;
  const pct = Math.round((score / 5) * 100);
  passwordStrengthFill.style.width = `${pct}%`;
  passwordStrengthLabel.textContent = score === 5 ? "Strong password" : score >= 3 ? "Getting stronger" : "Use a stronger password";
  passwordStrength.classList.toggle("is-strong", score === 5);
  if (passwordRules) {
    passwordRules.querySelectorAll("[data-rule]").forEach((item) => {
      item.classList.toggle("is-met", !!checks[item.dataset.rule]);
    });
  }
}

passwordInput.addEventListener("input", updatePasswordStrength);
if (confirmPasswordInput) confirmPasswordInput.addEventListener("input", () => {
  if (confirmPasswordInput.value && confirmPasswordInput.value !== passwordInput.value) {
    setError("The passwords do not match.");
  } else if (confirmPasswordInput.value) {
    setError(null);
  }
});

forgotLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim();
  if (!email) {
    setError("Enter your email above first, then click “Forgot password”.");
    emailInput.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    setError(null);
    showAlertModal({
      title: "Password Reset Sent",
      body: `A password reset link has been dispatched to <strong>${email}</strong>. Check your inbox and spam folder.`,
      buttonLabel: "Understood"
    });
  } catch (err) {
    setError(describeAuthError(err));
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError(null);
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!email || !password) {
    setError("Please enter both your email address and password.");
    return;
  }

  if (mode === "signup") {
    if (!isStrongPassword(password)) {
      setError("Choose a strong password that meets all five requirements.");
      updatePasswordStrength();
      return;
    }
    if (confirmPasswordInput.value !== password) {
      setError("The passwords do not match.");
      return;
    }
  }

  setLoading(true);
  try {
    if (mode === "signin") {
      await signInWithEmailAndPassword(auth, email, password);
      await routeAfterLogin();
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
      window.location.href = "student-onboarding.html";
    }
  } catch (err) {
    setError(describeAuthError(err));
    setLoading(false);
  }
});

googleBtn.addEventListener("click", async () => {
  setError(null);
  try {
    await signInWithPopup(auth, googleProvider);
    await routeAfterLogin();
  } catch (err) {
    setError(describeAuthError(err));
  }
});

async function routeAfterLogin() {
  if (routing) return;
  routing = true;
  try {
    const me = await getMe();
    if (me.role === "student") {
      const enrollment = await (await import("./api.js")).getEnrollment();
      window.location.href = enrollment.status === "Approved" ? "student.html" : "student-onboarding.html";
    } else if (me.role === "staff" || me.role === "teacher" || me.role === "cr") {
      window.location.href = "teacher.html";
    } else {
      window.location.href = "student-onboarding.html";
    }
  } catch (err) {
    routing = false;
    if (err instanceof ApiError && err.code === "NOT_REGISTERED") {
      window.location.href = "student-onboarding.html";
      return;
    }
    setError(err.message || "Something went wrong. Please try again.");
    setLoading(false);
  }
}

function describeAuthError(err) {
  const code = err && err.code;
  const map = {
    "auth/invalid-email": "That email address doesn't look valid.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password. Try again or reset it.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account already exists with that email. Try signing in instead.",
    "auth/weak-password": "Choose a stronger password with at least 8 characters, including upper, lower, number, and symbol.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled before finishing."
  };
  return map[code] || (err && err.message) || "Something went wrong. Please try again.";
}

// If already signed in, redirect straight to the right dashboard.
onAuthStateChanged(auth, async (user) => {
  if (!user || mode === "signup") return;
  await routeAfterLogin();
});
