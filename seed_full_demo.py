# -*- coding: utf-8 -*-
# CostHub 全功能演示数据补齐脚本（2026-08-14）
# 用法：python seed_full_demo.py（放项目根目录运行；先关闭 costhub.exe）
# 幂等：按业务键查重，可重复执行；自动备份原库
# 覆盖：目标成本（驾驶舱预警）/ 供应商+价格历史（趋势小结）/ 成本快照（异动+AI解释）/ SKU / ODM / 项目规格
import sqlite3, os, shutil, sys, datetime

def find_db():
    candidates = [
        os.path.join('src-tauri', 'target', 'release', 'costhub.db'),
        'costhub.db',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None

conn = None
def main():
    global conn
    db_path = find_db()
    if not db_path:
        print('未找到 costhub.db'); sys.exit(1)
    print('数据库：', os.path.abspath(db_path))
    bak = db_path + '.seed_bak_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    shutil.copy2(db_path, bak)
    print('已备份：', os.path.basename(bak))
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    # ===== 0) 幂等清理：先删子表（按 seed 父表 id 关联），再删父表；最后清孤儿 =====
    # 注意：part_supplier_price_history / sku_diffs 的 remark 列存业务描述，只能按父表 id 关联清理
    cur.execute("DELETE FROM part_supplier_price_history WHERE supplier_id IN (SELECT id FROM part_suppliers WHERE remark = '__seed_demo__')")
    cur.execute("DELETE FROM part_suppliers WHERE remark = '__seed_demo__'")
    cur.execute("DELETE FROM sku_diffs WHERE sku_id IN (SELECT id FROM project_skus WHERE remark = '__seed_demo__')")
    cur.execute("DELETE FROM project_skus WHERE remark = '__seed_demo__'")
    cur.execute("DELETE FROM project_cost_snapshots WHERE change_reason LIKE '__seed_demo__%' OR change_details LIKE '__seed_demo__%'")
    cur.execute("DELETE FROM project_targets WHERE remark = '__seed_demo__'")
    cur.execute("DELETE FROM project_supplier_price_history WHERE change_reason LIKE '__seed_demo__%'")
    cur.execute("DELETE FROM project_suppliers WHERE remark = '__seed_demo__'")
    # 孤儿兜底（历史版本残留）
    cur.execute("DELETE FROM sku_diffs WHERE sku_id NOT IN (SELECT id FROM project_skus)")
    cur.execute("DELETE FROM part_supplier_price_history WHERE supplier_id NOT IN (SELECT id FROM part_suppliers)")
    conn.commit()
    pid = {}
    for r in cur.execute('SELECT id, code FROM projects'):
        pid[r[1]] = r[0]
    print('项目映射：', pid)

    # ===== 1) 目标成本（驾驶舱目标达成预警演示）=====
    targets = [
        # (code, domain, target_cost) —— 目标基于实际领域成本设计：超支=实际×0.8~0.9，达标=实际×1.05~1.15
        ('MNT-2401', '结构类', 110),
        ('MNT-2402', '加工费类', 45), ('MNT-2402', '包材类', 28), ('MNT-2402', '硬件类', 60),
        ('MNT-2701', '加工费类', 22), ('MNT-2701', '包材类', 30),
        ('MNT-2702', '加工费类', 48), ('MNT-2702', '结构类', 230), ('MNT-2702', '包材类', 32),
        ('MNT-2703', '加工费类', 58), ('MNT-2703', '硬件类', 105),
        ('MNT-3201', '加工费类', 50), ('MNT-3201', '结构类', 245),
    ]
    for code, domain, tc in targets:
        if code in pid:
            cur.execute("INSERT INTO project_targets (project_id, domain, target_cost, remark) VALUES (?,?,?,'__seed_demo__')", (pid[code], domain, tc))
    print('目标成本：', len(targets), '条（M270/M280/M300 故意不设——演示未设目标提示）')

    # ===== 2) 项目规格补齐（规格级预估需要规格字段）=====
    spec_fix = [
        ('A001', '23.8\"', '1920×1080 (FHD)', '60Hz', 'IPS'),
        ('A002', '24\"', '1920×1080 (FHD)', '75Hz', 'IPS'),
    ]
    for code, ss, res, hz, panel in spec_fix:
        if code in pid:
            cur.execute("UPDATE projects SET screen_size=?, resolution=?, refresh_rate=?, panel_type=? WHERE id=? AND (screen_size IS NULL OR screen_size='')", (ss, res, hz, panel, pid[code]))
    print('规格补齐：A001/A002')

    # ===== 3) 器件供应商 + 价格历史（供应商趋势小结演示）=====
    # (part_name LIKE 条件, [(supplier, price, share, is_active), ...])
    supplier_plan = [
        ("name LIKE '%27寸2K面板%'", [('京东方', 475, 60, 1), ('LG Display', 450, 40, 1)]),
        ("name LIKE '%27\" QHD 144Hz%'", [('京东方', 505, 70, 1), ('友达光电', 480, 30, 1)]),
        ("name LIKE '%主控驱动板%'", [('瑞芯微', 115, 80, 1), ('全志科技', 120, 20, 1)]),
        ("name LIKE '%内置电源板 120W%'", [('台达电子', 62, 100, 1)]),
        ("name LIKE '%SMT贴片 驱动板%'", [('立讯精密', 20, 100, 1)]),
        ("name LIKE '%电源线%'", [('公牛集团', 2.9, 100, 1)]),
    ]
    hist_plan = {
        # (part_name LIKE, supplier) -> [(old, new, reason, date), ...] 按时间正序
        ("name LIKE '%27寸2K面板%'", '京东方'): [(450, 460, '面板 Q3 涨价', '2026-06-15 10:00:00'), (460, 475, '面板 Q4 涨价', '2026-08-01 10:00:00')],
        ("name LIKE '%27寸2K面板%'", 'LG Display'): [(460, 450, '量价谈判降价', '2026-07-10 10:00:00')],
        ("name LIKE '%27\" QHD 144Hz%'", '京东方'): [(480, 490, '原材料涨价', '2026-06-20 10:00:00'), (490, 505, '季度调价', '2026-08-05 10:00:00')],
        ("name LIKE '%27\" QHD 144Hz%'", '友达光电'): [(480, 475, '竞争性报价下调', '2026-07-01 10:00:00'), (475, 480, '汇率波动回调', '2026-08-01 10:00:00')],
        ("name LIKE '%主控驱动板%'", '瑞芯微'): [(120, 118, 'BOM 优化降本', '2026-05-10 10:00:00'), (118, 115, '代工费下调', '2026-07-15 10:00:00')],
        ("name LIKE '%主控驱动板%'", '全志科技'): [(120, 120.5, '物料微调', '2026-06-10 10:00:00')],
        ("name LIKE '%内置电源板 120W%'", '台达电子'): [(55, 58, '铜价上涨', '2026-06-01 10:00:00'), (58, 62, '功率器件缺货', '2026-08-01 10:00:00')],
        ("name LIKE '%SMT贴片 驱动板%'", '立讯精密'): [(20, 20.2, '汇率微调', '2026-06-01 10:00:00'), (20.2, 20, '返利抵扣', '2026-07-01 10:00:00')],
        ("name LIKE '%电源线%'", '公牛集团'): [(3.0, 2.9, '集采降价', '2026-07-20 10:00:00')],
    }
    sup_count = 0
    hist_count = 0
    for like, sups in supplier_plan:
        part = cur.execute('SELECT id, cost FROM parts WHERE ' + like + " AND id NOT IN (SELECT part_id FROM part_suppliers WHERE remark='__seed_demo__') ORDER BY id LIMIT 1").fetchone()
        if not part:
            print('  跳过（无器件）：', like); continue
        part_id, part_cost = part
        for (sname, price, share, active) in sups:
            cur.execute("INSERT INTO part_suppliers (part_id, supplier_name, price, share_ratio, is_active, remark, created_at, updated_at) VALUES (?,?,?,?,?,'__seed_demo__',datetime('now','localtime'),datetime('now','localtime'))", (part_id, sname, price, share, active))
            sup_count += 1
            sid = cur.lastrowid
            for (oldp, newp, reason, ts) in hist_plan.get((like, sname), []):
                cur.execute("INSERT INTO part_supplier_price_history (supplier_id, old_price, new_price, changed_at, change_reason, part_id, supplier_name) VALUES (?,?,?,?,?,?,?)", (sid, oldp, newp, ts, reason, part_id, sname))
                hist_count += 1
    print('供应商：', sup_count, '条；价格历史：', hist_count, '条（持续涨/降/波动/平稳/单次 各形态）')

    # ===== 4) 成本快照补齐（快照异动 + AI 解释演示）=====
    snap_plan = {
        # code -> [(bom_cost, type, reason, ts, details), ...] 时间正序；最后一条=当前 BOM 成本
        'M270': [(689, 'bom_change', '__seed_demo__ 面板调价', '2026-06-10 09:00:00', ''), (720, 'part_changed', '__seed_demo__ 面板涨价', '2026-07-20 09:00:00', ''), (740, 'part_changed', '__seed_demo__ 驱动板换型', '2026-08-10 09:00:00', '')],
        'M280': [(680, 'bom_change', '__seed_demo__ 初始导入', '2026-06-01 09:00:00', ''), (689, 'module_imported', '__seed_demo__ 导入电源模块', '2026-07-05 09:00:00', '')],
        'M300': [(780, 'bom_change', '__seed_demo__ 初始导入', '2026-05-20 09:00:00', ''), (810, 'part_changed', '__seed_demo__ 4K 面板涨价', '2026-07-01 09:00:00', ''), (842, 'part_changed', '__seed_demo__ 内存颗粒上涨', '2026-08-12 09:00:00', '')],
        'MNT-2701': [(520, 'bom_change', '__seed_demo__ 初始导入', '2026-05-10 09:00:00', ''), (540, 'part_changed', '__seed_demo__ 面板涨价', '2026-07-15 09:00:00', ''), (566, 'module_imported', '__seed_demo__ 导入电竞电源模块', '2026-08-08 09:00:00', '')],
        'MNT-2702': [(880, 'bom_change', '__seed_demo__ 初始导入', '2026-04-20 09:00:00', ''), (920, 'part_changed', '__seed_demo__ QHD 面板溢价', '2026-06-25 09:00:00', ''), (965, 'part_changed', '__seed_demo__ 高刷面板涨价', '2026-08-11 09:00:00', '')],
        'MNT-2703': [(860, 'bom_change', '__seed_demo__ 初始导入', '2026-05-01 09:00:00', ''), (880, 'part_changed', '__seed_demo__ 4K 面板微调', '2026-07-10 09:00:00', ''), (901, 'rate_changed', '__seed_demo__ 费率调整', '2026-08-06 09:00:00', '')],
        'MNT-3201': [(790, 'bom_change', '__seed_demo__ 初始导入', '2026-05-15 09:00:00', ''), (820, 'part_changed', '__seed_demo__ 32寸面板涨价', '2026-07-20 09:00:00', ''), (859, 'part_changed', '__seed_demo__ 散热方案升级', '2026-08-13 09:00:00', '')],
        'A001': [(950, 'bom_change', '__seed_demo__ 初始导入', '2026-06-01 09:00:00', ''), (991, 'part_changed', '__seed_demo__ 物料替换', '2026-08-01 09:00:00', '')],
    }
    snap_count = 0
    for code, snaps in snap_plan.items():
        if code not in pid: continue
        # 只补快照少于 2 条的项目（保留已有历史）
        n = cur.execute('SELECT COUNT(*) FROM project_cost_snapshots WHERE project_id=?', (pid[code],)).fetchone()[0]
        if n >= 2 and code not in ('M280',): continue
        if code == 'M280':
            # M280 已有 1 条（740），只补早期两条
            snaps = snaps[:2]
        for (bc, st, reason, ts, det) in snaps:
            cur.execute("INSERT INTO project_cost_snapshots (project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count, created_at, change_details) VALUES (?,?,?,?,?,0,0,0,0,?,?)", (pid[code], st, reason, bc, bc, ts, det))
            snap_count += 1
    print('快照补齐：', snap_count, '条')

    # ===== 5) SKU 变体（SKU 对比演示）=====
    if 'M270' in pid:
        m270 = pid['M270']
        sku_plan = [
            ('M270-1TB', '1TB 大存储版', '加装 512G 固态硬盘', [('add', '存储模块', '固态硬盘 NVMe 512G', 'SSD-512G', 1, 210, '加装存储')]),
            ('M270-GAMING', '电竞高刷版', '升级 2K 165Hz 面板 + 电竞支架', [('replace', '显示模块', '面板 27寸', 'M270QAN02.0', None, 680, '升级高刷面板'), ('add', '结构模块', '电竞支架', 'GS-BRACKET', 1, 45, '电竞支架')]),
            ('M270-LITE', '精简版', '去掉内置音箱', [('remove', '显示模块', '内置音箱', None, None, None, '精简配置')]),
        ]
        for (code, sname, sdesc, diffs) in sku_plan:
            if cur.execute('SELECT COUNT(*) FROM project_skus WHERE project_id=? AND sku_code=?', (m270, code)).fetchone()[0] > 0:
                continue
            cur.execute("INSERT INTO project_skus (project_id, sku_code, sku_name, spec_desc, remark, created_at) VALUES (?,?,?,?,'__seed_demo__',datetime('now','localtime'))", (m270, code, sname, sdesc))
            skuid = cur.lastrowid
            for (dt, mod, pname, pmodel, qty, uc, rem) in diffs:
                cur.execute("INSERT INTO sku_diffs (sku_id, diff_type, module_name, part_name, part_model, quantity, unit_cost, remark, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))", (skuid, dt, mod, pname, pmodel, qty, uc, rem))
        print('SKU：M270 新增 3 个变体（add/replace/remove 全形态）')

    # ===== 6) ODM 整机供应商（ODM 演示）=====
    odm_plan = [
        ('MNT-2702', '富士康', 965, 60, 1, [(990, 965, '__seed_demo__ 量产降价', '2026-07-01 10:00:00')]),
        ('MNT-2702', '群创光电', 980, 40, 1, []),
        ('MNT-3201', '比亚迪电子', 859, 70, 1, []),
        ('MNT-3201', 'TCL 华星', 870, 30, 1, []),
    ]
    for (code, sname, qp, share, active, hists) in odm_plan:
        if code not in pid: continue
        if cur.execute('SELECT COUNT(*) FROM project_suppliers WHERE project_id=? AND supplier_name=?', (pid[code], sname)).fetchone()[0] > 0:
            continue
        cur.execute("INSERT INTO project_suppliers (project_id, supplier_name, quoted_price, share_ratio, is_active, remark, created_at, updated_at) VALUES (?,?,?,?,?,'__seed_demo__',datetime('now','localtime'),datetime('now','localtime'))", (pid[code], sname, qp, share, active))
        sid = cur.lastrowid
        for (oldp, newp, reason, ts) in hists:
            cur.execute("INSERT INTO project_supplier_price_history (supplier_id, old_price, new_price, changed_at, change_reason) VALUES (?,?,?,?,?)", (sid, oldp, newp, ts, reason))
    print('ODM 供应商：4 条（含报价历史）')

    conn.commit()
    # ===== 验证 ======
    print('=== 验证 ===')
    print('目标成本：', cur.execute("SELECT COUNT(*) FROM project_targets WHERE remark='__seed_demo__'").fetchone()[0] + cur.execute("SELECT COUNT(*) FROM project_targets WHERE remark != '__seed_demo__'").fetchone()[0], '条（全部）')
    print('供应商：', cur.execute('SELECT COUNT(*) FROM part_suppliers').fetchone()[0], '条；价格历史：', cur.execute('SELECT COUNT(*) FROM part_supplier_price_history').fetchone()[0], '条')
    print('快照：', cur.execute('SELECT COUNT(*) FROM project_cost_snapshots').fetchone()[0], '条')
    print('SKU：', cur.execute('SELECT COUNT(*) FROM project_skus').fetchone()[0], '个；差异：', cur.execute('SELECT COUNT(*) FROM sku_diffs').fetchone()[0], '条')
    print('ODM：', cur.execute('SELECT COUNT(*) FROM project_suppliers').fetchone()[0], '条')
    print('完成！重新打开 costhub.exe 测试：驾驶舱目标预警 / 项目体检 / 供应商趋势 / 快照对比 / SKU / 规格预估')
    conn.close()

if __name__ == '__main__':
    main()