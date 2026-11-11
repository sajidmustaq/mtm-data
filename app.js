"use strict";

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  browserLocalPersistence, browserSessionPersistence, createUserWithEmailAndPassword,
  EmailAuthProvider, indexedDBLocalPersistence, initializeAuth, inMemoryPersistence,
  onAuthStateChanged, reauthenticateWithCredential, signInWithEmailAndPassword,
  signOut, updatePassword
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  addDoc, arrayRemove, arrayUnion, collection, deleteDoc, doc, getCountFromServer,
  getDocFromCache, getDocFromServer, getDocs, getDocsFromCache, getDocsFromServer,
  getFirestore, initializeFirestore, limit, onSnapshot, orderBy, persistentLocalCache,
  persistentMultipleTabManager, query, serverTimestamp, setDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDfu50nkc3YrIw80QEwQP2Sqlx2Dpb1Wpk",
  authDomain: "student-portal-5dd94.firebaseapp.com",
  projectId: "student-portal-5dd94",
  storageBucket: "student-portal-5dd94.firebasestorage.app",
  messagingSenderId: "676699117940",
  appId: "1:676699117940:web:790a46517353937f03b421"
};
const EMAIL_DOMAIN = "student-portal-5dd94.firebaseapp.com";
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
});
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch {
  db = getFirestore(app);
}
let creatorAuth = null;
function getCreatorAuth() {
  if (!creatorAuth) {
    const creatorApp = initializeApp(firebaseConfig, "userCreator");
    creatorAuth = initializeAuth(creatorApp, { persistence: inMemoryPersistence });
  }
  return creatorAuth;
}
const YES = "جی ہاں", NO = "جی نہیں", PAGE_SIZE = 50, IDLE_MS = 15 * 60 * 1000;
const RECORD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const nfc = v => String(v ?? "").normalize("NFC");
const K = {
  code: "عملہ کوڈ", name: "نام", father: "ولدیت", branch: "شاخ", duty: "ذمہ داری",
  district: "ڈسٹرکٹ", division: "سرکاری ڈویژن", province: "صوبائی/انتظامی اکائی",
  offMin: "آفیشل منٹ", grade: "گریڈ", ijaraMin: "اجارے کے منٹ",
  hifz: "کیا یہ مدرس حقیتا حفظ کا درجہ بڑھا رہے ہیں",
  nazra: "کیا یہ حقیقتا ناظرہ کا درجہ  پڑھا رہےہیں"
};
const COLS = Object.values(K);
const EXTRA_COLS = ["آخری تبدیلی از", "آخری تبدیلی کا وقت"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const nowStr = () => new Date().toLocaleString("en-GB", { hour12: false });
const userEmail = username => `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
const pwProblem = (pw, username) => {
  if (pw.length < 8) return "پاس ورڈ کم از کم 8 حروف کا ہو";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "پاس ورڈ میں حروف اور ہندسے دونوں ہوں";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "پاس ورڈ میں یوزر نیم شامل نہ ہو";
  if (/^(admin|password|12345678)/i.test(pw)) return "یہ پاس ورڈ بہت آسان ہے";
  return "";
};
const nameProblem = n => /^[A-Za-z0-9_.-]{3,30}$/.test(n) ? "" : "یوزر نیم 3 سے 30 حروف: انگریزی حروف، ہندسے، _ . -";
const recordId = r => encodeURIComponent(`${r[K.code]}|${r[K.province]}`);
const isDone = r => !!r?.[K.hifz] && !!r?.[K.nazra];
const clean = v => nfc(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

let me = null, DATA = [], USERS = [], ENTRIES = [], LOG = [], usersLoaded = false, entriesLoaded = false;
let page = 1, editingId = null, unsubscribers = [], lastActive = Date.now(), loggingOut = false;
let provinces = [], RECORD_DOCS = new Map(), DRAFT_ENTRIES = new Map(), recordsLoading = false, pendingScopeSelection = null;
let loaderCount = 0;

function showLoader(text = "براہِ کرم انتظار کریں...") {
  loaderCount++;
  if ($("loaderText")) $("loaderText").textContent = text;
  $("globalLoader")?.classList.remove("hidden");
}

function hideLoader() {
  loaderCount = Math.max(0, loaderCount - 1);
  if (!loaderCount) $("globalLoader")?.classList.add("hidden");
}

async function withLoader(text, fn) {
  showLoader(text);
  try {
    return await fn();
  } finally {
    hideLoader();
  }
}

function setButtonBusy(btn, busy, busyText = "") {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span><span>${esc(busyText || btn.textContent)}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml !== undefined) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}


function showError(message) {
  $("loginErr").textContent = message;
}

function reportError(message, error) {
  console.error(message, error);
  alert(`${message}: ${error?.message || error}`);
}

function assignmentsForUser(user) {
  return Array.isArray(user.assignments) ? user.assignments : [];
}

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return normalized === "admin" || normalized === "user" ? normalized : "";
}

function hasRegion(user, row) {
  if (user.role === "admin") return true;
  const prov = nfc(row[K.province]);
  const div = nfc(row[K.division]);
  return assignmentsForUser(user).some(a => nfc(a.province) === prov &&
    (!Array.isArray(a.divisions) || !a.divisions.length || a.divisions.some(d => nfc(d) === div)));
}

function visibleRows() {
  if (!me) return [];
  if (me.role === "admin") {
    const selectedUid = $("entryUser")?.value || "";
    if (selectedUid && selectedUid !== me.id) {
      return DATA.filter(row => row.assignedTo?.includes(selectedUid));
    }
    return DATA;
  }
  return DATA.filter(row => row.assignedTo?.includes(me.id) && hasRegion(me, row));
}

function entryOwnerId() {
  return me?.role === "admin" ? ($("entryUser")?.value || "") : (me?.id || "");
}

function entryFor(record, ownerId = entryOwnerId()) {
  if (ownerId) {
    return ENTRIES.find(entry => entry.recordId === record.id && entry.userId === ownerId);
  }
  const matches = ENTRIES.filter(entry => entry.recordId === record.id);
  return matches.find(e => e.submitted || isDone(e)) || matches[0];
}

function saveLog(action, detail = "") {
  if (!me?.id || !me?.username || !action) {
    return Promise.reject(new Error("لاگ اِن پروفائل میں یوزر آئی ڈی موجود نہیں؛ Firebase users document درست کریں۔"));
  }
  return addDoc(collection(db, "logs"), {
    uid: me.id, username: me.username, action, detail, createdAt: serverTimestamp(), time: nowStr()
  });
}

function stopListeners() {
  unsubscribers.forEach(unsubscribe => unsubscribe());
  unsubscribers = [];
}

function syncStorageKey(userId) {
  return `mtm_rec_sync_${firebaseConfig.projectId}_${userId}`;
}

function rowFromDocData(id, raw) {
  const rawData = raw?.data || {};
  const byNfcKey = {};
  for (const [key, val] of Object.entries(rawData)) {
    byNfcKey[nfc(key).trim()] = nfc(val);
  }
  const normalized = {};
  COLS.forEach(col => {
    if (byNfcKey[nfc(col)] !== undefined) normalized[col] = byNfcKey[nfc(col)];
  });
  return { id, ...rawData, ...normalized, assignedTo: raw?.assignedTo || [] };
}

function applyRecordDocs() {
  DATA = [...RECORD_DOCS.values()].map(raw => rowFromDocData(raw.id, raw));
  provinces = [...new Set(DATA.map(r => r[K.province]).filter(Boolean))].sort();
  fillProvinceSelects();
  fillUserProvinceFilter();
  fillScopeChecks();
  refreshAll();
}

async function loadRecords(user, forceServer = false) {
  if (!user) return;
  recordsLoading = true;
  try {
    const recordQuery = user.role === "admin"
      ? collection(db, "records")
      : query(collection(db, "records"), where("assignedTo", "array-contains", user.id));
    const key = syncStorageKey(user.id);
    const lastSyncMs = Number(localStorage.getItem(key) || 0);

    if (!forceServer && lastSyncMs > 0) {
      try {
        const cachedSnap = await getDocsFromCache(recordQuery);
        if (!me || me.id !== user.id) return;
        if (!cachedSnap.empty) {
          RECORD_DOCS = new Map(cachedSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
          recordsLoading = false;
          applyRecordDocs();

          const countSnap = await getCountFromServer(recordQuery);
          if (!me || me.id !== user.id) return;
          const serverCount = countSnap.data().count;
          if (serverCount === cachedSnap.size) {
            if (user.role === "admin") {
              const deltaSnap = await getDocsFromServer(
                query(collection(db, "records"), where("updatedAtMs", ">", lastSyncMs))
              );
              if (!me || me.id !== user.id) return;
              if (!deltaSnap.empty) {
                deltaSnap.docs.forEach(d => RECORD_DOCS.set(d.id, { id: d.id, ...d.data() }));
                applyRecordDocs();
              }
              localStorage.setItem(key, String(Math.max(0, Date.now() - 10000)));
              return;
            }
            if (Date.now() - lastSyncMs < RECORD_CACHE_TTL_MS) {
              return;
            }
          }
        }
      } catch (cacheErr) {
        console.warn("Cache read skipped, falling back to server:", cacheErr);
      }
    }

    const serverSnap = await withLoader("ریکارڈز لوڈ ہو رہے ہیں...", () => getDocsFromServer(recordQuery));
    if (!me || me.id !== user.id) return;
    RECORD_DOCS = new Map(serverSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    localStorage.setItem(key, String(Math.max(0, Date.now() - 10000)));
    recordsLoading = false;
    applyRecordDocs();
  } finally {
    recordsLoading = false;
  }
}

function showApp(user) {
  me = user;
  lastActive = Date.now();
  loggingOut = false;
  setButtonBusy($("lBtn"), false);
  $("bootView")?.classList.add("hidden");
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  const assignments = assignmentsForUser(user);
  const scope = user.role === "admin" ? "ایڈمن" :
    assignments.map(a => `${a.province}${a.divisions?.length ? ` (${a.divisions.join("، ")})` : ""}`).join("، ");
  $("whoLabel").textContent = `${user.username} (${scope || "کوئی علاقہ اسائن نہیں"})`;
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", user.role !== "admin"));
  if (user.role === "admin") {
    unsubscribers.push(onSnapshot(collection(db, "users"), snap => {
      USERS = snap.docs.map(d => {
        const profile = d.data();
        return {
          id: d.id, ...profile,
          role: normalizeRole(profile.role),
          username: profile.username || (d.id === me.id ? me.username : profile.usernameKey || "")
        };
      });
      usersLoaded = true;
      fillEntryUsers();
      fillReportUsers();
      fillUserProvinceFilter();
      refreshAll();
      if (!$("tab-users").classList.contains("hidden")) renderUsers();
      fillScopeChecks();
    }, err => reportError("یوزرز لوڈ نہیں ہو سکے", err)));
    unsubscribers.push(onSnapshot(query(collection(db, "logs"), orderBy("createdAt", "desc"), limit(300)), snap => {
      LOG = snap.docs.map(d => d.data());
      if (!$("tab-log").classList.contains("hidden")) renderLog();
    }, err => reportError("سرگرمی لاگ لوڈ نہیں ہو سکا", err)));
  } else {
    USERS = [user];
    usersLoaded = true;
  }
  loadRecords(user).catch(err => reportError("ڈیٹا لوڈ نہیں ہو سکا", err));
  const entryQuery = user.role === "admin"
    ? collection(db, "entries")
    : query(collection(db, "entries"), where("userId", "==", user.id));
  unsubscribers.push(onSnapshot(entryQuery, snap => {
    ENTRIES = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    entriesLoaded = true;
    refreshAll();
  }, err => reportError("انٹریاں لوڈ نہیں ہو سکیں", err)));
  if (user.role === "admin") fillEntryUsers();
  fillProvinceSelects();
  refreshAll();
}

function resetLoginPassword() {
  $("showPass").checked = false;
  $("lPass").type = "password";
}

function resetAllFilters() {
  ["fSearch", "fStatus", "uSearch", "uFilterRole", "uFilterProvince", "uFilterStatus"].forEach(id => {
    if ($(id)) $(id).value = "";
  });
  Object.values(multiFilters).forEach(mf => mf.clear(true));
  page = 1;
}

function returnToLogin(message = "") {
  stopListeners();
  me = null; DATA = []; USERS = []; ENTRIES = []; LOG = [];
  usersLoaded = false; entriesLoaded = false; loggingOut = false; recordsLoading = false; pendingScopeSelection = null;
  RECORD_DOCS.clear();
  DRAFT_ENTRIES.clear();
  resetAllFilters();
  setButtonBusy($("lBtn"), false);
  $("bootView")?.classList.add("hidden");
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  resetLoginPassword();
  showError(message);
}

async function fetchUserProfile(uid) {
  const userRef = doc(db, "users", uid);
  try {
    return await getDocFromServer(userRef);
  } catch (error) {
    if (error?.code === "unavailable" || /offline|network/i.test(String(error?.message || ""))) {
      const cached = await getDocFromCache(userRef);
      if (cached.exists()) return cached;
    }
    throw error;
  }
}


onAuthStateChanged(auth, async account => {
  if (!account) {
    returnToLogin();
    return;
  }
  const showOverlay = $("bootView")?.classList.contains("hidden");
  if (showOverlay) showLoader("لاگ اِن کی تصدیق ہو رہی ہے...");
  try {
    const snapshot = await fetchUserProfile(account.uid);
    if (!snapshot.exists() || !snapshot.data().active) {
      await signOut(auth);
      returnToLogin("یہ اکاؤنٹ غیر فعال ہے یا ایڈمن نے ابھی بنایا نہیں۔");
      return;
    }
    const profile = snapshot.data();
    const role = normalizeRole(profile.role);
    if (!role) {
      throw new Error(`Firestore میں users/${account.uid} کے role کی ویلیو "${profile.role ?? "خالی"}" ہے۔ اسے lowercase string "admin" یا "user" کریں۔`);
    }
    const username = typeof profile.username === "string" && profile.username.trim()
      ? profile.username.trim()
      : account.email?.endsWith(`@${EMAIL_DOMAIN}`)
        ? account.email.slice(0, account.email.indexOf("@"))
        : "";
    if (!username) throw new Error("یوزر پروفائل میں username موجود نہیں، اور Authentication اکاؤنٹ میں قابلِ شناخت یوزر آئی ڈی نہیں۔");
    showApp({ id: account.uid, ...profile, username, role });
    saveLog("لاگ اِن").catch(error => reportError("لاگ اِن لاگ محفوظ نہیں ہوا", error));
  } catch (error) {
    await signOut(auth);
    returnToLogin(`اکاؤنٹ کی معلومات نہیں مل سکیں: ${error.message}`);
  } finally {
    if (showOverlay) hideLoader();
  }
}, error => {
  setButtonBusy($("lBtn"), false);
  $("bootView")?.classList.add("hidden");
  $("loginView").classList.remove("hidden");
  showError(`Firebase لاگ اِن تیار نہیں: ${error.message}`);
});

$("showPass").addEventListener("change", () => {
  $("lPass").type = $("showPass").checked ? "text" : "password";
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("lUser").value.trim();
  const password = $("lPass").value;
  const problem = nameProblem(username);
  if (problem) { showError(problem); return; }
  setButtonBusy($("lBtn"), true, "لاگ اِن ہو رہا ہے...");
  showError("");
  try {
    await auth.authStateReady();
    await signInWithEmailAndPassword(auth, userEmail(username), password);
    $("lPass").value = "";
    resetLoginPassword();
  } catch (error) {
    setButtonBusy($("lBtn"), false);
    showError(error.code === "auth/too-many-requests"
      ? "بہت سی ناکام کوششیں؛ کچھ دیر بعد دوبارہ کوشش کریں۔"
      : "یوزر آئی ڈی یا پاس ورڈ درست نہیں۔");
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await withLoader("لاگ آؤٹ ہو رہا ہے...", async () => {
      await saveLog("لاگ آؤٹ");
      await signOut(auth);
    });
  } catch (error) {
    reportError("لاگ آؤٹ مکمل نہیں ہو سکا", error);
  }
});

["click", "keydown", "change", "scroll"].forEach(name =>
  document.addEventListener(name, () => { lastActive = Date.now(); }, { passive: true }));

setInterval(async () => {
  if (!me || loggingOut || Date.now() - lastActive <= IDLE_MS) return;
  loggingOut = true;
  try { await saveLog("خودکار لاگ آؤٹ (خاموشی)"); }
  catch (error) { console.error("Could not save automatic logout log", error); }
  try {
    await signOut(auth);
    alert("خاموشی کی وجہ سے آپ کو لاگ آؤٹ کر دیا گیا ہے۔");
  } catch (error) {
    loggingOut = false;
    reportError("خودکار لاگ آؤٹ مکمل نہیں ہو سکا", error);
  }
}, 15000);

function createMultiFilter(containerId, allLabel, pluralLabel, onChange) {
  const wrap = $(containerId);
  wrap.innerHTML = `<button type="button" class="ms-btn"><span class="ms-text">${esc(allLabel)}</span><span class="ms-caret">▾</span></button>
    <div class="ms-menu hidden">
      <div class="ms-top"><input type="text" class="ms-search" placeholder="تلاش..."><button type="button" class="ms-clear">صاف</button></div>
      <div class="ms-list"></div>
    </div>`;
  const btn = wrap.querySelector(".ms-btn");
  const textEl = wrap.querySelector(".ms-text");
  const menu = wrap.querySelector(".ms-menu");
  const searchEl = wrap.querySelector(".ms-search");
  const clearBtn = wrap.querySelector(".ms-clear");
  const listEl = wrap.querySelector(".ms-list");
  const selected = new Set();
  let options = [];

  function updateLabel() {
    if (!selected.size) {
      textEl.textContent = allLabel;
      btn.classList.remove("active");
    } else if (selected.size === 1) {
      textEl.textContent = [...selected][0];
      btn.classList.add("active");
    } else {
      textEl.textContent = `${selected.size} ${pluralLabel}`;
      btn.classList.add("active");
    }
    btn.title = selected.size ? [...selected].join("، ") : allLabel;
  }

  function applySearch() {
    const q = searchEl.value.trim().toLowerCase();
    listEl.querySelectorAll(".ms-opt").forEach(opt => {
      opt.classList.toggle("hidden", !!(q && !opt.dataset.val.toLowerCase().includes(q)));
    });
  }

  function renderList() {
    listEl.innerHTML = options.length
      ? options.map(val => `<label class="ms-opt" data-val="${esc(val)}"><input type="checkbox" value="${esc(val)}" ${selected.has(val) ? "checked" : ""}><span>${esc(val)}</span></label>`).join("")
      : '<div class="ms-empty">کوئی آپشن نہیں</div>';
    applySearch();
  }

  btn.addEventListener("click", event => {
    event.stopPropagation();
    const wasHidden = menu.classList.contains("hidden");
    document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden"));
    if (wasHidden) {
      menu.classList.remove("hidden");
      menu.style.right = "0";
      menu.style.left = "auto";
      if (menu.getBoundingClientRect().left < 8) {
        menu.style.right = "auto";
        menu.style.left = "0";
      }
      if (options.length > 8) searchEl.focus();
    }
  });

  menu.addEventListener("click", event => event.stopPropagation());
  searchEl.addEventListener("input", applySearch);
  listEl.addEventListener("change", event => {
    const cb = event.target;
    if (cb.type !== "checkbox") return;
    if (cb.checked) selected.add(cb.value);
    else selected.delete(cb.value);
    updateLabel();
    onChange();
  });
  clearBtn.addEventListener("click", () => {
    if (!selected.size && !searchEl.value) return;
    selected.clear();
    searchEl.value = "";
    renderList();
    updateLabel();
    onChange();
  });

  return {
    setOptions(values) {
      options = values;
      const valid = new Set(values);
      for (const item of [...selected]) {
        if (!valid.has(item)) selected.delete(item);
      }
      renderList();
      updateLabel();
    },
    getSelected() { return selected; },
    clear(silent = false) {
      selected.clear();
      searchEl.value = "";
      renderList();
      updateLabel();
      if (!silent) onChange();
    }
  };
}

document.addEventListener("click", () => document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden")));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden"));
});

const multiFilters = {
  province: createMultiFilter("fProvince", "تمام صوبے", "صوبے", () => { page = 1; fillFilters(); renderTable(); }),
  division: createMultiFilter("fDivision", "تمام ڈویژنز", "ڈویژنز", () => { page = 1; fillFilters(); renderTable(); }),
  district: createMultiFilter("fDistrict", "تمام اضلاع", "اضلاع", () => { page = 1; fillFilters(); renderTable(); }),
  branch:   createMultiFilter("fBranch",   "تمام شاخیں", "شاخیں", () => { page = 1; fillFilters(); renderTable(); }),
  duty:     createMultiFilter("fDuty",     "تمام ذمہ داریاں", "ذمہ داریاں", () => { page = 1; renderTable(); })
};

function fillProvinceSelects() {
  if (!me) return;
  const provList = me.role === "admin"
    ? provinces
    : [...new Set(visibleRows().map(r => r[K.province]).filter(Boolean))].sort();
  multiFilters.province.setOptions(provList);
  $("fProvince").classList.toggle("hidden", me.role !== "admin" && provList.length <= 1);
}

function fillFilter(select, label, values) {
  const current = select.value;
  select.innerHTML = `<option value="">${label}</option>` +
    values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  if (values.includes(current)) select.value = current;
}

function fillFilters() {
  let rows = visibleRows();
  const selProvs = $("fProvince").classList.contains("hidden") ? new Set() : multiFilters.province.getSelected();
  if (selProvs.size) rows = rows.filter(r => selProvs.has(r[K.province]));
  const unique = field => [...new Set(rows.map(r => r[field]).filter(Boolean))].sort();

  multiFilters.division.setOptions(unique(K.division));
  const selDivs = multiFilters.division.getSelected();
  if (selDivs.size) rows = rows.filter(r => selDivs.has(r[K.division]));

  multiFilters.district.setOptions(unique(K.district));
  const selDists = multiFilters.district.getSelected();
  if (selDists.size) rows = rows.filter(r => selDists.has(r[K.district]));

  multiFilters.branch.setOptions(unique(K.branch));
  const selBranches = multiFilters.branch.getSelected();
  if (selBranches.size) rows = rows.filter(r => selBranches.has(r[K.branch]));

  multiFilters.duty.setOptions(unique(K.duty));
}

function filteredRows() {
  const search = $("fSearch").value.trim().toLowerCase();
  const selProvs = $("fProvince").classList.contains("hidden") ? new Set() : multiFilters.province.getSelected();
  const selDivs = multiFilters.division.getSelected();
  const selDists = multiFilters.district.getSelected();
  const selBranches = multiFilters.branch.getSelected();
  const selDuties = multiFilters.duty.getSelected();
  const status = $("fStatus").value;
  return visibleRows().filter(row => {
    if (selProvs.size && !selProvs.has(row[K.province])) return false;
    if (selDivs.size && !selDivs.has(row[K.division])) return false;
    if (selDists.size && !selDists.has(row[K.district])) return false;
    if (selBranches.size && !selBranches.has(row[K.branch])) return false;
    if (selDuties.size && !selDuties.has(row[K.duty])) return false;
    const entry = entryFor(row);
    if (status === "done" && !isDone(entry)) return false;
    if (status === "pending" && isDone(entry)) return false;
    if (search && ![row[K.name], row[K.code], row[K.father], row[K.branch], row[K.duty]]
      .some(v => String(v || "").toLowerCase().includes(search))) return false;
    return true;
  });
}

const opts = value => `<option value="">-- منتخب کریں --</option>` +
  `<option value="${YES}" ${value === YES ? "selected" : ""}>${YES}</option>` +
  `<option value="${NO}" ${value === NO ? "selected" : ""}>${NO}</option>`;

function isEntryLocked(entry) {
  return !!(entry && (entry.submitted === true || (entry[K.hifz] && entry[K.nazra])));
}

function showConfirmModal({ icon = "⚠️", title = "تصدیقِ اندراج", message = "", detailsHtml = "", okText = "ہاں، جمع کریں", cancelText = "منسوخ کریں", showCancel = true }) {
  return new Promise(resolve => {
    const dlg = $("confirmDlg");
    $("confirmIcon").textContent = icon;
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = message;
    if (detailsHtml) {
      $("confirmDetails").innerHTML = detailsHtml;
      $("confirmDetails").classList.remove("hidden");
    } else {
      $("confirmDetails").innerHTML = "";
      $("confirmDetails").classList.add("hidden");
    }
    $("confirmOkBtn").textContent = okText;
    $("confirmCancelBtn").textContent = cancelText;
    $("confirmCancelBtn").classList.toggle("hidden", !showCancel);

    const cleanup = result => {
      $("confirmOkBtn").onclick = null;
      $("confirmCancelBtn").onclick = null;
      dlg.oncancel = null;
      if (dlg.open) dlg.close();
      resolve(result);
    };
    $("confirmOkBtn").onclick = () => cleanup(true);
    $("confirmCancelBtn").onclick = () => cleanup(false);
    dlg.oncancel = event => { event.preventDefault(); cleanup(false); };
    dlg.showModal();
  });
}

function renderTable() {
  if (!me) return;
  const rows = filteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ownerId = entryOwnerId();
  const isAdmin = me.role === "admin";
  $("dataTable").querySelector("tbody").innerHTML = slice.map((row, i) => {
    const saved = entryFor(row, ownerId) || {};
    const locked = isEntryLocked(saved);
    const editable = isAdmin || !locked;
    const entry = editable && DRAFT_ENTRIES.has(row.id) ? DRAFT_ENTRIES.get(row.id) : saved;
    const ownerUser = saved.userId ? USERS.find(u => u.id === saved.userId) : null;
    const ownerBadge = ownerUser ? ownerUser.username : (saved.updatedBy || "");
    let actionCell;
    if (locked && !isAdmin) {
      actionCell = '<span class="tag submitted-tag">✓ جمع شدہ</span>';
    } else if (locked && isAdmin) {
      const label = ownerBadge ? `✓ ${esc(ownerBadge)}` : "✓ جمع شدہ";
      actionCell = `<span class="tag submitted-tag">${label}</span> <button type="button" class="btn-light row-submit-btn" data-act="submit-row" data-id="${esc(row.id)}">اپڈیٹ</button>`;
    } else {
      actionCell = `<button type="button" class="btn row-submit-btn" data-act="submit-row" data-id="${esc(row.id)}">جمع کریں</button>`;
    }
    return `<tr class="${isDone(saved) ? "done" : "pending"}">
      <td>${(page - 1) * PAGE_SIZE + i + 1}</td>
      <td>${esc(row[K.code])}</td><td>${esc(row[K.name])}</td><td>${esc(row[K.father])}</td>
      <td>${esc(row[K.branch])}</td><td>${esc(row[K.duty])}</td><td>${esc(row[K.district])}</td>
      <td>${esc(row[K.division])}</td>${isAdmin ? `<td>${esc(row[K.province])}</td>` : ""}
      ${isAdmin ? `<td>${esc(row[K.offMin])}</td><td>${esc(row[K.grade])}</td><td>${esc(row[K.ijaraMin])}</td>` : ""}
      <td><select ${editable ? "" : "disabled"} class="${entry[K.hifz] ? "" : "empty"}" data-id="${esc(row.id)}" data-f="hifz">${opts(entry[K.hifz])}</select></td>
      <td><select ${editable ? "" : "disabled"} class="${entry[K.nazra] ? "" : "empty"}" data-id="${esc(row.id)}" data-f="nazra">${opts(entry[K.nazra])}</select></td>
      <td>${actionCell}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${isAdmin ? 15 : 11}" class="center">کوئی ریکارڈ نہیں ملا</td></tr>`;
  $("pager").innerHTML = `<button id="pPrev" ${page <= 1 ? "disabled" : ""}>پچھلا</button>
    <span>صفحہ ${page} / ${pages} &nbsp;(کل ${rows.length})</span>
    <button id="pNext" ${page >= pages ? "disabled" : ""}>اگلا</button>`;
  $("pPrev").onclick = () => { page--; renderTable(); };
  $("pNext").onclick = () => { page++; renderTable(); };
}

