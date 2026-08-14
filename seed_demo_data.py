# -*- coding: utf-8 -*-
# CostHub 竞争力雷达演示数据导入脚本（2026-08-12）
# 用法：把本文件与 demo_data.sql 一起放到项目根目录，运行：python seed_demo_data.py
# 功能：自动寻找 costhub.db（exe 同目录）→ 自动备份 → 执行 demo_data.sql（幂等，可重复执行）
# 注意：执行前请先关闭 costhub.exe（数据库被占用时会失败）
import sqlite3, os, shutil, sys, datetime

def find_db():
    candidates = [
        os.path.join('src-tauri', 'target', 'release', 'costhub.db'),
        'costhub.db',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    for root, dirs, files in os.walk('.'):
        if 'node_modules' in root or 'target' in root and 'release' not in root:
            continue
        if 'costhub.db' in files:
            return os.path.join(root, 'costhub.db')
    return None

def main():
    db_path = find_db()
    if not db_path:
        print('未找到 costhub.db——请把脚本放到项目根目录后运行')
        sys.exit(1)
    print('数据库：', os.path.abspath(db_path))
    bak = db_path + '.demo_bak_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    try:
        shutil.copy2(db_path, bak)
        print('已备份：', os.path.basename(bak))
    except Exception as e:
        print('备份失败：', e)
        sys.exit(1)
    sql_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'demo_data.sql')
    if not os.path.exists(sql_path):
        print('未找到 demo_data.sql（应与本脚本同目录）')
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    try:
        with open(sql_path, encoding='utf-8') as f:
            conn.executescript(f.read())
        conn.commit()
        c = conn.cursor()
        m270 = c.execute("SELECT COUNT(*) FROM projects WHERE code='M270'").fetchone()[0]
        comps = c.execute("SELECT COUNT(*) FROM competitors WHERE category='显示器'").fetchone()[0]
        boms = c.execute("SELECT COUNT(*) FROM project_boms pb JOIN projects p ON pb.project_id=p.id WHERE p.code='M270' AND pb.is_deleted=0").fetchone()[0]
        cboms = c.execute("SELECT COUNT(*) FROM competitor_boms cb JOIN competitors c ON cb.competitor_id=c.id WHERE c.category='显示器'").fetchone()[0]
        scores = c.execute("SELECT COUNT(*) FROM product_scores ps JOIN product_features f ON ps.feature_id=f.id WHERE f.type='radar'").fetchone()[0]
        links = c.execute("SELECT COUNT(*) FROM module_feature_links").fetchone()[0]
        print('验证：M270 项目 =', m270, '| 演示竞品 =', comps, '| 项目 BOM =', boms, '| 竞品 BOM =', cboms, '| 五维评分 =', scores, '| 模块关联 =', links)
        if m270 and comps >= 2 and boms >= 5 and scores >= 15 and links >= 6:
            print('完成！重新打开 costhub.exe → 对比分析页 → 选 M270 + 勾选竞品 → 生成雷达')
        else:
            print('数据不完整，请检查（可能已存在旧数据被跳过）')
    except Exception as e:
        conn.rollback()
        print('执行失败已回滚：', e)
        sys.exit(1)
    finally:
        conn.close()

if __name__ == '__main__':
    main()
