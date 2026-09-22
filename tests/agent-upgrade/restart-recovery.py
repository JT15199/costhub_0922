import json
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "artifacts" / "agent-upgrade" / "20260910-p00" / "database-copy.db"
OUT = ROOT / "artifacts" / "agent-upgrade" / "20260910-restart-recovery"
DB = OUT / "restart-copy.db"


def connect():
    db = sqlite3.connect(DB)
    db.execute("PRAGMA foreign_keys=ON")
    return db


def write_state():
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE, DB)
    db = connect()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS local_ai_session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT DEFAULT '',
          seq INTEGER NOT NULL DEFAULT 0,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS local_ai_action_ledger (
          action_id TEXT PRIMARY KEY,
          session_id INTEGER NOT NULL,
          run_id TEXT DEFAULT '',
          tool_id TEXT NOT NULL,
          args_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          result_json TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now','localtime')),
          updated_at TEXT DEFAULT (datetime('now','localtime'))
        );
        """
    )
    session_id = db.execute("SELECT id FROM local_ai_sessions ORDER BY id LIMIT 1").fetchone()
    if session_id is None:
        db.execute("INSERT INTO local_ai_sessions(title, pi_state_json) VALUES (?, ?)", ("Recovery probe", ""))
        session_id = (db.execute("SELECT last_insert_rowid()").fetchone()[0],)
    session_id = session_id[0]
    state = {
        "version": 2,
        "messages": [{"role": "user", "content": "保留这条原始上下文"}],
        "compaction": {"summary": "unknown action remains pending", "sourceEnd": 1},
    }
    db.execute("UPDATE local_ai_sessions SET pi_state_json=?, updated_at=datetime('now','localtime') WHERE id=?", (json.dumps(state, ensure_ascii=False), session_id))
    db.execute("INSERT OR REPLACE INTO local_ai_session_events(session_id,event_id,run_id,seq,event_type,payload_json) VALUES(?,?,?,?,?,?)", (session_id, "restart-event-1", "restart-run", 1, "run_started", json.dumps({"raw": "保留"}, ensure_ascii=False)))
    db.execute("INSERT OR REPLACE INTO local_ai_action_ledger(action_id,session_id,run_id,tool_id,args_json,status) VALUES(?,?,?,?,?,?)", ("restart-action-1", session_id, "restart-run", "save_quote", "{\"amount\":42}", "unknown"))
    db.commit()
    db.close()
    print(json.dumps({"phase": "writer", "sessionId": session_id, "closedAt": datetime.now().isoformat()}))


def verify_state():
    db = connect()
    session = db.execute("SELECT pi_state_json FROM local_ai_sessions WHERE pi_state_json LIKE '%保留这条原始上下文%' ORDER BY id DESC LIMIT 1").fetchone()
    event = db.execute("SELECT event_type,payload_json FROM local_ai_session_events WHERE event_id='restart-event-1'").fetchone()
    action = db.execute("SELECT status,args_json FROM local_ai_action_ledger WHERE action_id='restart-action-1'").fetchone()
    assert session and json.loads(session[0])["messages"][0]["content"] == "保留这条原始上下文"
    assert event and json.loads(event[1])["raw"] == "保留"
    assert action and action[0] == "unknown" and json.loads(action[1])["amount"] == 42
    result = {"phase": "reader-after-process-restart", "stateRestored": True, "eventRestored": True, "unknownActionRestored": True}
    db.close()
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        write_state()
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--verify"], check=True)
    else:
        verify_state()
