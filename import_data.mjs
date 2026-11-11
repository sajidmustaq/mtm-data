/**
 * MTM Data — Firestore ڈیٹا امپورٹ (student-portal-5dd94)
 * استعمال: node import_data.mjs [data.json]
 */

import { readFileSync } from "fs";
import {
  TARGET_PROJECT_ID,
  initFirebaseProject,
  normalizeRow,
  userCanSeeRegion
} from "./firebase_admin_helper.mjs";

const DATA_PATH = process.argv[2] || "./data.json";
const { db, keyPath, projectId } = initFirebaseProject(TARGET_PROJECT_ID, "target");
console.log(`🔑 Firebase Project: ${projectId} (${keyPath})`);

const rawData = JSON.parse(readFileSync(DATA_PATH, "utf8"));
if (!Array.isArray(rawData)) throw new Error("JSON فائل ریکارڈز کی فہرست (array) ہونی چاہیے۔");
console.log(`📂 کل قطاریں (${DATA_PATH}): ${rawData.length}`);

const usersSnap = await db.collection("users").get();
const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
console.log(`👤 موجودہ فعال یوزرز: ${users.filter(u => u.active).length}`);

const deduplicated = new Map();
let skipped = 0;
for (const row of rawData) {
  const norm = normalizeRow(row);
  if (!norm) { skipped++; continue; }
  deduplicated.set(norm.recordId, norm);
}

const records = [...deduplicated.values()];
console.log(`✅ منفرد درست ریکارڈ: ${records.length} (چھوڑے: ${skipped})`);

const existing = await db.collection("records").limit(1).get();
if (!existing.empty) {
  console.log("⚠️  Firestore میں records پہلے سے موجود ہیں؛ پرانے ریکارڈ اپڈیٹ ہوں گے۔");
}

console.log("\n🚀 امپورٹ شروع ہو رہا ہے...\n");

let success = 0;
const BATCH_SIZE = 400;
const updatedAt = new Date().toLocaleString("en-GB", { hour12: false });
const updatedAtMs = Date.now();

for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = db.batch();
  const chunk = records.slice(i, i + BATCH_SIZE);

  for (const rec of chunk) {
    const ref = db.collection("records").doc(rec.recordId);
    const assignedTo = users
      .filter(u => userCanSeeRegion(u, rec.province, rec.division))
      .map(u => u.id);

    batch.set(ref, {
      data: rec.data,
      province: rec.province,
      division: rec.division,
      district: rec.district,
      sourceKey: rec.sourceKey,
      assignedTo,
      updatedAt,
      updatedAtMs
    }, { merge: true });

    success++;
  }

  await batch.commit();
  process.stdout.write(`\r   ${Math.min(i + BATCH_SIZE, records.length)}/${records.length} ریکارڈ...`);
}

console.log(`\n\n✅ امپورٹ مکمل! کامیاب: ${success} | چھوڑے: ${skipped}`);
process.exit(0);
