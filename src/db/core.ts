// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';



let db: Database | null = null;


let dbUrl: string | null = null;


let schemaReady = false;


// ====== 数据锁（登录门禁） ======
// 解锁前：所有查询返回空数据、所有写入静默跳过 —— 密码错误也能进入应用，但不显示任何数据
let dataLocked = true;


let rawDb: Database | null = null;

 // 绕过拦截的原始实例（仅登录/改密码/锁状态用）
const AUTH_KEY = 'auth_password_hash';


const AUTH_PLAIN_KEY = 'auth_password_plain';

   // 明文副本（用于找回显示，仅存本地）
const AUTH_CHANGED_KEY = 'auth_password_changed';

 // 是否已改过密码（控制首次提示）
const AUTH_USERNAME_KEY = 'auth_username';

        // 用户名（可自定义，默认 admin）
const DEFAULT_PASSWORD = '666666';


const DEFAULT_USERNAME = 'admin';



export function isDataLocked(): boolean { return dataLocked; }


export function setDataLocked(locked: boolean) { dataLocked = locked; }



async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}



// 获取原始数据库实例（绕过数据锁，仅供登录/认证流程使用）
async function getRawDb(): Promise<Database> {
  if (!rawDb) {
    rawDb = await Database.load(await getDbUrl());
    // ⚠️ 修复（2026-08-08）：全新环境首次运行时 settings 表不存在，
    // 不建表会导致 ensureAuthPassword 静默失败、默认密码 666666 无法初始化
    if (!schemaReady) {
      await ignoreSchemaError(rawDb.execute('PRAGMA journal_mode=WAL'));
      await ignoreSchemaError(rawDb.execute('PRAGMA busy_timeout=8000'));
      await ensureSchema(rawDb);
      schemaReady = true;
    }
  }
  return rawDb;
}



async function getDbUrl(): Promise<string> {
  if (!dbUrl) { dbUrl = await invoke<string>('get_db_path'); }
  return dbUrl;
}



function isAuthQuery(sql: string): boolean {
  const s = sql.trim().toLowerCase();
  return s.includes('settings') && s.includes(AUTH_KEY.toLowerCase());
}



async function getDb(): Promise<Database> {
  if (!db) {
    const real = await Database.load(await getDbUrl());
    // Proxy 拦截：数据锁定时 select 返回空、execute 静默跳过（认证相关查询除外）
    db = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: any[]) => {
          const sql: string = typeof args[0] === 'string' ? args[0] : '';
          if (dataLocked && !isAuthQuery(sql)) {
            if (prop === 'select') return Promise.resolve([]);
            if (prop === 'execute') return Promise.resolve({ rowsAffected: 0, lastInsertId: 0 });
          }
          return value.apply(target, args);
        };
      },
    }) as unknown as Database;
  }
  // 数据库初始化配置：WAL 模式 + 繁忙等待，避免 "database is locked" 冲突
  // WAL 允许读写并发，busy_timeout 让写锁冲突时等待而不是立即失败
  await ignoreSchemaError(db.execute('PRAGMA journal_mode=WAL'));
  await ignoreSchemaError(db.execute('PRAGMA busy_timeout=8000'));
  if (!schemaReady) {
    await ensureSchema(db);
    schemaReady = true;
  }
  return db;
}



async function ignoreSchemaError(task: Promise<any>) {
  try { await task; } catch { }
}



