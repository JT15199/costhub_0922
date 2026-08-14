# -*- coding: utf-8 -*-
"""
CostHub 工作手账测试数据生成器
用法: python 生成手账测试数据.py
插入12条模拟工作记录（便签+待办），用于测试 AI 总结功能
"""
import sqlite3
import os
import sys

# 候选数据库路径（应用运行时数据库在 exe 同目录）
CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src-tauri', 'target', 'release', 'costhub.db'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'costhub.db'),
]

def find_db():
    for p in CANDIDATES:
        if os.path.exists(p):
            return p
    return None

# 测试数据（日期改为相对今天的近几个月，方便总结）
from datetime import datetime, timedelta
now = datetime.now()

def d(days_ago, hm='10:00'):
    dt = now - timedelta(days=days_ago)
    return dt.strftime(f'%Y-%m-%d {hm}')

DATA = [
    # (days_ago, title, content, category, is_todo, done)
    (60, 'M270项目BOM成本审核', '完成M270项目整机BOM审核，对比三版供应商报价。发现电源模块偏贵：电源管理IC报价比历史高18%，电解电容高12%。与供应商初步沟通，预计可谈回8-10%。', '成本分析', 0, 0),
    (46, 'Q2降本目标复盘', 'Q2降本目标达成率92%。主要贡献：面板统一采购降本2.3万，电源方案替换降本1.8万。剩余缺口在包材，计划Q3集中谈。', '成本分析', 0, 0),
    (32, 'M32新品成本测算', '完成M32 4K新品成本测算：BOM成本¥1,352，目标成本¥1,280，超4.5%。主要超支在面板和背光，需在8月评审前优化方案。', '成本分析', 0, 0),
    (42, '面板供应商年度谈判', '与京东方完成年度框架谈判：27寸面板降价4.5%，31.5寸降价3.8%，预计全年节省12万。锁定明年一季度供货份额60%。', '供应商谈判', 0, 0),
    (19, '电源适配器供应商比价', '对比3家适配器供应商（航嘉/台达/比亚迪），航嘉报价最低但交期长2周。建议双供应商策略：航嘉60%+台达40%。', '供应商谈判', 0, 0),
    (54, '竞品BOM拆解对比', '完成AOC 27寸竞品拆解，我方BOM比竞品高6.8%。差异主要在：竞品用国产主控省12元，我方用瑞昱。评估切换可行性中。', 'BOM审核', 0, 0),
    (36, 'Q3产品线规划会', '参与Q3产品线规划：确定2款新品立项（27寸电竞款+31.5寸商用款），我负责成本目标设定和BOM预审。', '会议', 0, 0),
    # 待办 - 已完成
    (52, '', '完成包材供应商比价，选定2家新供应商', '项目推进', 1, 1),
    (39, '', '输出Q3降本方案初稿并提交评审', '项目推进', 1, 1),
    (26, '', '完成M270成本评审会材料准备', '项目推进', 1, 1),
    # 待办 - 未完成
    (14, '', '推进M32面板方案优化，目标降本70元', '项目推进', 1, 0),
    (9, '', '整理Q3供应商评级报告', '项目推进', 1, 0),
]

def main():
    db_path = find_db()
    if not db_path:
        print('✗ 未找到 costhub.db，请确认路径：')
        for p in CANDIDATES:
            print(f'  {p}')
        sys.exit(1)
    print(f'✓ 找到数据库: {db_path}')

    try:
        conn = sqlite3.connect(db_path, timeout=10)
    except Exception as e:
        print(f'✗ 无法连接数据库（可能被应用占用，请先关闭CostHub）: {e}')
        sys.exit(1)

    try:
        # 确保表存在
        conn.execute("""CREATE TABLE IF NOT EXISTS work_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_date TEXT, title TEXT DEFAULT '', content TEXT NOT NULL,
            category TEXT DEFAULT '其他', tags TEXT DEFAULT '',
            is_todo INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
            created_at TEXT, updated_at TEXT
        )""")

        # 询问是否清空已有数据
        existing = conn.execute('SELECT COUNT(*) FROM work_logs').fetchone()[0]
        if existing > 0:
            ans = input(f'  已有 {existing} 条记录，是否清空后重新生成？(y/n): ').strip().lower()
            if ans == 'y':
                conn.execute('DELETE FROM work_logs')
                print('  ✓ 已清空旧数据')
            else:
                print('  ✗ 已取消（不清空，直接追加）')

        for days_ago, title, content, category, is_todo, done in DATA:
            conn.execute(
                'INSERT INTO work_logs (log_date, title, content, category, is_todo, done) VALUES (?,?,?,?,?,?)',
                (d(days_ago), title, content, category, is_todo, done)
            )
        conn.commit()
        total = conn.execute('SELECT COUNT(*) FROM work_logs').fetchone()[0]
        print(f'✓ 已生成 {len(DATA)} 条测试数据（当前共 {total} 条）')
        print('  打开 CostHub → 工作手账 → 选时间范围 → AI 总结')
    except Exception as e:
        print(f'✗ 写入失败（数据库可能被应用锁定，请先关闭CostHub再运行）: {e}')
    finally:
        conn.close()

if __name__ == '__main__':
    main()