function renderMini() {
  const rows = visibleRows();
  const done = rows.filter(row => isDone(entryFor(row))).length;
  $("miniSummary").innerHTML = `<div><b>${rows.length}</b>کل مدرسین</div>
    <div><b>${done}</b>انٹری مکمل</div><div class="rem"><b>${rows.length - done}</b>باقی</div>`;
}

function refreshAll() {
  if (!me) return;
  fillFilters();
  renderMini();
  renderTable();
  if (me.role === "admin" && !$("tab-report").classList.contains("hidden")) renderReport();
}

function fixPair(entry, changed) {
  if (changed === "hifz" && entry[K.hifz] === YES) entry[K.nazra] = NO;
  else if (changed === "nazra" && entry[K.nazra] === YES) entry[K.hifz] = NO;
  else if (!changed && entry[K.hifz] === YES) entry[K.nazra] = NO;
  else if (!changed && entry[K.nazra] === YES) entry[K.hifz] = NO;
}

$("dataTable").addEventListener("change", event => {
  const select = event.target;
  if (select.tagName !== "SELECT" || !select.dataset.id) return;
  const row = DATA.find(r => r.id === select.dataset.id);
  const saved = row ? (entryFor(row) || {}) : {};
  const isAdmin = me?.role === "admin";
  if (!row || (!isAdmin && (!row.assignedTo?.includes(me.id) || isEntryLocked(saved)))) {
    refreshAll();
    return;
  }
  if (!["hifz", "nazra"].includes(select.dataset.f) || ![YES, NO, ""].includes(select.value)) {
    refreshAll();
    return;
  }
  const current = DRAFT_ENTRIES.get(row.id) || {
    [K.hifz]: saved[K.hifz] || "", [K.nazra]: saved[K.nazra] || ""
  };
  const draft = { [K.hifz]: current[K.hifz] || "", [K.nazra]: current[K.nazra] || "" };
  draft[K[select.dataset.f]] = select.value;
  fixPair(draft, select.dataset.f);
  DRAFT_ENTRIES.set(row.id, draft);

  const tr = select.closest("tr");
  if (tr) {
    const hifzSel = tr.querySelector('select[data-f="hifz"]');
    const nazraSel = tr.querySelector('select[data-f="nazra"]');
    if (hifzSel) {
      hifzSel.value = draft[K.hifz];
      hifzSel.classList.toggle("empty", !draft[K.hifz]);
    }
    if (nazraSel) {
      nazraSel.value = draft[K.nazra];
      nazraSel.classList.toggle("empty", !draft[K.nazra]);
    }
  }
});

