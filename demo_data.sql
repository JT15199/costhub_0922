-- ============================================================
-- CostHub 竞争力雷达演示数据（2026-08-12）
-- 幂等：重复执行不会产生重复数据（全部带存在性检查）
-- 内容：我方项目 M270（5 模块 BOM ¥740）+ 竞品三星 S27A800（¥643）+ 竞品 LG 27UP850（¥722）
--       五维评分（性能/规格/显示/外观/可靠性）+ 模块-特性关联
-- 执行：python seed_demo_data.py  （自动找 db、自动备份）
--   或：sqlite3 costhub.db < demo_data.sql （需手动关闭 costhub.exe）
-- ============================================================

-- ---------- 1. 我方项目 M270 ----------
INSERT INTO projects (code, name, project_type, tier, status, category, screen_size, resolution, refresh_rate, panel_type, created_at)
SELECT 'M270', '27寸主流显示器', '在研', '主流级', '进行中', '显示器', '27英寸', '2560×1440', '165Hz', 'IPS', datetime('now','localtime')
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE code = 'M270');

-- ---------- 2. 器件（我方 BOM 用） ----------
INSERT INTO parts (main_category, sub_category, category, name, model, cost, projects)
SELECT '硬件类', '显示面板', '面板', '27寸2K面板', 'M270-PANEL-A', 450, 'M270'
WHERE NOT EXISTS (SELECT 1 FROM parts WHERE name = '27寸2K面板' AND model = 'M270-PANEL-A');
INSERT INTO parts (main_category, sub_category, category, name, model, cost, projects)
SELECT '硬件类', '驱动板', '驱动板', '主控驱动板', 'M270-DRV-A', 120, 'M270'
WHERE NOT EXISTS (SELECT 1 FROM parts WHERE name = '主控驱动板' AND model = 'M270-DRV-A');
INSERT INTO parts (main_category, sub_category, category, name, model, cost, projects)
SELECT '电源类', '内置电源', '电源', '内置电源', 'M270-PSU-A', 60, 'M270'
WHERE NOT EXISTS (SELECT 1 FROM parts WHERE name = '内置电源' AND model = 'M270-PSU-A');
INSERT INTO parts (main_category, sub_category, category, name, model, cost, projects)
SELECT '结构类', '结构件', '结构件', '中框结构件', 'M270-FRAME-A', 80, 'M270'
WHERE NOT EXISTS (SELECT 1 FROM parts WHERE name = '中框结构件' AND model = 'M270-FRAME-A');
INSERT INTO parts (main_category, sub_category, category, name, model, cost, projects)
SELECT '包材类', '外包装', '包装', '包装箱', 'M270-BOX-A', 30, 'M270'
WHERE NOT EXISTS (SELECT 1 FROM parts WHERE name = '包装箱' AND model = 'M270-BOX-A');

-- ---------- 3. 我方项目 BOM（模块化 + 快照列） ----------
INSERT INTO project_boms (project_id, part_id, module_name, quantity, part_name, part_model, part_cost, main_category, sub_category, is_deleted)
SELECT p.id, pa.id, '面板模块', 1, pa.name, pa.model, pa.cost, pa.main_category, pa.sub_category, 0
FROM projects p, parts pa WHERE p.code = 'M270' AND pa.name = '27寸2K面板' AND pa.model = 'M270-PANEL-A';
INSERT INTO project_boms (project_id, part_id, module_name, quantity, part_name, part_model, part_cost, main_category, sub_category, is_deleted)
SELECT p.id, pa.id, '驱动板模块', 1, pa.name, pa.model, pa.cost, pa.main_category, pa.sub_category, 0
FROM projects p, parts pa WHERE p.code = 'M270' AND pa.name = '主控驱动板' AND pa.model = 'M270-DRV-A';
INSERT INTO project_boms (project_id, part_id, module_name, quantity, part_name, part_model, part_cost, main_category, sub_category, is_deleted)
SELECT p.id, pa.id, '电源模块', 1, pa.name, pa.model, pa.cost, pa.main_category, pa.sub_category, 0
FROM projects p, parts pa WHERE p.code = 'M270' AND pa.name = '内置电源' AND pa.model = 'M270-PSU-A';
INSERT INTO project_boms (project_id, part_id, module_name, quantity, part_name, part_model, part_cost, main_category, sub_category, is_deleted)
SELECT p.id, pa.id, '结构件', 1, pa.name, pa.model, pa.cost, pa.main_category, pa.sub_category, 0
FROM projects p, parts pa WHERE p.code = 'M270' AND pa.name = '中框结构件' AND pa.model = 'M270-FRAME-A';
INSERT INTO project_boms (project_id, part_id, module_name, quantity, part_name, part_model, part_cost, main_category, sub_category, is_deleted)
SELECT p.id, pa.id, '包装材料', 1, pa.name, pa.model, pa.cost, pa.main_category, pa.sub_category, 0
FROM projects p, parts pa WHERE p.code = 'M270' AND pa.name = '包装箱' AND pa.model = 'M270-BOX-A';

-- ---------- 4. 竞品 ----------
INSERT INTO competitors (brand, model, tier, category, market_price, bom_cost, sort_order, created_at)
SELECT '三星', 'S27A800', '主流级', '显示器', 1299, 643, 1, datetime('now','localtime')
WHERE NOT EXISTS (SELECT 1 FROM competitors WHERE brand = '三星' AND model = 'S27A800');
INSERT INTO competitors (brand, model, tier, category, market_price, bom_cost, sort_order, created_at)
SELECT 'LG', '27UP850', '主流级', '显示器', 1399, 722, 2, datetime('now','localtime')
WHERE NOT EXISTS (SELECT 1 FROM competitors WHERE brand = 'LG' AND model = '27UP850');

