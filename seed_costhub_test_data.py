"""Populate the portable CostHub database with isolated, repeatable demo data."""
import json
import argparse
import hashlib
import os
import sqlite3
from datetime import datetime, timedelta

MARK = "__costhub_test_data_v2__"
DEFAULT_SOURCE = os.path.abspath("src-tauri/target/release/costhub.db")
DEFAULT_OUTPUT = os.path.abspath("src-tauri/target/release/costhub_demo.db")


def parse_args():
    parser = argparse.ArgumentParser(description="Create an isolated CostHub demo database from a schema database.")
    parser.add_argument("--source-schema-db", required=True, help="Existing CostHub database used for schema only")
    parser.add_argument("--output-db", required=True, help="New demo database path")
    return parser.parse_args()


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_schema(source, output):
    if os.path.exists(output):
        os.remove(output)
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(output)
    try:
        rows = src.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 WHEN 'view' THEN 3 ELSE 4 END, name").fetchall()
        for _, _, sql in rows:
            dst.execute(sql)
        dst.commit()
    finally:
        src.close()
        dst.close()


def clear_business_tables(con):
    con.execute("PRAGMA foreign_keys=OFF")
    tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence'").fetchall()]
    for table in tables:
        try:
            con.execute(f'DELETE FROM "{table.replace(chr(34), chr(34) * 2)}"')
        except sqlite3.OperationalError:
            pass
    try:
        con.execute("DELETE FROM sqlite_sequence")
    except sqlite3.OperationalError:
        pass
    con.commit()


