import { auth } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
onAuthStateChanged(auth,user=>{if(!user){location.href="index.html";return;}document.getElementById("user-email-text").textContent=user.email||"";});
document.getElementById("signout-btn").addEventListener("click",async()=>{await signOut(auth);location.href="index.html";});