async function ensureSchema(d: Database) {
  // ===== 核心表建表（取代 Rust migration 系统）=====
  // 全部用 ignoreSchemaError 包裹，已存在的表会静默跳过
  const coreCreate = [
    `CREATE TABLE IF NOT EXISTS parts (id INTEGER PRIMARY KEY AUTOINCREMENT, main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', category TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, specs TEXT DEFAULT '', projects TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, project_type TEXT DEFAULT '在研', tier TEXT DEFAULT '主流级', status TEXT DEFAULT '进行中', category TEXT DEFAULT '未分类', screen_size TEXT DEFAULT '', resolution TEXT DEFAULT '', refresh_rate TEXT DEFAULT '', panel_type TEXT DEFAULT '', platform_fee_rate REAL DEFAULT 0, profit_rate REAL DEFAULT 0, image TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS modules (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, module_category TEXT DEFAULT '未分类', description TEXT DEFAULT '', category TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS module_items (id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER NOT NULL, part_id INTEGER, part_name TEXT NOT NULL, part_model TEXT DEFAULT '', main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', cost REAL DEFAULT 0, quantity INTEGER DEFAULT 1, remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_boms (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, part_id INTEGER NOT NULL, module_name TEXT DEFAULT '', quantity INTEGER DEFAULT 1, cost REAL DEFAULT 0, remark TEXT DEFAULT '', is_reference INTEGER DEFAULT 0, reference_remark TEXT DEFAULT '', is_deleted INTEGER DEFAULT 0, ref_project_id INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS part_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, old_cost REAL NOT NULL, new_cost REAL NOT NULL, changed_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS competitors (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, model TEXT NOT NULL, tier TEXT DEFAULT '主流级', category TEXT DEFAULT '未分类', market_price REAL DEFAULT 0, bom_cost REAL DEFAULT 0, platform_fee_rate REAL DEFAULT 0, remark TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS competitor_boms (id INTEGER PRIMARY KEY AUTOINCREMENT, competitor_id INTEGER NOT NULL, part_id INTEGER, part_name TEXT NOT NULL, part_model TEXT DEFAULT '', module_name TEXT DEFAULT '', estimated_cost REAL DEFAULT 0, quantity INTEGER DEFAULT 1, is_mapped INTEGER DEFAULT 0, our_part_name TEXT DEFAULT '', our_part_model TEXT DEFAULT '', our_cost REAL DEFAULT 0, our_quantity INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS competitor_parts (id INTEGER PRIMARY KEY AUTOINCREMENT, main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', category TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, cost REAL DEFAULT 0, specs TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_cost_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, stage TEXT NOT NULL, reviewed_cost REAL NOT NULL, reviewer TEXT DEFAULT '', reviewed_at TEXT DEFAULT (datetime('now','localtime')), remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_cost_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, snapshot_type TEXT DEFAULT 'bom_change', change_reason TEXT DEFAULT '', bom_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, platform_fee_rate REAL DEFAULT 0, profit_rate REAL DEFAULT 0, module_count INTEGER DEFAULT 0, item_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, domain TEXT NOT NULL, target_cost REAL DEFAULT 0, remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_measures (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, main_category TEXT NOT NULL, measure TEXT NOT NULL, status TEXT DEFAULT '待执行', due_date TEXT DEFAULT '', owner TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, weight REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL, feature_id INTEGER NOT NULL, score REAL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS module_feature_links (id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT NOT NULL, feature_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(module_name, feature_id))`,
    `CREATE TABLE IF NOT EXISTS project_skus (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, sku_code TEXT NOT NULL, sku_name TEXT DEFAULT '', spec_desc TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS sku_diffs (id INTEGER PRIMARY KEY AUTOINCREMENT, sku_id INTEGER NOT NULL, diff_type TEXT NOT NULL, module_name TEXT DEFAULT '', part_name TEXT DEFAULT '', part_model TEXT DEFAULT '', quantity REAL DEFAULT 1, unit_cost REAL DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT DEFAULT '', alias_name TEXT NOT NULL, alias_model TEXT DEFAULT '', canonical_name TEXT NOT NULL, canonical_model TEXT DEFAULT '', main_category TEXT DEFAULT '', sub_category TEXT DEFAULT '', source TEXT DEFAULT 'user_confirmed', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_compare_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT '', module_name TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT DEFAULT '', identified_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(category, module_name))`,
    `CREATE TABLE IF NOT EXISTS ai_bridge_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_key TEXT NOT NULL,
      material_name TEXT NOT NULL,
      category TEXT DEFAULT '',
      question TEXT DEFAULT '',
      cloud_result TEXT DEFAULT '',
      local_result TEXT DEFAULT '',
      verdict TEXT DEFAULT '',
      reused INTEGER DEFAULT 0,
      reuse_of INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_advisor_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insight_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      ref_type TEXT DEFAULT '',
      ref_id INTEGER DEFAULT 0,
      ref_name TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      source TEXT DEFAULT 'rule',
      fingerprint TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS part_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT '', module_name TEXT NOT NULL, insight_json TEXT DEFAULT '', status TEXT DEFAULT 'unread', handled_json TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(category, module_name))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS api_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_type TEXT NOT NULL, provider_name TEXT NOT NULL, api_key TEXT DEFAULT '', base_url TEXT DEFAULT '', model_name TEXT DEFAULT '', is_active INTEGER DEFAULT 0, priority INTEGER DEFAULT 0, is_preset INTEGER DEFAULT 0, monthly_quota_note TEXT DEFAULT '', registration_url TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, price REAL DEFAULT 0, share_ratio REAL DEFAULT 0, is_active INTEGER DEFAULT 1, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS supplier_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT NOT NULL UNIQUE, logo TEXT DEFAULT '', category TEXT DEFAULT '', contact TEXT DEFAULT '', phone TEXT DEFAULT '', rating INTEGER DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_supplier_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, old_price REAL DEFAULT 0, new_price REAL DEFAULT 0, changed_at TEXT DEFAULT (datetime('now','localtime')), change_reason TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, quoted_price REAL DEFAULT 0, share_ratio REAL DEFAULT 0, is_active INTEGER DEFAULT 1, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_supplier_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, old_price REAL DEFAULT 0, new_price REAL DEFAULT 0, changed_at TEXT DEFAULT (datetime('now','localtime')), change_reason TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS cost_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, change_type TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL, ref_name TEXT DEFAULT '', supplier_name TEXT DEFAULT '', old_value REAL DEFAULT 0, new_value REAL DEFAULT 0, change_reason TEXT DEFAULT '', impact_scope TEXT DEFAULT '', changed_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT DEFAULT '#3B82F6', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, project_id INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trend_items (id INTEGER PRIMARY KEY AUTOINCREMENT, query_category TEXT NOT NULL, category_type TEXT DEFAULT '直接查询', trend_direction TEXT DEFAULT '', confidence_level TEXT DEFAULT '', summary TEXT DEFAULT '', suggested_action TEXT DEFAULT '', raw_search_results TEXT DEFAULT '', last_updated_at TEXT DEFAULT '', magnitude_min REAL DEFAULT NULL, magnitude_max REAL DEFAULT NULL, magnitude_reference TEXT DEFAULT '', last_queried_at TEXT DEFAULT '', source_type TEXT DEFAULT 'decomposition', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, source_title TEXT DEFAULT '', source_url TEXT DEFAULT '', excerpt TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, question TEXT DEFAULT '', answer TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, query_time TEXT DEFAULT (datetime('now','localtime')), source_type TEXT DEFAULT 'direct_query', direction TEXT DEFAULT '', confidence TEXT DEFAULT '', confidence_level TEXT DEFAULT '', summary TEXT DEFAULT '', suggested_action TEXT DEFAULT '', skill_used TEXT DEFAULT '', magnitude_min REAL DEFAULT NULL, magnitude_max REAL DEFAULT NULL, magnitude_reference TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS trend_insight_dimensions (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_snapshot_id INTEGER NOT NULL, dimension_type TEXT DEFAULT '', dimension_order INTEGER DEFAULT 0, content TEXT DEFAULT '', evidence_strength TEXT DEFAULT '', data_points TEXT DEFAULT '', source_title TEXT DEFAULT '', source_url TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS trend_key_events (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_snapshot_id INTEGER NOT NULL, event_date TEXT DEFAULT '', event_description TEXT DEFAULT '', impact_direction TEXT DEFAULT '', source_title TEXT DEFAULT '', source_url TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS trend_part_mapping (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, trend_item_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS rollup_contributions (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_snapshot_id INTEGER NOT NULL, child_component_id INTEGER NOT NULL, cost_ratio_used REAL DEFAULT NULL, direction_used TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS rollup_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, component_id INTEGER NOT NULL, component_name TEXT DEFAULT '', ai_direction TEXT DEFAULT '', ai_summary TEXT DEFAULT '', ai_confidence_level TEXT DEFAULT '', user_corrected_direction TEXT DEFAULT '', user_corrected_confidence_level TEXT DEFAULT '', correction_reason TEXT DEFAULT '', user_corrected_summary TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS ai_request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, request_type TEXT NOT NULL, material_name TEXT DEFAULT '', system_prompt TEXT DEFAULT '', user_prompt TEXT DEFAULT '', response_summary TEXT DEFAULT '', success INTEGER DEFAULT 1, error_message TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS material_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS local_ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '新对话', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS local_ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS local_ai_context (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS local_ai_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT DEFAULT 'general', source_session INTEGER DEFAULT 0, hit_count INTEGER DEFAULT 0, last_used_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS module_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, keywords TEXT NOT NULL, module TEXT NOT NULL, main_category TEXT NOT NULL, sub_category TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS work_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, log_date TEXT DEFAULT (datetime('now','localtime')), title TEXT DEFAULT '', content TEXT NOT NULL, category TEXT DEFAULT '其他', tags TEXT DEFAULT '', is_todo INTEGER DEFAULT 0, done INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS work_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '', content TEXT NOT NULL, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
  ];
  for (const sql of coreCreate) {
    await ignoreSchemaError(d.execute(sql));
  }

  // 首先确保关键表存在（防止迁移未执行）
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS decomposition_tree (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_part_id INTEGER,
        parent_id INTEGER,
        component_name TEXT NOT NULL,
        cost_ratio_estimate REAL DEFAULT NULL,
        source_type TEXT DEFAULT 'user_confirmed',
        node_type TEXT DEFAULT 'structural',
        insight_status TEXT DEFAULT 'pending',
        trend_item_id INTEGER DEFAULT NULL,
        remark TEXT DEFAULT '',
        ai_insights TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ decomposition_tree 表已确保存在');
  } catch (e) {
    console.error('创建 decomposition_tree 表失败:', e);
  }

  // 确保 decomposition_history 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS decomposition_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_part_id INTEGER NOT NULL,
        timestamp TEXT DEFAULT (datetime('now','localtime')),
        summary TEXT DEFAULT ''
      )
    `);
    console.log('✓ decomposition_history 表已确保存在');
  } catch (e) {
    console.error('创建 decomposition_history 表失败:', e);
  }

  // 确保 trend_part_mapping 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS trend_part_mapping (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        part_id INTEGER NOT NULL,
        trend_item_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ trend_part_mapping 表已确保存在');
  } catch (e) {
    console.error('创建 trend_part_mapping 表失败:', e);
  }

  // 确保 material_categories 表存在
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS material_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_name TEXT NOT NULL UNIQUE
      )
    `);
    console.log('✓ material_categories 表已确保存在');
  } catch (e) {
    console.error('创建 material_categories 表失败:', e);
  }

  // 确保 ai_request_logs 表存在（用于审计）
  try {
    await d.execute(`
      CREATE TABLE IF NOT EXISTS ai_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_type TEXT NOT NULL,
        material_name TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        user_prompt TEXT DEFAULT '',
        response_summary TEXT DEFAULT '',
        success INTEGER DEFAULT 1,
        error_message TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('✓ ai_request_logs 表已确保存在');
  } catch (e) {
    console.error('创建 ai_request_logs 表失败:', e);
  }

    // part_insights 补 handled_json（已处理组快照，供「已处理」视图查看/撤销）
  await ignoreSchemaError(d.execute("ALTER TABLE part_insights ADD COLUMN handled_json TEXT DEFAULT ''"));
