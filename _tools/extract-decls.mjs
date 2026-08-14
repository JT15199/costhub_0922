import fs from 'fs';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const n = src.length;

function extractDecls(src) {
  const decls = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && c2 === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { j += 1; break; }
        j += 1;
      }
      i = j; continue;
    }
    if (c === '{') {
      let k = i;
      while (k > 0 && src[k] !== '\n' && src[k] !== ';') k--;
      const line = src.slice(k, i).trim();
      const isFunc = /(export\s+)?(async\s+)?function\s+[A-Za-z0-9_$]+/.test(line) && !/=>/.test(line);
      const isConst = /(export\s+)?(const|let|var)\s+[A-Za-z0-9_$]+/.test(line) && !/=>/.test(line);
      if (isFunc || isConst) {
        let s = k, p = k;
        while (p > 0) {
          const prev = src.lastIndexOf('\n', p - 1);
          const seg = src.slice(prev + 1, p).trim();
          if (/^export|^async|^function|^const|^let|^var/.test(seg)) { s = prev + 1; break; }
          if (seg.endsWith(';')) break;
          p = prev;
          if (p <= 0) break;
        }
        let depth = 1, j = i + 1, st = 'n';
        while (j < n && depth > 0) {
          const cc = src[j], cc2 = src[j + 1];
          if (st === 'n') {
            if (cc === '/' && cc2 === '/') { st = 'lc'; j += 2; continue; }
            if (cc === '/' && cc2 === '*') { st = 'bc'; j += 2; continue; }
            if (cc === '\'' || cc === '"' || cc === '`') { st = (cc === '`') ? 't' : 's'; j += 1; continue; }
            if (cc === '{') depth += 1;
            else if (cc === '}') depth -= 1;
          } else if (st === 'lc') { if (cc === '\n') st = 'n'; }
          else if (st === 'bc') { if (cc === '*' && cc2 === '/') { st = 'n'; j += 1; } }
          else if (st === 's') { if (cc === '\\') j += 1; else if (cc === '\'' || cc === '"') st = 'n'; }
          else if (st === 't') { if (cc === '\\') j += 1; else if (cc === '`') st = 'n'; }
          j += 1;
        }
        decls.push({ start: s, end: j, text: src.slice(s, j) });
        i = j; continue;
      }
    }
    i += 1;
  }
  return decls;
}

const decls = extractDecls(src);
for (const d of decls) {
  const firstLine = d.text.split('\n')[0].trim().slice(0, 95);
  console.log(d.start + '..' + d.end + '  ' + firstLine);
}
console.log('TOTAL:', decls.length);