$("dataTable").addEventListener("click", async event => {
  const button = event.target.closest('button[data-act="submit-row"]');
  if (!button) return;
  const row = DATA.find(r => r.id === button.dataset.id);
  const saved = row ? (entryFor(row) || {}) : {};
  const isAdmin = me?.role === "admin";
  if (!row || (!isAdmin && (!row.assignedTo?.includes(me.id) || isEntryLocked(saved)))) {
    await showConfirmModal({
      icon: "⛔", title: "اجازت نہیں",
      message: "اس ریکارڈ میں تبدیلی کی اجازت نہیں ہے۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    refreshAll();
    return;
  }

  const draft = DRAFT_ENTRIES.get(row.id) || {
    [K.hifz]: saved[K.hifz] || "", [K.nazra]: saved[K.nazra] || ""
  };
  if (!isAdmin && (![YES, NO].includes(draft[K.hifz]) || ![YES, NO].includes(draft[K.nazra]))) {
    await showConfirmModal({
      icon: "ℹ️", title: "نامکمل معلومات",
      message: "براہِ کرم جمع کرانے سے پہلے حفظ اور ناظرہ دونوں سوالات کے جواب منتخب کریں۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    return;
  }

  const isClearing = isAdmin && !draft[K.hifz] && !draft[K.nazra];
  if (isClearing && !saved.id) {
    await showConfirmModal({
      icon: "ℹ️", title: "کوئی انٹری نہیں",
      message: "اس ریکارڈ میں ابھی کوئی انٹری محفوظ نہیں ہے۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    return;
  }

  const isUpdate = isAdmin && isEntryLocked(saved);
  const detailsHtml = `
    <div><b>عملہ کوڈ:</b> ${esc(row[K.code])}</div>
    <div><b>نام:</b> ${esc(row[K.name])} (${esc(row[K.father])})</div>
    <div><b>حفظ کا درجہ:</b> ${esc(draft[K.hifz] || "خالی")}</div>
    <div><b>ناظرہ کا درجہ:</b> ${esc(draft[K.nazra] || "خالی")}</div>
  `;
  const confirmed = await showConfirmModal({
    icon: "⚠️",
    title: isClearing ? "انٹری ختم کرنے کی تصدیق" : (isUpdate ? "اندراج اپڈیٹ کرنے کی تصدیق" : "ڈیٹا جمع کرانے کی تصدیق"),
    message: isClearing
      ? "کیا آپ واقعی یہ محفوظ شدہ انٹری ختم (خالی) کرنا چاہتے ہیں؟ اس کے بعد یوزر دوبارہ انٹری کر سکے گا۔"
      : (isUpdate
        ? "کیا آپ واقعی اس اندراج میں کی گئی تبدیلی محفوظ کرنا چاہتے ہیں؟"
        : "کیا آپ واقعی یہ ڈیٹا جمع کرنا چاہتے ہیں؟ کیونکہ بعد میں اس میں تبدیلی نہیں ہوگی۔"),
    detailsHtml,
    okText: isClearing ? "ہاں، ختم کریں" : (isUpdate ? "ہاں، اپڈیٹ کریں" : "ہاں، جمع کریں"),
    cancelText: "منسوخ کریں",
    showCancel: true
  });
  if (!confirmed) return;

  setButtonBusy(button, true, isClearing ? "ختم ہو رہی ہے..." : "محفوظ ہو رہا ہے...");
  const targetUserId = saved.userId || entryOwnerId() || me.id;
  const entryDocId = saved.id || `${row.id}__${targetUserId}`;
  const now = nowStr();
  const entry = {
    recordId: row.id,
    userId: targetUserId,
    [K.hifz]: draft[K.hifz],
    [K.nazra]: draft[K.nazra],
    submitted: isDone(draft),
    submittedAt: isDone(draft) ? (saved.submittedAt || now) : "",
    updatedBy: me.username,
    updatedAt: now
  };
  try {
    await withLoader(isClearing ? "انٹری ختم کی جا رہی ہے..." : "ڈیٹا محفوظ ہو رہا ہے...", async () => {
      if (isClearing) {
        await deleteDoc(doc(db, "entries", entryDocId));
      } else {
        await setDoc(doc(db, "entries", entryDocId), entry);
      }
      DRAFT_ENTRIES.delete(row.id);
    });
    const logAction = isClearing ? "انٹری ختم" : (isUpdate ? "انٹری اپڈیٹ" : "انٹری جمع");
    const logDetail = isClearing
      ? `${row[K.code]} — انٹری خالی کر دی گئی`
      : `${row[K.code]} — حفظ: ${entry[K.hifz] || "-"}، ناظرہ: ${entry[K.nazra] || "-"}`;
    saveLog(logAction, logDetail)
      .catch(error => reportError("کارروائی مکمل ہو گئی، مگر سرگرمی لاگ محفوظ نہیں ہوا", error));
  } catch (error) {
    setButtonBusy(button, false);
    await showConfirmModal({
      icon: "❌", title: "خرابی",
      message: `انٹری محفوظ نہیں ہو سکی: ${error?.message || error}`,
      okText: "ٹھیک ہے", showCancel: false
    });
  }
});

$("fSearch").addEventListener("input", () => { page = 1; renderTable(); });
$("fStatus").addEventListener("change", () => { page = 1; renderTable(); });
$("clearFiltersBtn").addEventListener("click", () => {
  $("fSearch").value = "";
  $("fStatus").value = "";
  Object.values(multiFilters).forEach(mf => mf.clear(true));
  page = 1;
  fillFilters();
  renderTable();
});

function fillEntryUsers() {
  if (!me || me.role !== "admin") return;
  const select = $("entryUser");
  const current = select.value;
  select.innerHTML = '<option value="">تمام یوزرز</option>' + USERS.map(user =>
    `<option value="${esc(user.id)}">${esc(user.username)}${user.id === me.id ? " (ایڈمن)" : ""}</option>`
  ).join("");
  select.value = USERS.some(user => user.id === current) ? current : "";
}
function fillReportUsers() {
  if (!me || me.role !== "admin") return;
  const select = $("reportUser");
  const current = select.value;
  select.innerHTML = '<option value="">تمام یوزرز</option>' + USERS.map(user =>
    `<option value="${esc(user.id)}">${esc(user.username)}${user.active ? "" : " (غیر فعال)"}</option>`
  ).join("");
  select.value = USERS.some(user => user.id === current) ? current : "";
}
$("entryUser").addEventListener("change", () => {
  DRAFT_ENTRIES.clear();
  page = 1;
  fillProvinceSelects();
  refreshAll();
});
$("reportUser").addEventListener("change", renderReport);

$("refreshBtn").addEventListener("click", async () => {
  if (!me) return;
  const button = $("refreshBtn");
  setButtonBusy(button, true, "تازہ ہو رہا ہے...");
  try {
    await loadRecords(me, true);
  } catch (error) {
    reportError("تازہ ڈیٹا لوڈ نہیں ہو سکا", error);
  } finally {
    setButtonBusy(button, false);
  }
});

$("exportBtn").addEventListener("click", () => {
  const ownerId = entryOwnerId();
  const exportCols = me.role === "admin"
    ? COLS
    : COLS.filter(col => ![K.offMin, K.grade, K.ijaraMin].includes(col));
  const rows = filteredRows().map(row => {
    const entry = entryFor(row, ownerId) || {};
    const output = {};
    exportCols.forEach(col => output[col] = col === K.hifz || col === K.nazra ? entry[col] || "" : row[col] ?? "");
    output[EXTRA_COLS[0]] = entry.updatedBy || "";
    output[EXTRA_COLS[1]] = entry.updatedAt || "";
    return output;
  });
  const sheet = XLSX.utils.json_to_sheet(rows, { header: exportCols.concat(EXTRA_COLS) });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "مدرسین");
  XLSX.writeFile(book, `teachers_${me.username}.xlsx`);
  saveLog("ایکسل ایکسپورٹ", `${rows.length} ریکارڈ`).catch(error => reportError("لاگ محفوظ نہیں ہوا", error));
});

$("templateBtn").addEventListener("click", () => {
  if (me?.role !== "admin") return;
  const sheet = XLSX.utils.aoa_to_sheet([COLS]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "مدرسین");
  XLSX.writeFile(book, "blank_form.xlsx");
});

function normalizeRecord(input) {
  const byNfcKey = {};
  for (const [key, val] of Object.entries(input || {})) {
    byNfcKey[nfc(key).trim()] = val;
  }
  const row = {};
  COLS.forEach(col => row[col] = clean(byNfcKey[nfc(col)]));
  if (!row[K.code] || !row[K.province]) return null;
  row[K.hifz] = "";
  row[K.nazra] = "";
  return row;
}

function userCanSeeRegion(user, row) {
  return user.role === "admin" || hasRegion(user, row);
}

function buildRecordPayload(row, updatedAt, updatedAtMs) {
  const assignedTo = USERS.filter(user => user.active && userCanSeeRegion(user, row)).map(user => user.id);
  return {
    data: row, province: row[K.province], division: row[K.division], district: row[K.district],
    assignedTo, sourceKey: `${row[K.code]}|${row[K.province]}`, updatedAt, updatedAtMs
  };
}

async function uploadRecords(inputRows, sourceName) {
  if (!usersLoaded) throw new Error("یوزرز لوڈ ہونے تک انتظار کریں اور دوبارہ امپورٹ کریں۔");
  const normalized = new Map();
  let skipped = 0;
  inputRows.forEach(input => {
    if (!input || typeof input !== "object") { skipped++; return; }
    const row = normalizeRecord(input);
    if (!row) { skipped++; return; }
    normalized.set(recordId(row), row);
  });
  const entries = [...normalized.entries()];
  const updatedAt = nowStr(), updatedAtMs = Date.now();
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = writeBatch(db);
    entries.slice(offset, offset + 400).forEach(([id, row]) => {
      const payload = buildRecordPayload(row, updatedAt, updatedAtMs);
      batch.set(doc(db, "records", id), payload, { merge: true });
      const prev = RECORD_DOCS.get(id) || {};
      RECORD_DOCS.set(id, { ...prev, id, ...payload });
    });
    await batch.commit();
  }
  localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
  applyRecordDocs();
  await saveLog("امپورٹ", `${sourceName}: ${entries.length} ریکارڈ، رد ${skipped}`);
  alert(`امپورٹ مکمل\nریکارڈ: ${entries.length}\nرد (کوڈ یا صوبہ خالی): ${skipped}`);
}

$("importFile").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || me?.role !== "admin") return;
  if (!/\.(xlsx|xls|csv|json)$/i.test(file.name) || file.size > 15 * 1024 * 1024) {
    alert("صرف xlsx/xls/csv/json اور 15MB تک کی فائل");
    return;
  }
  const reader = new FileReader();
  reader.onload = async loadEvent => {
    try {
      await withLoader("فائل امپورٹ ہو رہی ہے...", async () => {
        let rows;
        if (/\.json$/i.test(file.name)) {
          rows = JSON.parse(new TextDecoder("utf-8").decode(loadEvent.target.result));
          if (!Array.isArray(rows)) throw new Error("JSON فائل ریکارڈز کی فہرست ہونی چاہیے");
        } else {
          const workbook = XLSX.read(loadEvent.target.result, { type: "array" });
          rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
        }
        await uploadRecords(rows, file.name);
      });
    } catch (error) {
      reportError("فائل امپورٹ نہیں ہو سکی", error);
    }
  };
  reader.readAsArrayBuffer(file);
});

function reportRow(label, group) {
  const remaining = group.total - group.done;
  const percent = group.total ? Math.round(group.done * 100 / group.total) : 0;
  return `<tr><td>${esc(label)}</td><td>${group.total}</td><td>${group.done}</td>
    <td class="rem-num">${remaining}</td><td>${percent}%<span class="bar"><i style="width:${percent}%"></i></span></td></tr>`;
}

function renderGroupedReport(field, table, label, reportRows, completedRecords) {
  const groups = new Map();
  reportRows.forEach(row => {
    const key = `${row[K.province]}||${row[field] || "نامعلوم"}`;
    const group = groups.get(key) || { total: 0, done: 0 };
    group.total++;
    if (completedRecords.has(row.id)) group.done++;
    groups.set(key, group);
  });
  const body = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, group]) => {
    const [province, name] = key.split("||");
    return `<tr><td>${esc(province)}</td><td>${esc(name)}</td><td>${group.total}</td>
      <td>${group.done}</td><td class="rem-num">${group.total - group.done}</td>
      <td>${group.total ? Math.round(group.done * 100 / group.total) : 0}%</td></tr>`;
  }).join("");
  $(table).innerHTML = `<thead><tr><th>صوبہ</th><th>${label}</th><th>کل انٹریاں</th><th>مکمل</th><th>باقی</th><th>پیش رفت</th></tr></thead>
    <tbody>${body || '<tr><td colspan="6" class="center">ڈیٹا موجود نہیں</td></tr>'}</tbody>`;
}

