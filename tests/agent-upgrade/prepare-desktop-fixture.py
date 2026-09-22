import hashlib
import json
import os
import shutil
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "artifacts" / "agent-upgrade" / "20260910-p00" / "database-copy.db"
OUT = Path(os.environ.get("COSTHUB_FIXTURE_DIR", ROOT / "artifacts" / "agent-upgrade" / "20260910-desktop-fixture"))
OUT.mkdir(parents=True, exist_ok=True)
DB = OUT / "costhub.db"
EXE = Path(os.environ.get("COSTHUB_FIXTURE_EXE", ROOT / "artifacts" / "agent-upgrade" / "20260910-portable" / "CostHub-Portable" / "CostHub.exe"))
for sidecar in OUT.glob("costhub.db-*"):
    sidecar.unlink(missing_ok=True)
shutil.copy2(SOURCE, DB)
shutil.copy2(EXE, OUT / "CostHub.exe")

username = "agent-test"
password = "agent-test-666"
fixture_model = os.environ.get("COSTHUB_FIXTURE_MODEL", "").strip()
db = sqlite3.connect(DB)
db.execute(
    "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
    ("auth_username", username),
)
db.execute(
    "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
    ("auth_password_hash", hashlib.sha256(password.encode()).hexdigest()),
)
db.execute(
    "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
    ("auth_password_changed", "1"),
)
db.execute("DELETE FROM settings WHERE key='auth_password_plain'")
if fixture_model:
    db.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
        ("local_ai_model", fixture_model),
    )
db.commit()
integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
db.close()
assert integrity == "ok"
(OUT / "desktop-fixture.json").write_text(
    json.dumps(
        {
            "mode": "desktop-fixture",
            "database": str(DB),
            "executable": str(OUT / "CostHub.exe"),
            "username": username,
            "password": password,
            "formalDatabaseTouched": False,
            "integrity": integrity,
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
print(json.dumps({"directory": str(OUT), "integrity": integrity, "formalDatabaseTouched": False}))