// 为 trend_items 表添加缺失的列
  await ignoreSchemaError(d.execute('ALTER TABLE trend_items ADD COLUMN magnitude_min REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute('ALTER TABLE trend_items ADD COLUMN magnitude_max REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_items ADD COLUMN magnitude_reference TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_items ADD COLUMN source_type TEXT DEFAULT 'decomposition'"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_items ADD COLUMN last_queried_at TEXT DEFAULT ''"));

  // 为 trend_snapshots 表添加缺失的列
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence_level TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_min REAL DEFAULT NULL"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_max REAL DEFAULT NULL"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_reference TEXT DEFAULT ''"));

  // 为 trend_insight_dimensions 表添加缺失的列
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN data_points TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_title TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_url TEXT DEFAULT ''"));

  // 为 trend_key_events 表添加缺失的列（确保所有列都存在）
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_date TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_description TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN impact_direction TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_title TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_url TEXT DEFAULT ''"));

  // 原有的列补齐逻辑
  await ignoreSchemaError(d.execute('ALTER TABLE parts ADD COLUMN trend_enabled INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE parts ADD COLUMN trend_query_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE parts ADD COLUMN trend_category_type TEXT DEFAULT '直接查询'"));

  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN price REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN share_ratio REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN is_active INTEGER DEFAULT 1'));
  await ignoreSchemaError(d.execute('ALTER TABLE part_suppliers ADD COLUMN unit_price REAL DEFAULT 0'));

  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN source_type TEXT DEFAULT 'direct_query'"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence_level TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE modules ADD COLUMN module_category TEXT DEFAULT '未分类'"));

  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN correction_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN user_corrected_summary TEXT DEFAULT ''"));

  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_messages ADD COLUMN reasoning TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_memory ADD COLUMN category TEXT DEFAULT 'general'"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_request_logs ADD COLUMN provider_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_request_logs ADD COLUMN model_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN prompt_tokens INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN completion_tokens INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN total_tokens INTEGER DEFAULT 0'));
  // 演示生成习惯库（v2.3.19+）：local_ai_context 加分类列（演示结构/风格描述/素材模板等），默认 general
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_context ADD COLUMN category TEXT DEFAULT 'general'"));
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN is_todo INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN done INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN work_project TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE projects ADD COLUMN category TEXT DEFAULT '未分类'"));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN cost_ratio_estimate REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN source_type TEXT DEFAULT 'user_confirmed'"));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN insight_status TEXT DEFAULT 'pending'"));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN trend_item_id INTEGER DEFAULT NULL'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN is_deleted INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE competitors ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN category TEXT DEFAULT '未分类'"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_reference INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN reference_remark TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_deleted INTEGER DEFAULT 0'));
  // project_boms 快照列（v2.3.19+ 写入，保证 模块库/项目页 读同一份数据，避免两页偏差）
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_model TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN part_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN main_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN sub_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_specs TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_module_item INTEGER DEFAULT 0'));
  // project_boms 时间列（v2.3.19+）：快照回溯对比用；旧数据默认补当前时间
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN created_at TEXT DEFAULT (datetime('now','localtime'))"));
  // 器件供应商价格历史：补充 part_id/supplier_name 列（历史 bug：写入用了不存在的 supplier_price_history 表，
  // 此表从未写入过数据——统一写入 part_supplier_price_history 并按 part_id+supplier_name 检索）
  await ignoreSchemaError(d.execute('ALTER TABLE part_supplier_price_history ADD COLUMN part_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE part_supplier_price_history ADD COLUMN supplier_name TEXT DEFAULT ''"));
  // 竞争力雷达（v2.3.19+）：product_features 区分特性体系——custom=用户自定义（旧对比雷达）、radar=固定五维（性能/规格/显示/外观/可靠性）
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN type TEXT DEFAULT 'custom'"));

  // 竞争力雷达五维种子（幂等：按名字检查，不存在才插入，避免重复）
  const radarSeedNames = ['性能', '规格', '显示', '外观', '可靠性'];
  try {
    const existing = await d.select<any[]>('SELECT name FROM product_features WHERE type = ?', ['radar']);
    const have = new Set(existing.map((r: any) => r.name));
    for (const nm of radarSeedNames) {
      if (!have.has(nm)) {
        await d.execute("INSERT INTO product_features (name, weight, type) VALUES (?, 1.0, 'radar')", [nm]);
      }
    }
  } catch (e) { console.warn('radar seed failed', e); }

  // ====== 性能优化：添加关键索引 ======
  // 这些索引可以显著提升查询性能，特别是数据量大时
  console.log('正在创建数据库索引...');

  // trend_items 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_items_part_id ON trend_items(part_id)'));

  // trend_snapshots 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_trend_item_id ON trend_snapshots(trend_item_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_query_time ON trend_snapshots(query_time DESC)'));

  // trend_sources 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_sources_trend_item_id ON trend_sources(trend_item_id)'));

  // trend_conversations 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_conversations_trend_item_id ON trend_conversations(trend_item_id)'));

  // trend_insight_dimensions 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_insight_dimensions_snapshot_id ON trend_insight_dimensions(trend_snapshot_id)'));

  // trend_key_events 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_trend_key_events_snapshot_id ON trend_key_events(trend_snapshot_id)'));

  // decomposition_tree 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_root_part_id ON decomposition_tree(root_part_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_parent_id ON decomposition_tree(parent_id)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_decomposition_tree_trend_item_id ON decomposition_tree(trend_item_id)'));

  // part_suppliers 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_part_suppliers_part_id ON part_suppliers(part_id)'));

  // parts 索引
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_parts_main_category ON parts(main_category)'));
  await ignoreSchemaError(d.execute('CREATE INDEX IF NOT EXISTS idx_parts_trend_enabled ON parts(trend_enabled)'));

  console.log('✓ 数据库索引创建完成');

  // Migrate project_cost_snapshots table - rebuild if it has old schema with snapshot_name
  try {
    await d.execute(
      `INSERT INTO project_cost_snapshots (project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count) VALUES (?,?,?,?,?,?,?,?,?)`,
      [-999, 'test', 'test', 0, 0, 0, 0, 0, 0]
    );
    await d.execute('DELETE FROM project_cost_snapshots WHERE project_id = -999');
  } catch (e) {
    // If insert fails, rebuild the table
    console.log('Rebuilding project_cost_snapshots table...');
    await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots RENAME TO project_cost_snapshots_old'));
    await d.execute(`
      CREATE TABLE IF NOT EXISTS project_cost_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        snapshot_type TEXT DEFAULT 'bom_change',
        change_reason TEXT DEFAULT '',
        bom_cost REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        platform_fee_rate REAL DEFAULT 0,
        profit_rate REAL DEFAULT 0,
        module_count INTEGER DEFAULT 0,
        item_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    await ignoreSchemaError(d.execute(`
      INSERT INTO project_cost_snapshots (id, project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count, created_at)
      SELECT id, project_id,
        COALESCE(snapshot_type, 'bom_change'),
        COALESCE(change_reason, ''),
        COALESCE(bom_cost, 0),
        COALESCE(total_cost, 0),
        COALESCE(platform_fee_rate, 0),
        COALESCE(profit_rate, 0),
        COALESCE(module_count, 0),
        COALESCE(item_count, 0),
        created_at
      FROM project_cost_snapshots_old
    `));
    await ignoreSchemaError(d.execute('DROP TABLE project_cost_snapshots_old'));
  }

  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN snapshot_type TEXT DEFAULT 'bom_change'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN change_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN bom_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN total_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN platform_fee_rate REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN profit_rate REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN module_count INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_cost_snapshots ADD COLUMN item_count INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN change_details TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute(`
    CREATE TABLE IF NOT EXISTS project_cost_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      snapshot_type TEXT DEFAULT 'bom_change',
      change_reason TEXT DEFAULT '',
      bom_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      platform_fee_rate REAL DEFAULT 0,
      profit_rate REAL DEFAULT 0,
      module_count INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `));

  // ===== project_boms 快照列回填（v2.3.19+ 一次性的历史数据修复）=====
  // 旧版本 project_boms 只存 part_id，页面 JOIN parts 取实时价；
  // 而模块库读 module_items（导入时的 Excel 快照价）→ 同一模块两页显示不一致。
  // 回填策略：以 module_items 的 Excel 快照为准（项目+模块名+器件名匹配），
  // 无快照的行用 parts 当前值兜底。只回填空快照列的行（一次性，幂等）。
  try {
    const dirty = await d.select<any[]>(`SELECT pb.id, pb.project_id, pb.module_name, pb.part_id
      FROM project_boms pb WHERE COALESCE(NULLIF(pb.part_name, ''), '') = ''`);
    if (dirty.length > 0) {
      // 快照索引：project_id + module_name + part_id → {cost, name, model, main, sub}
      const miRows = await d.select<any[]>(`SELECT mi.part_id, mi.cost, mi.part_name, mi.part_model, mi.main_category, mi.sub_category, m.project_id, m.name AS module_name
        FROM module_items mi JOIN modules m ON mi.module_id = m.id WHERE mi.part_id IS NOT NULL`);
      const snapIndex: Record<string, any> = {};
      for (const mi of miRows) {
        const key = `${mi.project_id}|${mi.module_name}|${mi.part_id}`;
        if (!snapIndex[key]) snapIndex[key] = mi;
      }
      for (const row of dirty) {
        const snap = snapIndex[`${row.project_id}|${row.module_name}|${row.part_id}`];
        if (snap) {
          await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=? WHERE id=?`,
            [snap.part_name || '', snap.part_model || '', snap.cost || 0, snap.main_category || '', snap.sub_category || '', row.id]);
        } else {
          // parts 兜底
          const p = await d.select<any[]>('SELECT name, model, cost, main_category, sub_category FROM parts WHERE id = ?', [row.part_id]).then(r => r[0]);
          if (p) await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=? WHERE id=?`,
            [p.name || '', p.model || '', p.cost || 0, p.main_category || '', p.sub_category || '', row.id]);
        }
      }
      console.log(`project_boms 快照列回填完成: ${dirty.length} 行`);
    }
  } catch (e) { console.warn('project_boms 快照列回填失败:', e); }

  // ===== 查询索引（v2.3.19 性能优化：高频查询列建索引，幂等）=====
  const indexSql = [
    'CREATE INDEX IF NOT EXISTS idx_parts_main_cat ON parts(main_category, sub_category)',
    'CREATE INDEX IF NOT EXISTS idx_parts_name ON parts(name)',
    'CREATE INDEX IF NOT EXISTS idx_parts_model ON parts(model)',
    'CREATE INDEX IF NOT EXISTS idx_project_boms_project ON project_boms(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_project_boms_module ON project_boms(project_id, module_name)',
    'CREATE INDEX IF NOT EXISTS idx_part_suppliers_part ON part_suppliers(part_id)',
    'CREATE INDEX IF NOT EXISTS idx_part_price_history_part ON part_price_history(part_id)',
    'CREATE INDEX IF NOT EXISTS idx_project_suppliers_project ON project_suppliers(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_trend_snapshots_item ON trend_snapshots(trend_item_id)',
    'CREATE INDEX IF NOT EXISTS idx_trend_sources_item ON trend_sources(trend_item_id)',
    'CREATE INDEX IF NOT EXISTS idx_decomposition_tree_parent ON decomposition_tree(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_work_logs_date ON work_logs(log_date)',
    'CREATE INDEX IF NOT EXISTS idx_competitor_boms_comp ON competitor_boms(competitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_sku_diffs_sku ON sku_diffs(sku_id)',
    'CREATE INDEX IF NOT EXISTS idx_cost_change_log_type ON cost_change_log(change_type)',
    'CREATE INDEX IF NOT EXISTS idx_ai_request_logs_type ON ai_request_logs(request_type)',
  ];
  for (const sql of indexSql) {
    await ignoreSchemaError(d.execute(sql));
  }
}



// 生成与 SQLite datetime('now','localtime') 一致的本地时间字符串（YYYY-MM-DD HH:MM:SS）
function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export { getDb, getRawDb, sha256, localNow, dataLocked, AUTH_KEY, AUTH_PLAIN_KEY, AUTH_CHANGED_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME };