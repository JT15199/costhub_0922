import fs from 'fs';
import ts from 'typescript';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile('db.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const out = [];
for (const stmt of sf.statements) {
  const start = stmt.getFullStart();
  const end = stmt.end;
  const text = src.slice(start, end);
  let name = '';
  let kind = 'other';
  if (ts.isFunctionDeclaration(stmt)) { kind = 'function'; name = stmt.name ? stmt.name.text : '(anon)'; }
  else if (ts.isVariableStatement(stmt)) {
    kind = 'variable';
    const names = [];
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) names.push(d.name.text);
      else names.push('(pattern)');
    }
    name = names.join(',');
  }
  else if (ts.isImportDeclaration(stmt)) { kind = 'import'; name = stmt.moduleSpecifier.getText(); }
  else if (ts.isExportDeclaration(stmt)) { kind = 'export'; name = 'export-decl'; }
  else { kind = 'other'; name = ts.SyntaxKind[stmt.kind]; }
  const first = text.split('\n')[0].trim().slice(0, 80);
  out.push({ start, end, kind, name, first });
}

for (const o of out) {
  console.log(o.kind.padEnd(10) + ' ' + o.name.padEnd(40).slice(0,40) + ' ' + o.start + '..' + o.end + '  ' + o.first);
}
console.log('TOTAL:', out.length);