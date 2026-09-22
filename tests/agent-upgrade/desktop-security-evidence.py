import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "artifacts" / "agent-upgrade" / "20260910-desktop-fixture"
DB = FIXTURE / "costhub.db"
OUT = ROOT / "artifacts" / "agent-upgrade" / "20260911-desktop-security"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    session = conn.execute(
        "SELECT id, title, created_at, updated_at FROM local_ai_sessions ORDER BY id DESC LIMIT 1"
    ).fetchone()
    message = conn.execute(
        "SELECT role, content, created_at FROM local_ai_messages WHERE role = 'user' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    events = conn.execute(
        "SELECT event_type, payload_json FROM local_ai_session_events WHERE session_id = ? ORDER BY id ASC"
        , (session[0],)
    ).fetchall()
    action_count = conn.execute("SELECT COUNT(*) FROM local_ai_action_ledger").fetchone()[0]
    business_counts = {}
    for table in ("parts", "projects", "project_boms", "voice_item", "work_logs"):
        business_counts[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    conn.close()

    payload = {
        "mode": "desktop",
        "fixture": str(FIXTURE),
        "formalDatabaseTouched": False,
        "readOnlyAttachmentGuard": {
            "session": session,
            "latestMessage": message,
            "latestEvents": events,
            "actionLedgerCount": action_count,
            "businessCounts": business_counts,
            "expected": "attachment is evidence only; no import/write action",
        },
    }
    (OUT / "desktop-security-evidence.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    event_types = [event[0] for event in events]
    prepared = [json.loads(event[1]) for event in events if event[0] == "tool_prepared"]
    assert action_count == 0
    assert message and "不可信证据" in message[1]
    assert "tool_prepared" in event_types and any(item.get("pending", {}).get("name") == "read" for item in prepared)
    assert "checkpoint" in event_types
    print(json.dumps({"output": str(OUT), "actionLedgerCount": action_count}, ensure_ascii=False))


if __name__ == "__main__":
    main()