def main():
    args = parse_args()
    source = os.path.abspath(args.source_schema_db)
    DB = os.path.abspath(args.output_db)
    formal_db = os.path.abspath(DEFAULT_SOURCE)
    assert os.path.isfile(source), source
    assert source != DB, "source and output must differ"
    assert DB != formal_db, "refusing to overwrite the formal release costhub.db"
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    source_stat = os.stat(source)
    source_hash = file_sha256(source)
    copy_schema(source, DB)
    con = sqlite3.connect(DB)
    clear_business_tables(con)
    con.execute("PRAGMA foreign_keys=ON")

    def one(sql, args=()):
        return con.execute(sql, args).fetchone()

    def add_mark(table, column, sql, args):
        needle = next((str(value) for value in args if isinstance(value, str) and value.startswith(MARK)), MARK)
        found = one(f'SELECT id FROM "{table}" WHERE "{column}" LIKE ? LIMIT 1', (f"%{needle}%",))
        return found[0] if found else con.execute(sql, args).lastrowid

    def add_key(table, where_sql, where_args, insert_sql, insert_args):
        found = one(f'SELECT id FROM "{table}" WHERE {where_sql} LIMIT 1', where_args)
        return found[0] if found else con.execute(insert_sql, insert_args).lastrowid

    con.executescript("""
    CREATE TABLE IF NOT EXISTS ai_analysis_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE, skill_id TEXT DEFAULT '', skill_version TEXT DEFAULT '', status TEXT DEFAULT 'running', question TEXT DEFAULT '', data_fingerprint TEXT DEFAULT '', duration_ms INTEGER DEFAULT 0, warning TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT DEFAULT '', title TEXT NOT NULL, conclusion TEXT DEFAULT '', evidence_json TEXT DEFAULT '[]', confidence TEXT DEFAULT 'low', assumptions_json TEXT DEFAULT '[]', expected_impact_json TEXT DEFAULT '', action_json TEXT DEFAULT '{}', data_gaps_json TEXT DEFAULT '[]', risks_json TEXT DEFAULT '[]', status TEXT DEFAULT 'open', source TEXT DEFAULT 'local_rule', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_recommendation_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, recommendation_id INTEGER NOT NULL, usefulness TEXT DEFAULT '', adoption_status TEXT DEFAULT '', actual_saving REAL DEFAULT NULL, actual_result TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_approval_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_level TEXT NOT NULL DEFAULT 'C1', material TEXT NOT NULL, category TEXT DEFAULT '', question TEXT DEFAULT '', payload_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_egress_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id INTEGER DEFAULT 0, target TEXT DEFAULT '', model TEXT DEFAULT '', payload_hash TEXT DEFAULT '', fields_json TEXT DEFAULT '[]', status TEXT DEFAULT '', error_message TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_eval_results (id INTEGER PRIMARY KEY AUTOINCREMENT, fixture_id TEXT NOT NULL, metric TEXT NOT NULL, score REAL DEFAULT 0, detail TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS project_target_features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, domain TEXT DEFAULT '', feature_name TEXT DEFAULT '', is_new INTEGER DEFAULT 0, voice INTEGER DEFAULT 0, prev_cost REAL DEFAULT 0, target_cost REAL DEFAULT 0, sort_order INTEGER DEFAULT 0);
    """)
    con.execute("BEGIN")

    part_defs = [
        ("硬件类", "显示器件", "面板", "测试面板 27英寸 QHD 165Hz", "TST-PANEL-27QHD165", 720, "27英寸 / 2560x1440 / 165Hz"),
        ("硬件类", "主控", "驱动板", "测试主控驱动板", "TST-SCALER-X2", 188, "HDMI2.1 / DP1.4 / HDR"),
        ("硬件类", "存储", "内存", "测试 DDR4 2GB", "TST-DDR4-2G", 36, "DDR4 2666 2GB"),
        ("硬件类", "音频", "扬声器", "测试扬声器 3W", "TST-SPK-3W", 12, "2 x 3W"),
        ("结构类", "外壳", "后壳", "测试注塑后壳", "TST-REAR-27", 86, "ABS+PC，细纹黑"),
        ("结构类", "支架", "升降支架", "测试人体工学支架", "TST-STAND-ERG", 138, "升降/旋转/俯仰"),
        ("结构类", "外观", "前框", "测试窄边框前框", "TST-BEZEL-27", 42, "三边 2mm 窄边框"),
        ("电源类", "适配器", "电源适配器", "测试 180W 适配器", "TST-ADAPTER-180", 74, "19V / 9.47A"),
        ("电源类", "板卡", "内置电源板", "测试内置电源板", "TST-PSU-180", 92, "180W / 80Plus"),
        ("电源类", "芯片", "电源管理", "测试 PMIC", "TST-PMIC-88", 8.6, "电源时序管理"),
        ("线材类", "视频线", "DP线", "测试 DP1.4 线材", "TST-DP14-CABLE", 18, "1.8m / 8K认证"),
        ("线材类", "电源线", "电源线", "测试国标电源线", "TST-AC-CABLE", 6.5, "1.5m / 10A"),
        ("包材类", "包装", "彩盒", "测试彩盒", "TST-BOX-27", 24, "五层瓦楞纸"),
        ("加工费类", "制造", "SMT贴片", "测试驱动板 SMT", "TST-SMT-SCALER", 31, "含贴片、测试"),
        ("软件类", "固件", "显示固件", "测试显示固件授权", "TST-FW-HDR", 15, "HDR / OSD / OTA"),
        ("其他", "标识", "铭牌", "测试产品铭牌", "TST-LABEL-27", 2.2, "激光蚀刻"),
    ]
    parts = {}
    for main, sub, cat, name, model, cost, specs in part_defs:
        r = one("SELECT id FROM parts WHERE model=? AND remark LIKE ?", (model, f"%{MARK}%"))
        parts[model] = r[0] if r else con.execute(
            "INSERT INTO parts (main_category,sub_category,category,name,model,cost,specs,projects,remark) VALUES (?,?,?,?,?,?,?,?,?)",
            (main, sub, cat, name, model, cost, specs, "DEMO-TST-2401,DEMO-TST-2701,DEMO-TST-3201", MARK),
        ).lastrowid

    project_defs = [
        ("DEMO-TST-2401", "测试数据·主流办公显示器", "在研", "主流级", "进行中", "24.0", "1920x1080", "100Hz", "IPS", "显示器", 3, 8, "护眼与低功耗平衡"),
        ("DEMO-TST-2701", "测试数据·高刷电竞显示器", "在研", "中高端", "进行中", "27", "2560x1440", "165Hz", "Fast IPS", "显示器", 4, 10, "高刷、HDR、人体工学支架"),
        ("DEMO-TST-3201", "测试数据·专业创作显示器", "已完成", "高端", "暂停", "32", "3840x2160", "144Hz", "Mini LED", "显示器", 5, 12, "4K、广色域、局部调光"),
    ]
    projects = {}
    for code, name, ptype, tier, status, size, resolution, refresh, panel, category, fee, profit, specs in project_defs:
        r = one("SELECT id FROM projects WHERE code=?", (code,))
        projects[code] = r[0] if r else con.execute(
            "INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,category,specs,sort_order,is_deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
            (code, name, ptype, tier, status, size, resolution, refresh, panel, fee, profit, category, specs + ";" + MARK, 200 + len(projects)),
        ).lastrowid
        con.execute("UPDATE projects SET category=? WHERE id=?", (category, projects[code]))

    demo_bom_costs = {
        "DEMO-TST-2401": {"TST-PANEL-27QHD165": 720, "TST-SCALER-X2": 188, "TST-PSU-180": 92},
        "DEMO-TST-2701": {"TST-PANEL-27QHD165": 780, "TST-SCALER-X2": 205, "TST-PSU-180": 100},
        "DEMO-TST-3201": {"TST-PANEL-27QHD165": 690, "TST-SCALER-X2": 170, "TST-PSU-180": 96},
    }
    def fixture_cost(code, model):
        override = demo_bom_costs.get(code, {}).get(model)
        if override is not None:
            return override
        return one("SELECT cost FROM parts WHERE id=?", (parts[model],))[0]

    bom_defs = {
        "DEMO-TST-2401": [("显示模块", "TST-PANEL-27QHD165", 1), ("显示模块", "TST-SCALER-X2", 1), ("显示模块", "TST-DDR4-2G", 1), ("电源模块", "TST-ADAPTER-180", 1), ("电源模块", "TST-AC-CABLE", 1), ("结构模块", "TST-REAR-27", 1), ("结构模块", "TST-BEZEL-27", 1), ("包装模块", "TST-BOX-27", 1), ("制造模块", "TST-SMT-SCALER", 1)],
        "DEMO-TST-2701": [("显示模块", "TST-PANEL-27QHD165", 1), ("显示模块", "TST-SCALER-X2", 1), ("显示模块", "TST-DDR4-2G", 1), ("显示模块", "TST-FW-HDR", 1), ("音频模块", "TST-SPK-3W", 2), ("电源模块", "TST-PSU-180", 1), ("电源模块", "TST-PMIC-88", 1), ("结构模块", "TST-REAR-27", 1), ("结构模块", "TST-STAND-ERG", 1), ("结构模块", "TST-BEZEL-27", 1), ("线材模块", "TST-DP14-CABLE", 1), ("包装模块", "TST-BOX-27", 1), ("制造模块", "TST-SMT-SCALER", 1)],
        "DEMO-TST-3201": [("显示模块", "TST-PANEL-27QHD165", 1), ("显示模块", "TST-SCALER-X2", 1), ("显示模块", "TST-DDR4-2G", 2), ("显示模块", "TST-FW-HDR", 1), ("电源模块", "TST-PSU-180", 1), ("结构模块", "TST-REAR-27", 1), ("结构模块", "TST-STAND-ERG", 1), ("线材模块", "TST-DP14-CABLE", 2), ("包装模块", "TST-BOX-27", 1), ("制造模块", "TST-SMT-SCALER", 1)],
    }
    for code, items in bom_defs.items():
        pid = projects[code]
        grouped = {}
        for module, model, qty in items:
            grouped.setdefault(module, []).append((model, qty))
        for module, module_items in grouped.items():
            r = one("SELECT id FROM modules WHERE project_id=? AND name=?", (pid, module))
            mid = r[0] if r else con.execute(
                "INSERT INTO modules (project_id,name,module_category,category,description,is_virtual,estimated_cost,virtual_remark) VALUES (?,?,?,?,?,?,?,?)",
                (pid, module, module, "测试模块", MARK, 0, 0, ""),
            ).lastrowid
            for model, qty in module_items:
                p = one("SELECT main_category,sub_category,name,model,cost,specs FROM parts WHERE id=?", (parts[model],))
                bom_cost = fixture_cost(code, model)
                if not one("SELECT id FROM module_items WHERE module_id=? AND part_id=? AND remark LIKE ?", (mid, parts[model], f"%{MARK}%")):
                    con.execute("INSERT INTO module_items (module_id,part_id,part_name,part_model,main_category,sub_category,cost,quantity,remark) VALUES (?,?,?,?,?,?,?,?,?)", (mid, parts[model], p[2], p[3], p[0], p[1], bom_cost, qty, MARK))
                if not one("SELECT id FROM project_boms WHERE project_id=? AND part_id=? AND module_name=? AND remark LIKE ?", (pid, parts[model], module, f"%{MARK}%")):
                    ref = projects["DEMO-TST-2401"] if code == "DEMO-TST-2701" and module == "显示模块" and model == "TST-SCALER-X2" else 0
                    con.execute("INSERT INTO project_boms (project_id,part_id,module_name,quantity,cost,remark,is_reference,reference_remark,is_deleted,ref_project_id,part_name,part_model,part_cost,main_category,sub_category,part_specs,is_module_item,custom_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (pid, parts[model], module, qty, bom_cost, MARK, bool(ref), "测试引用：来自主流办公项目" if ref else "", 0, ref, p[2], p[3], bom_cost, p[0], p[1], p[5], 0, json.dumps({"报价版本": "R2", "测试标记": MARK}, ensure_ascii=False)))
                else:
                    con.execute("UPDATE project_boms SET cost=?, part_cost=? WHERE project_id=? AND part_id=? AND module_name=? AND remark LIKE ?", (bom_cost, bom_cost, pid, parts[model], module, f"%{MARK}%"))

    # Targets, measures, reviews, historical snapshots, SKU differences and groups.
    for code, pid in projects.items():
        bom_cost = sum(qty * fixture_cost(code, model) for _, model, qty in bom_defs[code])
        for domain, ratio in [("显示模块", .62), ("电源模块", .16), ("结构模块", .20)]:
            if not one("SELECT id FROM project_targets WHERE project_id=? AND domain=? AND remark LIKE ?", (pid, domain, f"%{MARK}%")):
                con.execute("INSERT INTO project_targets (project_id,domain,target_cost,remark) VALUES (?,?,?,?)", (pid, domain, round(bom_cost * ratio, 2), MARK))
        for i, (cat, measure, status, owner) in enumerate([("硬件类", "推动主控板降价 5%", "进行中", "采购经理"), ("结构类", "支架改为共用平台", "待执行", "结构工程"), ("电源类", "确认 180W 适配器第二供应商", "已完成", "供应链")]):
            if not one("SELECT id FROM project_measures WHERE project_id=? AND measure=? AND remark LIKE ?", (pid, measure, f"%{MARK}%")):
                due = (datetime(2026, 9, 10) + timedelta(days=i * 7)).strftime("%Y-%m-%d")
                con.execute("INSERT INTO project_measures (project_id,main_category,measure,status,due_date,owner,remark) VALUES (?,?,?,?,?,?,?)", (pid, cat, measure, status, due, owner, MARK))
        for i, (stage, ratio) in enumerate([("立项评审", 1.08), ("样机评审", 1.03), ("量产评审", 1.0)]):
            if not one("SELECT id FROM project_cost_reviews WHERE project_id=? AND stage=? AND remark LIKE ?", (pid, stage, f"%{MARK}%")):
                con.execute("INSERT INTO project_cost_reviews (project_id,stage,reviewed_cost,reviewer,reviewed_at,remark) VALUES (?,?,?,?,?,?)", (pid, stage, bom_cost * ratio, "测试评审组", f"2026-08-{10 + i * 5:02d} 10:00:00", MARK))
        for i, ratio in enumerate([1.08, 1.04, 1.0]):
            reason = f"{MARK} 第{i + 1}版成本快照"
            if not one("SELECT id FROM project_cost_snapshots WHERE project_id=? AND change_reason=?", (pid, reason)):
                total = bom_cost * ratio * 1.11
                con.execute("INSERT INTO project_cost_snapshots (project_id,snapshot_type,change_reason,bom_cost,total_cost,platform_fee_rate,profit_rate,module_count,item_count,created_at,change_details) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (pid, "manual_snapshot", reason, bom_cost * ratio, total, 3, 8, len(set(m for m, _, _ in bom_defs[code])), len(bom_defs[code]), f"2026-08-{10 + i * 5:02d} 09:00:00", json.dumps({"测试变化": "模拟供应商议价后成本下降", "版本": i + 1}, ensure_ascii=False)))
        for sku, sname, desc in [("TST-STD", "标准版", "100Hz / 支架基础版"), ("TST-PRO", "专业版", "165Hz / 升降支架 / HDR"), ("TST-LOW", "降本版", "144Hz / 固定支架")]:
            if not one("SELECT id FROM project_skus WHERE project_id=? AND sku_code=?", (pid, sku)):
                sid = con.execute("INSERT INTO project_skus (project_id,sku_code,sku_name,spec_desc,remark) VALUES (?,?,?,?,?)", (pid, sku, sname, desc, MARK)).lastrowid
                con.execute("INSERT INTO sku_diffs (sku_id,diff_type,module_name,part_name,part_model,new_model,quantity,unit_cost,remark) VALUES (?,?,?,?,?,?,?,?,?)", (sid, "替换", "结构模块", "测试人体工学支架", "TST-STAND-ERG", "TST-STAND-FIX", 1, 78, MARK))
        if not one("SELECT id FROM project_bom_custom_columns WHERE project_id=? AND field_key=?", (pid, "test_supplier_quote")):
            con.execute("INSERT INTO project_bom_custom_columns (project_id,field_key,title,data_type,sort_order) VALUES (?,?,?,?,?)", (pid, "test_supplier_quote", "测试供应商报价", "number", 1))
        for order, (key, value) in enumerate([("screen_size", "27英寸"), ("resolution", "2560x1440"), ("refresh_rate", "165Hz")]):
            if not one("SELECT id FROM project_spec_templates WHERE project_id=? AND spec_name=? AND spec_value LIKE ?", (pid, "【测试】" + key, f"%{MARK}%")):
                con.execute("INSERT INTO project_spec_templates (project_id,spec_name,spec_value,sort_order) VALUES (?,?,?,?)", (pid, "【测试】" + key, value + ";" + MARK, order))
        for feature, target in [("高刷体验", 36), ("HDR显示", 28), ("支架人体工学", 18)]:
            if not one("SELECT id FROM project_target_features WHERE project_id=? AND feature_name=?", (pid, "【测试】" + feature)):
                con.execute("INSERT INTO project_target_features (project_id,domain,feature_name,is_new,voice,prev_cost,target_cost,sort_order) VALUES (?,?,?,?,?,?,?,?)", (pid, "产品体验", "【测试】" + feature, 1, 1, 0, target, 1))
    for name, desc, codes in [("测试·在研项目组", "覆盖报价审核和降本跟踪；" + MARK, ["DEMO-TST-2401", "DEMO-TST-2701"]), ("测试·历史项目组", "覆盖已完成与暂停项目；" + MARK, ["DEMO-TST-3201"])]:
        gid = add_key("project_groups", "name=?", (name,), "INSERT INTO project_groups (name,description) VALUES (?,?)", (name, desc))
        for code in codes:
            con.execute("INSERT OR IGNORE INTO project_group_members (group_id,project_id) VALUES (?,?)", (gid, projects[code]))

    # Suppliers, supplier histories and competitor mappings.
    suppliers = ["测试供应商·华东", "测试供应商·华南", "测试供应商·精工", "测试供应商·智造"]
    for i, supplier in enumerate(suppliers):
        con.execute("INSERT OR IGNORE INTO supplier_profiles (supplier_name,category,contact,phone,rating,remark) VALUES (?,?,?,?,?,?)", (supplier, "显示器 ODM", f"测试联系人{i + 1}", f"1380000{i + 1:04d}", 4 - i // 2, MARK))
    for model in list(parts)[:10]:
        base = one("SELECT cost FROM parts WHERE id=?", (parts[model],))[0]
        if not one("SELECT id FROM part_price_history WHERE part_id=? AND changed_at=?", (parts[model], "2026-08-20 10:00:00")):
            con.execute("INSERT INTO part_price_history (part_id,old_cost,new_cost,changed_at) VALUES (?,?,?,?)", (parts[model], base * 1.08, base, "2026-08-20 10:00:00"))
        for i, supplier in enumerate(suppliers[:2]):
            price = round(base * (1 + i * .08), 2)
            r = one("SELECT id FROM part_suppliers WHERE part_id=? AND supplier_name=? AND remark LIKE ?", (parts[model], supplier, f"%{MARK}%"))
            sid = r[0] if r else con.execute("INSERT INTO part_suppliers (part_id,supplier_name,price,unit_price,share_ratio,is_active,remark) VALUES (?,?,?,?,?,?,?)", (parts[model], supplier, price, price, 60 if i == 0 else 40, 1, MARK)).lastrowid
            if not one("SELECT id FROM part_supplier_price_history WHERE supplier_id=? AND change_reason LIKE ?", (sid, f"%{MARK}%")):
                con.execute("INSERT INTO part_supplier_price_history (supplier_id,old_price,new_price,changed_at,change_reason,part_id,supplier_name) VALUES (?,?,?,?,?,?,?)", (sid, price * 1.08, price, "2026-08-20 11:00:00", MARK, parts[model], supplier))
    for model, alias in [("TST-PANEL-27QHD165", "27寸QHD165面板"), ("TST-SCALER-X2", "X2主控板"), ("TST-PSU-180", "180W电源板")]:
        if not one("SELECT id FROM part_aliases WHERE alias_name=? AND canonical_model=?", (alias, model)):
            con.execute("INSERT INTO part_aliases (module_name,alias_name,alias_model,canonical_name,canonical_model,main_category,sub_category,source) VALUES (?,?,?,?,?,?,?,?)", ("测试模块", alias, alias, "测试器件", model, "硬件类", "测试", "test_fixture"))
    for code, pid in projects.items():
        base = sum(qty * fixture_cost(code, model) for _, model, qty in bom_defs[code])
        for i, supplier in enumerate(suppliers[:3]):
            r = one("SELECT id FROM project_suppliers WHERE project_id=? AND supplier_name=? AND remark LIKE ?", (pid, supplier, f"%{MARK}%"))
            sid = r[0] if r else con.execute("INSERT INTO project_suppliers (project_id,supplier_name,quoted_price,share_ratio,is_active,remark) VALUES (?,?,?,?,?,?)", (pid, supplier, round(base * (1 + i * .045), 2), 50 if i == 0 else 25, 1, MARK)).lastrowid
            if not one("SELECT id FROM project_supplier_price_history WHERE supplier_id=? AND change_reason LIKE ?", (sid, f"%{MARK}%")):
                con.execute("INSERT INTO project_supplier_price_history (supplier_id,old_price,new_price,changed_at,change_reason) VALUES (?,?,?,?,?)", (sid, base * (1 + i * .045 + .03), base * (1 + i * .045), f"2026-08-{18 + i:02d} 12:00:00", MARK))
    for i, (brand, model, tier, price, bom) in enumerate([("测试品牌A", "TST-CMP-A27", "中高端", 2999, 1730), ("测试品牌B", "TST-CMP-B27", "主流级", 2399, 1420), ("测试品牌C", "TST-CMP-C32", "高端", 4999, 2860), ("测试品牌D", "TST-CMP-D27", "旗舰级", 3999, 2310)]):
        r = one("SELECT id FROM competitors WHERE model=? AND remark LIKE ?", (model, f"%{MARK}%"))
        cid = r[0] if r else con.execute("INSERT INTO competitors (brand,model,tier,category,screen_size,resolution,refresh_rate,panel_type,specs,market_price,bom_cost,platform_fee_rate,remark,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (brand, model, tier, "显示器", "27" if "27" in model else "32", "2560x1440", "165Hz", "IPS", "测试竞品参数；" + MARK, price, bom, 4, MARK, 20 + i)).lastrowid
        for j, (module, pm) in enumerate([("显示模块", "TST-PANEL-27QHD165"), ("显示模块", "TST-SCALER-X2"), ("电源模块", "TST-PSU-180"), ("结构模块", "TST-STAND-ERG"), ("线材模块", "TST-DP14-CABLE")]):
            if not one("SELECT id FROM competitor_boms WHERE competitor_id=? AND part_model=? AND module_name=?", (cid, pm, module)):
                p = one("SELECT name,cost,model FROM parts WHERE id=?", (parts[pm],))
                mapped = j < 3
                con.execute("INSERT INTO competitor_boms (competitor_id,part_id,part_name,part_model,module_name,estimated_cost,quantity,is_mapped,our_part_name,our_part_model,our_cost,our_quantity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (cid, parts[pm], p[0], p[2], module, round(p[1] * (.92 + j * .04), 2), 1, mapped, p[0] if mapped else "", p[2] if mapped else "", p[1] if mapped else 0, 1 if mapped else 0))
    for name, model, cat, cost in [("测试竞品特殊涂层", "TST-CMP-PART-COAT", "外观", 46), ("测试竞品本地电源板", "TST-CMP-PART-PSU", "电源", 110)]:
        if not one("SELECT id FROM competitor_parts WHERE model=?", (model,)):
            con.execute("INSERT INTO competitor_parts (main_category,sub_category,category,name,model,cost,specs,remark) VALUES (?,?,?,?,?,?,?,?)", ("其他", cat, cat, name, model, cost, "测试竞品专用物料", MARK))

    # Tender workbench: two specification baselines, two rounds, two suppliers.
    pid = projects["DEMO-TST-2701"]
    baselines = []
    for no, spec, changed in [(1, {"code": "DEMO-TST-2701", "refresh_rate": "144Hz"}, []), (2, {"code": "DEMO-TST-2701", "refresh_rate": "165Hz"}, ["refresh_rate"])]:
        fp = f"{MARK}:baseline:{no}"
        r = one("SELECT id FROM project_spec_baselines WHERE fingerprint=?", (fp,))
        baselines.append(r[0] if r else con.execute("INSERT INTO project_spec_baselines (project_id,version_no,fingerprint,spec_json,changed_fields_json,source_type,created_at) VALUES (?,?,?,?,?,?,?)", (pid, no, fp, json.dumps(spec, ensure_ascii=False), json.dumps(changed), "test_fixture", f"2026-08-{8 + no:02d} 09:00:00")).lastrowid)
    rounds = []
    for no, bid, name, status in [(1, baselines[0], "摸底报价", "closed"), (2, baselines[1], "议价轮", "active")]:
        r = one("SELECT id FROM tender_rounds WHERE project_id=? AND round_no=?", (pid, no))
        rid = r[0] if r else con.execute("INSERT INTO tender_rounds (project_id,round_no,name,stage,spec_baseline_id,status,created_at) VALUES (?,?,?,?,?,?,?)", (pid, no, name, name, bid, status, f"2026-08-{10 + no:02d} 10:00:00")).lastrowid
        rounds.append(rid)
    quote_specs = [("显示模块", "测试面板 27英寸 QHD 165Hz", "TST-PANEL-27QHD165", "27英寸/2560x1440", 1, 720), ("显示模块", "测试主控驱动板", "TST-SCALER-X2", "HDMI2.1/DP1.4", 1, 188), ("电源模块", "测试内置电源板", "TST-PSU-180", "180W", 1, 92), ("结构模块", "测试人体工学支架", "TST-STAND-ERG", "升降/旋转", 1, 138), ("线材模块", "测试 DP1.4 线材", "TST-DP14-CABLE", "1.8m", 1, 18), ("其他模块", "测试特殊涂层", "TST-UNMATCHED", "供应商自定义", 1, 46)]
    latest_batch = None
    for ri, rid in enumerate(rounds):
        for si, supplier in enumerate(suppliers[:2]):
            h = f"{MARK}:quote:{ri + 1}:{si + 1}"
            r = one("SELECT id FROM supplier_quote_batches WHERE source_file_hash=?", (h,))
            if r:
                batch = r[0]
            else:
                total = sum(cost * (1.02 + si * .055 - ri * .025) * qty for _, _, _, _, qty, cost in quote_specs)
                batch = con.execute("INSERT INTO supplier_quote_batches (project_id,tender_round_id,supplier_name,batch_no,source_file_name,source_file_hash,quoted_at,status,currency,tax_mode,pricing_mode,total_amount,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (pid, rid, supplier, ri + 1, f"{supplier}-R{ri + 1}-测试报价.xlsx", h, f"2026-08-{12 + ri * 5:02d} 14:00:00", "imported", "CNY", "exclusive", "one_time", round(total, 2), f"2026-08-{12 + ri * 5:02d} 14:05:00")).lastrowid
            latest_batch = batch
            for li, (module, name, model, spec, qty, cost) in enumerate(quote_specs):
                if one("SELECT id FROM supplier_quote_lines WHERE batch_id=? AND source_row=?", (batch, li + 1)):
                    continue
                unit = round(cost * (1.02 + si * .055 - ri * .025), 2)
                relation = "unmatched" if model == "TST-UNMATCHED" else ("equivalent" if model == "TST-STAND-ERG" and si == 1 else "exact")
                key = name.lower().replace(" ", "") + "|" + spec.lower().replace(" ", "")
                lid = con.execute("INSERT INTO supplier_quote_lines (batch_id,source_row,raw_name,raw_model,raw_specs,module_name,quantity,unit_price,line_total,remark,raw_json,canonical_key,relation_type,match_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (batch, li + 1, name, model if model != "TST-UNMATCHED" else "SUP-CUSTOM-001", spec, module, qty, unit, round(unit * qty, 2), MARK, json.dumps({"来源": "测试报价文件", "标记": MARK}, ensure_ascii=False), key, relation, .96 if relation == "exact" else (.72 if relation == "equivalent" else 0), f"2026-08-{12 + ri * 5:02d} 14:06:00")).lastrowid
                con.execute("INSERT INTO quote_line_matches (quote_line_id,canonical_part_id,relation_type,confidence,spec_diff_json,source,remark) VALUES (?,?,?,?,?,?,?)", (lid, parts.get(model), relation, .96 if relation == "exact" else (.72 if relation == "equivalent" else 0), json.dumps({"差异": "支架材质不同"} if relation == "equivalent" else {}, ensure_ascii=False), "test_fixture", MARK))
    quote_line_rows = con.execute("SELECT id FROM supplier_quote_lines WHERE batch_id=? AND relation_type IN ('exact','equivalent') ORDER BY id LIMIT 3", (latest_batch,)).fetchall()
    for i, (line_id,) in enumerate(quote_line_rows):
        line = one("SELECT raw_name,raw_specs,module_name,unit_price FROM supplier_quote_lines WHERE id=?", (line_id,))
        if not one("SELECT id FROM negotiation_items WHERE project_id=? AND quote_line_id=? AND target_supplier=?", (pid, line_id, suppliers[1])):
            con.execute("INSERT INTO negotiation_items (project_id,quote_line_id,module_name,material_name,specs,benchmark_supplier,benchmark_price,target_supplier,target_price,current_price,status,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (pid, line_id, line[2], line[0], line[1], suppliers[0], line[3] * .95, suppliers[1], line[3] * .92, line[3], ["draft", "sent", "agreed"][i], MARK))
    if not one("SELECT id FROM tender_decisions WHERE project_id=?", (pid,)):
        total = one("SELECT total_amount FROM supplier_quote_batches WHERE id=?", (latest_batch,))[0]
        con.execute("INSERT INTO tender_decisions (project_id,selected_supplier,final_quote,status,rationale,review_summary,decided_at) VALUES (?,?,?,?,?,?,?)", (pid, suppliers[0], round(total * .97, 2), "selected", "综合可比报价、交付与议价空间；" + MARK, "测试决策：华东为主供，华南为备供。", "2026-08-28 16:00:00"))
    if not one("SELECT id FROM project_process_events WHERE project_id=? AND detail LIKE ?", (pid, f"%{MARK}%")):
        con.execute("INSERT INTO project_process_events (project_id,event_type,summary,detail,actor) VALUES (?,?,?,?,?)", (pid, "tender_review", "测试报价已完成复核", json.dumps({"标记": MARK}), "测试采购经理"))
    for event_type, summary in [("spec_changed", "测试规格从144Hz升级到165Hz"), ("quote_imported", "测试两家供应商报价已导入"), ("negotiation_started", "测试议价清单已生成"), ("supplier_selected", "测试已选择主供与备供")]:
        if not one("SELECT id FROM project_process_events WHERE project_id=? AND event_type=? AND detail LIKE ?", (pid, event_type, f"%{MARK}%")):
            con.execute("INSERT INTO project_process_events (project_id,event_type,summary,detail,actor,created_at) VALUES (?,?,?,?,?,?)", (pid, event_type, summary, MARK, "测试采购经理", "2026-08-28 16:10:00"))

    # Trend insight and user voice records.
    trend_ids = []
    for i, (cat, summary, action, model) in enumerate([("测试面板成本", "面板价格近期有 3%~6% 下行空间", "锁定季度价格并比较两家供应商", "TST-PANEL-27QHD165"), ("测试主控板", "主控板报价存在 8% 议价空间", "以历史低价和替代料做谈判基准", "TST-SCALER-X2"), ("测试电源模块", "电源模块供应商报价差异明显", "要求拆分适配器与内置电源板成本", "TST-PSU-180")]):
        raw = MARK + ":" + cat
        tid = add_mark("trend_items", "raw_search_results", "INSERT INTO trend_items (query_category,category_type,trend_direction,confidence_level,summary,suggested_action,raw_search_results,last_updated_at,magnitude_min,magnitude_max,magnitude_reference,last_queried_at,source_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (cat, "直接查询", "下降" if i < 2 else "分化", "高", summary, action, raw, "2026-08-25 12:00:00", 3 + i, 6 + i, "本地样例百分比", "2026-08-25 12:00:00", "test_fixture"))
        trend_ids.append(tid)
        for j in range(2):
            con.execute("INSERT INTO trend_sources (trend_item_id,source_title,source_url,excerpt) VALUES (?,?,?,?)", (tid, f"测试来源 {i + 1}-{j + 1}", "https://local.test/cost/" + str(i + 1), MARK + " 本地模拟证据"))
            sid = con.execute("INSERT INTO trend_snapshots (trend_item_id,query_time,source_type,direction,confidence_level,summary,suggested_action,raw_search_results,skill_used,magnitude_min,magnitude_max,magnitude_reference,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (tid, f"2026-08-{20 + j:02d} 09:00:00", "test_fixture", "下降", "高", summary, action, raw, "trend-cost", 3 + i, 6 + i, "本地样例百分比", .9)).lastrowid
            for k, dim in enumerate(["价格驱动", "供应商变化", "行动建议"]):
                con.execute("INSERT INTO trend_insight_dimensions (trend_snapshot_id,dimension_type,content,evidence_strength,source_title,source_url,dimension_order,data_points) VALUES (?,?,?,?,?,?,?,?)", (sid, dim, f"测试维度：{dim}；{MARK}", "高", "测试来源", "https://local.test", k, json.dumps({"样本": i + 1})))
            con.execute("INSERT INTO trend_key_events (trend_snapshot_id,event_date,event_description,impact_direction,source_title,source_url) VALUES (?,?,?,?,?,?)", (sid, f"2026-08-{15 + j:02d}", f"测试价格事件 {i + 1}；{MARK}", "positive", "测试来源", "https://local.test"))
        con.execute("INSERT INTO trend_conversations (trend_item_id,question,answer) VALUES (?,?,?)", (tid, "这项趋势对报价有什么影响？", "测试回答：优先比较可比报价，保留证据链；" + MARK))
        con.execute("INSERT OR IGNORE INTO trend_part_mapping (part_id,trend_item_id) VALUES (?,?)", (parts[model], tid))
        component = one("SELECT id FROM component_decomposition ORDER BY id LIMIT 1")
        if component:
            con.execute("INSERT OR IGNORE INTO component_trend_mapping (component_id,trend_item_id,component_type) VALUES (?,?,?)", (component[0], tid, "part"))
        if not one("SELECT id FROM part_insights WHERE category=? AND module_name=?", (cat, "测试趋势模块")):
            con.execute("INSERT INTO part_insights (category,module_name,insight_json,status) VALUES (?,?,?,?)", (cat, "测试趋势模块", "[]", "read"))

    def add_history_fixture(category, source_type, directions, magnitudes, source_title, source_url):
        item_id = con.execute("INSERT INTO trend_items (query_category,category_type,trend_direction,confidence_level,summary,suggested_action,raw_search_results,last_updated_at,source_type,last_queried_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (category, "直接查询", directions[-1], "中", "演示历史：每次快照均可展开查看判断、结构化结果和来源。", "以历史判断和来源为谈价准备", MARK, "2026-08-30 12:00:00", source_type, "2026-08-30 12:00:00")).lastrowid
        for index, direction in enumerate(directions):
            confidence = ["低", "中", "高"][index % 3]
            value = magnitudes[index] if magnitudes else None
            result = {"headline": f"演示第 {index + 1} 次：{direction}信号", "direction": direction, "confidence": confidence, "drivers": [{"label": "供需变化", "text": "演示结构化驱动，不代表真实市场结论。", "direction": direction}], "opportunities": [{"label": "议价窗口", "text": "可结合多供应商报价继续核验。"}], "risks": [{"label": "数据边界", "text": "演示数据不能替代实际报价。"}], "actions": [{"label": "下一步", "text": "补充真实报价并复核来源。"}]}
            snapshot_id = con.execute("INSERT INTO trend_snapshots (trend_item_id,query_time,source_type,direction,confidence_level,summary,suggested_action,raw_search_results,skill_used,magnitude_min,magnitude_max,magnitude_reference,confidence,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (item_id, f"2026-08-{10 + index:02d} 09:00:00", source_type, direction, confidence, f"演示快照 {index + 1}：{direction}。", "补充报价后复核", MARK, "demo-fixture", value - 1 if value is not None else None, value + 1 if value is not None else None, "演示百分比" if value is not None else "", {"低": .55, "中": .75, "高": .92}[confidence], json.dumps(result, ensure_ascii=False))).lastrowid
            con.execute("INSERT INTO trend_sources (trend_item_id,source_title,source_url,excerpt,trend_snapshot_id) VALUES (?,?,?,?,?)", (item_id, source_title, source_url, "公开示例来源；仅用于演示来源链路。", snapshot_id))
            con.execute("INSERT INTO trend_insight_dimensions (trend_snapshot_id,dimension_type,content,evidence_strength,source_title,source_url,dimension_order,data_points) VALUES (?,?,?,?,?,?,?,?)", (snapshot_id, "供需驱动", "演示结构化维度：需结合实际报价核验。", confidence, source_title, source_url, 0, json.dumps({"演示": True}, ensure_ascii=False)))
            con.execute("INSERT INTO trend_key_events (trend_snapshot_id,event_date,event_description,impact_direction,source_title,source_url) VALUES (?,?,?,?,?,?)", (snapshot_id, f"2026-08-{8 + index:02d}", f"演示关键事件 {index + 1}", "neutral", source_title, source_url))
        return item_id

    simulated_id = add_history_fixture("测试·六次AI模拟趋势", "demo_simulated", ["下降", "震荡", "分化", "上涨", "上涨", "震荡"], [], "USGS Lithium Statistics", "https://www.usgs.gov/centers/national-minerals-information-center/lithium-statistics-and-information")
    real_id = add_history_fixture("测试·四次真实幅度趋势", "demo_real", ["下降", "下降", "震荡", "上涨"], [2.5, 3.2, 3.0, 4.1], "IEA Critical Minerals Outlook", "https://www.iea.org/reports/global-critical-minerals-outlook-2024")
    parent_id = con.execute("INSERT INTO trend_items (query_category,category_type,trend_direction,confidence_level,summary,suggested_action,raw_search_results,last_updated_at,source_type,last_queried_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ("测试·电源模块分解", "分解洞察", "分化", "中", "演示分解父级：子节点结果保留在树中。", "进入分解树查看节点", MARK, "2026-08-30 12:00:00", "decomposition", "2026-08-30 12:00:00")).lastrowid
    node_id = add_history_fixture("测试·电源板节点", "demo_real", ["上涨", "震荡"], [4.0, 4.5], "IEA Critical Minerals Outlook", "https://www.iea.org/reports/global-critical-minerals-outlook-2024")
    root_node = con.execute("INSERT INTO decomposition_tree (root_part_id,parent_id,component_name,cost_ratio_estimate,source_type,node_type,insight_status,trend_item_id,remark) VALUES (?,?,?,?,?,?,?,?,?)", (None, None, "测试·电源模块分解", 100, "user_confirmed", "structural", "partial", parent_id, MARK)).lastrowid
    con.execute("UPDATE decomposition_tree SET root_part_id=? WHERE id=?", (root_node, root_node))
    child_node = con.execute("INSERT INTO decomposition_tree (root_part_id,parent_id,component_name,cost_ratio_estimate,source_type,node_type,insight_status,trend_item_id,remark) VALUES (?,?,?,?,?,?,?,?,?)", (root_node, root_node, "测试·电源板节点", 65, "user_confirmed", "terminal", "queried", node_id, MARK)).lastrowid
    con.execute("INSERT INTO decomposition_tree (root_part_id,parent_id,component_name,cost_ratio_estimate,source_type,node_type,insight_status,trend_item_id,remark) VALUES (?,?,?,?,?,?,?,?,?)", (root_node, root_node, "测试·适配器节点", 35, "user_confirmed", "terminal", "ready", None, MARK))

    # 仅保留一组与真实项目品类/模块对应的有效差异样例，避免“价格相同却显示有差异”。
    con.execute("DELETE FROM part_insights WHERE category LIKE '测试%' AND module_name='测试趋势模块'")
    con.execute("DELETE FROM part_aliases WHERE module_name='测试趋势模块' AND source IN ('user_confirmed','marked_different')")
    for module, models in [("显示模块", ["TST-PANEL-27QHD165", "TST-SCALER-X2"]), ("电源模块", ["TST-PSU-180"])]:
        insight_groups = []
        for model in models:
            insight_rows = []
            for code, pid in projects.items():
                bom = one("SELECT part_name,part_model,part_cost,quantity,part_specs,sub_category FROM project_boms WHERE project_id=? AND part_id=? AND module_name=? AND remark LIKE ?", (pid, parts[model], module, f"%{MARK}%"))
                if bom:
                    insight_rows.append({"project": code, "projectId": pid, "name": bom[0], "model": bom[1], "cost": bom[2], "quantity": bom[3], "specs": bom[4], "sub_category": bom[5]})
            if len(insight_rows) < 2:
                continue
            prices = [float(row["cost"]) for row in insight_rows]
            insight_groups.append({"name": insight_rows[0]["name"], "type": "rule", "diff": round(max(prices) - min(prices), 2), "reason": "同型号跨项目报价差异明显", "rows": insight_rows})
        if insight_groups:
            payload = json.dumps(insight_groups, ensure_ascii=False)
            existing = one("SELECT id FROM part_insights WHERE category=? AND module_name=?", ("显示器", module))
            if existing:
                con.execute("UPDATE part_insights SET insight_json=?, status='unread', handled_json='[]' WHERE id=?", (payload, existing[0]))
            else:
                con.execute("INSERT INTO part_insights (category,module_name,insight_json,status,handled_json) VALUES (?,?,?,?,?)", ("显示器", module, payload, "unread", "[]"))
    for category in ["硬件类", "结构类", "电源类", "线材类", "包材类", "加工费类", "软件类", "其他"]:
        con.execute("INSERT OR IGNORE INTO material_categories (category_name) VALUES (?)", (category,))
        con.execute("INSERT OR IGNORE INTO material_category_dict (category_name) VALUES (?)", (category,))
    root = one("SELECT id FROM parts WHERE model=?", ("TST-PANEL-27QHD165",))
    if root and not one("SELECT id FROM decomposition_history WHERE root_part_id=? AND summary LIKE ?", (root[0], f"%{MARK}%")):
        con.execute("INSERT INTO decomposition_history (root_part_id,summary) VALUES (?,?)", (root[0], "测试拆解历史：面板→显示模块→整机；" + MARK))
    if trend_ids and not one("SELECT id FROM followup_pattern_log WHERE question_theme LIKE ?", (f"%{MARK}%",)):
        con.execute("INSERT INTO followup_pattern_log (question_theme,trend_item_id) VALUES (?,?)", ("测试追问：价格变化是否影响谈价；" + MARK, trend_ids[0]))
    component = one("SELECT id,component_name FROM component_decomposition ORDER BY id LIMIT 1")
    if component and not one("SELECT id FROM rollup_feedback WHERE component_id=? AND correction_reason LIKE ?", (component[0], f"%{MARK}%")):
        con.execute("INSERT INTO rollup_feedback (component_id,component_name,ai_direction,ai_summary,ai_confidence_level,user_corrected_direction,user_corrected_confidence_level,user_corrected_summary,correction_reason) VALUES (?,?,?,?,?,?,?,?,?)", (component[0], component[1], "下降", "测试汇总判断", "medium", "分化", "high", "测试用户修正：需区分供应商", MARK))
    dims = []
    for i, name in enumerate(["画质", "刷新体验", "支架体验", "价格感知"]):
        r = one("SELECT id FROM voice_dimension WHERE product=? AND name=?", ("测试原声产品", name))
        dims.append(r[0] if r else con.execute("INSERT INTO voice_dimension (name,weight,count,positive,negative,evidence,product,kind) VALUES (?,?,?,?,?,?,?,?)", (name, 1 + i * .2, 20 + i * 3, 12 + i, 3 + i, "测试原声证据；" + MARK, "测试原声产品", "测试")).lastrowid)
    for text in ["颜色很舒服，办公一天眼睛不累", "165Hz 滑动窗口明显更顺", "支架能升降对长时间使用很有帮助", "这个配置如果再便宜一点会更有竞争力", "希望 DP 和 HDMI 都能稳定跑满", "包装不错但彩盒成本可以再看"]:
        if not one("SELECT id FROM voice_item WHERE product=? AND content=?", ("测试原声产品", text)):
            con.execute("INSERT INTO voice_item (content,source,product) VALUES (?,?,?)", (text, MARK, "测试原声产品"))
    for title, content, category in [("测试：供应商报价复核", "完成两家供应商报价导入，发现主控板和支架有议价空间。", "报价审核"), ("测试：项目成本评审", "目标成本差距待处理，下一步跟进支架共用平台。", "项目管理"), ("测试：竞品拆解", "完成4个竞品的显示、电源、结构模块映射。", "竞品分析")]:
        if not one("SELECT id FROM work_logs WHERE title=? AND tags LIKE ?", (title, f"%{MARK}%")):
            con.execute("INSERT INTO work_logs (log_date,title,content,category,tags,is_todo,done,work_project) VALUES (?,?,?,?,?,?,?,?)", ("2026-08-28", title, content, category, MARK, 1 if "待" in content else 0, 0 if "待" in content else 1, "DEMO-TST-2701"))
    for key, title, content, category in [("demo-project-context", "测试项目上下文", "项目报价来自 ODM；重点关注模块拆分、供应商比较与目标成本。", "project"), ("demo-negotiation-style", "测试议价偏好", "优先按可比报价和历史低价排序，再形成议价清单。", "style")]:
        con.execute("INSERT OR IGNORE INTO local_ai_context (key,title,content,category) VALUES (?,?,?,?)", (key, title, content + " " + MARK, category))
    for code, pid in projects.items():
        for i, feature in enumerate(["高刷体验", "HDR显示", "支架人体工学"]):
            con.execute("INSERT OR IGNORE INTO value_scores (ref_type,ref_id,feature_key,score,category) VALUES (?,?,?,?,?)", ("project", pid, "test_" + feature, 70 + i * 8, "测试价值"))
        if not one("SELECT id FROM selling_points WHERE project_id=? AND name=?", (pid, "【测试】高刷卖点")):
            spid = con.execute("INSERT INTO selling_points (project_id,product,name,description,positive,negative,sort_order) VALUES (?,?,?,?,?,?,?)", (pid, "测试产品", "【测试】高刷卖点", "覆盖高刷、HDR、支架体验；" + MARK, "顺滑清晰", "价格敏感", 1)).lastrowid
            con.execute("INSERT OR IGNORE INTO selling_point_dims (selling_point_id,voice_dimension_id) VALUES (?,?)", (spid, dims[1]))
        if not one("SELECT id FROM selling_point_analysis WHERE project_id=? AND conclusion LIKE ?", (pid, f"%{MARK}%")):
            con.execute("INSERT INTO selling_point_analysis (project_id,product,conclusion,source) VALUES (?,?,?,?)", (pid, "测试产品", "测试分析：高刷和支架是正向卖点，价格是主要负向反馈；" + MARK, "test_fixture"))

    # AI recommendations, feedback, local eval rows and audit samples.
    for i, (skill, title, conclusion, saving, status) in enumerate([("quote-negotiation", "测试建议：先谈主控驱动板", "两家报价差异明显，建议以低价供应商作为基准谈降。", 48, "adopted"), ("target-gap", "测试建议：补齐电源模块目标", "电源模块目标成本缺少约束，建议拆分管理。", 22, "open"), ("project-retro", "测试建议：保留第二供应商", "华南供应商可作为备供，降低单一来源风险。", 15, "useful")]):
        run = f"{MARK}:run:{i + 1}"
        add_mark("ai_analysis_runs", "run_id", "INSERT INTO ai_analysis_runs (run_id,skill_id,skill_version,status,question,data_fingerprint,duration_ms,warning) VALUES (?,?,?,?,?,?,?,?)", (run, skill, "1.0.0", "success", "测试本地分析任务", MARK, 420 + i * 130, ""))
        evidence = json.dumps([{"refType": "project", "refId": projects["DEMO-TST-2701"], "label": "测试项目报价", "field": "supplier_quote_lines", "value": "测试证据", "deepLink": {"page": "projects", "params": {"projectId": projects["DEMO-TST-2701"]}}}], ensure_ascii=False)
        impact = json.dumps({"min": round(saving * .8, 2), "max": round(saving * 1.2, 2), "currency": "CNY"})
        action = json.dumps({"label": "打开测试项目", "type": "open"})
        rec = add_mark("ai_recommendations", "source", "INSERT INTO ai_recommendations (run_id,title,conclusion,evidence_json,confidence,assumptions_json,expected_impact_json,action_json,data_gaps_json,risks_json,status,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (run, title, conclusion, evidence, "high", "[]", impact, action, "[]", json.dumps(["报价仍需人工确认"], ensure_ascii=False), status, MARK + ":" + run))
        con.execute("UPDATE ai_recommendations SET evidence_json=?, expected_impact_json=?, action_json=? WHERE id=?", (evidence, impact, action, rec))
        if not one("SELECT id FROM ai_recommendation_feedback WHERE recommendation_id=? AND note LIKE ?", (rec, f"%{MARK}%")):
            con.execute("INSERT INTO ai_recommendation_feedback (recommendation_id,usefulness,adoption_status,actual_saving,actual_result,note) VALUES (?,?,?,?,?,?)", (rec, "useful", "adopted" if status == "adopted" else "done", saving, "测试反馈：建议已验证；" + MARK, MARK))
    metrics = ["toolSuccess", "evidenceCoverage", "toolSelection", "numericAccuracy", "durationMs", "recommendationAdoption", "actualSaving", "leakageBlocked", "safeWriteBlocked"]
    evals = {"project-bom-total": (1, 1, 1, 1, 420, .8, 0, 1, 1), "target-gap": (1, 1, 1, .92, 360, .7, 0, 1, 1), "quote-negotiation": (1, 1, 1, .88, 510, .67, 63.5, 1, 1), "unsafe-write-confirmation": (1, 1, 1, 1, 120, 0, 0, 1, 1)}
    for fixture, scores in evals.items():
        for metric, score in zip(metrics, scores):
            if not one("SELECT id FROM ai_eval_results WHERE fixture_id=? AND metric=? AND detail LIKE ?", (fixture, metric, f"%{MARK}%")):
                con.execute("INSERT INTO ai_eval_results (fixture_id,metric,score,detail) VALUES (?,?,?,?)", (fixture, metric, score, "测试数据；" + MARK))
    for text, status, progress, linked in [("测试目标：完成两家供应商议价", "active", "60%", "DEMO-TST-2701"), ("测试目标：形成电源模块基准价", "active", "35%", "DEMO-TST-2401"), ("测试目标：沉淀竞品映射经验", "done", "100%", "DEMO-TST-3201")]:
        con.execute("INSERT OR IGNORE INTO ai_goals (text,status,progress,linked_project) VALUES (?,?,?,?)", (text, status, progress, linked))
    for code, pid in projects.items():
        if not one("SELECT id FROM project_analysis_logs WHERE project_code=? AND conclusion LIKE ?", (code, f"%{MARK}%")):
            con.execute("INSERT INTO project_analysis_logs (project_id,project_code,conclusion,source) VALUES (?,?,?,?)", (pid, code, "测试项目分析：成本、目标与供应商报价均已准备；" + MARK, "test_fixture"))
    if not one("SELECT id FROM quote_review_logs WHERE quote_input LIKE ?", (f"%{MARK}%",)):
        con.execute("INSERT INTO quote_review_logs (quote_input,verdict_summary) VALUES (?,?)", (MARK + " 测试报价文本", "测试审价结论：主控板与支架存在可谈空间，特殊涂层暂不可比。"))
    for i, desc in enumerate(["检查同一器件多供应商价格差异", "检查报价行是否存在不可比项", "检查项目是否设置目标成本", "检查快照是否连续"]):
        if not one("SELECT id FROM analysis_checklist WHERE item_description=?", (desc,)):
            cid = con.execute("INSERT INTO analysis_checklist (item_description,is_active,source,strength_level,trigger_count,last_triggered_at) VALUES (?,?,?,?,?,?)", (desc, 1, MARK, "observing", 2 + i, "2026-08-28 15:00:00")).lastrowid
            con.execute("INSERT INTO checklist_trigger_log (checklist_item_id,trend_item_id,question_snippet) VALUES (?,?,?)", (cid, trend_ids[i % len(trend_ids)], "测试触发：" + desc))
    for target, error in [("local-rule", "测试环境：外发前需要用户确认"), ("cloud-abstract-analysis", "测试环境：未提供一次性 C2 授权")]:
        if not one("SELECT id FROM ai_egress_audit WHERE target=? AND error_message LIKE ?", (target, f"%{MARK}%")):
            con.execute("INSERT INTO ai_egress_audit (grant_id,target,model,payload_hash,fields_json,status,error_message) VALUES (?,?,?,?,?,?,?)", (0, target, "test-model", MARK, '["summary"]', "blocked", error + "；" + MARK))
    for code, pid in projects.items():
        if not one("SELECT id FROM ai_advisor_insights WHERE fingerprint=?", (MARK + ":" + code,)):
            con.execute("INSERT INTO ai_advisor_insights (insight_type,title,detail,ref_type,ref_id,ref_name,prompt,status,source,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)", ("test", "测试AI情报：目标成本差距", "建议复核主控板报价。", "project", pid, code, "测试提示", "open", "test_fixture", MARK + ":" + code))

    con.commit()
    assert os.stat(source).st_size == source_stat.st_size and os.stat(source).st_mtime_ns == source_stat.st_mtime_ns and file_sha256(source) == source_hash, "source database changed during demo generation"
    counts = {}
    for table in ["parts", "projects", "project_boms", "modules", "project_targets", "project_measures", "project_cost_snapshots", "project_skus", "supplier_profiles", "part_suppliers", "competitors", "competitor_boms", "project_spec_baselines", "tender_rounds", "supplier_quote_batches", "supplier_quote_lines", "quote_line_matches", "project_process_events", "negotiation_items", "tender_decisions", "trend_items", "trend_snapshots", "voice_item", "voice_dimension", "ai_analysis_runs", "ai_recommendations", "ai_recommendation_feedback", "ai_eval_results"]:
        counts[table] = one(f'SELECT count(*) FROM "{table}"')[0]
    orphan = one("SELECT count(*) FROM project_boms b LEFT JOIN parts p ON p.id=b.part_id WHERE b.project_id IN (?,?,?) AND p.id IS NULL", tuple(projects.values()))[0]
    assert orphan == 0
    assert counts["tender_rounds"] >= 2 and counts["supplier_quote_lines"] >= 12 and counts["ai_recommendations"] >= 3
    assert con.execute("SELECT count(*) FROM parts WHERE remark NOT LIKE ?", (f"%{MARK}%",)).fetchone()[0] == 0
    print(json.dumps({"db": DB, "source_schema_db": source, "projects": list(projects), "counts": counts, "orphan_project_boms": orphan, "source_sha256": source_hash}, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()
