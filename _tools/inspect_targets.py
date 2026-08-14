import sqlite3
conn = sqlite3.connect(r'C:/Users/96529/Desktop/AI coding folder/monitor-cost-main/src-tauri/target/release/costhub.db')
cur = conn.cursor()
print('=== projects ===')
for r in cur.execute('SELECT id, code, name, project_type, tier, status, platform_fee_rate, profit_rate FROM projects'):
    print(r)
print('=== project_targets ===')
for r in cur.execute('SELECT * FROM project_targets'):
    print(r)
print('=== project_cost_snapshots (last 6) ===')
for r in cur.execute('SELECT id, project_id, snapshot_type, change_reason, bom_cost, total_cost, created_at FROM project_cost_snapshots ORDER BY id DESC LIMIT 6'):
    print(r)
print('=== project_cost_snapshots count per project ===')
for r in cur.execute('SELECT project_id, COUNT(*), MIN(created_at), MAX(created_at) FROM project_cost_snapshots GROUP BY project_id'):
    print(r)
conn.close()