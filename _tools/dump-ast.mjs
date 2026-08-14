import fs from 'fs';
import ts from 'typescript';

const file = process.argv[2];
const outFile = process.argv[3];
const src = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile('db.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const out = [];
for (const stmt of sf.statements) {
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
  else if (ts.isExportDeclaration(stmt)) { kind = 'export'; name = stmt.exportClause ? stmt.exportClause.getText() : '*'; }
  else { kind = 'other'; name = ts.SyntaxKind[stmt.kind]; }
  out.push({ kind, name, start: stmt.getFullStart(), end: stmt.end });
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('written', out.length, 'statements');