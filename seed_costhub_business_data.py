"""Create a complete, traceable ODM business dataset for CostHub.

The source database is used only as a schema snapshot. The generated database is
written to a separate path so the caller can back up and replace the app copies
after validation.
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from datetime import datetime, timedelta


def parse_args():
    parser = argparse.ArgumentParser(description="Generate CostHub ODM business data")
    parser.add_argument("--source-schema-db", required=True)
    parser.add_argument("--output-db", required=True)
    return parser.parse_args()


def sha256(path):
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
            try:
                dst.execute(sql)
            except sqlite3.OperationalError as error:
                if "already exists" not in str(error):
                    raise
        dst.commit()
    finally:
        src.close()
        dst.close()


def clear_data(con):
    con.execute("PRAGMA foreign_keys=OFF")
    preserve = {"_sqlx_migrations", "settings", "analysis_skills", "api_providers"}
    tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence'").fetchall()]
    for table in tables:
        if table in preserve:
            continue
        con.execute(f'DELETE FROM "{table.replace(chr(34), chr(34) * 2)}"')
    try:
        con.execute("DELETE FROM sqlite_sequence")
    except sqlite3.OperationalError:
        pass
    con.commit()


def main():
    args = parse_args()
    source = os.path.abspath(args.source_schema_db)
    output = os.path.abspath(args.output_db)
    assert os.path.isfile(source), source
    assert source != output, "source and output must differ"
    os.makedirs(os.path.dirname(output), exist_ok=True)
    source_hash = sha256(source)
    source_stat = os.stat(source)
    copy_schema(source, output)
    con = sqlite3.connect(output)
    con.row_factory = sqlite3.Row
    clear_data(con)
    con.executescript("""
    CREATE TABLE IF NOT EXISTS ai_analysis_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE, skill_id TEXT DEFAULT '', skill_version TEXT DEFAULT '', status TEXT DEFAULT 'running', question TEXT DEFAULT '', data_fingerprint TEXT DEFAULT '', duration_ms INTEGER DEFAULT 0, warning TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT DEFAULT '', title TEXT NOT NULL, conclusion TEXT DEFAULT '', evidence_json TEXT DEFAULT '[]', confidence TEXT DEFAULT 'low', assumptions_json TEXT DEFAULT '[]', expected_impact_json TEXT DEFAULT '', action_json TEXT DEFAULT '{}', data_gaps_json TEXT DEFAULT '[]', risks_json TEXT DEFAULT '[]', status TEXT DEFAULT 'open', source TEXT DEFAULT 'local_rule', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_recommendation_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, recommendation_id INTEGER NOT NULL, usefulness TEXT DEFAULT '', adoption_status TEXT DEFAULT '', actual_saving REAL DEFAULT NULL, actual_result TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_approval_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_level TEXT NOT NULL DEFAULT 'C1', material TEXT NOT NULL, category TEXT DEFAULT '', question TEXT DEFAULT '', payload_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_egress_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id INTEGER DEFAULT 0, target TEXT DEFAULT '', model TEXT DEFAULT '', payload_hash TEXT DEFAULT '', fields_json TEXT DEFAULT '[]', status TEXT DEFAULT '', error_message TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS ai_eval_results (id INTEGER PRIMARY KEY AUTOINCREMENT, fixture_id TEXT NOT NULL, metric TEXT NOT NULL, score REAL DEFAULT 0, detail TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS project_target_features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, domain TEXT DEFAULT '', feature_name TEXT DEFAULT '', is_new INTEGER DEFAULT 0, voice INTEGER DEFAULT 0, prev_cost REAL DEFAULT 0, target_cost REAL DEFAULT 0, sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS project_module_feature_links (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, module_name TEXT NOT NULL, feature_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, module_name, feature_id));
    CREATE TABLE IF NOT EXISTS project_competitive_dimensions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, feature_id INTEGER NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, feature_id));
    """)

    def table_exists(table):
        return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None

    def insert(table, values):
        if not table_exists(table):
            return None
        columns = {row[1] for row in con.execute(f'PRAGMA table_info("{table}")')}
        payload = {key: value for key, value in values.items() if key in columns}
        names = ",".join(f'"{key}"' for key in payload)
        marks = ",".join("?" for _ in payload)
        return con.execute(f'INSERT INTO "{table}" ({names}) VALUES ({marks})', tuple(payload.values())).lastrowid

    def one(sql, values=()):
        row = con.execute(sql, values).fetchone()
        return row[0] if row else None

    def money(value):
        return round(float(value), 2)

    con.execute("BEGIN")
    created = "2026-08-18 09:00:00"

    # 品类与规格字典：成本策划页据此生成规格基线输入项。
    for category in ["显示器", "办公显示器", "电竞显示器", "创作显示器"]:
        insert("product_categories", {"name": category, "sort_order": 1, "created_at": created})
    fields = [
        ("screen_size", "屏幕尺寸", "number", "英寸", 1),
        ("resolution", "分辨率", "text", "", 1),
        ("refresh_rate", "刷新率", "number", "Hz", 1),
        ("panel_type", "面板类型", "text", "", 1),
        ("brightness", "典型亮度", "number", "nit", 0),
        ("color_gamut", "色域覆盖", "text", "", 0),
        ("ports", "接口组合", "text", "", 0),
    ]
    for order, (key, label, data_type, unit, required) in enumerate(fields):
        insert("category_spec_fields", {"category_name": "显示器", "field_key": key, "field_label": label, "data_type": data_type, "unit": unit, "options_json": "[]", "group_name": "产品规格", "sort_order": order, "required": required, "compare_direction": "", "active": 1})
    for order, (key, label) in enumerate([("画质", "画质与色彩"), ("高刷", "刷新体验"), ("支架", "人体工学"), ("接口", "连接能力"), ("噪音", "使用体验")]):
        insert("cat_feature_templates", {"category": "显示器", "feature_key": key, "feature_label": label, "weight": 1.0, "sort_order": order})
    for keywords, module, main, sub in [
        ("面板,显示,屏幕", "显示模块", "硬件类", "显示器件"),
        ("主控,Scaler,驱动", "主控模块", "硬件类", "主控"),
        ("内存,DDR", "主控模块", "硬件类", "存储"),
        ("适配器,电源,PMIC", "电源模块", "电源类", "电源"),
        ("后壳,前框,支架,底座", "结构模块", "结构类", "结构"),
        ("DP,HDMI,线材", "线材模块", "线材类", "视频线"),
        ("彩盒,泡棉,标签", "包装模块", "包材类", "包装"),
        ("SMT,组装,固件", "制造模块", "加工费类", "制造"),
    ]:
        insert("module_rules", {"keywords": keywords, "module": module, "main_category": main, "sub_category": sub, "sort_order": 1, "source": "业务分类规则", "created_at": created})

    # 物料主档：价格是供应商报价基准，后续可在器件库补充更多报价历史。
    part_defs = [
        ("硬件类", "显示器件", "面板", "27英寸 QHD 高刷面板", "BOE-NV270QHM-NY1", 610.00, "27英寸 / 2560×1440 / 165Hz / IPS"),
        ("硬件类", "显示器件", "面板", "27英寸 QHD 高刷面板", "CSOT-27QHD-165", 598.00, "27英寸 / 2560×1440 / 165Hz / Fast IPS"),
        ("硬件类", "显示器件", "面板", "24英寸 FHD 商用面板", "CSOT-24FHD-100", 382.00, "23.8英寸 / 1920×1080 / 100Hz / IPS"),
        ("硬件类", "显示器件", "面板", "32英寸 4K 创作面板", "LG-LM320UQA-SSA1", 1220.00, "31.5英寸 / 3840×2160 / 144Hz / Nano IPS"),
        ("硬件类", "显示器件", "面板", "27英寸 FHD 电竞面板", "AUO-M270HAN08-180", 468.00, "27英寸 / 1920×1080 / 180Hz / Fast IPS"),
        ("硬件类", "主控", "驱动板", "Realtek HDMI 2.1 主控板", "Realtek-RTD2796", 76.00, "HDMI 2.1 / DP 1.4 / HDR / USB Hub"),
        ("硬件类", "主控", "驱动板", "Novatek 高刷主控板", "Novatek-MST9U31", 58.00, "HDMI 2.0 / DP 1.4 / 180Hz"),
        ("硬件类", "主控", "驱动板", "Realtek 商用主控板", "Realtek-RTD2556", 43.00, "HDMI 2.0 / DP 1.2 / 100Hz"),
        ("硬件类", "存储", "内存", "DDR4 2GB 显存缓存", "Winbond-DDR4-2G", 36.00, "DDR4 2666 / 2GB"),
        ("硬件类", "存储", "内存", "DDR5 4GB 显存缓存", "Micron-DDR5-4G", 68.00, "DDR5 4800 / 4GB"),
        ("硬件类", "接口", "USB Hub", "4口 USB 3.0 Hub", "Realtek-USBHUB-4P", 33.00, "USB 3.0 / 4口 / 过流保护"),
        ("硬件类", "音频", "扬声器", "全频扬声器 3W", "AAC-SPK-3W", 12.50, "2×3W / 4Ω / 防磁"),
        ("电源类", "适配器", "电源适配器", "180W 外置适配器", "Huntkey-ADP-180", 72.00, "19V / 9.47A / 六级能效"),
        ("电源类", "适配器", "电源适配器", "120W 外置适配器", "Huntkey-ADP-120", 49.00, "19V / 6.32A / 六级能效"),
        ("电源类", "适配器", "电源适配器", "230W 外置适配器", "Chicony-ADP-230", 98.00, "19V / 12.1A / 六级能效"),
        ("电源类", "板卡", "内置电源板", "180W 内置电源板", "MPS-PSU-180", 91.00, "180W / 主动 PFC / 保护齐全"),
        ("电源类", "芯片", "电源管理", "显示器 PMIC", "MPS-PMIC-88", 8.60, "多路电源时序 / 过温保护"),
        ("电源类", "芯片", "背光驱动", "Mini LED 背光驱动板", "MPS-BL-96Z", 64.00, "96分区 / PWM调光 / 12V输入"),
        ("结构类", "外壳", "后壳", "27英寸注塑后壳", "LENS-REAR-27-Q", 84.00, "ABS+PC / 细纹黑 / 阻燃 V-0"),
        ("结构类", "外壳", "后壳", "24英寸注塑后壳", "LENS-REAR-24-O", 61.00, "ABS+PC / 商用黑 / 阻燃 V-0"),
        ("结构类", "外壳", "后壳", "32英寸注塑后壳", "LENS-REAR-32-C", 118.00, "ABS+PC / 细纹黑 / 局部散热孔"),
        ("结构类", "外观", "前框", "27英寸窄边框前框", "LENS-BEZEL-27", 39.00, "三边 2mm / PC+ABS / 喷涂"),
        ("结构类", "外观", "前框", "24英寸窄边框前框", "LENS-BEZEL-24", 31.00, "三边 2.2mm / PC+ABS / 喷涂"),
        ("结构类", "支架", "升降支架", "人体工学升降支架", "KOKU-STAND-ERG", 132.00, "升降 / 旋转 / 俯仰 / VESA 100"),
        ("结构类", "支架", "固定支架", "商用固定支架", "KOKU-STAND-FIX", 67.00, "俯仰 / VESA 100 / 铝合金底座"),
        ("结构类", "底座", "底座", "32英寸加重底座", "KOKU-BASE-32", 72.00, "钢板加重 / 防倾倒 / 喷粉"),
        ("线材类", "视频线", "DP线", "DP 1.4 视频线", "LUXSHARE-DP14-18", 17.00, "1.8m / 8K / 镀金端子"),
        ("线材类", "视频线", "HDMI线", "HDMI 2.1 视频线", "LUXSHARE-HDMI21-15", 22.00, "1.5m / 48Gbps / 编织外被"),
        ("线材类", "电源线", "电源线", "国标交流电源线", "LUXSHARE-AC-15", 6.80, "1.5m / 10A / CCC"),
        ("包材类", "包装", "彩盒", "27英寸五层彩盒", "PACK-BOX-27-Q", 26.00, "五层瓦楞 / 彩印 / ISTA运输要求"),
        ("包材类", "包装", "彩盒", "24英寸五层彩盒", "PACK-BOX-24-O", 21.00, "五层瓦楞 / 彩印 / 商用版"),
        ("包材类", "包装", "彩盒", "32英寸五层彩盒", "PACK-BOX-32-C", 39.00, "五层瓦楞 / 彩印 / 加强护角"),
        ("包材类", "缓冲", "泡棉", "EPE 结构泡棉套件", "PACK-EPE-27", 9.80, "EPE / 定制模切 / 防跌落"),
        ("其他", "标识", "铭牌", "激光蚀刻产品铭牌", "ID-LABEL-27", 2.20, "铝牌 / 激光蚀刻 / 背胶"),
        ("加工费类", "制造", "SMT贴片", "主控板 SMT 贴片工艺", "ODM-SMT-SCALER", 31.00, "贴片 / AOI / ICT / 功能检验"),
        ("加工费类", "制造", "整机组装", "整机组装与老化检验", "ODM-ASSY-AGING", 38.00, "组装 / 4小时老化 / OQC"),
        ("软件类", "固件", "显示固件", "显示固件与 OSD 授权", "FW-OSD-HDR", 16.00, "HDR / OSD / OTA升级"),
        ("硬件类", "传感器", "色彩传感器", "出厂色彩校准传感器", "SENSOR-COLOR-01", 22.00, "色温校准 / 出厂一次性使用"),
    ]
    part_ids = {}
    for main, sub, category, name, model, cost, specs in part_defs:
        part_ids[model] = insert("parts", {"main_category": main, "sub_category": sub, "category": category, "name": name, "model": model, "cost": cost, "specs": specs, "projects": "", "remark": "供应商报价基准；进入器件库后可继续补充多家报价", "created_at": created, "updated_at": "2026-09-02 18:19:00", "trend_enabled": 1 if category in {"面板", "驱动板", "电源适配器", "背光驱动"} else 0, "trend_query_category": name, "trend_category_type": "直接查询"})

    # 项目与项目 BOM：用 ODM 供应商报价的模块拆分口径组织。
    project_defs = [
        ("CM27QHD165-26", "27英寸 QHD 高刷办公显示器", "在研", "中高端", "进行中", "27", "2560×1440", "165Hz", "Fast IPS", "PDCP", 3.0, 8.0, 1599, 1160, "以 165Hz、低蓝光和升降支架为主卖点；面板价格按 Q3 供应商报价中位数估算。"),
        ("CM24FHD100-26", "24英寸 FHD 商用显示器", "在研", "主流级", "进行中", "23.8", "1920×1080", "100Hz", "IPS", "CDCP", 2.5, 7.0, 899, 760, "面向办公批量采购，优先保证交期、低功耗和接口稳定。"),
        ("CM32UHD144-25", "32英寸 4K 创作显示器", "已完成", "高端", "已完成", "31.5", "3840×2160", "144Hz", "Nano IPS", "量产后降本", 4.0, 10.0, 3299, 2240, "广色域、硬件校色与人体工学支架已完成量产验证。"),
        ("CM27FHD180-26", "27英寸 FHD 电竞显示器", "在研", "主流级", "进行中", "27", "1920×1080", "180Hz", "Fast IPS", "ADCP", 3.0, 8.0, 1299, 980, "以 180Hz 和低延迟为核心，使用共用结构平台控制成本。"),
    ]
    projects = {}
    for order, row in enumerate(project_defs):
        code, name, ptype, tier, status, size, resolution, refresh, panel, stage, fee, profit, target_price, target_cost, assumptions = row
        projects[code] = insert("projects", {"code": code, "name": name, "project_type": ptype, "tier": tier, "status": status, "screen_size": size, "resolution": resolution, "refresh_rate": refresh, "panel_type": panel, "platform_fee_rate": fee, "profit_rate": profit, "category": "显示器", "specs": assumptions, "stage": stage, "target_price": target_price, "financial_target_cost": target_cost, "charter_assumptions": assumptions, "sort_order": order + 1, "is_deleted": 0, "created_at": f"2026-0{5 + order}-0{8 + order} 09:00:00"})

    bom_defs = {
        "CM27QHD165-26": [("显示模块", "BOE-NV270QHM-NY1", 1), ("主控模块", "Realtek-RTD2796", 1), ("主控模块", "Winbond-DDR4-2G", 1), ("主控模块", "Realtek-USBHUB-4P", 1), ("显示模块", "FW-OSD-HDR", 1), ("电源模块", "Huntkey-ADP-180", 1), ("电源模块", "MPS-PMIC-88", 1), ("结构模块", "LENS-REAR-27-Q", 1), ("结构模块", "LENS-BEZEL-27", 1), ("结构模块", "KOKU-STAND-ERG", 1), ("线材模块", "LUXSHARE-DP14-18", 1), ("线材模块", "LUXSHARE-HDMI21-15", 1), ("线材模块", "LUXSHARE-AC-15", 1), ("包装模块", "PACK-BOX-27-Q", 1), ("包装模块", "PACK-EPE-27", 1), ("制造模块", "ODM-SMT-SCALER", 1), ("制造模块", "ODM-ASSY-AGING", 1), ("其他", "ID-LABEL-27", 1)],
        "CM24FHD100-26": [("显示模块", "CSOT-24FHD-100", 1), ("主控模块", "Realtek-RTD2556", 1), ("主控模块", "Winbond-DDR4-2G", 1), ("显示模块", "FW-OSD-HDR", 1), ("电源模块", "Huntkey-ADP-120", 1), ("电源模块", "MPS-PMIC-88", 1), ("结构模块", "LENS-REAR-24-O", 1), ("结构模块", "LENS-BEZEL-24", 1), ("结构模块", "KOKU-STAND-FIX", 1), ("线材模块", "LUXSHARE-HDMI21-15", 1), ("线材模块", "LUXSHARE-AC-15", 1), ("包装模块", "PACK-BOX-24-O", 1), ("包装模块", "PACK-EPE-27", 1), ("制造模块", "ODM-SMT-SCALER", 1), ("制造模块", "ODM-ASSY-AGING", 1), ("其他", "ID-LABEL-27", 1)],
        "CM32UHD144-25": [("显示模块", "LG-LM320UQA-SSA1", 1), ("显示模块", "SENSOR-COLOR-01", 1), ("主控模块", "Realtek-RTD2796", 1), ("主控模块", "Micron-DDR5-4G", 1), ("主控模块", "Realtek-USBHUB-4P", 1), ("显示模块", "MPS-BL-96Z", 1), ("显示模块", "FW-OSD-HDR", 1), ("电源模块", "Chicony-ADP-230", 1), ("电源模块", "MPS-PMIC-88", 1), ("结构模块", "LENS-REAR-32-C", 1), ("结构模块", "KOKU-BASE-32", 1), ("结构模块", "KOKU-STAND-ERG", 1), ("线材模块", "LUXSHARE-DP14-18", 2), ("线材模块", "LUXSHARE-HDMI21-15", 1), ("线材模块", "LUXSHARE-AC-15", 1), ("包装模块", "PACK-BOX-32-C", 1), ("制造模块", "ODM-SMT-SCALER", 1), ("制造模块", "ODM-ASSY-AGING", 1), ("其他", "ID-LABEL-27", 1)],
        "CM27FHD180-26": [("显示模块", "AUO-M270HAN08-180", 1), ("主控模块", "Novatek-MST9U31", 1), ("主控模块", "Winbond-DDR4-2G", 1), ("显示模块", "FW-OSD-HDR", 1), ("电源模块", "Huntkey-ADP-180", 1), ("电源模块", "MPS-PMIC-88", 1), ("结构模块", "LENS-REAR-27-Q", 1), ("结构模块", "LENS-BEZEL-27", 1), ("结构模块", "KOKU-STAND-FIX", 1), ("线材模块", "LUXSHARE-DP14-18", 1), ("线材模块", "LUXSHARE-HDMI21-15", 1), ("线材模块", "LUXSHARE-AC-15", 1), ("包装模块", "PACK-BOX-27-Q", 1), ("包装模块", "PACK-EPE-27", 1), ("制造模块", "ODM-SMT-SCALER", 1), ("制造模块", "ODM-ASSY-AGING", 1), ("其他", "ID-LABEL-27", 1)],
    }
    project_bom_rows = {}
    for code, items in bom_defs.items():
        pid = projects[code]
        project_bom_rows[code] = []
        for module, model, quantity in items:
            part_id = part_ids[model]
            part = con.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone()
            cost = float(part["cost"])
            module_id = one("SELECT id FROM modules WHERE project_id=? AND name=?", (pid, module))
            if not module_id:
                module_id = insert("modules", {"project_id": pid, "name": module, "description": f"{module}的 ODM 报价拆分", "created_at": created, "is_virtual": 0, "estimated_cost": 0, "virtual_remark": "", "category": module, "module_category": module.replace("模块", "")})
            insert("module_items", {"module_id": module_id, "part_id": part_id, "part_name": part["name"], "part_model": model, "main_category": part["main_category"], "sub_category": part["sub_category"], "cost": cost, "quantity": quantity, "remark": "供应商报价明细"})
            bom_id = insert("project_boms", {"project_id": pid, "part_id": part_id, "module_name": module, "quantity": quantity, "remark": "供应商报价明细；可继续补充规格或核价证据", "cost": cost, "is_reference": 0, "reference_remark": "", "is_deleted": 0, "part_name": part["name"], "part_model": model, "part_cost": cost, "main_category": part["main_category"], "sub_category": part["sub_category"], "part_specs": part["specs"], "is_module_item": 0, "custom_data": json.dumps({"报价来源": "ODM 供应商季度报价", "报价批次": "R2"}, ensure_ascii=False), "cost_layer": "packaging" if part["main_category"] == "包材类" else "odm_processing" if part["main_category"] == "加工费类" else "material"})
            project_bom_rows[code].append({"id": bom_id, "module": module, "model": model, "part_id": part_id, "quantity": quantity, "cost": cost, "main": part["main_category"], "name": part["name"], "specs": part["specs"]})
        module_costs = {}
        for row in project_bom_rows[code]:
            module_costs[row["module"]] = module_costs.get(row["module"], 0) + row["cost"] * row["quantity"]
        for module, cost in module_costs.items():
            con.execute("UPDATE modules SET estimated_cost=? WHERE project_id=? AND name=?", (money(cost), pid, module))
        con.execute("UPDATE parts SET projects=? WHERE id IN (SELECT part_id FROM project_boms WHERE project_id=?)", (code, pid))
    for model, part_id in part_ids.items():
        project_codes = [code for code, rows in project_bom_rows.items() if any(row["part_id"] == part_id for row in rows)]
        con.execute("UPDATE parts SET projects=? WHERE id=?", (",".join(project_codes), part_id))

    def bom_cost(code):
        return money(sum(row["cost"] * row["quantity"] for row in project_bom_rows[code]))

    # 规格、BOM版本、目标与成本措施。
    for code, pid in projects.items():
        project = next(row for row in project_defs if row[0] == code)
        values = {"screen_size": project[5], "resolution": project[6], "refresh_rate": project[7], "panel_type": project[8], "brightness": "350" if "24" not in code else "300", "color_gamut": "sRGB 99%" if "32" not in code else "DCI-P3 98%", "ports": "DP 1.4 / HDMI 2.1" if "24" not in code else "DP 1.2 / HDMI 2.0"}
        spec_json = json.dumps(values, ensure_ascii=False, sort_keys=True)
        baseline_id = insert("project_spec_baselines", {"project_id": pid, "version_no": 1, "fingerprint": hashlib.sha256(spec_json.encode()).hexdigest()[:16], "spec_json": spec_json, "changed_fields_json": json.dumps(list(values), ensure_ascii=False), "source_type": "供应商规格确认", "created_at": "2026-08-20 10:00:00"})
        for order, (key, value) in enumerate(values.items()):
            field_id = one("SELECT id FROM category_spec_fields WHERE field_key=? LIMIT 1", (key,))
            if field_id:
                insert("project_spec_values", {"project_id": pid, "field_id": field_id, "value_text": value, "updated_at": "2026-08-20 10:00:00"})
            insert("project_spec_templates", {"project_id": pid, "spec_name": key, "spec_value": value, "sort_order": order})
        insert("project_bom_custom_columns", {"project_id": pid, "field_key": "supplier_quote", "title": "供应商报价", "data_type": "number", "sort_order": 1, "created_at": created})
        current = bom_cost(code)
        fee = float(project[10])
        for version_no, status, factor, date in [(1, "frozen", 1.04, "2026-07-12 16:00:00"), (2, "frozen", 1.01, "2026-08-16 16:00:00")]:
            if code != "CM27QHD165-26" and version_no == 2:
                continue
            total = money(current * factor)
            vid = insert("project_bom_versions", {"project_id": pid, "version_no": version_no, "version_name": f"供应商报价 R{version_no}", "source_type": "supplier_quote", "source_ref_id": 0, "stage": project[9], "status": status, "data_fingerprint": hashlib.sha256(f"{code}:{version_no}".encode()).hexdigest()[:16], "total_cost": total, "created_at": date, "frozen_at": date})
            for row in project_bom_rows[code]:
                line_cost = money(row["cost"] * factor)
                insert("project_bom_version_lines", {"version_id": vid, "source_bom_id": row["id"], "canonical_part_id": row["part_id"], "module_name": row["module"], "part_name": row["name"], "part_model": row["model"], "specs": row["specs"], "quantity": row["quantity"], "unit_cost": line_cost, "line_total": money(line_cost * row["quantity"]), "cost_layer": "material", "relation_key": row["model"], "raw_json": "{}"})
        target = float(project[13])
        for domain, current_domain in sorted({row["main"]: sum(x["cost"] * x["quantity"] for x in project_bom_rows[code] if x["main"] == row["main"]) for row in project_bom_rows[code]}.items()):
            target_domain = money(current_domain * (0.95 if domain in {"硬件类", "结构类"} else 0.97))
            insert("project_targets", {"project_id": pid, "domain": domain, "target_cost": target_domain, "remark": "按供应商历史报价中位数与降本机会分解", "baseline_cost": money(current_domain), "opportunity_amount": money(current_domain - target_domain), "allocated_challenge": money(current_domain - target_domain), "status": "confirmed"})
        v1 = insert("project_target_versions", {"project_id": pid, "version_no": 1, "target_cost": target, "baseline_cost": current, "challenge_gap": money(current - target), "status": "frozen", "source_version_ids": "1", "created_at": "2026-08-21 15:00:00", "frozen_at": "2026-08-21 15:00:00"})
        if code == "CM27QHD165-26":
            insert("project_target_versions", {"project_id": pid, "version_no": 2, "target_cost": money(target - 28), "baseline_cost": money(current - 18), "challenge_gap": money(current - 18 - (target - 28)), "status": "draft", "source_version_ids": "1,2", "created_at": "2026-09-01 11:30:00", "frozen_at": None})
        for domain, current_domain in sorted({row["main"]: sum(x["cost"] * x["quantity"] for x in project_bom_rows[code] if x["main"] == row["main"]) for row in project_bom_rows[code]}.items()):
            con.execute("UPDATE project_targets SET version_id=? WHERE project_id=? AND domain=?", (v1, pid, domain))
        measures = {
            "CM27QHD165-26": [("硬件类", "将主控板由 RTD2796 议价至两家供应商中位价", "进行中", "采购负责人", 46, 0, "2026-09-12"), ("结构类", "与 27 英寸 FHD 平台共用升降支架模具", "待执行", "结构工程", 32, 0, "2026-09-20"), ("线材类", "将 HDMI 2.1 线切换为年度框架价", "已完成", "供应链", 12, 12, "2026-08-28")],
            "CM24FHD100-26": [("电源类", "120W 适配器引入第二供应商", "执行中", "供应链", 9, 0, "2026-09-15"), ("结构类", "固定支架与商显平台共用底座", "已完成", "结构工程", 14, 14, "2026-08-22")],
            "CM32UHD144-25": [("包材类", "彩盒护角从纸浆模塑改为通用 EPE", "已完成", "包装工程", 18, 18, "2026-06-30")],
            "CM27FHD180-26": [("结构类", "复用 QHD 项目前框与后壳模具", "待执行", "结构工程", 24, 0, "2026-09-18"), ("硬件类", "主控板增加备选供应商并重新比价", "执行中", "采购负责人", 18, 0, "2026-09-10")],
        }[code]
        for category, measure, status, owner, forecast, realized, due in measures:
            insert("project_measures", {"project_id": pid, "main_category": category, "measure": measure, "status": status, "due_date": due, "owner": owner, "remark": "需在下一轮报价或样机评审中复核", "created_at": "2026-08-19 09:00:00", "updated_at": "2026-09-02 18:00:00", "forecast_saving": forecast, "realized_saving": realized, "realized_evidence": "供应商 R2 报价已核对" if realized else ""})
        for index, (stage, factor, date) in enumerate([("立项评审", 1.10, "2026-06-08 10:00:00"), ("样机评审", 1.05, "2026-07-15 14:00:00"), ("阶段报价评审", 1.02, "2026-08-16 15:30:00"), ("当前复盘", 1.00, "2026-09-02 18:19:00")]):
            insert("project_cost_reviews", {"project_id": pid, "stage": stage, "reviewed_cost": money(current * factor), "reviewer": "成本与供应链联合评审", "reviewed_at": date, "remark": "对照当期 BOM、供应商报价与已确认措施复核"})
            insert("project_cost_snapshots", {"project_id": pid, "snapshot_type": "manual_snapshot", "change_reason": ["首版供应商报价", "面板与主控价格复核", "结构平台共用后更新", "当前报价基线"][index], "bom_cost": money(current * factor), "total_cost": money(current * factor * (1 + fee / 100)), "platform_fee_rate": fee, "profit_rate": project[11], "module_count": len(set(row["module"] for row in project_bom_rows[code])), "item_count": len(project_bom_rows[code]), "created_at": date, "change_details": json.dumps({"stage": stage, "review": "供应商报价和 BOM 版本已留痕"}, ensure_ascii=False), "stage": project[9]})
        for sku_code, sku_name, spec_desc, model, diff_type in [("STD", "标准版", "基础支架 / 165Hz", "KOKU-STAND-ERG", "保留"), ("ECO", "降本版", "固定支架 / 144Hz", "KOKU-STAND-FIX", "替换")]:
            sid = insert("project_skus", {"project_id": pid, "sku_code": sku_code, "sku_name": sku_name, "spec_desc": spec_desc, "remark": "面向不同渠道的配置变体", "created_at": created})
            if sid and diff_type == "替换":
                insert("sku_diffs", {"sku_id": sid, "diff_type": "替换", "module_name": "结构模块", "part_name": "人体工学升降支架", "part_model": "KOKU-STAND-ERG", "new_model": model, "quantity": 1, "unit_cost": part_ids[model] and one("SELECT cost FROM parts WHERE id=?", (part_ids[model],)), "remark": "渠道版成本与功能取舍"})

    # 成本策划的基线候选、变更包与项目分组。一个模块只生成一条基线，避免把模块内每个 BOM 行误显示成多个机会。
    for code, pid in projects.items():
        module_totals = {}
        module_sources = {}
        for row in project_bom_rows[code]:
            if row["module"] in {"显示模块", "主控模块", "电源模块"}:
                module_totals[row["module"]] = module_totals.get(row["module"], 0) + row["cost"] * row["quantity"]
                module_sources.setdefault(row["module"], row["id"])
        for module, value in module_totals.items():
            insert("cost_baseline_decisions", {"project_id": pid, "baseline_type": "module", "category": module, "scope_key": f"{code}:{module}", "source_type": "project_bom", "source_ref_id": module_sources[module], "value": money(value), "comparable_rule_json": json.dumps({"same_model": True, "history_window": "180d"}), "status": "confirmed" if code == "CM27QHD165-26" else "candidate", "rationale": "基于当前模块合计与同型号历史报价形成的初始基线", "confirmed_at": "2026-08-28 11:00:00" if code == "CM27QHD165-26" else None, "created_at": "2026-08-22 10:00:00"})
        package = insert("project_change_packages", {"project_id": pid, "title": "主控与结构平台降本变更包", "trigger_type": "cost_down", "trigger_field": "供应商报价", "before_value": "当前 BOM 基线", "after_value": "目标成本版本", "status": "confirmed" if code == "CM27QHD165-26" else "draft", "confidence": 0.86, "rationale": "来源于供应商多报价差异与跨项目共用平台机会", "created_at": "2026-08-28 11:30:00", "confirmed_at": "2026-08-29 16:00:00" if code == "CM27QHD165-26" else None})
        group_name = "在研报价项目" if next(row for row in project_defs if row[0] == code)[4] == "进行中" else "量产复盘项目"
        group_id = one("SELECT id FROM project_groups WHERE name=?", (group_name,)) or insert("project_groups", {"name": group_name, "description": "按项目生命周期归档报价、目标与复盘记录", "created_at": created})
        insert("project_group_members", {"group_id": group_id, "project_id": pid})

    # 供应商与多报价价格历史。
    supplier_defs = [("华东视讯科技", "华东", "周工", "13810001201", 5), ("南方智显电子", "华南", "陈工", "13810001202", 4), ("精工显示制造", "华东", "李工", "13810001203", 4), ("星河视讯 ODM", "华南", "王工", "13810001204", 4), ("远景电子供应链", "华北", "赵工", "13810001205", 3)]
    supplier_ids = {}
    for name, region, contact, phone, rating in supplier_defs:
        supplier_ids[name] = insert("supplier_profiles", {"supplier_name": name, "category": "显示器 ODM", "contact": contact, "phone": phone, "rating": rating, "remark": f"{region}供应商；已完成季度报价核验", "created_at": "2026-05-08 09:00:00", "updated_at": "2026-09-02 18:00:00"})
    for model, pid in list(part_ids.items())[:24]:
        base = float(one("SELECT cost FROM parts WHERE id=?", (pid,)))
        for index, (supplier, factor) in enumerate([("华东视讯科技", 1.00), ("南方智显电子", 1.035), ("精工显示制造", 0.972)]):
            price = money(base * factor)
            sid = insert("part_suppliers", {"part_id": pid, "supplier_name": supplier, "price": price, "unit_price": price, "share_ratio": 0.34, "is_active": 1, "remark": "季度报价已核对规格与税口径", "created_at": "2026-08-20 09:00:00", "updated_at": "2026-09-02 18:00:00"})
            insert("part_price_history", {"part_id": pid, "old_cost": money(price * 1.06), "new_cost": price, "changed_at": f"2026-0{6 + index}-1{index + 2} 10:00:00"})
            insert("part_supplier_price_history", {"supplier_id": sid, "old_price": money(price * 1.04), "new_price": price, "changed_at": "2026-08-20 10:00:00", "change_reason": "季度报价复核", "part_id": pid, "supplier_name": supplier})

    for code, pid in projects.items():
        current = bom_cost(code)
        for index, supplier in enumerate(["华东视讯科技", "南方智显电子", "精工显示制造"]):
            insert("project_suppliers", {"project_id": pid, "supplier_name": supplier, "quoted_price": money(current * (1.02 + index * 0.025)), "share_ratio": 0.33, "is_active": 1, "remark": "项目级整机报价，需与 BOM 明细联核", "created_at": "2026-08-20 09:00:00", "updated_at": "2026-09-02 18:00:00"})

    # 竞品与 BOM 估算：用于项目总览和竞品成本对比。
    competitor_defs = [
        ("AOC", "Q27G4", "主流级", 1499, "27", "2560×1440", "180Hz", "Fast IPS", "电商主流 QHD 高刷竞品"),
        ("Dell", "P2723D", "中高端", 2199, "27", "2560×1440", "60Hz", "IPS", "商用办公竞品"),
        ("ASUS", "VG27AQ3A", "中高端", 1899, "27", "2560×1440", "180Hz", "Fast IPS", "电竞高刷竞品"),
        ("BenQ", "PD3225U", "高端", 4999, "32", "3840×2160", "60Hz", "IPS Black", "创作设计竞品"),
        ("Lenovo", "P24h-30", "主流级", 1399, "24", "2560×1440", "100Hz", "IPS", "办公显示器竞品"),
    ]
    comp_ids = {}
    for brand, model, tier, price, size, resolution, refresh, panel, remark in competitor_defs:
        comp_ids[model] = insert("competitors", {"brand": brand, "model": model, "tier": tier, "market_price": price, "bom_cost": 0, "platform_fee_rate": 3.0, "remark": remark, "created_at": "2026-08-18 10:00:00", "sort_order": len(comp_ids) + 1, "category": "显示器", "screen_size": size, "resolution": resolution, "refresh_rate": refresh, "panel_type": panel, "specs": f"{size}英寸 / {resolution} / {refresh} / {panel}"})
    competitor_boms = {
        "Q27G4": [("显示模块", "CSOT-27QHD-165", 1, 560), ("主控模块", "Novatek-MST9U31", 1, 61), ("结构模块", "KOKU-STAND-FIX", 1, 70), ("电源模块", "Huntkey-ADP-180", 1, 68), ("包装模块", "PACK-BOX-27-Q", 1, 25)],
        "P2723D": [("显示模块", "CSOT-27QHD-165", 1, 590), ("主控模块", "Realtek-RTD2556", 1, 45), ("结构模块", "KOKU-STAND-ERG", 1, 136), ("电源模块", "Huntkey-ADP-120", 1, 48), ("包装模块", "PACK-BOX-27-Q", 1, 25)],
        "VG27AQ3A": [("显示模块", "AUO-M270HAN08-180", 1, 460), ("主控模块", "Novatek-MST9U31", 1, 60), ("结构模块", "KOKU-STAND-ERG", 1, 128), ("电源模块", "Huntkey-ADP-180", 1, 70), ("包装模块", "PACK-BOX-27-Q", 1, 25)],
        "PD3225U": [("显示模块", "LG-LM320UQA-SSA1", 1, 1190), ("主控模块", "Realtek-RTD2796", 1, 78), ("结构模块", "KOKU-STAND-ERG", 1, 135), ("电源模块", "Chicony-ADP-230", 1, 100), ("包装模块", "PACK-BOX-32-C", 1, 40)],
        "P24h-30": [("显示模块", "CSOT-24FHD-100", 1, 390), ("主控模块", "Realtek-RTD2556", 1, 44), ("结构模块", "KOKU-STAND-FIX", 1, 68), ("电源模块", "Huntkey-ADP-120", 1, 50), ("包装模块", "PACK-BOX-24-O", 1, 21)],
    }
    for model, items in competitor_boms.items():
        cid = comp_ids[model]
        total = 0
        for module, part_model, quantity, cost in items:
            our_id = part_ids.get(part_model)
            our_cost = float(one("SELECT cost FROM parts WHERE id=?", (our_id,))) if our_id else 0
            insert("competitor_boms", {"competitor_id": cid, "part_id": our_id, "part_name": con.execute("SELECT name FROM parts WHERE id=?", (our_id,)).fetchone()[0] if our_id else part_model, "part_model": part_model, "module_name": module, "estimated_cost": cost, "quantity": quantity, "is_mapped": 1 if our_id else 0, "our_part_name": con.execute("SELECT name FROM parts WHERE id=?", (our_id,)).fetchone()[0] if our_id else "", "our_part_model": part_model if our_id else "", "our_cost": our_cost, "our_quantity": quantity})
            total += cost * quantity
        con.execute("UPDATE competitors SET bom_cost=? WHERE id=?", (money(total), cid))

    # 招标工作台：3 家供应商、3 轮报价、原文批次、匹配与议价线索。
    primary = projects["CM27QHD165-26"]
    spec_baseline = one("SELECT id FROM project_spec_baselines WHERE project_id=? ORDER BY version_no DESC LIMIT 1", (primary,))
    round_ids = []
    for round_no, name, stage, date in [(1, "摸底报价", "摸底报价", "2026-07-10 09:30:00"), (2, "规格确认报价", "比价", "2026-08-05 14:00:00"), (3, "谈价回合", "谈价", "2026-09-02 16:30:00")]:
        round_ids.append(insert("tender_rounds", {"project_id": primary, "round_no": round_no, "name": name, "stage": stage, "spec_baseline_id": spec_baseline, "status": "active" if round_no == 3 else "closed", "created_at": date}))
    quote_lines = []
    base_rows = project_bom_rows["CM27QHD165-26"]
    factors = {"华东视讯科技": [1.04, 1.00, 0.98], "南方智显电子": [1.08, 1.03, 1.01], "精工显示制造": [1.02, 0.99, 0.965]}
    for supplier, supplier_factors in factors.items():
        for round_no, round_id in enumerate(round_ids, start=1):
            factor = supplier_factors[round_no - 1]
            lines = []
            for source_row, row in enumerate(base_rows, start=2):
                price = money(row["cost"] * factor)
                line_total = money(price * row["quantity"])
                lines.append((row, price, line_total))
            batch_total = money(sum(line[2] for line in lines))
            batch_id = insert("supplier_quote_batches", {"project_id": primary, "tender_round_id": round_id, "supplier_name": supplier, "batch_no": 1, "source_file_name": f"{supplier}_R{round_no}_报价.xlsx", "source_file_hash": hashlib.sha256(f"{supplier}:{round_no}".encode()).hexdigest(), "quoted_at": f"2026-0{6 + round_no}-0{4 + round_no} 09:00:00", "status": "accepted" if round_no == 3 else "archived", "currency": "CNY", "tax_mode": "exclusive", "pricing_mode": "one_time", "total_amount": batch_total, "created_at": f"2026-0{6 + round_no}-0{4 + round_no} 09:30:00"})
            for source_row, (row, price, line_total) in enumerate(lines, start=2):
                line_id = insert("supplier_quote_lines", {"batch_id": batch_id, "source_row": source_row, "raw_name": row["name"], "raw_model": row["model"], "raw_specs": row["specs"], "module_name": row["module"], "quantity": row["quantity"], "unit_price": price, "line_total": line_total, "remark": "未税一口价；与当前规格基线匹配", "raw_json": json.dumps({"模块": row["module"], "器件名称": row["name"], "型号": row["model"], "数量": row["quantity"], "单价": price}, ensure_ascii=False), "canonical_key": row["model"], "relation_type": "exact", "match_confidence": 0.98, "created_at": "2026-09-02 16:30:00"})
                quote_lines.append((supplier, round_no, line_id, row, price, line_total))
                insert("quote_line_matches", {"quote_line_id": line_id, "canonical_part_id": row["part_id"], "relation_type": "exact", "confidence": 0.98, "spec_diff_json": "{}", "source": "名称+型号精确匹配", "remark": "规格字段已核对", "created_at": "2026-09-02 17:00:00"})
    for at, event_type, summary, detail, actor in [("2026-07-10 09:30:00", "quote_imported", "第1轮摸底报价导入", "3家供应商共提交 18 项报价", "供应链"), ("2026-08-05 14:00:00", "quote_imported", "第2轮规格确认报价导入", "面板、主控和结构件完成可比匹配", "供应链"), ("2026-08-18 11:20:00", "quote_match_confirmed", "主控板匹配关系复核", "RTD2796 与供应商原文规格一致", "成本工程"), ("2026-09-02 16:30:00", "quote_imported", "第3轮谈价报价导入", "形成当前轮次理论组合底价", "供应链")]:
        insert("project_process_events", {"project_id": primary, "event_type": event_type, "summary": summary, "detail": detail, "actor": actor, "created_at": at})
    latest_lines = [row for row in quote_lines if row[1] == 3]
    for supplier, _, line_id, row, price, line_total in latest_lines:
        if row["model"] in {"BOE-NV270QHM-NY1", "Realtek-RTD2796", "KOKU-STAND-ERG", "Huntkey-ADP-180"}:
            benchmark = money(row["cost"] * 0.965)
            insert("negotiation_items", {"project_id": primary, "quote_line_id": line_id, "module_name": row["module"], "material_name": row["name"], "specs": row["specs"], "benchmark_supplier": "精工显示制造", "benchmark_price": benchmark, "target_supplier": supplier, "target_price": benchmark, "current_price": price, "status": "sent" if row["model"] == "Realtek-RTD2796" else "draft", "note": "以第3轮可比最低价为谈判锚点，需补充交期和质量条款", "created_at": "2026-09-02 17:20:00", "updated_at": "2026-09-02 17:20:00"})
    insert("tender_decisions", {"project_id": primary, "selected_supplier": "精工显示制造", "final_quote": 1128.00, "status": "selected", "rationale": "综合考虑可比报价、面板供货稳定性、交期与第二供应商备供能力。", "review_summary": "主控与面板仍保留季度复核点；结构件采用共用平台后再做一次量产复盘。", "decided_at": "2026-09-03 10:00:00", "created_at": "2026-09-03 10:00:00", "updated_at": "2026-09-03 10:00:00"})

    # 物料行情与分解树：每张卡都有最新方向、简短原因和可回看的历史快照。
    trend_specs = [
        ("27英寸 QHD 高刷面板", "上涨", "高刷面板近期小幅上涨，主要受 27 英寸高刷需求回暖与部分产线排产收紧影响。", "控制备货节奏，谈价时锁定季度框架价", 2.4),
        ("Realtek HDMI 2.1 主控板", "下降", "主控板报价回落，主要因第二供应商进入量产配套，替代料竞争扩大。", "以低价供应商作为基准推进二次议价", -4.8),
        ("Novatek 高刷主控板", "震荡", "高刷主控价格横盘，主要受芯片交期稳定但小批量需求分散影响。", "保持两家合格供应商，不急于切换", 0.6),
        ("180W 外置适配器", "下降", "适配器报价继续下探，主要因年度框架采购和铜材成本回落释放空间。", "在下一轮报价中要求同步下调", -3.1),
        ("人体工学升降支架", "上涨", "升降支架价格上行，主要因铝材与表面处理成本增加，且小批量模具摊销偏高。", "优先推动平台共用和模具摊销复核", 3.8),
        ("DDR4 2GB 显存缓存", "震荡", "DDR4 2GB 报价震荡，主要因存量库存消化与品牌颗粒补库节奏不一致。", "保留替代料并持续记录历史低价", 0.2),
        ("DP 1.4 视频线", "下降", "DP 1.4 线材价格走低，主要因年度框架量提升与连接器采购集中。", "用年度框架价替换一次性报价", -2.6),
        ("Mini LED 背光驱动板", "分化", "背光驱动板出现分化，主要因不同分区规格和调光方案导致可比口径不一致。", "先按分区数和效率拆分规格再比价", 1.1),
        ("32英寸 4K 创作面板", "下降", "4K 创作面板价格回落，主要因大尺寸面板稼动率修复与创作类需求进入常态。", "量产后复盘长协价与色彩规格溢价", -5.2),
        ("商用显示器固定支架", "下降", "固定支架报价稳定下行，主要因商用平台共用与订单规模增加。", "纳入 24 英寸商用平台通用件清单", -2.0),
    ]
    trend_ids = {}
    for index, (category, direction, summary, action, magnitude) in enumerate(trend_specs):
        item_id = insert("trend_items", {"query_category": category, "category_type": "直接查询", "trend_direction": direction, "confidence_level": "高" if index % 3 else "中", "summary": summary, "suggested_action": action, "raw_search_results": json.dumps({"basis": "供应商季度报价汇总", "review_window": "2026Q2-2026Q3", "method": "历史报价复核"}, ensure_ascii=False), "last_updated_at": "2026-09-02 18:19:00", "created_at": "2026-06-12 09:00:00", "magnitude_min": magnitude - 0.8, "magnitude_max": magnitude + 0.8, "magnitude_reference": "季度报价变化（内部复核）", "source_type": "supplier_quote", "last_queried_at": "2026-09-02 18:19:00"})
        trend_ids[category] = item_id
        for snap_index, snap_direction in enumerate(["下降", "震荡", direction]):
            query_time = ["2026-06-12 09:00:00", "2026-07-18 10:30:00", "2026-09-02 18:19:00"][snap_index]
            snap_summary = summary if snap_index == 2 else f"{category}在{query_time[:7]}的报价判断为{snap_direction}，需结合供应商批次与规格口径继续核验。"
            snapshot_id = insert("trend_snapshots", {"trend_item_id": item_id, "query_time": query_time, "direction": snap_direction, "confidence_level": "中" if snap_index < 2 else "高", "magnitude_min": magnitude - 1.0 + snap_index * 0.3, "magnitude_max": magnitude + 1.0 + snap_index * 0.3, "magnitude_reference": "季度报价变化（内部复核）", "summary": snap_summary, "suggested_action": action, "raw_search_results": "supplier_quote|history_review", "source_type": "supplier_quote", "skill_used": "supplier-price-review", "confidence": "0.82" if snap_index == 2 else "0.68", "result_json": json.dumps({"headline": snap_summary, "direction": snap_direction, "drivers": [{"label": "报价复核", "text": summary}], "actions": [{"label": "下一步", "text": action}]}, ensure_ascii=False)})
            source_id = insert("trend_sources", {"trend_item_id": item_id, "source_title": "供应商季度报价汇总", "source_url": "", "excerpt": "内部供应商报价批次与历史价格记录已核对。", "trend_snapshot_id": snapshot_id})
            insert("trend_insight_dimensions", {"trend_snapshot_id": snapshot_id, "dimension_type": "主要原因", "content": summary, "evidence_strength": "高" if snap_index == 2 else "中", "source_title": "供应商季度报价汇总", "source_url": "", "dimension_order": 0, "data_points": json.dumps({"snapshot": snap_index + 1, "magnitude": magnitude}, ensure_ascii=False)})
            insert("trend_key_events", {"trend_snapshot_id": snapshot_id, "event_date": query_time[:10], "event_description": "完成供应商报价批次复核并更新判断", "impact_direction": "positive" if snap_direction == "下降" else "negative" if snap_direction == "上涨" else "neutral", "source_title": "供应商季度报价汇总", "source_url": ""})
        part_id = part_ids.get(next((model for model, value in part_ids.items() if con.execute("SELECT name FROM parts WHERE id=?", (value,)).fetchone()[0] == category), ""))
        if part_id:
            insert("trend_part_mapping", {"part_id": part_id, "trend_item_id": item_id, "created_at": "2026-09-02 18:19:00"})
    parent_trend = insert("trend_items", {"query_category": "CM27QHD165-26 电源模块", "category_type": "分解洞察", "trend_direction": "分化", "confidence_level": "中", "summary": "电源模块报价出现分化，主要因适配器降价但 PMIC 与小批量加工费保持稳定。", "suggested_action": "进入分解树分别核验适配器、PMIC 与加工费", "raw_search_results": "supplier_quote|module_decomposition", "last_updated_at": "2026-09-02 18:19:00", "created_at": "2026-08-11 09:00:00", "source_type": "decomposition", "last_queried_at": "2026-09-02 18:19:00"})
    root_id = insert("decomposition_tree", {"root_part_id": None, "parent_id": None, "component_name": "CM27QHD165-26 电源模块", "cost_ratio_estimate": 100, "source_type": "user_confirmed", "node_type": "structural", "insight_status": "partial", "trend_item_id": parent_trend, "remark": "按项目 BOM 模块拆分；终端节点保留独立趋势历史"})
    con.execute("UPDATE decomposition_tree SET root_part_id=? WHERE id=?", (root_id, root_id))
    child_specs = [("180W 外置适配器", 72, trend_ids["180W 外置适配器"], "queried"), ("显示器 PMIC", 8.6, None, "ready"), ("整机组装与老化检验", 38, None, "pending")]
    for name, cost, trend_id, status in child_specs:
        insert("decomposition_tree", {"root_part_id": root_id, "parent_id": root_id, "component_name": name, "cost_ratio_estimate": money(cost / 118.6 * 100), "source_type": "project_bom", "node_type": "terminal", "insight_status": status, "trend_item_id": trend_id, "remark": "来自当前项目 BOM 的终端节点"})
    for category in ["27英寸 QHD 高刷面板", "Realtek HDMI 2.1 主控板", "180W 外置适配器"]:
        payload = [{"name": category, "type": "rule", "diff": 0, "reason": "同型号跨供应商报价已形成可比区间", "rows": [{"project": "CM27QHD165-26", "projectId": primary, "name": category, "cost": float(one("SELECT cost FROM parts WHERE name=? LIMIT 1", (category,)) or 0)}]}]
        if not one("SELECT id FROM part_insights WHERE category=? AND module_name=?", ("显示器", "供应商报价审核")):
            insert("part_insights", {"category": "显示器", "module_name": "供应商报价审核", "insight_json": json.dumps(payload, ensure_ascii=False), "status": "unread", "created_at": "2026-09-02 18:19:00", "handled_json": "[]"})
    insert("decomposition_history", {"root_part_id": part_ids["BOE-NV270QHM-NY1"], "summary": "面板、主控、电源与结构节点已建立分解关系"})

    # 用户原声、产品特性与卖点价值：与价值权衡面板直接关联。
    voice_product = "CM27QHD165-26"
    voice_items = [
        ("高刷拖影控制得不错，办公和轻度游戏都够用，但底座占桌面比较大。", "电商评价"),
        ("文字清晰，长时间看表格眼睛不会太累，亮度调节也比较顺手。", "电商评价"),
        ("希望 DP 和 HDMI 都能稳定跑满高刷新，切换笔记本时不要黑屏。", "售后工单"),
        ("升降和旋转很实用，会议共享时不用搬动整台显示器。", "用户访谈"),
        ("如果主控和支架还能再便宜一些，整体配置会更有竞争力。", "渠道反馈"),
        ("颜色比上一代自然，默认模式不偏冷，做表格和看图都舒服。", "电商评价"),
        ("包装保护到位，但彩盒体积偏大，仓储和运输占用比较明显。", "供应商售后"),
        ("USB 接口数量够用，键鼠和 U 盘不用频繁插拔主机。", "电商评价"),
    ]
    for content, platform in voice_items:
        insert("voice_item", {"content": content, "source": platform, "created_at": "2026-08-18 12:00:00", "product": voice_product, "project_id": primary, "source_platform": platform, "source_product": "27英寸 QHD 高刷办公显示器", "collected_at": "2026-08-18"})
    voice_dims = [("高刷与响应", 1.30, 28, 22, 3, "高刷、拖影与切换稳定性反复出现", "主控模块"), ("护眼与画质", 1.20, 24, 20, 2, "清晰度、默认色彩和长时间观看体验被多次提及", "显示模块"), ("支架灵活性", 1.05, 18, 15, 2, "升降旋转能直接改善办公与会议场景", "结构模块"), ("接口稳定性", 0.95, 16, 11, 4, "用户关注 DP/HDMI 高刷协同与切换黑屏", "主控模块"), ("价格感知", 0.90, 14, 7, 5, "配置认可度高，但主控和支架价格影响购买决策", "整机")]
    dimension_ids = {}
    for name, weight, count, positive, negative, evidence, module in voice_dims:
        dimension_ids[name] = insert("voice_dimension", {"name": name, "weight": weight, "count": count, "positive": positive, "negative": negative, "evidence": evidence, "created_at": "2026-08-20 09:00:00", "product": voice_product, "kind": "模型提炼后人工确认", "project_id": primary, "kano_category": "期望型" if name in {"护眼与画质", "高刷与响应"} else "基本型", "decision": "保留并进入规格权衡", "rationale": evidence, "confirmed": 1, "module_name": module})
    features = [("高刷体验", 1.3, "期望型", "优先保证 165Hz 与低延迟", 1), ("护眼画质", 1.2, "基本型", "作为办公显示器的核心体验", 1), ("支架人体工学", 1.05, "期望型", "用共用平台控制结构溢价", 1), ("接口稳定性", 0.95, "基本型", "纳入主控规格与报价审核", 1)]
    feature_ids = {}
    for name, weight, kano, decision, confirmed in features:
        feature_ids[name] = insert("product_features", {"name": name, "weight": weight, "created_at": "2026-08-20 09:00:00", "type": "用户原声", "project_id": primary, "kano_category": kano, "decision": decision, "rationale": "由用户原声与项目规格共同确认", "confirmed": confirmed})
        insert("product_scores", {"ref_type": "project", "ref_id": primary, "feature_id": feature_ids[name], "score": round(75 + weight * 10, 1)})
    radar_feature_ids = {}
    for name in ["性能", "规格", "显示", "外观", "可靠性"]:
        radar_feature_ids[name] = insert("product_features", {"name": name, "weight": 1.0, "created_at": "2026-08-20 09:00:00", "type": "radar", "project_id": 0})
    for module, feature_names in {
        "显示模块": ["性能", "规格", "显示"], "主控模块": ["性能", "规格", "可靠性"],
        "电源模块": ["可靠性"], "结构模块": ["外观", "可靠性"], "线材模块": ["可靠性"],
        "包装模块": ["外观", "可靠性"], "制造模块": ["可靠性"],
    }.items():
        for feature_name in feature_names:
            insert("module_feature_links", {"module_name": module, "feature_id": radar_feature_ids[feature_name]})
    project_radar_links = {
        "显示模块": ["性能", "规格", "显示"], "主控模块": ["性能", "规格", "可靠性"],
        "电源模块": ["可靠性"], "结构模块": ["外观", "可靠性"], "线材模块": ["可靠性"],
        "包装模块": ["外观", "可靠性"], "制造模块": ["可靠性"],
    }
    for project_id in projects.values():
        for sort_order, feature_name in enumerate(["性能", "规格", "显示", "外观", "可靠性"], 1):
            insert("project_competitive_dimensions", {"project_id": project_id, "feature_id": radar_feature_ids[feature_name], "name": feature_name, "sort_order": sort_order, "enabled": 1})
        for module, feature_names in project_radar_links.items():
            for feature_name in feature_names:
                insert("project_module_feature_links", {"project_id": project_id, "module_name": module, "feature_id": radar_feature_ids[feature_name]})
    radar_scores = {
        "CM27QHD165-26": [8.5, 8.0, 8.8, 7.5, 8.0], "Q27G4": [9.0, 8.0, 8.6, 6.8, 7.5],
        "P2723D": [6.5, 8.8, 7.4, 7.8, 8.8], "VG27AQ3A": [9.2, 7.8, 8.4, 7.0, 7.6],
        "PD3225U": [7.6, 9.0, 9.4, 8.8, 8.7], "P24h-30": [6.8, 8.3, 7.2, 7.6, 8.2],
    }
    for ref, scores in radar_scores.items():
        ref_type, ref_id = ("project", projects[ref]) if ref in projects else ("competitor", comp_ids[ref])
        for feature_name, score in zip(["性能", "规格", "显示", "外观", "可靠性"], scores):
            insert("product_scores", {"ref_type": ref_type, "ref_id": ref_id, "feature_id": radar_feature_ids[feature_name], "score": score})
    insert("selling_points", {"project_id": primary, "product": voice_product, "name": "165Hz 清晰办公", "description": "以高刷、护眼和稳定接口覆盖高频办公与轻度游戏场景。", "positive": 22, "negative": 4, "sort_order": 1, "created_at": "2026-08-22 16:00:00"})
    insert("selling_points", {"project_id": primary, "product": voice_product, "name": "升降旋转支架", "description": "把升降、旋转与会议共享的用户价值和结构成本放在同一张权衡表中。", "positive": 15, "negative": 3, "sort_order": 2, "created_at": "2026-08-22 16:00:00"})
    insert("selling_point_analysis", {"project_id": primary, "product": voice_product, "conclusion": "用户最在意高刷响应、护眼画质与接口稳定性；升降支架是有感知的差异点，但需通过平台共用控制成本。", "source": "用户原声与成本策划联动", "created_at": "2026-08-23 10:00:00"})
    for feature, score in [("高刷体验", 88), ("护眼画质", 84), ("支架人体工学", 78), ("接口稳定性", 80)]:
        insert("value_scores", {"ref_type": "project", "ref_id": primary, "feature_key": feature, "score": score, "category": "用户价值", "updated_at": "2026-08-23 10:00:00"})

    # 工作日志、AI 建议和可回看的分析成果。
    logs = [("2026-09-02", "第3轮报价复核", "精工显示制造在面板、主控和支架上形成最低可比价；已将四条差异转入议价清单。", "报价审核", "重要", "跟进主控二次议价", primary), ("2026-08-28", "用户原声与规格权衡", "高刷、护眼和支架体验是当前项目的主要价值维度，已同步到产品特性。", "产品分析", "重要", "将特性权重带入目标成本评审", primary), ("2026-08-20", "面板价格历史复核", "QHD 高刷面板近两个月报价先稳后升，当前基线按三家供应商中位数管理。", "物料审核", "一般", "下轮报价要求锁定季度价格", primary)]
    for date, title, content, category, importance, next_action, pid in logs:
        insert("work_logs", {"log_date": date, "title": title, "content": content, "category": category, "tags": "ODM,报价审核,可追溯", "created_at": f"{date} 16:00:00", "updated_at": f"{date} 16:00:00", "is_todo": 1 if next_action else 0, "done": 0, "work_project": "CM27QHD165-26", "record_type": "decision", "impact": importance, "next_action": next_action, "evidence_json": json.dumps({"project_id": pid}, ensure_ascii=False), "importance": importance, "project_id": pid, "stage": "PDCP"})
    insert("work_summaries", {"title": "Q3 项目成本与报价周报", "content": "CM27QHD165-26 已完成第3轮供应商报价复核，当前整机报价最低为精工显示制造；主控板与升降支架仍有可谈空间。", "start_date": "2026-08-31", "end_date": "2026-09-04", "created_at": "2026-09-03 09:00:00", "summary_type": "项目周报", "project_filter": "CM27QHD165-26", "source_log_ids_json": "[]"})
    insert("local_ai_context", {"key": "odm-cost-review", "title": "ODM 报价审核口径", "content": "品牌方不直接采购器件；器件价格来自供应商报价。优先比较同型号多供应商价格、历史报价与模块合计，再形成议价清单。", "updated_at": "2026-09-02 18:19:00", "category": "project"})
    insert("local_ai_context", {"key": "cost-planning-flow", "title": "成本策划使用顺序", "content": "先保存并冻结规格基线，再冻结当前 BOM，接着确认领域目标，最后把差异沉淀为变更包。价值权衡和成本墙用于补充判断。", "updated_at": "2026-09-02 18:19:00", "category": "workflow"})
    for index, (title, conclusion, saving, status) in enumerate([("先以精工显示制造作为主控谈价锚点", "第3轮报价中主控板、面板与支架存在可比差异；建议按最低可比价发起一次目标价确认，并保留交期与质量条款。", 46, "open"), ("将升降支架纳入共用平台", "当前结构成本中的升降支架占比较高，与 FHD 电竞项目存在共用机会；先核对模具、承重和外观一致性，再确认节省。", 32, "open"), ("把用户原声的高刷体验写入目标约束", "高刷与响应是用户高频关注维度，目标成本不应通过削弱接口稳定性或刷新体验来实现。", 18, "adopted")]):
        run_id = f"odm-review-202609-{index + 1}"
        insert("ai_analysis_runs", {"run_id": run_id, "skill_id": "cost-review", "skill_version": "2.3", "status": "success", "question": title, "data_fingerprint": hashlib.sha256(title.encode()).hexdigest()[:16], "duration_ms": 420 + index * 90, "warning": "", "created_at": "2026-09-02 18:30:00"})
        rec_id = insert("ai_recommendations", {"run_id": run_id, "title": title, "conclusion": conclusion, "evidence_json": json.dumps([{"refType": "project", "refId": primary, "label": "CM27QHD165-26 报价与 BOM", "deepLink": {"page": "projects", "params": {"projectId": primary}}}], ensure_ascii=False), "confidence": "high", "assumptions_json": json.dumps(["报价关系已由名称+型号核对", "未把不可比项计入理论底价"], ensure_ascii=False), "expected_impact_json": json.dumps({"min": saving * 0.7, "max": saving * 1.15, "currency": "CNY"}, ensure_ascii=False), "action_json": json.dumps({"label": "打开项目成本策划", "type": "open", "page": "projects"}, ensure_ascii=False), "data_gaps_json": json.dumps(["交期和质量条款需要人工确认"], ensure_ascii=False), "risks_json": json.dumps(["最低价不一定对应最优交付条件"], ensure_ascii=False), "status": status, "source": "local_rule", "created_at": "2026-09-02 18:30:00", "updated_at": "2026-09-03 10:00:00"})
        insert("ai_recommendation_feedback", {"recommendation_id": rec_id, "usefulness": "useful", "adoption_status": "adopted" if status == "adopted" else "pending", "actual_saving": saving if status == "adopted" else None, "actual_result": "高刷与接口规格未被削弱，已同步到目标成本评审。" if status == "adopted" else "待供应商和工程共同确认", "note": "项目复盘记录", "created_at": "2026-09-03 10:00:00"})
    for text, status, progress, linked in [("完成 CM27QHD165-26 主控与支架二次议价", "active", "60%", "CM27QHD165-26"), ("把三家供应商报价沉淀为可比区间", "done", "100%", "CM27QHD165-26"), ("完成 32 英寸创作项目量产后降本复盘", "done", "100%", "CM32UHD144-25")]:
        insert("ai_goals", {"text": text, "status": status, "progress": progress, "linked_project": linked, "created_at": "2026-08-20 09:00:00", "updated_at": "2026-09-03 10:00:00", "completed_at": "2026-09-01 17:00:00" if status == "done" else None})
    insert("analysis_artifacts", {"artifact_type": "project_review", "title": "CM27QHD165-26 项目报价审核摘要", "summary": "当前 BOM、冻结版本、供应商报价与用户原声已形成可回看的证据链。", "data_json": json.dumps({"project": "CM27QHD165-26", "supplier_count": 3, "quote_rounds": 3, "negotiation_items": 4}, ensure_ascii=False), "source_json": json.dumps({"source": "CostHub 本地数据库", "updated_at": "2026-09-03 10:00:00"}, ensure_ascii=False), "session_id": 0, "created_at": "2026-09-03 10:00:00", "updated_at": "2026-09-03 10:00:00", "data_fingerprint": hashlib.sha256(b"CM27QHD165-26-review").hexdigest()[:16], "source_version_ids": "1,2"})
    for code, pid in projects.items():
        insert("project_analysis_logs", {"project_id": pid, "project_code": code, "conclusion": "项目成本由 BOM、供应商报价、目标版本与措施记录共同支撑；下一步以当前阶段的未关闭措施为准。", "source": "项目总览", "created_at": "2026-09-02 18:19:00"})
    insert("quote_review_logs", {"quote_input": "CM27QHD165-26 第3轮供应商报价批次", "verdict_summary": "可比覆盖率较高；主控板、面板和升降支架存在可谈差异，建议保留交期和质量的人工复核。", "created_at": "2026-09-02 18:30:00"})
    for index, description in enumerate(["同一器件是否有多供应商报价", "报价行是否完成规格匹配", "项目是否已设置领域目标", "当前 BOM 是否已冻结版本", "用户原声是否已关联项目"]):
        cid = insert("analysis_checklist", {"item_description": description, "is_active": 1, "source": "业务审核清单", "created_at": "2026-08-18 09:00:00", "updated_at": "2026-09-02 18:19:00", "strength_level": "confirmed", "trigger_count": 3 + index, "first_triggered_at": "2026-08-20 10:00:00", "last_triggered_at": "2026-09-02 18:19:00"})
        insert("checklist_trigger_log", {"checklist_item_id": cid, "trend_item_id": trend_ids["Realtek HDMI 2.1 主控板"], "question_snippet": "项目报价审核时自动检查"})
    insert("ai_advisor_insights", {"insight_type": "quote_opportunity", "title": "主控板与升降支架存在议价窗口", "detail": "第3轮报价已形成可比最低价，建议在不改变高刷与接口规格的前提下推进目标价确认。", "ref_type": "project", "ref_id": primary, "ref_name": "CM27QHD165-26", "prompt": "基于当前轮报价、历史价格和目标成本复核", "status": "open", "source": "local_rule", "fingerprint": "cm27qhd165-26-quote-opportunity", "created_at": "2026-09-02 18:30:00", "updated_at": "2026-09-02 18:30:00", "issue_key": "quote-opportunity", "evidence_fingerprint": "quote-r3", "first_seen_at": "2026-08-18 11:20:00", "last_seen_at": "2026-09-02 18:30:00", "occurrence_count": 3, "severity": "medium", "impact_amount": 78, "impact_band": "50-100"})
    for category, item_id in trend_ids.items():
        insert("analysis_item_meta", {"item_key": f"trend:{item_id}", "domain": "material", "object_type": "trend_item", "object_id": str(item_id), "object_name": category, "favorite": 1 if category in {"Realtek HDMI 2.1 主控板", "27英寸 QHD 高刷面板"} else 0, "archived": 0, "updated_at": "2026-09-02 18:19:00"})

    con.commit()
    con.execute("PRAGMA foreign_keys=ON")
    assert os.stat(source).st_size == source_stat.st_size and os.stat(source).st_mtime_ns == source_stat.st_mtime_ns and sha256(source) == source_hash, "source database changed during generation"
    counts = {}
    for table in ["parts", "projects", "project_boms", "modules", "project_targets", "project_target_versions", "project_measures", "project_cost_reviews", "project_cost_snapshots", "supplier_profiles", "part_suppliers", "part_price_history", "competitors", "competitor_boms", "tender_rounds", "supplier_quote_batches", "supplier_quote_lines", "quote_line_matches", "negotiation_items", "tender_decisions", "trend_items", "trend_snapshots", "trend_sources", "decomposition_tree", "voice_item", "voice_dimension", "product_features", "selling_points", "work_logs", "ai_recommendations", "ai_goals", "analysis_artifacts"]:
        counts[table] = one(f'SELECT count(*) FROM "{table}"') or 0
    orphan_bom = one("SELECT count(*) FROM project_boms b LEFT JOIN parts p ON p.id=b.part_id WHERE p.id IS NULL") or 0
    orphan_version = one("SELECT count(*) FROM project_bom_version_lines l LEFT JOIN project_bom_versions v ON v.id=l.version_id WHERE v.id IS NULL") or 0
    assert counts["projects"] == 4 and counts["parts"] >= 35 and counts["project_boms"] >= 60
    assert counts["trend_snapshots"] >= 30 and counts["supplier_quote_lines"] >= 40 and counts["voice_item"] >= 8
    assert orphan_bom == 0 and orphan_version == 0
    assert one("SELECT count(*) FROM projects WHERE name LIKE '%测试%' OR code LIKE '%TST%'") == 0
    assert one("SELECT count(*) FROM parts WHERE name LIKE '%测试%' OR model LIKE '%TST%'") == 0
    print(json.dumps({"db": output, "source_schema_db": source, "projects": list(projects), "counts": counts, "orphan_project_boms": orphan_bom, "orphan_version_lines": orphan_version, "source_sha256": source_hash}, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()
