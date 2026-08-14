import fs from 'fs';
import path from 'path';
const ROOT = process.argv[2];
const ast = JSON.parse(fs.readFileSync(path.join(ROOT, '_tools', 'db-ast.json'), 'utf8'));
console.log('ast entries:', ast.length);
const funcs = ast.filter(s => s.kind === 'function');
console.log('functions:', funcs.length);
console.log('first func:', JSON.stringify(funcs[0]).slice(0, 120));
const src = fs.readFileSync(path.join(ROOT, 'src', 'db.ts'), 'utf8');
console.log('db.ts length:', src.length);
const s = funcs.find(f => f.name === 'getParts');
if (s) { console.log('getParts start/end:', s.start, s.end); console.log('slice:', src.slice(s.start, s.end).slice(0, 80)); }
else console.log('getParts NOT FOUND in ast');