// Run: node prototypes/liquid-glass-20260906/check.mjs
// Check the prototype's actual demo model; browser interactions are recorded in the design handoff.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const file = new URL('./app.js', import.meta.url);
execFileSync(process.execPath, ['--check', fileURLToPath(file)]);
const source = readFileSync(file, 'utf8').split('let inputIsKeyboard=false;')[0];
runInNewContext(source + `
assert.equal(domains.reduce((s,r)=>s+r[1],0),610);
assert.equal(domains.reduce((s,r)=>s+r[2],0),605);
assert.equal(money(domains.reduce((s,r)=>s+r[2],0)*1.05), '635.25');
assert.equal(money((610-605)*1.05),'5.25');
assert.equal(new Set(notes.map(n=>n.id)).size,notes.length);
assert.ok(notes.every(n=>books[n.book]));
assert.ok(notes.filter(n=>n.source).every(n=>books[n.book].code==='M27-Q'));
for(const p of projects){
  if(p.risk==='已达标')assert.ok(p.goal!==null&&p.bom*1.05<=p.goal);
  if(p.goal===null)assert.equal(p.risk,'目标待确认');
}
`, { assert });
console.log('PASS: script syntax, cost conservation, note ownership, target semantics');