function renderReport() {
  const ownerId = $("reportUser").value;
  const reportRows = ownerId
    ? DATA.filter(row => row.assignedTo?.includes(ownerId))
    : DATA;
  const completedRecords = new Set(ENTRIES
    .filter(entry => (!ownerId || entry.userId === ownerId) && isDone(entry))
    .map(entry => entry.recordId));
  const groups = new Map();
  reportRows.forEach(row => {
    const group = groups.get(row[K.province]) || { total: 0, done: 0 };
    group.total++;
    if (completedRecords.has(row.id)) group.done++;
    groups.set(row[K.province], group);
  });
  let total = 0, done = 0;
  const body = provinces.map(province => {
    const group = groups.get(province) || { total: 0, done: 0 };
    total += group.total; done += group.done;
    return reportRow(province, group);
  }).join("");
  $("repProvince").innerHTML = `<thead><tr><th>صوبہ</th><th>کل انٹریاں</th><th>مکمل</th><th>باقی</th><th>پیش رفت</th></tr></thead>
    <tbody>${body}</tbody><tfoot>${reportRow("کل", { total, done })}</tfoot>`;
  renderGroupedReport(K.division, "repDivision", "ڈویژن", reportRows, completedRecords);
  renderGroupedReport(K.district, "repDistrict", "ڈسٹرکٹ", reportRows, completedRecords);
}

