import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { readdirSync, readFileSync } from "fs";

export const TARGET_PROJECT_ID = "student-portal-5dd94";
export const OLD_PROJECT_ID = "mtm-data";
export const EMAIL_DOMAIN = "student-portal-5dd94.firebaseapp.com";

export const nfc = v => String(v ?? "").normalize("NFC");
export const clean = v => nfc(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

export const K = {
  code:     "عملہ کوڈ",
  name:     "نام",
  father:   "ولدیت",
  branch:   "شاخ",
  duty:     "ذمہ داری",
  district: "ڈسٹرکٹ",
  division: "سرکاری ڈویژن",
  province: "صوبائی/انتظامی اکائی",
  offMin:   "آفیشل منٹ",
  grade:    "گریڈ",
  ijaraMin: "اجارے کے منٹ",
  hifz:     "کیا یہ مدرس حقیتا حفظ کا درجہ بڑھا رہے ہیں",
  nazra:    "کیا یہ حقیقتا ناظرہ کا درجہ  پڑھا رہےہیں"
};

export const PROVINCES = {
  "اسلام آباد":           ["وفاقی دار الحکومت"],
  "اندرون سندھ":         ["جیکب آباد","بھنبور","حیدرآباد","لاڑکانہ","نوابشاہ","میرپور خاص","سکھر"],
  "بلوچستان":            ["کوئٹہ","نصیرآباد","سبی","رخشان","مکران","قلات","لورالائی"],
  "خیبر پختونخواہ":      ["کوہاٹ","ڈیرہ اسمٰعیل خان","ہزارہ","پشاور","مالاکنڈ","بنوں"],
  "صحرائے مدینہ کراچی": ["صحرائے مدینہ ڈویژن(فرضی)"],
  "لاہور":               ["لاہور"],
  "پنجاب":               ["ڈیرہ غازی خان","فیصل آباد","گوجرنوالہ","گجرات","ساہیوال","راولپنڈی","ملتان","بہاولپور","سرگودھا","شیخوپورہ"],
  "کراچی":               ["کراچی ایسٹ ڈویژن","کراچی ویسٹ ڈویژن","کراچی بن قاسم ڈوٰژن","کراچی سنٹرل ڈوژین","کراچی ساؤتھ ڈویژن"],
  "کشمیر":               ["میرپور","پونجھ","مظفرآباد"],
  "گلگت بلتستان":        ["دیامر","گلگت"]
};

export function findServiceAccountPath(projectId, explicitPath = "") {
  if (explicitPath) return explicitPath;
  const files = readdirSync(".").filter(f => /-adminsdk-.*\.json$/i.test(f));
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(`./${file}`, "utf8"));
      if (parsed.project_id === projectId) return `./${file}`;
    } catch {
      // Ignore unreadable JSON candidates
    }
  }
  throw new Error(
    `پروجیکٹ "${projectId}" کی Service Account JSON فائل نہیں ملی۔\n` +
    `Firebase Console (${projectId}) → Project Settings → Service accounts → Generate new private key سے فائل ڈاؤن لوڈ کر کے اس فولڈر میں رکھیں۔`
  );
}

export function initFirebaseProject(projectId, appName = projectId, explicitPath = "") {
  const keyPath = findServiceAccountPath(projectId, explicitPath);
  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  const existing = getApps().find(a => a.name === appName);
  const app = existing || initializeApp({ credential: cert(serviceAccount) }, appName);
  return {
    app,
    db: getFirestore(app),
    auth: getAuth(app),
    keyPath,
    projectId: serviceAccount.project_id
  };
}

export function normalizeRow(rawRow) {
  if (!rawRow || typeof rawRow !== "object") return null;
  const byNfcKey = {};
  for (const [key, val] of Object.entries(rawRow)) {
    byNfcKey[nfc(key).trim()] = val;
  }
  const code = clean(byNfcKey[nfc(K.code)]);
  const province = clean(byNfcKey[nfc(K.province)]);
  if (!code || !province) return null;

  const data = {};
  for (const field of Object.values(K)) {
    const val = byNfcKey[nfc(field)];
    if (val !== null && val !== undefined && val !== "") {
      data[field] = clean(val);
    }
  }
  data[K.hifz] = "";
  data[K.nazra] = "";

  const division = clean(byNfcKey[nfc(K.division)]);
  const district = clean(byNfcKey[nfc(K.district)]);
  const sourceKey = `${code}|${province}`;
  const recordId = encodeURIComponent(sourceKey);

  return { recordId, sourceKey, province, division, district, data };
}

export function userCanSeeRegion(user, province, division) {
  if (!user?.active) return false;
  if (user.role === "admin") return true;
  if (!Array.isArray(user.assignments)) return false;
  const normProv = nfc(province);
  const normDiv = nfc(division);
  return user.assignments.some(a =>
    nfc(a.province) === normProv &&
    (!Array.isArray(a.divisions) || !a.divisions.length || a.divisions.some(d => nfc(d) === normDiv))
  );
}

export async function syncRecords(db, uid, assignments) {
  const previous = await db.collection("records").where("assignedTo", "array-contains", uid).get();
  const desired = new Map();
  for (const a of assignments) {
    const prov = nfc(a.province).trim();
    const divs = (a.divisions || []).map(d => nfc(d).trim());
    const snap = await db.collection("records").where("province", "==", prov).get();
    snap.docs.forEach(d => {
      const data = d.data();
      if (!divs.length || divs.includes(nfc(data.division || ""))) {
        desired.set(d.id, d.ref);
      }
    });
  }
  const updates = new Map();
  previous.docs.forEach(d => { if (!desired.has(d.id)) updates.set(d.id, { ref: d.ref, add: false }); });
  desired.forEach((ref, id) => updates.set(id, { ref, add: true }));
  const list = [...updates.values()];
  const nowMs = Date.now();
  for (let i = 0; i < list.length; i += 400) {
    const batch = db.batch();
    list.slice(i, i + 400).forEach(item => {
      batch.update(item.ref, {
        assignedTo: item.add ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid),
        updatedAtMs: nowMs
      });
    });
    await batch.commit();
  }
  return list.length;
}
