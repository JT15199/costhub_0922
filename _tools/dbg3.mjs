import fs from 'fs';
import ts from 'typescript';
const src = fs.readFileSync(process.argv[2], 'utf8');
const sf = ts.createSourceFile('db.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
for (const stmt of sf.statements) {
  if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === 'ensureSchema') {
    const t = src.slice(stmt.getFullStart(), stmt.end);
    console.log('ensureSchema fullStart:', stmt.getFullStart(), 'end:', stmt.end, 'len:', t.length);
    console.log('=== last 300 chars ===');
    console.log(JSON.stringify(t.slice(-300)));
    console.log('=== first 120 ===');
    console.log(JSON.stringify(t.slice(0, 120)));
  }
  if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === 'getParts') {
    console.log('getParts fullStart:', stmt.getFullStart(), 'end:', stmt.end);
    const t = src.slice(stmt.getFullStart(), stmt.end);
    console.log('=== getParts first 100 ===');
    console.log(JSON.stringify(t.slice(0, 100)));
  }
}