$("tabs").addEventListener("click", event => {
  const tab = event.target.dataset.tab;
  if (!tab || (tab !== "entry" && me.role !== "admin")) return;
  document.querySelectorAll("#tabs button").forEach(button => button.classList.toggle("active", button === event.target));
  ["entry", "report", "users", "log", "settings"].forEach(name => $("tab-" + name).classList.toggle("hidden", name !== tab));
  if (tab === "report") renderReport();
  if (tab === "users") renderUsers();
  if (tab === "log") renderLog();
  if (tab === "settings") $("aName").value = me.username;
});

const requireAdmin = () => {
  if (!me || me.role !== "admin") { alert("اجازت نہیں"); return false; }
  return true;
};

function provinceDivisions(province) {
  const normProv = nfc(province);
  return [...new Set(
    DATA.filter(row => nfc(row[K.province]) === normProv)
      .map(row => row[K.division])
      .filter(Boolean)
  )].sort();
}

function renderScopeChecks(selected = []) {
  if (!DATA.length && recordsLoading) {
    pendingScopeSelection = selected;
    $("uScopeSelections").innerHTML = '<span class="note">ڈیٹا ریکارڈز لوڈ ہو رہے ہیں، براہِ کرم انتظار کریں...</span>';
    return;
  }
  const assignments = new Map(selected.map(item => [nfc(item.province), (item.divisions || []).map(nfc)]));
  const scopeProvinces = [...new Set([...provinces, ...assignments.keys()])].filter(Boolean).sort();
  $("uScopeSelections").innerHTML = scopeProvinces.map(province => {
    const selectedDivisions = assignments.get(province);
    const provinceChecked = assignments.has(province);
    const divisions = [...new Set([...provinceDivisions(province), ...(selectedDivisions || [])])].filter(Boolean).sort();
    return `<div class="scope-province">
      <label class="inline"><input type="checkbox" class="province-check" value="${esc(province)}" ${provinceChecked ? "checked" : ""}> ${esc(province)}
        <small>(کوئی ڈویژن منتخب نہ ہو تو پورا صوبہ)</small></label>
      <div class="checks">${divisions.map(division =>
        `<label><input type="checkbox" class="division-check" data-province="${esc(province)}" value="${esc(division)}"
        ${selectedDivisions?.includes(division) ? "checked" : ""}> ${esc(division)}</label>`
      ).join("") || '<span class="note">اس صوبے کے ڈویژن ڈیٹا امپورٹ کے بعد دکھیں گے</span>'}</div>
    </div>`;
  }).join("") || '<span class="note">پہلے ڈیٹا امپورٹ کریں</span>';
}

