// Offline check of the actual Rust header guard. No Tauri/database/network calls.
// Run: node docs/review-astra-cloud-20260905.mjs (requires the installed rustc).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
const start = source.indexOf('fn safe_provider_headers(');
const end = source.indexOf('fn query_escape(', start);
if (start < 0 || end < 0) throw new Error('Header guard moved; update source extraction before running.');
const dir = path.join(root, 'src-tauri/target/review-astra');
fs.mkdirSync(dir, { recursive: true });
const rustFile = path.join(dir, 'review_headers.rs');
const binary = path.join(dir, process.platform === 'win32' ? 'review_headers.exe' : 'review_headers');
fs.writeFileSync(rustFile, `use std::collections::HashMap;
${source.slice(start, end)}
fn main() {
    let cases = [
        ("normal JSON header", "Content-Type", "application/json", true),
        ("unknown header rejected", "X-Private", "SYNTHETIC_MARKER", false),
        ("private parameter in allowed header rejected", "Accept", "application/json; note=SYNTHETIC_PRIVATE_MARKER", false),
    ];
    let mut failures = 0;
    for (name, key, value, expected) in cases {
        let accepted = safe_provider_headers(HashMap::from([(key.to_string(), value.to_string())])).is_ok();
        if accepted != expected { failures += 1; }
        println!("{} {} (accepted={}, expected={})", if accepted == expected { "PASS" } else { "FAIL" }, name, accepted, expected);
    }
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
`);
const compile = spawnSync('rustc', ['--edition=2021', rustFile, '-o', binary], { cwd: root, encoding: 'utf8', windowsHide: true });
if (compile.error || compile.status !== 0) throw new Error(compile.error?.message || compile.stderr);
const result = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true });
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
