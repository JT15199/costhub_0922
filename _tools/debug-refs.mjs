import fs from 'fs';
import path from 'path';
import ts from 'typescript';
const ROOT = process.argv[2];
const src = fs.readFileSync(path.join(ROOT, 'src', 'db.ts'), 'utf8');
const ast = JSON.parse(fs.readFileSync(path.join(ROOT, '_tools', 'db-ast.json'), 'utf8'));

const DOMAINS = {
  core: ['db','dbUrl','schemaReady','dataLocked','rawDb','AUTH_KEY','AUTH_PLAIN_KEY','AUTH_CHANGED_KEY','AUTH_USERNAME_KEY','DEFAULT_PASSWORD','DEFAULT_USERNAME','sha256','getRawDb','getDbUrl','isAuthQuery','getDb','ignoreSchemaError','ensureSchema','localNow'],
  parts: ['getParts','getPart','savePart','deletePart','getPriceHistory','getCategories','getMainCategories','getSubCategories','getAllPartSuppliers','getPartSuppliers','addPartSupplier','updatePartSupplier','deletePartSupplier','updatePartWeightedCost','getSupplierPriceHistory'],
};
const nameToDomain = Object.create(null);
for (const [dom, names] of Object.entries(DOMAINS)) for (const nm of names) nameToDomain[nm] = dom;

const partsStmts = ast.filter(s => {
  if (s.kind !== 'function' && s.kind !== 'variable') return false;
  const first = s.name.split(',')[0];
  return nameToDomain[first] === 'parts';
});
const text = partsStmts.map(s => src.slice(s.start, s.end)).join('\n');
const sfs = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const refs = new Set();
const locals = new Set();
function visit(node) {
  if (ts.isIdentifier(node)) refs.add(node.text);
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    const nm = node.name;
    if (ts.isIdentifier(nm)) locals.add(nm.text);
  }
  if (ts.isFunctionDeclaration(node) && node.name) locals.add(node.name.text);
  ts.forEachChild(node, visit);
}
visit(sfs);
console.log('refs size:', refs.size);
console.log('has getDb:', refs.has('getDb'), 'has recordProjectCostSnapshot:', refs.has('recordProjectCostSnapshot'));
const cross = [...refs].filter(nm => nameToDomain[nm] && !DOMAINS['parts'].includes(nm) && !locals.has(nm));
console.log('cross:', cross.join(', '));