function collectAssignments() {
  return [...$("uScopeSelections").querySelectorAll(".province-check:checked")].map(check => {
    const province = check.value;
    const divisions = [...$("uScopeSelections").querySelectorAll(".division-check:checked")]
      .filter(item => item.dataset.province === province).map(item => item.value);
    return { province, divisions };
  });
}

function fillScopeChecks() {
  if (!$("userDlg").open) return;
  const selected = pendingScopeSelection ?? collectAssignments();
  pendingScopeSelection = null;
  renderScopeChecks(selected);
}

function fillUserProvinceFilter() {
  if (!me || me.role !== "admin" || !$("uFilterProvince")) return;
  const userProvs = USERS.flatMap(u => assignmentsForUser(u).map(a => nfc(a.province)).filter(Boolean));
  const list = [...new Set([...provinces, ...userProvs])].sort();
  fillFilter($("uFilterProvince"), "تمام صوبے", list);
}

function renderUsers() {
  if (!requireAdmin()) return;
  fillUserProvinceFilter();
  const search = ($("uSearch")?.value || "").trim().toLowerCase();
  const roleFilter = $("uFilterRole")?.value || "";
  const provFilter = $("uFilterProvince")?.value || "";
  const statusFilter = $("uFilterStatus")?.value || "";

  const filtered = USERS.filter(user => {
    if (roleFilter && user.role !== roleFilter) return false;
    if (statusFilter === "active" && !user.active) return false;
    if (statusFilter === "inactive" && user.active) return false;
    const userAssigns = assignmentsForUser(user);
    if (provFilter && !userAssigns.some(a => nfc(a.province) === provFilter)) return false;
    if (search) {
      const scopeText = userAssigns.map(a => `${a.province} ${(a.divisions || []).join(" ")}`).join(" ").toLowerCase();
      if (!user.username.toLowerCase().includes(search) && !scopeText.includes(search)) return false;
    }
    return true;
  });

  $("userTable").innerHTML = `<thead><tr><th>یوزر آئی ڈی</th><th>کردار</th><th>اسائن شدہ صوبے/ڈویژن</th><th>حالت</th><th></th></tr></thead><tbody>` +
    (filtered.map(user => {
      const scope = user.role === "admin" ? "تمام ڈیٹا" : assignmentsForUser(user)
        .map(item => `${item.province}${item.divisions?.length ? ` — ${item.divisions.join("، ")}` : " — پورا صوبہ"}`).join("<br>");
      return `<tr><td>${esc(user.username)}</td><td>${user.role === "admin" ? "ایڈمن" : "یوزر"}</td>
        <td>${scope || "کوئی علاقہ اسائن نہیں"}</td>
        <td><span class="tag ${user.active ? "" : "off"}">${user.active ? "فعال" : "بند"}</span></td>
        <td><button class="link" data-act="edit" data-id="${esc(user.id)}">ترمیم</button>
        ${user.id === me.id ? "" : `<button class="link del" data-act="del" data-id="${esc(user.id)}">حذف</button>`}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="center">کوئی یوزر نہیں ملا</td></tr>`) + "</tbody>";
  fillEntryUsers();
}

["uSearch", "uFilterRole", "uFilterProvince", "uFilterStatus"].forEach(id => {
  $(id)?.addEventListener(id === "uSearch" ? "input" : "change", () => renderUsers());
});

function openUserDlg(user = null) {
  if (!requireAdmin()) return;
  editingId = user?.id || null;
  $("userDlgTitle").textContent = user ? "یوزر میں ترمیم" : "نیا یوزر";
  $("uName").value = user?.username || "";
  $("uName").disabled = !!user;
  $("uPass").value = "";
  $("uPass").required = !user;
  $("uPass").disabled = !!user;
  $("uPassLabel").classList.toggle("hidden", !!user);
  $("uRole").value = user?.role || "user";
  $("uActive").checked = user ? !!user.active : true;
  $("userErr").textContent = "";
  renderScopeChecks(user ? assignmentsForUser(user) : []);
  toggleScope();
  $("userDlg").showModal();
}

function toggleScope() {
  $("scopeBox").classList.toggle("hidden", $("uRole").value === "admin");
}

function otherActiveAdmins(exceptUid) {
  return USERS.filter(u => u.id !== exceptUid && u.role === "admin" && u.active).length;
}

async function syncRecordAssignmentsClient(uid, targetUser) {
  if (!RECORD_DOCS.size) await loadRecords(me, false);
  const updates = [];
  for (const [id, raw] of RECORD_DOCS.entries()) {
    const row = rowFromDocData(id, raw);
    const hasUid = Array.isArray(raw.assignedTo) && raw.assignedTo.includes(uid);
    const shouldHave = !!(targetUser && targetUser.active && userCanSeeRegion(targetUser, row));
    if (hasUid !== shouldHave) {
      updates.push({ id, raw, add: shouldHave });
    }
  }
  const nowMs = Date.now();
  for (let offset = 0; offset < updates.length; offset += 400) {
    const batch = writeBatch(db);
    updates.slice(offset, offset + 400).forEach(item => {
      batch.update(doc(db, "records", item.id), {
        assignedTo: item.add ? arrayUnion(uid) : arrayRemove(uid),
        updatedAtMs: nowMs
      });
      const prev = Array.isArray(item.raw.assignedTo) ? item.raw.assignedTo : [];
      item.raw.assignedTo = item.add
        ? [...new Set([...prev, uid])]
        : prev.filter(x => x !== uid);
      item.raw.updatedAtMs = nowMs;
    });
    await batch.commit();
  }
  if (updates.length) {
    localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
    applyRecordDocs();
  }
}

$("addUserBtn").addEventListener("click", () => openUserDlg());
$("userCancel").addEventListener("click", () => { pendingScopeSelection = null; $("userDlg").close(); });
$("userDlg").addEventListener("close", () => { pendingScopeSelection = null; });
$("uRole").addEventListener("change", toggleScope);
$("uScopeSelections").addEventListener("change", event => {
  const input = event.target;
  if (input.classList.contains("division-check") && input.checked) {
    const province = [...$("uScopeSelections").querySelectorAll(".province-check")]
      .find(check => check.value === input.dataset.province);
    if (province) province.checked = true;
  } else if (input.classList.contains("province-check") && !input.checked) {
    [...$("uScopeSelections").querySelectorAll(".division-check")]
      .filter(check => check.dataset.province === input.value)
      .forEach(check => { check.checked = false; });
  }
});

$("userForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireAdmin()) return;
  const oldUser = editingId ? USERS.find(u => u.id === editingId) : null;
  const username = oldUser ? oldUser.username : $("uName").value.trim();
  const password = $("uPass").value;
  const role = normalizeRole($("uRole").value);
  const active = $("uActive").checked;
  const assignments = role === "admin" ? [] : collectAssignments();
  const error = message => { $("userErr").textContent = message; };

  if (!editingId) {
    let problem = nameProblem(username);
    if (problem) { error(problem); return; }
    problem = pwProblem(password, username);
    if (problem) { error(problem); return; }
    if (USERS.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      error("یہ یوزر نیم پہلے سے موجود ہے");
      return;
    }
  } else {
    if (!oldUser) { error("یوزر نہیں ملا"); return; }
    if (editingId === me.id && (role !== "admin" || !active)) {
      error("اپنا ایڈمن اکاؤنٹ بند یا کم درجہ نہیں کر سکتے۔");
      return;
    }
    if (oldUser.role === "admin" && oldUser.active && (role !== "admin" || !active) && otherActiveAdmins(editingId) < 1) {
      error("کم از کم ایک فعال ایڈمن لازمی ہے۔");
      return;
    }
  }
  if (!role) { error("کردار درست نہیں"); return; }
  if (role === "user" && !assignments.length) {
    error("یوزر کو کم از کم ایک صوبہ اسائن کریں");
    return;
  }

  const submit = $("userForm").querySelector('button[type="submit"]');
  setButtonBusy(submit, true, "محفوظ ہو رہا ہے...");
  try {
    if (!editingId) {
      const cAuth = getCreatorAuth();
      const cred = await createUserWithEmailAndPassword(cAuth, userEmail(username), password);
      const uid = cred.user.uid;
      const profile = {
        username,
        usernameKey: username.toLowerCase(),
        role,
        active,
        assignments,
        createdAt: new Date().toISOString()
      };
      try {
        await setDoc(doc(db, "users", uid), profile);
      } catch (writeErr) {
        try { await cred.user.delete(); } catch {}
        throw writeErr;
      } finally {
        try { await signOut(cAuth); } catch {}
      }
      await syncRecordAssignmentsClient(uid, profile);
    } else {
      const nextProfile = {
        username: oldUser.username,
        usernameKey: (oldUser.usernameKey || oldUser.username).toLowerCase(),
        role,
        active,
        assignments,
        createdAt: oldUser.createdAt || new Date().toISOString()
      };
      await setDoc(doc(db, "users", editingId), nextProfile);
      await syncRecordAssignmentsClient(editingId, nextProfile);
      if (editingId === me.id) me = { ...me, ...nextProfile };
    }
    await saveLog(editingId ? "یوزر ترمیم" : "نیا یوزر", `${username} — ${role}`);
    $("userDlg").close();
    renderUsers();
  } catch (err) {
    if (err?.code === "auth/email-already-in-use") {
      error("یہ یوزر آئی ڈی پہلے سے Auth میں موجود ہے؛ دوسرا نام رکھیں یا admin_cli.mjs سے شامل کریں۔");
    } else {
      error(err.message || "یوزر محفوظ نہیں ہو سکا");
    }
  } finally {
    setButtonBusy(submit, false);
  }
});

$("userTable").addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button || !requireAdmin()) return;
  const user = USERS.find(item => item.id === button.dataset.id);
  if (!user) return;
  if (button.dataset.act === "edit") openUserDlg(user);
  if (button.dataset.act === "del" && user.id !== me.id) {
    if (user.role === "admin" && user.active && otherActiveAdmins(user.id) < 1) {
      alert("کم از کم ایک فعال ایڈمن لازمی ہے۔");
      return;
    }
    if (!confirm(`یوزر "${user.username}" کا رسائی ریکارڈ حذف کریں؟`)) return;
    try {
      await withLoader("یوزر حذف ہو رہا ہے...", async () => {
        await syncRecordAssignmentsClient(user.id, null);
        await deleteDoc(doc(db, "users", user.id));
        await saveLog("یوزر حذف", user.username);
      });
    } catch (error) {
      reportError("یوزر حذف نہیں ہو سکا", error);
    }
  }
});

