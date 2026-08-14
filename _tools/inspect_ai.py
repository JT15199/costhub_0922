import sqlite3
conn = sqlite3.connect(r'C:/Users/96529/Desktop/AI coding folder/monitor-cost-main/src-tauri/target/release/costhub.db')
cur = conn.cursor()
print('=== api_providers ===')
for r in cur.execute('SELECT provider_type, provider_name, base_url, model_name, is_active, is_preset, priority FROM api_providers'):
    print(r)
print('=== settings AI-related ===')
for r in cur.execute("SELECT key, value FROM settings WHERE key LIKE '%ai%' OR key LIKE '%model%' OR key LIKE '%search%' OR key LIKE '%llama%'"):
    print(r)
print('=== usage counts ===')
for t in ['trend_items','part_insights','ai_request_logs','work_summaries','cost_change_log','local_ai_messages']:
    try:
        n = cur.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]
        print(t, n)
    except Exception as e:
        print(t, 'ERR', e)
conn.close()