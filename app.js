"use strict";

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  browserSessionPersistence, EmailAuthProvider, initializeAuth, onAuthStateChanged,
  reauthenticateWithCredential, signInWithEmailAndPassword, signOut, updatePassword
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  addDoc, collection, doc, getDoc, getDocs, getFirestore, limit, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBAnPSD2XhLOTnupNMwwo9-GmJrOg8MotM",
  authDomain: "mtm-data.firebaseapp.com",
  projectId: "mtm-data",
  storageBucket: "mtm-data.firebasestorage.app",
  messagingSenderId: "649943045136",
  appId: "1:649943045136:web:e5504c105dcfd3cd152695"
};
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, { persistence: browserSessionPersistence });
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1");
const manageUser = httpsCallable(functions, "manageUser");
const manageSelf = httpsCallable(functions, "manageSelf");
const YES = "جی ہاں", NO = "جی نہیں", PAGE_SIZE = 50, IDLE_MS = 15 * 60 * 1000;
const K = {
  code: "عملہ کوڈ", name: "نام", father: "ولدیت", branch: "شاخ", duty: "ذمہ داری",
  district: "ڈسٹرکٹ", division: "سرکاری ڈویژن", province: "صوبائی/انتظامی اکائی",
  offMin: "آفیشل منٹ", grade: "گریڈ", ijaraMin: "اجارے کے منٹ",
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
const userEmail = username => `${username.trim().toLowerCase()}@mtm-data.firebaseapp.com`;
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
const clean = v => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

let me = null, DATA = [], USERS = [], ENTRIES = [], LOG = [], usersLoaded = false;
let page = 1, editingId = null, unsubscribers = [], lastActive = Date.now(), loggingOut = false;
let provinces = [];

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

function hasRegion(user, row) {
  if (user.role === "admin") return true;
  return assignmentsForUser(user).some(a => a.province === row[K.province] &&
    (!Array.isArray(a.divisions) || !a.divisions.length || a.divisions.includes(row[K.division])));
}

function visibleRows() {
  return DATA.filter(row => me && (me.role === "admin" || row.assignedTo?.includes(me.id)) && hasRegion(me, row));
}

function entryOwnerId() {
  return me.role === "admin" ? ($("entryUser").value || me.id) : me.id;
}

function entryFor(record, ownerId = entryOwnerId()) {
  return ENTRIES.find(entry => entry.recordId === record.id && entry.userId === ownerId);
}

function saveLog(action, detail = "") {
  return addDoc(collection(db, "logs"), {
    uid: me.id, username: me.username, action, detail, createdAt: serverTimestamp(), time: nowStr()
  });
}

function stopListeners() {
  unsubscribers.forEach(unsubscribe => unsubscribe());
  unsubscribers = [];
}

function showApp(user) {
  me = user;
  lastActive = Date.now();
  loggingOut = false;
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  const assignments = assignmentsForUser(user);
  const scope = user.role === "admin" ? "ایڈمن" :
    assignments.map(a => `${a.province}${a.divisions?.length ? ` (${a.divisions.join("، ")})` : ""}`).join("، ");
  $("whoLabel").textContent = `${user.username} (${scope || "کوئی علاقہ اسائن نہیں"})`;
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", user.role !== "admin"));
  if (user.role === "admin") {
    unsubscribers.push(onSnapshot(collection(db, "users"), snap => {
      USERS = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      usersLoaded = true;
      fillEntryUsers();
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
  const recordQuery = user.role === "admin"
    ? collection(db, "records")
    : query(collection(db, "records"), where("assignedTo", "array-contains", user.id));
  unsubscribers.push(onSnapshot(recordQuery, snap => {
    DATA = snap.docs.map(d => ({ id: d.id, ...d.data().data, assignedTo: d.data().assignedTo || [] }));
    provinces = [...new Set(DATA.map(r => r[K.province]).filter(Boolean))].sort();
    fillProvinceSelects();
    fillScopeChecks();
    refreshAll();
  }, err => reportError("ڈیٹا لوڈ نہیں ہو سکا", err)));
  const entryQuery = user.role === "admin"
    ? collection(db, "entries")
    : query(collection(db, "entries"), where("userId", "==", user.id));
  unsubscribers.push(onSnapshot(entryQuery, snap => {
    ENTRIES = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshAll();
  }, err => reportError("انٹریاں لوڈ نہیں ہو سکیں", err)));
  if (user.role === "admin") fillEntryUsers();
  refreshAll();
}

function resetLoginPassword() {
  $("showPass").checked = false;
  $("lPass").type = "password";
}

function returnToLogin(message = "") {
  stopListeners();
  me = null; DATA = []; USERS = []; ENTRIES = []; LOG = []; usersLoaded = false; loggingOut = false;
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  resetLoginPassword();
  showError(message);
}


onAuthStateChanged(auth, async account => {
  if (!account) {
    returnToLogin();
    return;
  }
  try {
    const snapshot = await getDoc(doc(db, "users", account.uid));
    if (!snapshot.exists() || !snapshot.data().active) {
      await signOut(auth);
      returnToLogin("یہ اکاؤنٹ غیر فعال ہے یا ایڈمن نے ابھی بنایا نہیں۔");
      return;
    }
    showApp({ id: account.uid, ...snapshot.data() });
    saveLog("لاگ اِن").catch(error => reportError("لاگ اِن لاگ محفوظ نہیں ہوا", error));
  } catch (error) {
    await signOut(auth);
    returnToLogin(`اکاؤنٹ کی معلومات نہیں مل سکیں: ${error.message}`);
  }
}, error => showError(`Firebase لاگ اِن تیار نہیں: ${error.message}`));

$("showPass").addEventListener("change", () => {
  $("lPass").type = $("showPass").checked ? "text" : "password";
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("lUser").value.trim();
  const password = $("lPass").value;
  const problem = nameProblem(username);
  if (problem) { showError(problem); return; }
  $("lBtn").disabled = true;
  showError("");
  try {
    await auth.authStateReady();
    await signInWithEmailAndPassword(auth, userEmail(username), password);
    $("lPass").value = "";
    resetLoginPassword();
  } catch (error) {
    showError(error.code === "auth/too-many-requests"
      ? "بہت سی ناکام کوششیں؛ کچھ دیر بعد دوبارہ کوشش کریں۔"
      : "یوزر آئی ڈی یا پاس ورڈ درست نہیں۔");
  } finally {
    $("lBtn").disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await saveLog("لاگ آؤٹ");
    await signOut(auth);
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

function fillProvinceSelects() {
  const current = $("fProvince").value;
  $("fProvince").innerHTML = '<option value="">تمام صوبے</option>' +
    provinces.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  if (provinces.includes(current)) $("fProvince").value = current;
}

function fillFilter(select, label, values) {
  const current = select.value;
  select.innerHTML = `<option value="">${label}</option>` +
    values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  if (values.includes(current)) select.value = current;
}

function fillFilters() {
  let rows = visibleRows();
  if (me.role === "admin" && $("fProvince").value) rows = rows.filter(r => r[K.province] === $("fProvince").value);
  const unique = field => [...new Set(rows.map(r => r[field]).filter(Boolean))].sort();
  fillFilter($("fDivision"), "تمام ڈویژنز", unique(K.division));
  if ($("fDivision").value) rows = rows.filter(r => r[K.division] === $("fDivision").value);
  fillFilter($("fDistrict"), "تمام اضلاع", unique(K.district));
}

function filteredRows() {
  const search = $("fSearch").value.trim();
  const province = me.role === "admin" ? $("fProvince").value : "";
  const division = $("fDivision").value, district = $("fDistrict").value, status = $("fStatus").value;
  return visibleRows().filter(row => {
    if (province && row[K.province] !== province) return false;
    if (division && row[K.division] !== division) return false;
    if (district && row[K.district] !== district) return false;
    const entry = entryFor(row);
    if (status === "done" && !isDone(entry)) return false;
    if (status === "pending" && isDone(entry)) return false;
    if (search && ![row[K.name], row[K.code], row[K.father]].some(v => String(v || "").includes(search))) return false;
    return true;
  });
}

const opts = value => `<option value="">-- منتخب کریں --</option>` +
  `<option value="${YES}" ${value === YES ? "selected" : ""}>${YES}</option>` +
  `<option value="${NO}" ${value === NO ? "selected" : ""}>${NO}</option>`;

function renderTable() {
  if (!me) return;
  const rows = filteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ownerId = entryOwnerId();
  const canEdit = ownerId === me.id;
  $("dataTable").querySelector("tbody").innerHTML = slice.map((row, i) => {
    const entry = entryFor(row, ownerId) || {};
    return `<tr class="${isDone(entry) ? "done" : "pending"}">
      <td>${(page - 1) * PAGE_SIZE + i + 1}</td>
      <td>${esc(row[K.code])}</td><td>${esc(row[K.name])}</td><td>${esc(row[K.father])}</td>
      <td>${esc(row[K.branch])}</td><td>${esc(row[K.duty])}</td><td>${esc(row[K.district])}</td>
      <td>${esc(row[K.division])}</td>${me.role === "admin" ? `<td>${esc(row[K.province])}</td>` : ""}
      <td>${esc(row[K.offMin])}</td><td>${esc(row[K.grade])}</td><td>${esc(row[K.ijaraMin])}</td>
      <td><select ${canEdit ? "" : "disabled"} class="${entry[K.hifz] ? "" : "empty"}" data-id="${esc(row.id)}" data-f="hifz">${opts(entry[K.hifz])}</select></td>
      <td><select ${canEdit ? "" : "disabled"} class="${entry[K.nazra] ? "" : "empty"}" data-id="${esc(row.id)}" data-f="nazra">${opts(entry[K.nazra])}</select></td>
    </tr>`;
  }).join("") || `<tr><td colspan="14" class="center">کوئی ریکارڈ نہیں ملا</td></tr>`;
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

$("dataTable").addEventListener("change", async event => {
  const select = event.target;
  if (select.tagName !== "SELECT" || !select.dataset.id) return;
  const row = DATA.find(r => r.id === select.dataset.id);
  if (!row || (me.role !== "admin" && !row.assignedTo?.includes(me.id)) || entryOwnerId() !== me.id) {
    alert("اس ریکارڈ میں تبدیلی کی اجازت نہیں");
    refreshAll();
    return;
  }
  if (!["hifz", "nazra"].includes(select.dataset.f) || ![YES, NO, ""].includes(select.value)) {
    refreshAll();
    return;
  }
  const previous = entryFor(row, me.id) || {};
  const entry = {
    recordId: row.id, userId: me.id,
    [K.hifz]: previous[K.hifz] || "", [K.nazra]: previous[K.nazra] || ""
  };
  entry[K[select.dataset.f]] = select.value;
  fixPair(entry, select.dataset.f);
  entry.updatedBy = me.username;
  entry.updatedAt = nowStr();
  try {
    await setDoc(doc(db, "entries", `${row.id}__${me.id}`), entry);
    await saveLog("انٹری", `${row[K.code]} — حفظ: ${entry[K.hifz] || "-"}، ناظرہ: ${entry[K.nazra] || "-"}`);
  } catch (error) {
    reportError("انٹری محفوظ نہیں ہو سکی", error);
  }
});

["fSearch", "fDistrict", "fStatus"].forEach(id =>
  $(id).addEventListener("input", () => { page = 1; renderTable(); }));
$("fDivision").addEventListener("change", () => { $("fDistrict").value = ""; page = 1; fillFilters(); renderTable(); });
$("fProvince").addEventListener("change", () => {
  $("fDivision").value = ""; $("fDistrict").value = ""; page = 1; fillFilters(); renderTable();
});

function fillEntryUsers() {
  if (!me || me.role !== "admin") return;
  const current = $("entryUser").value;
  $("entryUser").innerHTML = USERS.map(user =>
    `<option value="${esc(user.id)}">${esc(user.username)}${user.id === me.id ? " (ایڈمن)" : ""}</option>`
  ).join("");
  if (USERS.some(user => user.id === current)) $("entryUser").value = current;
  else $("entryUser").value = me.id;
}
$("entryUser").addEventListener("change", () => { page = 1; refreshAll(); });

$("exportBtn").addEventListener("click", () => {
  const ownerId = entryOwnerId();
  const rows = filteredRows().map(row => {
    const entry = entryFor(row, ownerId) || {};
    const output = {};
    COLS.forEach(col => output[col] = col === K.hifz || col === K.nazra ? entry[col] || "" : row[col] ?? "");
    output[EXTRA_COLS[0]] = entry.updatedBy || "";
    output[EXTRA_COLS[1]] = entry.updatedAt || "";
    return output;
  });
  const sheet = XLSX.utils.json_to_sheet(rows, { header: COLS.concat(EXTRA_COLS) });
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
  const row = {};
  COLS.forEach(col => row[col] = clean(input[col]));
  if (!row[K.code] || !row[K.province]) return null;
  row[K.hifz] = "";
  row[K.nazra] = "";
  return row;
}

function userCanSeeRegion(user, row) {
  return user.role === "admin" || hasRegion(user, row);
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
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = writeBatch(db);
    entries.slice(offset, offset + 400).forEach(([id, row]) => {
      const assignedTo = USERS.filter(user => userCanSeeRegion(user, row)).map(user => user.id);
      batch.set(doc(db, "records", id), {
        data: row, province: row[K.province], division: row[K.division], district: row[K.district],
        assignedTo, sourceKey: `${row[K.code]}|${row[K.province]}`, updatedAt: nowStr()
      }, { merge: true });
    });
    await batch.commit();
  }
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
      let rows;
      if (/\.json$/i.test(file.name)) {
        rows = JSON.parse(new TextDecoder("utf-8").decode(loadEvent.target.result));
        if (!Array.isArray(rows)) throw new Error("JSON فائل ریکارڈز کی فہرست ہونی چاہیے");
      } else {
        const workbook = XLSX.read(loadEvent.target.result, { type: "array" });
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
      }
      await uploadRecords(rows, file.name);
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

function renderGroupedReport(field, table, label) {
  const groups = new Map();
  const ownerId = $("entryUser").value || me.id;
  const reportRows = me.role === "admin" && ownerId !== me.id
    ? DATA.filter(row => row.assignedTo?.includes(ownerId))
    : visibleRows();
  reportRows.forEach(row => {
    const key = `${row[K.province]}||${row[field] || "نامعلوم"}`;
    const entry = entryFor(row, ownerId);
    const group = groups.get(key) || { total: 0, done: 0 };
    group.total++;
    if (isDone(entry)) group.done++;
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
  const ownerId = $("entryUser").value || me.id;
  const reportRows = me.role === "admin" && ownerId !== me.id
    ? DATA.filter(row => row.assignedTo?.includes(ownerId))
    : visibleRows();
  const groups = new Map();
  reportRows.forEach(row => {
    const group = groups.get(row[K.province]) || { total: 0, done: 0 };
    group.total++;
    if (isDone(entryFor(row, ownerId))) group.done++;
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
  renderGroupedReport(K.division, "repDivision", "ڈویژن");
  renderGroupedReport(K.district, "repDistrict", "ڈسٹرکٹ");
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
  return [...new Set(DATA.filter(row => row[K.province] === province).map(row => row[K.division]).filter(Boolean))].sort();
}

function renderScopeChecks(selected = []) {
  const assignments = new Map(selected.map(item => [item.province, item.divisions || []]));
  $("uScopeSelections").innerHTML = provinces.map(province => {
    const selectedDivisions = assignments.get(province);
    const provinceChecked = assignments.has(province);
    const divisions = provinceDivisions(province);
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
  if ($("userDlg").open && !editingId) renderScopeChecks(collectAssignments());
}

function renderUsers() {
  if (!requireAdmin()) return;
  $("userTable").innerHTML = `<thead><tr><th>یوزر آئی ڈی</th><th>کردار</th><th>اسائن شدہ صوبے/ڈویژن</th><th>حالت</th><th></th></tr></thead><tbody>` +
    USERS.map(user => {
      const scope = user.role === "admin" ? "تمام ڈیٹا" : assignmentsForUser(user)
        .map(item => `${item.province}${item.divisions?.length ? ` — ${item.divisions.join("، ")}` : " — پورا صوبہ"}`).join("<br>");
      return `<tr><td>${esc(user.username)}</td><td>${user.role === "admin" ? "ایڈمن" : "یوزر"}</td>
        <td>${scope || "کوئی علاقہ اسائن نہیں"}</td>
        <td><span class="tag ${user.active ? "" : "off"}">${user.active ? "فعال" : "بند"}</span></td>
        <td><button class="link" data-act="edit" data-id="${esc(user.id)}">ترمیم</button>
        ${user.id === me.id ? "" : `<button class="link del" data-act="del" data-id="${esc(user.id)}">حذف</button>`}</td></tr>`;
    }).join("") + "</tbody>";
  fillEntryUsers();
}

function openUserDlg(user = null) {
  if (!requireAdmin()) return;
  editingId = user?.id || null;
  $("userDlgTitle").textContent = user ? "یوزر میں ترمیم" : "نیا یوزر";
  $("uName").value = user?.username || "";
  $("uPass").value = "";
  $("uPass").required = !user;
  $("uPassLabel").firstChild.textContent = user ? "نیا پاس ورڈ (خالی چھوڑیں تو وہی رہے گا)" : "پاس ورڈ";
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

$("addUserBtn").addEventListener("click", () => openUserDlg());
$("userCancel").addEventListener("click", () => $("userDlg").close());
$("uRole").addEventListener("change", toggleScope);
$("uScopeSelections").addEventListener("change", event => {
  const input = event.target;
  if (input.classList.contains("division-check") && input.checked) {
    const province = [...$("uScopeSelections").querySelectorAll(".province-check")]
      .find(check => check.value === input.dataset.province);
    if (province) province.checked = true;
  }
});

$("userForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireAdmin()) return;
  const username = $("uName").value.trim();
  const password = $("uPass").value;
  const role = $("uRole").value;
  const assignments = role === "admin" ? [] : collectAssignments();
  const error = message => { $("userErr").textContent = message; };
  let problem = nameProblem(username);
  if (problem) { error(problem); return; }
  if (!editingId || password) {
    problem = pwProblem(password, username);
    if (problem) { error(problem); return; }
  }
  if (USERS.some(user => user.id !== editingId && user.username.toLowerCase() === username.toLowerCase())) {
    error("یہ یوزر نیم پہلے سے موجود ہے");
    return;
  }
  if (role === "user" && !assignments.length) {
    error("یوزر کو کم از کم ایک صوبہ اسائن کریں");
    return;
  }
  const submit = $("userForm").querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await manageUser({
      action: editingId ? "update" : "create",
      uid: editingId,
      username,
      password: password || undefined,
      role,
      active: $("uActive").checked,
      assignments
    });
    const user = result.data;
    if (user.id === me.id) me = { ...me, ...user };
    await saveLog(editingId ? "یوزر ترمیم" : "نیا یوزر", `${username} — ${role}`);
    $("userDlg").close();
    renderUsers();
  } catch (err) {
    error(err.message || "یوزر محفوظ نہیں ہو سکا");
  } finally {
    submit.disabled = false;
  }
});

$("userTable").addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button || !requireAdmin()) return;
  const user = USERS.find(item => item.id === button.dataset.id);
  if (!user) return;
  if (button.dataset.act === "edit") openUserDlg(user);
  if (button.dataset.act === "del" && user.id !== me.id &&
      confirm(`یوزر "${user.username}" اور اس کا لاگ اِن حذف کریں؟`)) {
    try {
      await manageUser({ action: "delete", uid: user.id });
      await saveLog("یوزر حذف", user.username);
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
  if (newPassword || repeatPassword) {
    if (newPassword !== repeatPassword) { message("نئے پاس ورڈ ایک جیسے نہیں", false); return; }
    problem = pwProblem(newPassword, newUsername);
    if (problem) { message(problem, false); return; }
  }
  try {
    const credential = EmailAuthProvider.credential(userEmail(me.username), currentPassword);
    await reauthenticateWithCredential(auth.currentUser, credential);
    if (newPassword) await updatePassword(auth.currentUser, newPassword);
    if (newUsername !== me.username) {
      const result = await manageSelf({ username: newUsername });
      me = { ...me, ...result.data };
      $("whoLabel").textContent = `${me.username} (ایڈمن)`;
    }
    $("aCur").value = $("aNew").value = $("aNew2").value = "";
    message("محفوظ ہو گیا", true);
    await saveLog("ایڈمن نام/پاس ورڈ تبدیل");
  } catch (error) {
    message(error.code === "auth/wrong-password" ? "موجودہ پاس ورڈ غلط ہے" : error.message, false);
  }
});

$("backupBtn").addEventListener("click", async () => {
  if (!requireAdmin()) return;
  try {
    const [records, entries] = await Promise.all([
      getDocs(collection(db, "records")), getDocs(collection(db, "entries"))
    ]);
    const backup = {
      version: 2, records: records.docs.map(d => ({ id: d.id, ...d.data() })),
      entries: entries.docs.map(d => ({ id: d.id, ...d.data() }))
    };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `backup_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    await saveLog("بیک اپ ڈاؤن لوڈ");
  } catch (error) {
    reportError("بیک اپ نہیں بن سکا", error);
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
      for (let offset = 0; offset < backup.records.length; offset += 400) {
        const batch = writeBatch(db);
        backup.records.slice(offset, offset + 400).forEach(item => {
          if (!item.id || !item.data) throw new Error("بیک اپ میں ریکارڈ کا فارمیٹ درست نہیں");
          const row = normalizeRecord(item.data);
          if (!row) throw new Error("بیک اپ میں ریکارڈ کا صوبہ یا کوڈ موجود نہیں");
          const province = row[K.province];
          const assignedTo = USERS.filter(user => userCanSeeRegion(user, row)).map(user => user.id);
          batch.set(doc(db, "records", item.id), {
            data: row, province, division: row[K.division],
            district: row[K.district], assignedTo,
            sourceKey: `${row[K.code]}|${province}`, updatedAt: nowStr()
          });
        });
        await batch.commit();
      }
      for (let offset = 0; offset < backup.entries.length; offset += 400) {
        const batch = writeBatch(db);
        backup.entries.slice(offset, offset + 400).forEach(item => {
          if (!item.id || !item.recordId || !item.userId) throw new Error("بیک اپ میں انٹری کا فارمیٹ درست نہیں");
          batch.set(doc(db, "entries", item.id), item);
        });
        await batch.commit();
      }
      await saveLog("بیک اپ بحال");
      alert("بحالی مکمل ہو گئی");
    } catch (error) {
      reportError("بیک اپ بحال نہیں ہوا", error);
    }
  };
  reader.readAsText(file);
});