function renderLog() {
  const rows = LOG.slice(0, 300);
  $("logTable").innerHTML = `<thead><tr><th>وقت</th><th>یوزر</th><th>عمل</th><th>تفصیل</th></tr></thead><tbody>` +
    (rows.map(log => `<tr><td>${esc(log.time)}</td><td>${esc(log.username)}</td>
      <td>${esc(log.action)}</td><td class="wrap">${esc(log.detail)}</td></tr>`).join("") ||
      '<tr><td colspan="4" class="center">کوئی سرگرمی نہیں</td></tr>') + "</tbody>";
}

$("adminForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireAdmin()) return;
  const message = (text, success) => {
    $("adminMsg").textContent = text;
    $("adminMsg").className = success ? "err ok" : "err";
  };
  const currentPassword = $("aCur").value;
  const newPassword = $("aNew").value;
  const repeatPassword = $("aNew2").value;
  const newUsername = $("aName").value.trim();
  let problem = nameProblem(newUsername);
  if (problem) { message(problem, false); return; }
  if (newUsername.toLowerCase() !== me.username.toLowerCase() &&
      USERS.some(user => user.id !== me.id && user.username.toLowerCase() === newUsername.toLowerCase())) {
    message("یہ یوزر نیم پہلے سے موجود ہے", false);
    return;
  }
  if (newUsername !== me.username) {
    message("یوزر آئی ڈی بدلنے کے لیے admin_cli.mjs استعمال کریں؛ پاس ورڈ یہیں سے تبدیل ہو سکتا ہے۔", false);
    return;
  }
  if (!newPassword && !repeatPassword) {
    message("نیا پاس ورڈ درج کریں", false);
    return;
  }
  if (newPassword !== repeatPassword) { message("نئے پاس ورڈ ایک جیسے نہیں", false); return; }
  problem = pwProblem(newPassword, me.username);
  if (problem) { message(problem, false); return; }
  const submit = $("adminForm").querySelector('button[type="submit"]');
  setButtonBusy(submit, true, "محفوظ ہو رہا ہے...");
  try {
    await withLoader("پاس ورڈ تبدیل ہو رہا ہے...", async () => {
      const credential = EmailAuthProvider.credential(userEmail(me.username), currentPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await updatePassword(auth.currentUser, newPassword);
      $("aCur").value = $("aNew").value = $("aNew2").value = "";
      message("پاس ورڈ تبدیل ہو گیا", true);
      await saveLog("ایڈمن پاس ورڈ تبدیل");
    });
  } catch (error) {
    message(error.code === "auth/wrong-password" ? "موجودہ پاس ورڈ غلط ہے" : error.message, false);
  } finally {
    setButtonBusy(submit, false);
  }
});

