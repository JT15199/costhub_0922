import json
import pathlib
import sqlite3

source = pathlib.Path('src-tauri/target/release/costhub.db')
out = pathlib.Path('artifacts/agent-upgrade/20260910-p00/database-copy.db')
out.parent.mkdir(parents=True, exist_ok=True)
if not source.exists():
    raise SystemExit(f'missing source database: {source}')
with sqlite3.connect(source) as src:
    with sqlite3.connect(out) as dst:
        src.backup(dst)
with sqlite3.connect(out) as db:
    integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    counts = {name: db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for (name,) in tables}
print(json.dumps({'source': str(source.resolve()), 'copy': str(out.resolve()), 'integrity': integrity, 'tables': len(tables), 'counts': counts}, ensure_ascii=False, indent=2))
