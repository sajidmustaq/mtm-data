import { readFileSync, writeFileSync } from 'fs';

const content = readFileSync('./app.js', 'utf8');

// renderScopeChecks میں provinces کو PROVINCE_DIVISIONS سے fallback دیں
const oldLine = '  $(\"uScopeSelections\").innerHTML = provinces.map(province => {';
const newLine = '  // provinces لوڈ نہ ہوں تو PROVINCE_DIVISIONS سے فہرست لیں\r\n  const scopeProvinces = provinces.length ? provinces : Object.keys(PROVINCE_DIVISIONS).sort();\r\n  $(\"uScopeSelections\").innerHTML = scopeProvinces.map(province => {';

if (!content.includes(oldLine)) {
  console.error('❌ line نہیں ملی');
  // debug
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.includes('uScopeSelections') && l.includes('provinces.map'));
  console.log('found at line:', idx+1, JSON.stringify(lines[idx]));
  process.exit(1);
}

const newContent = content.replace(oldLine, newLine);
writeFileSync('./app.js', newContent, 'utf8');
console.log('✅ renderScopeChecks اپڈیٹ ہو گیا');
process.exit(0);
