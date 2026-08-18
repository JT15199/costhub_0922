
import sqlite3, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
con = sqlite3.connect(r'C:/Users/96529/Desktop/AI coding folder/monitor-cost-main/src-tauri/target/release/costhub.db')
print('audit_findings:', con.execute('SELECT status, source, COUNT(*) FROM audit_findings GROUP BY status, source').fetchall())
print('---audit sample---')
for r in con.execute('SELECT id,type,status,source,title FROM audit_findings ORDER BY id DESC LIMIT 12').fetchall():
    print(r)
print('advisor:', con.execute('SELECT status, COUNT(*) FROM ai_advisor_insights GROUP BY status').fetchall())
print('think_logs:', con.execute('SELECT status, COUNT(*) FROM ai_think_logs GROUP BY status').fetchall())
print('review:', con.execute("SELECT value FROM settings WHERE key='ai_bridge_review'").fetchall())
print('insights:', con.execute('SELECT status, COUNT(*) FROM part_insights GROUP BY status').fetchall())
