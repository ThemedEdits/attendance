// Firebase initialization - uses the CDN ES-module build so this whole app
// can be deployed to Vercel as plain static files (no bundler needed).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBDBeX8TJnUoyG2l-23bMko6q8pMgiC40E",
  authDomain: "attendance-sheet-app-9c629.firebaseapp.com",
  projectId: "attendance-sheet-app-9c629",
  storageBucket: "attendance-sheet-app-9c629.firebasestorage.app",
  messagingSenderId: "615875865248",
  appId: "1:615875865248:web:117e9f3d0644c721df77c5"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