-- ---------- 5. 竞品 BOM ----------
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '27寸2K面板', 'SAM-PANEL', '面板模块', 380, 1 FROM competitors c WHERE c.brand = '三星' AND c.model = 'S27A800';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '主控驱动板', 'SAM-DRV', '驱动板模块', 110, 1 FROM competitors c WHERE c.brand = '三星' AND c.model = 'S27A800';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '内置电源', 'SAM-PSU', '电源模块', 55, 1 FROM competitors c WHERE c.brand = '三星' AND c.model = 'S27A800';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '中框结构件', 'SAM-FRAME', '结构件', 70, 1 FROM competitors c WHERE c.brand = '三星' AND c.model = 'S27A800';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '包装箱', 'SAM-BOX', '包装材料', 28, 1 FROM competitors c WHERE c.brand = '三星' AND c.model = 'S27A800';

INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '27寸2K面板', 'LG-PANEL', '面板模块', 430, 1 FROM competitors c WHERE c.brand = 'LG' AND c.model = '27UP850';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '主控驱动板', 'LG-DRV', '驱动板模块', 120, 1 FROM competitors c WHERE c.brand = 'LG' AND c.model = '27UP850';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '内置电源', 'LG-PSU', '电源模块', 62, 1 FROM competitors c WHERE c.brand = 'LG' AND c.model = '27UP850';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '中框结构件', 'LG-FRAME', '结构件', 80, 1 FROM competitors c WHERE c.brand = 'LG' AND c.model = '27UP850';
INSERT INTO competitor_boms (competitor_id, part_name, part_model, module_name, estimated_cost, quantity)
SELECT c.id, '包装箱', 'LG-BOX', '包装材料', 30, 1 FROM competitors c WHERE c.brand = 'LG' AND c.model = '27UP850';

-- ---------- 6. 模块-特性关联（同名模块全局一致） ----------
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '面板模块', f.id FROM product_features f WHERE f.name = '显示' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '面板模块' AND feature_id = f.id);
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '驱动板模块', f.id FROM product_features f WHERE f.name = '性能' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '驱动板模块' AND feature_id = f.id);
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '驱动板模块', f.id FROM product_features f WHERE f.name = '规格' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '驱动板模块' AND feature_id = f.id);
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '电源模块', f.id FROM product_features f WHERE f.name = '可靠性' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '电源模块' AND feature_id = f.id);
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '结构件', f.id FROM product_features f WHERE f.name = '外观' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '结构件' AND feature_id = f.id);
INSERT INTO module_feature_links (module_name, feature_id)
SELECT '包装材料', f.id FROM product_features f WHERE f.name = '外观' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM module_feature_links WHERE module_name = '包装材料' AND feature_id = f.id);

-- ---------- 7. 五维评分（0-10 分制） ----------
-- 我方 M270
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'project', p.id, f.id, 7 FROM projects p, product_features f
WHERE p.code = 'M270' AND f.name = '性能' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'project' AND ps.ref_id = p.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'project', p.id, f.id, 8 FROM projects p, product_features f
WHERE p.code = 'M270' AND f.name = '规格' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'project' AND ps.ref_id = p.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'project', p.id, f.id, 8.5 FROM projects p, product_features f
WHERE p.code = 'M270' AND f.name = '显示' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'project' AND ps.ref_id = p.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'project', p.id, f.id, 6.5 FROM projects p, product_features f
WHERE p.code = 'M270' AND f.name = '外观' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'project' AND ps.ref_id = p.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'project', p.id, f.id, 7.5 FROM projects p, product_features f
WHERE p.code = 'M270' AND f.name = '可靠性' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'project' AND ps.ref_id = p.id AND ps.feature_id = f.id);

-- 竞品三星
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 8 FROM competitors c, product_features f
WHERE c.brand = '三星' AND c.model = 'S27A800' AND f.name = '性能' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 8.5 FROM competitors c, product_features f
WHERE c.brand = '三星' AND c.model = 'S27A800' AND f.name = '规格' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 8 FROM competitors c, product_features f
WHERE c.brand = '三星' AND c.model = 'S27A800' AND f.name = '显示' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 7 FROM competitors c, product_features f
WHERE c.brand = '三星' AND c.model = 'S27A800' AND f.name = '外观' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 7.5 FROM competitors c, product_features f
WHERE c.brand = '三星' AND c.model = 'S27A800' AND f.name = '可靠性' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);

-- 竞品 LG
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 6.5 FROM competitors c, product_features f
WHERE c.brand = 'LG' AND c.model = '27UP850' AND f.name = '性能' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 7 FROM competitors c, product_features f
WHERE c.brand = 'LG' AND c.model = '27UP850' AND f.name = '规格' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 7.5 FROM competitors c, product_features f
WHERE c.brand = 'LG' AND c.model = '27UP850' AND f.name = '显示' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 6 FROM competitors c, product_features f
WHERE c.brand = 'LG' AND c.model = '27UP850' AND f.name = '外观' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
INSERT INTO product_scores (ref_type, ref_id, feature_id, score)
SELECT 'competitor', c.id, f.id, 7 FROM competitors c, product_features f
WHERE c.brand = 'LG' AND c.model = '27UP850' AND f.name = '可靠性' AND f.type = 'radar'
  AND NOT EXISTS (SELECT 1 FROM product_scores ps WHERE ps.ref_type = 'competitor' AND ps.ref_id = c.id AND ps.feature_id = f.id);