$("backupBtn").addEventListener("click", async () => {
  if (!requireAdmin()) return;
  const button = $("backupBtn");
  setButtonBusy(button, true, "بیک اپ بن رہا ہے...");
  try {
    await withLoader("بیک اپ تیار ہو رہا ہے...", async () => {
      await loadRecords(me, false);
      const records = [...RECORD_DOCS.values()];
      const entries = entriesLoaded
        ? ENTRIES.map(entry => ({ ...entry }))
        : (await getDocs(collection(db, "entries"))).docs.map(d => ({ id: d.id, ...d.data() }));
      const backup = { version: 2, records, entries };
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `backup_${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      await saveLog("بیک اپ ڈاؤن لوڈ");
    });
  } catch (error) {
    reportError("بیک اپ نہیں بن سکا", error);
  } finally {
    setButtonBusy(button, false);
  }
});

$("restoreFile").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !requireAdmin()) return;
  if (file.size > 30 * 1024 * 1024) { alert("فائل بہت بڑی ہے"); return; }
  const reader = new FileReader();
  reader.onload = async loadEvent => {
    try {
      const backup = JSON.parse(loadEvent.target.result);
      if (!Array.isArray(backup.records) || !Array.isArray(backup.entries)) throw new Error("بیک اپ فائل درست نہیں");
      if (!confirm(`ریکارڈ: ${backup.records.length}، انٹریاں: ${backup.entries.length}\nموجودہ ریکارڈز میں شامل کریں؟`)) return;
      await withLoader("بیک اپ بحال ہو رہا ہے...", async () => {
        const updatedAt = nowStr(), updatedAtMs = Date.now();
        for (let offset = 0; offset < backup.records.length; offset += 400) {
          const batch = writeBatch(db);
          backup.records.slice(offset, offset + 400).forEach(item => {
            if (!item.id || !item.data) throw new Error("بیک اپ میں ریکارڈ کا فارمیٹ درست نہیں");
            const row = normalizeRecord(item.data);
            if (!row) throw new Error("بیک اپ میں ریکارڈ کا صوبہ یا کوڈ موجود نہیں");
            const payload = buildRecordPayload(row, updatedAt, updatedAtMs);
            batch.set(doc(db, "records", item.id), payload);
            RECORD_DOCS.set(item.id, { id: item.id, ...payload });
          });
          await batch.commit();
        }
        localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
        applyRecordDocs();
        for (let offset = 0; offset < backup.entries.length; offset += 400) {
          const batch = writeBatch(db);
          backup.entries.slice(offset, offset + 400).forEach(item => {
            if (!item.id || !item.recordId || !item.userId) throw new Error("بیک اپ میں انٹری کا فارمیٹ درست نہیں");
            batch.set(doc(db, "entries", item.id), item);
          });
          await batch.commit();
        }
        await saveLog("بیک اپ بحال");
      });
      alert("بحالی مکمل ہو گئی");
    } catch (error) {
      reportError("بیک اپ بحال نہیں ہوا", error);
    }
  };
  reader.readAsText(file);
});
