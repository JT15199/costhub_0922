import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import { PRESET_PROVIDERS as PRESET_PROVIDER_TEMPLATES } from './constants';

let db: Database | null = null;
let dbUrl: string | null = null;
let schemaReady = false;
// ====== 数据锁（登录门禁） ======
// 解锁前：所有查询返回空数据、所有写入静默跳过 —— 密码错误也能进入应用，但不显示任何数据
let dataLocked = true;
let rawDb: Database | null = null; // 绕过拦截的原始实例（仅登录/改密码/锁状态用）
const AUTH_KEY = 'auth_password_hash';
const AUTH_PLAIN_KEY = 'auth_password_plain';   // 明文副本（用于找回显示，仅存本地）
const AUTH_CHANGED_KEY = 'auth_password_changed'; // 是否已改过密码（控制首次提示）
const AUTH_USERNAME_KEY = 'auth_username';        // 用户名（可自定义，默认 admin）
const DEFAULT_PASSWORD = '666666';
const DEFAULT_USERNAME = 'admin';

export function isDataLocked(): boolean { return dataLocked; }
export function setDataLocked(locked: boolean) { dataLocked = locked; }

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 初始化密码（仅当未设置过时写入默认密码 666666 + 明文副本 + 默认用户名）
export async function ensureAuthPassword(): Promise<void> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) {
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await sha256(DEFAULT_PASSWORD)]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_PLAIN_KEY, DEFAULT_PASSWORD]);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '0']);
      await raw.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, DEFAULT_USERNAME]);
    }
  } catch (e) { console.error('初始化密码失败:', e); }
}

// 获取用户名
export async function getUsername(): Promise<string> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_USERNAME_KEY]);
    return rows.length > 0 && rows[0].value ? rows[0].value : DEFAULT_USERNAME;
  } catch { return DEFAULT_USERNAME; }
}

// 修改用户名
export async function changeUsername(newName: string): Promise<{ ok: boolean; msg: string }> {
  if (!newName || !newName.trim()) return { ok: false, msg: '用户名不能为空' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_USERNAME_KEY, newName.trim()]);
    return { ok: true, msg: '用户名已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
}

// 是否首次使用（未改过密码 → 登录页显示初始密码提示）
export async function isFirstUse(): Promise<boolean> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_CHANGED_KEY]);
    return rows.length === 0 || rows[0].value !== '1';
  } catch { return true; }
}

// 获取明文密码（用于找回显示；仅本地，未改过密码时返回默认密码）
export async function getPlainPassword(): Promise<string> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_PLAIN_KEY]);
    if (rows.length > 0 && rows[0].value) return rows[0].value;
    return DEFAULT_PASSWORD;
  } catch { return DEFAULT_PASSWORD; }
}

// 验证密码（用原始实例，绕过数据锁）
export async function verifyPassword(input: string): Promise<boolean> {
  try {
    const raw = await getRawDb();
    const rows = await raw.select<any[]>('SELECT value FROM settings WHERE key=?', [AUTH_KEY]);
    if (rows.length === 0) return false;
    return (await sha256(input)) === rows[0].value;
  } catch (e) { console.error('验证密码失败:', e); return false; }
}

// 修改密码（验证旧密码后写入新密码哈希 + 明文副本 + 标记已改）
export async function changePassword(oldPwd: string, newPwd: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await verifyPassword(oldPwd))) return { ok: false, msg: '当前密码不正确' };
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新密码至少 4 位' };
  try {
    const raw = await getRawDb();
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_KEY, await sha256(newPwd)]);
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_PLAIN_KEY, newPwd]);
    await raw.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [AUTH_CHANGED_KEY, '1']);
    return { ok: true, msg: '密码已更新' };
  } catch (e: any) { return { ok: false, msg: `修改失败：${e?.message || e}` }; }
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
    `CREATE TABLE IF NOT EXISTS part_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT '', module_name TEXT NOT NULL, insight_json TEXT DEFAULT '', status TEXT DEFAULT 'unread', created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(category, module_name))`,
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
}

// ==================== Parts ====================
export async function getParts(search = '', category = '', mainCategory = '') {
  const d = await getDb();
  let q = 'SELECT * FROM parts WHERE 1=1'; const p: any[] = [];
  if (search) { q += ' AND (name LIKE ? OR model LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (category) { q += ' AND category = ?'; p.push(category); }
  if (mainCategory) { q += ' AND main_category = ?'; p.push(mainCategory); }
  q += ' ORDER BY main_category, sub_category, name';
  return d.select<any[]>(q, p);
}
export async function getPart(id: number) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM parts WHERE id = ?', [id]);
  return r[0] || null;
}
export async function savePart(data: any, autoSnapshot = true) {
  const d = await getDb();
  if (data.id) {
    const old = await d.select<{ cost: number }[]>('SELECT cost FROM parts WHERE id = ?', [data.id]);
    if (old[0] && Math.abs(old[0].cost - (data.cost || 0)) > 0.0001) {
      await d.execute('INSERT INTO part_price_history (part_id, old_cost, new_cost) VALUES (?, ?, ?)', [data.id, old[0].cost, data.cost || 0]);
    }
    const affectedProjects = autoSnapshot
      ? await d.select<{ project_id: number }[]>('SELECT DISTINCT project_id FROM project_boms WHERE part_id = ? AND COALESCE(is_deleted, 0) = 0', [data.id])
      : [];
    await d.execute(`UPDATE parts SET main_category=?, sub_category=?, category=?, name=?, model=?, cost=?, specs=?, projects=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '', data.id]);
    if (autoSnapshot && affectedProjects.length > 0) {
      for (const p of affectedProjects) {
        await recordProjectCostSnapshot(p.project_id, 'part_price_changed', `器件「${data.name || ''}」价格/信息变更`);
      }
    }
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO parts (main_category, sub_category, category, name, model, cost, specs, projects, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
      [data.main_category || '硬件类', data.sub_category || '', data.category || '', data.name, data.model, data.cost || 0, data.specs || '', data.projects || '', data.remark || '']);
    return r.lastInsertId;
  }
}
export async function deletePart(id: number) {
  const d = await getDb();
  // 先处理引用它的 BOM 行（软删，避免 JOIN 到不存在的 parts 造成错位/报错）
  await d.execute('UPDATE project_boms SET is_deleted = 1 WHERE part_id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  // 清理供应商数据
  await d.execute('DELETE FROM part_suppliers WHERE part_id = ?', [id]);
  await d.execute('DELETE FROM part_price_history WHERE part_id = ?', [id]);
  // 清理洞察关联
  await d.execute('DELETE FROM trend_part_mapping WHERE part_id = ?', [id]);
  await d.execute('DELETE FROM parts WHERE id = ?', [id]);
}
export async function getPriceHistory(partId: number) { return (await getDb()).select<any[]>('SELECT * FROM part_price_history WHERE part_id = ? ORDER BY changed_at DESC', [partId]); }
export async function getCategories() { return (await (await getDb()).select<{ category: string }[]>('SELECT DISTINCT category FROM parts ORDER BY category')).map(x => x.category); }
export async function getMainCategories(): Promise<string[]> {
  const d = await getDb();
  const r = await d.select<{ mc: string }[]>('SELECT DISTINCT main_category as mc FROM parts UNION SELECT DISTINCT domain as mc FROM project_targets ORDER BY mc');
  const defaults = ['硬件类', '结构类', '电源类', '线材类', '包材类', '加工费类', '软件类', '其他'];
  return [...new Set([...defaults, ...r.map(x => x.mc)])];
}
export async function getSubCategories(mainCat: string): Promise<string[]> {
  const r = await (await getDb()).select<{ sc: string }[]>('SELECT DISTINCT sub_category as sc FROM parts WHERE main_category = ? ORDER BY sc', [mainCat]);
  return r.map(x => x.sc).filter(Boolean);
}

// ==================== Projects ====================
export async function getProjects(status = '', projectType = '', category = '') {
  const d = await getDb(); let q = 'SELECT * FROM projects WHERE 1=1'; const p: any[] = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectType) { q += ' AND project_type = ?'; p.push(projectType); }
  if (category) { q += ' AND category = ?'; p.push(category); }
  q += ' AND COALESCE(is_deleted, 0) = 0 ORDER BY COALESCE(sort_order, 0), created_at DESC';
  return d.select<any[]>(q, p);
}
export async function getProject(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [id]); return r[0] || null; }
export async function saveProject(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(`UPDATE projects SET code=?,name=?,project_type=?,tier=?,status=?,category=?,screen_size=?,resolution=?,refresh_rate=?,panel_type=?,platform_fee_rate=?,profit_rate=?,image=? WHERE id=?`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.category || '未分类', data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '', data.id]);
    return data.id;
  } else {
    const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,category,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.code, data.name, data.project_type || '在研', data.tier, data.status, data.category || '未分类', data.screen_size || '', data.resolution || '', data.refresh_rate || '', data.panel_type || '', data.platform_fee_rate || 0, data.profit_rate || 0, data.image || '']);
    return r.lastInsertId;
  }
}
export async function deleteProject(id: number) { await (await getDb()).execute('UPDATE projects SET is_deleted = 1 WHERE id = ?', [id]); }

// ==================== 产品品类（可编辑） ====================
export async function getProductCategories() {
  return (await getDb()).select<any[]>('SELECT * FROM product_categories ORDER BY sort_order, id');
}
export async function saveProductCategory(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE product_categories SET name=?, sort_order=? WHERE id=?', [data.name, data.sort_order || 0, data.id]);
    return data.id;
  } else {
    const r = await d.execute('INSERT INTO product_categories (name, sort_order) VALUES (?,?)', [data.name, data.sort_order || 0]);
    return r.lastInsertId;
  }
}
export async function deleteProductCategory(id: number) {
  const d = await getDb();
  // 删除品类前，先把该品类的项目归回"未分类"兜底
  const [cat] = await d.select<any[]>('SELECT name FROM product_categories WHERE id=?', [id]);
  if (cat) {
    await d.execute("UPDATE projects SET category='未分类' WHERE category=?", [cat.name]);
    await d.execute("UPDATE competitors SET category='未分类' WHERE category=?", [cat.name]);
  }
  await d.execute('DELETE FROM product_categories WHERE id=?', [id]);
}
export async function ensureDefaultCategories() {
  const d = await getDb();
  const existing = await d.select<{ name: string }[]>('SELECT name FROM product_categories');
  const names = existing.map(e => e.name);
  // 只保证"未分类"兜底存在，其余品类由用户自行创建
  if (!names.includes('未分类')) {
    await d.execute('INSERT INTO product_categories (name, sort_order) VALUES (?,?)', ['未分类', 0]);
  }
}
export async function copyProject(id: number, newCode: string, newName: string) {
  const d = await getDb(); const src = await d.select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  if (!src[0]) return 0;
  const r = await d.execute(`INSERT INTO projects (code,name,project_type,tier,status,screen_size,resolution,refresh_rate,panel_type,platform_fee_rate,profit_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [newCode, newName, '在研', src[0].tier, '进行中', src[0].screen_size, src[0].resolution, src[0].refresh_rate, src[0].panel_type, src[0].platform_fee_rate, src[0].profit_rate]);
  const boms = await d.select<any[]>('SELECT * FROM project_boms WHERE project_id = ? AND COALESCE(is_deleted, 0) = 0', [id]);
  for (const b of boms) {
    // 复制完整快照列（名称/型号/单价/分类/标记），保证复制项目与源项目显示一致
    await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, part_name, part_model, part_cost, main_category, sub_category, is_module_item, ref_project_id, is_reference, reference_remark, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      [r.lastInsertId, b.part_id, b.module_name, b.quantity, b.remark || '', b.part_name || '', b.part_model || '', b.part_cost || 0, b.main_category || '', b.sub_category || '', b.is_module_item || 0, b.ref_project_id || 0, b.is_reference || 0, b.reference_remark || '']);
  }
  const mods = await d.select<any[]>('SELECT * FROM modules WHERE project_id = ?', [id]);
  for (const m of mods) {
    const mr = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)', [r.lastInsertId, m.name, m.module_category || '未分类', m.description]);
    const items = await d.select<any[]>('SELECT * FROM module_items WHERE module_id = ?', [m.id]);
    for (const mi of items) { await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [mr.lastInsertId, mi.part_id, mi.part_name, mi.part_model, mi.main_category, mi.sub_category, mi.cost, mi.quantity, mi.remark]); }
  }
  return r.lastInsertId;
}

// ==================== Project BOMs ====================
export async function getProjectBOMs(projectId: number) {
  return (await getDb()).select<any[]>(`SELECT pb.id, pb.project_id, pb.part_id, pb.module_name, pb.quantity, pb.remark, pb.ref_project_id, pb.cost, pb.is_reference, pb.reference_remark, pb.is_deleted, pb.is_module_item,
    COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name,
    COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
    CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as part_cost,
    COALESCE(NULLIF(pb.main_category, ''), p.main_category) as main_category,
    COALESCE(NULLIF(pb.sub_category, ''), p.sub_category) as sub_category,
    p.category
    FROM project_boms pb LEFT JOIN parts p ON pb.part_id = p.id
    WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0
    ORDER BY pb.module_name, main_category, sub_category, part_name`, [projectId]);
}
export async function recordProjectCostSnapshot(projectId: number, snapshotType = 'bom_change', changeReason = '') {
  const d = await getDb();
  const project = await d.select<any[]>('SELECT * FROM projects WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [projectId]).then(rows => rows[0]);
  if (!project) return 0;

  // Get current BOM data with part details（单价用 BOM 行快照列，与页面显示一致）
  // LEFT JOIN：虚拟器件（part_id=0）无 parts 对应行，也必须计入成本
  const rows = await d.select<any[]>(
    `SELECT pb.id, pb.module_name, pb.quantity, COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name, COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
            CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost
     FROM project_boms pb
     LEFT JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ? AND COALESCE(pb.is_deleted, 0) = 0`,
    [projectId]
  );

  // 计算口径：中间计算一律用原始值（该是多少就是多少），只有最终展示/落库才舍入
  const bomCost = rows.reduce((sum, row) => sum + (Number(row.cost) || 0) * (Number(row.quantity) || 0), 0);
  const totalCost = bomCost * (1 + ((Number(project.platform_fee_rate) || 0) + (Number(project.profit_rate) || 0)) / 100);
  const modules = new Set(rows.map(row => row.module_name || '未归类'));

  // Get previous snapshot to compare
  const prevSnapshots = await d.select<any[]>(
    'SELECT * FROM project_cost_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [projectId]
  );
  const prevSnap = prevSnapshots[0];

  // Build change details
  let changeDetails = '';
  if (prevSnap && snapshotType === 'part_changed') {
    // For part changes, extract which part changed from changeReason
    const match = changeReason.match(/调整BOM项：(.+)/);
    if (match) {
      const partName = match[1];
      const currentPart = rows.find(r => r.part_name === partName);
      if (currentPart) {
        changeDetails = `${partName} (${currentPart.part_model || ''}): 成本变化`;
      }
    }
  }

  if (changeDetails === '' && prevSnap) {
    const bomDiff = bomCost - Number(prevSnap.bom_cost || 0);
    if (Math.abs(bomDiff) > 0.01) {
      changeDetails = `BOM总成本: ¥${Number(prevSnap.bom_cost || 0).toFixed(2)} → ¥${bomCost.toFixed(2)} (${bomDiff > 0 ? '+' : ''}${bomDiff.toFixed(2)})`;
    }
  }

  const result = await d.execute(
    `INSERT INTO project_cost_snapshots
      (project_id, snapshot_type, change_reason, bom_cost, total_cost, platform_fee_rate, profit_rate, module_count, item_count, change_details)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      projectId,
      snapshotType,
      changeReason,
      Math.round(bomCost * 10000) / 10000,
      Math.round(totalCost * 10000) / 10000,
      Number(project.platform_fee_rate) || 0,
      Number(project.profit_rate) || 0,
      modules.size,
      rows.length,
      changeDetails,
    ]
  );
  return result.lastInsertId;
}
export async function getProjectCostSnapshots(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM project_cost_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC', [projectId]);
}
export async function getSnapshotBOMDetail(projectId: number, snapshotTime: string) {
  // Get BOM details at the time of snapshot (or closest before)
  const d = await getDb();
  const rows = await d.select<any[]>(
    `SELECT pb.module_name, pb.quantity, pb.remark,
            COALESCE(NULLIF(pb.part_name, ''), p.name) as part_name, COALESCE(NULLIF(pb.part_model, ''), p.model) as part_model,
            COALESCE(NULLIF(pb.main_category, ''), p.main_category) as main_category, COALESCE(NULLIF(pb.sub_category, ''), p.sub_category) as sub_category,
            CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost
     FROM project_boms pb
     LEFT JOIN parts p ON pb.part_id = p.id
     WHERE pb.project_id = ?
       AND COALESCE(pb.is_deleted, 0) = 0
       AND pb.created_at <= ?
     ORDER BY pb.module_name, main_category, part_name`,
    [projectId, snapshotTime]
  );
  return rows;
}
export async function deleteProjectCostSnapshot(snapshotId: number) {
  await (await getDb()).execute('DELETE FROM project_cost_snapshots WHERE id = ?', [snapshotId]);
}
export async function addBOMItem(projectId: number, partId: number, quantity = 1, moduleName = '', remark = '', refProjectId = 0, autoSnapshot = true, snapshot?: { name?: string; model?: string; cost?: number; mainCategory?: string; subCategory?: string }) {
  const d = await getDb();
  // 固化快照列：BOM 行写入时记录器件名/型号/单价/分类，保证项目页与模块库读同一份数据
  // （parts 实时价可能被其他项目导入/供应商报价更新覆盖，若只 JOIN parts 会导致同一行两处显示不一致）
  // snapshot 参数：从参照项目导入时传入参照项目的快照值，确保导入后与参照完全一致
  let part: any = null;
  if (snapshot) {
    part = { name: snapshot.name || '', model: snapshot.model || '', cost: snapshot.cost ?? 0, main_category: snapshot.mainCategory || '', sub_category: snapshot.subCategory || '' };
  } else {
    part = await d.select<any[]>('SELECT name, model, cost, main_category, sub_category FROM parts WHERE id = ?', [partId]).then(r => r[0]);
  }
  await d.execute('INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, ref_project_id, part_name, part_model, part_cost, main_category, sub_category, is_module_item, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
    [projectId, partId, moduleName, quantity, remark, refProjectId, part?.name || '', part?.model || '', part?.cost || 0, part?.main_category || '', part?.sub_category || '', 0]);
  if (autoSnapshot) await recordProjectCostSnapshot(projectId, 'part_added', `新增器件到${moduleName || '未归类'}`);
}

/**
 * 添加虚拟器件 BOM 行（成本占位）：不建 parts、不占器件库，直接写 BOM 快照列。
 * 用于在研项目测算时预估模块成本（如"预留电源IC"），定型/选型后可替换为真实器件。
 */
export async function addVirtualBOMItem(projectId: number, data: { name: string; model?: string; cost?: number; quantity?: number; moduleName?: string; mainCategory?: string; subCategory?: string; remark?: string }) {
  await (await getDb()).execute(
    'INSERT INTO project_boms (project_id, part_id, module_name, quantity, remark, part_name, part_model, part_cost, main_category, sub_category, is_module_item, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
    [projectId, 0, data.moduleName || '未归类', data.quantity ?? 1, data.remark || '', data.name || '虚拟器件', data.model || '', data.cost ?? 0, data.mainCategory || '硬件类', data.subCategory || '', 1]
  );
  await recordProjectCostSnapshot(projectId, 'part_added', `新增虚拟器件：${data.name || ''}（${data.moduleName || '未归类'}）`);
}
export async function updateBOMItem(id: number, quantity: number, moduleName: string, remark: string, autoSnapshot = true, extra?: { partName?: string; partModel?: string; cost?: number; mainCategory?: string; subCategory?: string }) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id FROM project_boms WHERE id = ?', [id]);
  // extra 传入时同步更新快照列（编辑 BOM 器件成本/名称时，快照优先显示会读到旧值）
  if (extra) {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=?, part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=? WHERE id=?',
      [quantity, moduleName, remark, extra.partName ?? '', extra.partModel ?? '', extra.cost ?? 0, extra.mainCategory ?? '', extra.subCategory ?? '', id]);
  } else {
    await d.execute('UPDATE project_boms SET quantity=?, module_name=?, remark=? WHERE id=?', [quantity, moduleName, remark, id]);
  }
  // 反向同步 module_items：项目页改 BOM 数量/模块后，模块库显示同一份数据
  try {
    const bom = await d.select<any[]>('SELECT part_id, module_name, part_name, part_model, part_cost, main_category, sub_category FROM project_boms WHERE id = ?', [id]).then(r => r[0]);
    if (rows[0]?.project_id && bom?.part_id) {
      await d.execute(`UPDATE module_items SET quantity=?, part_name=?, part_model=?, cost=?, main_category=?, sub_category=?
        WHERE module_id IN (SELECT id FROM modules WHERE project_id=? AND name=?)
          AND part_id=?`,
        [quantity, bom.part_name || '', bom.part_model || '', bom.part_cost || 0, bom.main_category || '', bom.sub_category || '', rows[0].project_id, bom.module_name, bom.part_id]);
    }
  } catch (e) { console.warn('updateBOMItem 同步 module_items 失败:', e); }
  if (autoSnapshot && rows[0]?.project_id) await recordProjectCostSnapshot(rows[0].project_id, 'part_changed', `调整BOM项：${moduleName || '未归类'}`);
}
export async function updateBOMRefProject(moduleName: string, projectId: number, refProjectId: number) {
  await (await getDb()).execute('UPDATE project_boms SET ref_project_id=? WHERE project_id=? AND module_name=?', [refProjectId, projectId, moduleName]);
}
export async function deleteBOMItem(id: number, autoSnapshot = true) {
  const d = await getDb();
  const rows = await d.select<any[]>('SELECT project_id, module_name, part_id FROM project_boms WHERE id = ?', [id]);
  await d.execute('UPDATE project_boms SET is_deleted = 1 WHERE id = ?', [id]);
  // 反向同步 module_items：项目页移除 BOM 行后，模块库对应器件同步删除（防止两页偏差）
  try {
    const bom = rows[0];
    if (bom?.project_id && bom?.part_id && bom?.module_name) {
      await d.execute(`DELETE FROM module_items
        WHERE module_id IN (SELECT id FROM modules WHERE project_id=? AND name=?)
          AND part_id=?`,
        [bom.project_id, bom.module_name, bom.part_id]);
    }
  } catch (e) { console.warn('deleteBOMItem 同步 module_items 失败:', e); }
  if (autoSnapshot && rows[0]?.project_id) await recordProjectCostSnapshot(rows[0].project_id, 'part_deleted', `移除器件：${rows[0].module_name || '未归类'}`);
}

// ==================== Modules ====================
export async function getModules(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM modules WHERE project_id = ? ORDER BY module_category, name', [projectId]); }
export async function getModuleItems(moduleId: number) { return (await getDb()).select<any[]>('SELECT * FROM module_items WHERE module_id = ? ORDER BY main_category, sub_category, part_name', [moduleId]); }
export async function saveModule(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE modules SET name=?, module_category=?, description=? WHERE id=?', [data.name, data.module_category || '未分类', data.description || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)', [data.project_id, data.name, data.module_category || '未分类', data.description || '']); return r.lastInsertId; }
}
export async function getModuleCategories() {
  return (await getDb()).select<{ module_category: string }[]>(
    "SELECT DISTINCT COALESCE(NULLIF(module_category, ''), '未分类') AS module_category FROM modules ORDER BY module_category"
  ).then(rows => rows.map(r => r.module_category));
}

/** 模块分类顺序（存 settings 表，JSON 数组；未设置时按分类名字母序） */
export async function getModuleCategoryOrder(): Promise<string[]> {
  const d = await getDb();
  const rows = await d.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', ['module_category_order']);
  try { const arr = JSON.parse(rows[0]?.value || '[]'); return Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []; }
  catch { return []; }
}
export async function saveModuleCategoryOrder(order: string[]) {
  await (await getDb()).execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['module_category_order', JSON.stringify(order)]);
}
export async function deleteModule(id: number) { await (await getDb()).execute('DELETE FROM modules WHERE id = ?', [id]); }
export async function updateModuleCategoryByName(name: string, category: string) {
  await (await getDb()).execute('UPDATE modules SET module_category = ? WHERE name = ?', [category || '未分类', name]);
}

/**
 * 修复 parts.projects 字段：按 project_boms 实际引用重算每个器件的关联项目代号（去重、逗号分隔）。
 * 历史数据早期导入未更新该字段，导致器件库"项目"列显示不全。幂等。
 */
export async function syncPartsProjectsField() {
  try {
    const d = await getDb();
    // 收集每个 part_id 被哪些项目引用（软删过滤）
    const rows = await d.select<any[]>(`SELECT pb.part_id, p.code FROM project_boms pb
      JOIN projects p ON pb.project_id = p.id
      WHERE pb.part_id > 0 AND COALESCE(pb.is_deleted, 0) = 0 AND COALESCE(p.is_deleted, 0) = 0
      ORDER BY pb.part_id, p.code`);
    const map: Record<number, string[]> = {};
    rows.forEach((r: any) => {
      if (!map[r.part_id]) map[r.part_id] = [];
      if (!map[r.part_id].includes(r.code)) map[r.part_id].push(r.code);
    });
    let fixed = 0;
    for (const [partId, codes] of Object.entries(map)) {
      const joined = codes.join(',');
      const cur = await d.select<any[]>('SELECT projects FROM parts WHERE id = ?', [Number(partId)]).then(r => r[0]);
      if (cur && (cur.projects || '') !== joined) {
        await d.execute('UPDATE parts SET projects = ? WHERE id = ?', [joined, Number(partId)]);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`parts.projects 字段修复完成: ${fixed} 个器件`);
  } catch (e) { console.warn('syncPartsProjectsField 失败:', e); }
}

/**
 * 从 project_boms（权威 BOM 数据源）同步缺失的模块/器件到 modules/module_items。
 * 场景：①历史种子数据直接写 project_boms 没建 modules ②项目定型时只同步 parts 没同步模块库。
 * 幂等：已存在的模块/器件不重复创建，只补齐缺失的。返回新建的模块数。
 */
export async function syncProjectModulesToLibrary() {
  const d = await getDb();
  let created = 0;
  try {
    // 所有项目去重后的模块名（来自 project_boms）
    const projRows = await d.select<any[]>(`SELECT DISTINCT project_id, module_name FROM project_boms
      WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(NULLIF(module_name, ''), '') != ''`);
    for (const row of projRows) {
      const pid = row.project_id;
      const modName = row.module_name;
      const existing = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [pid, modName]);
      let modId: number;
      if (existing.length > 0) {
        modId = existing[0].id;
      } else {
        const r = await d.execute('INSERT INTO modules (project_id, name, module_category, description) VALUES (?,?,?,?)',
          [pid, modName, '未分类', `从项目BOM自动同步`]);
        modId = r.lastInsertId!;
        created++;
      }
      // 该模块的器件（project_boms 快照列）
      const items = await d.select<any[]>(`SELECT part_id, part_name, part_model, part_cost, main_category, sub_category, quantity, remark
        FROM project_boms WHERE project_id = ? AND module_name = ? AND COALESCE(is_deleted, 0) = 0 AND part_id IS NOT NULL`,
        [pid, modName]);
      for (const it of items) {
        const dup = await d.select<any[]>('SELECT id FROM module_items WHERE module_id = ? AND part_id = ?', [modId, it.part_id]);
        if (dup.length === 0) {
          await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)',
            [modId, it.part_id, it.part_name || '', it.part_model || '', it.main_category || '硬件类', it.sub_category || '', it.part_cost ?? 0, it.quantity ?? 1, it.remark || '']);
        }
      }
    }
    if (created > 0) console.log(`模块库同步完成: 新建 ${created} 个模块`);
  } catch (e) { console.warn('syncProjectModulesToLibrary 失败:', e); }
  return created;
}
export async function saveModuleItem(data: any) {
  const d = await getDb();
  let itemId: number;
  if (data.id) { await d.execute('UPDATE module_items SET part_id=?, part_name=?, part_model=?, main_category=?, sub_category=?, cost=?, quantity=?, remark=? WHERE id=?', [data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost ?? 0, data.quantity ?? 1, data.remark || '', data.id]); itemId = data.id; }
  else { const r = await d.execute('INSERT INTO module_items (module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark) VALUES (?,?,?,?,?,?,?,?,?)', [data.module_id, data.part_id, data.part_name, data.part_model, data.main_category || '硬件类', data.sub_category || '', data.cost ?? 0, data.quantity ?? 1, data.remark || '']); itemId = r.lastInsertId!; }
  // 同步 project_boms 快照：模块库编辑器件后，项目页 BOM 显示同一份数据（防止两页偏差）
  try {
    const mod = await d.select<any[]>('SELECT project_id, name FROM modules WHERE id = ?', [data.module_id]).then(r => r[0]);
    if (mod) {
      await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=?, quantity=?, remark=?
        WHERE project_id=? AND module_name=? AND part_id=? AND COALESCE(is_deleted,0)=0`,
        [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', mod.project_id, mod.name, data.part_id]);
    }
  } catch (e) { console.warn('saveModuleItem 同步 project_boms 失败:', e); }
  return itemId;
}
export async function deleteModuleItem(id: number) {
  const d = await getDb();
  const item = await d.select<any[]>('SELECT module_id, part_id, quantity FROM module_items WHERE id = ?', [id]).then(r => r[0]);
  await d.execute('DELETE FROM module_items WHERE id = ?', [id]);
  // 同步 project_boms：模块库删除器件后，项目页 BOM 同步软删（防止两页偏差）
  try {
    if (item?.module_id && item?.part_id) {
      const mod = await d.select<any[]>('SELECT project_id, name FROM modules WHERE id = ?', [item.module_id]).then(r => r[0]);
      if (mod) {
        await d.execute(`UPDATE project_boms SET is_deleted=1
          WHERE project_id=? AND module_name=? AND part_id=? AND COALESCE(is_deleted,0)=0 AND quantity=?`,
          [mod.project_id, mod.name, item.part_id, item.quantity]);
      }
    }
  } catch (e) { console.warn('deleteModuleItem 同步 project_boms 失败:', e); }
}
export async function getModuleCost(moduleId: number) {
  const items = await getModuleItems(moduleId);
  return items.reduce((s, i) => s + (i.cost || 0) * (i.quantity || 1), 0);
}
/**
 * 模块库数据源（单一数据源 = project_boms）：
 * 返回所有项目的模块实例（每项目一个模块 = 一行），含成本/器件数/分类。
 * 模块分类取自 modules 表（有则用之，无则未分类）；模块存在与否、器件、成本全部以 project_boms 为准。
 * 这样模块库与项目管理页天然同源：任何一边改动，另一边自动反映，无需同步。
 */
export async function getLibraryModules() {
  const d = await getDb();
  const projs = await d.select<any[]>('SELECT * FROM projects WHERE COALESCE(is_deleted, 0) = 0 ORDER BY id');
  const mods = await d.select<any[]>(`SELECT m.id, m.project_id, m.name, m.module_category, m.description FROM modules m`);
  const catByKey: Record<string, string> = {};
  for (const m of mods) catByKey[`${m.project_id}|${m.name}`] = m.module_category || '未分类';
  const descByKey: Record<string, string> = {};
  for (const m of mods) descByKey[`${m.project_id}|${m.name}`] = m.description || '';

  const all: any[] = [];
  for (const p of projs) {
    // 该项目的全部 BOM 行（快照列，与项目页同一查询口径）
    const boms = await getProjectBOMs(p.id);
    // 按模块名分组
    const byMod: Record<string, any[]> = {};
    boms.forEach((b: any) => {
      const m = b.module_name || '未归类';
      if (!byMod[m]) byMod[m] = [];
      byMod[m].push(b);
    });
    for (const [modName, items] of Object.entries(byMod)) {
      // 虚拟模块过滤：空模块（成本预估占位、无器件）不进模块库
      if (items.length === 0) continue;
      const cost = items.reduce((s, b) => s + (b.part_cost || 0) * b.quantity, 0);
      const key = `${p.id}|${modName}`;
      all.push({
        // 标识用 project_id+module_name（模块库内部 id 不再依赖 modules 表）
        id: key, project_id: p.id, module_name: modName, name: modName,
        module_category: catByKey[key] || '未分类',
        description: descByKey[key] || '',
        project_code: p.code, project_name: p.name, project_type: p.project_type,
        prod_category: p.category || '未分类',
        itemCount: items.length, totalCost: cost, cost,
        items,
      });
    }
  }
  return all;
}

/** 模块库：取某项目某模块的器件明细（直接读 project_boms） */
export async function getLibraryModuleItems(projectId: number, moduleName: string) {
  const boms = await getProjectBOMs(projectId);
  return boms.filter((b: any) => (b.module_name || '未归类') === moduleName);
}

/** 模块库：编辑模块器件（更新 project_boms 快照列 + 同步 parts 器件库）——单一数据源，改这里两边都变 */
export async function updateLibraryModuleItem(bomId: number, data: any) {
  const d = await getDb();
  const bom = await d.select<any[]>('SELECT * FROM project_boms WHERE id = ?', [bomId]).then(r => r[0]);
  if (!bom) return;
  await d.execute(`UPDATE project_boms SET part_name=?, part_model=?, part_cost=?, main_category=?, sub_category=?, quantity=?, remark=? WHERE id=?`,
    [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', bomId]);
  // 同步 parts 表（器件库也更新），保证器件库/项目页/模块库三处一致
  if (bom.part_id) {
    await savePart({ id: bom.part_id, main_category: data.main_category || '硬件类', sub_category: data.sub_category || '', category: data.main_category || '硬件类', name: data.part_name, model: data.part_model || '', cost: data.cost ?? 0, specs: '', projects: '', remark: data.remark || '' }, false);
  }
  // 同步 module_items（兼容层）
  const mod = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [bom.project_id, bom.module_name]).then(r => r[0]);
  if (mod) {
    const dup = await d.select<any[]>('SELECT id FROM module_items WHERE module_id = ? AND part_id = ?', [mod.id, bom.part_id]).then(r => r[0]);
    if (dup) await d.execute('UPDATE module_items SET part_name=?, part_model=?, cost=?, main_category=?, sub_category=?, quantity=?, remark=? WHERE id=?',
      [data.part_name || '', data.part_model || '', data.cost ?? 0, data.main_category || '硬件类', data.sub_category || '', data.quantity ?? 1, data.remark || '', dup.id]);
  }
}

/** 模块库：删除模块（软删该项目该模块的全部 BOM 行 + 同步 module_items） */
export async function deleteLibraryModule(projectId: number, moduleName: string) {
  const d = await getDb();
  await d.execute('UPDATE project_boms SET is_deleted=1 WHERE project_id=? AND module_name=? AND COALESCE(is_deleted,0)=0', [projectId, moduleName]);
  const mod = await d.select<any[]>('SELECT id FROM modules WHERE project_id = ? AND name = ?', [projectId, moduleName]).then(r => r[0]);
  if (mod) await d.execute('DELETE FROM module_items WHERE module_id = ?', [mod.id]);
}

/** 模块库：模块改名（同步 project_boms 全部行 + modules 表） */
export async function renameLibraryModule(projectId: number, oldName: string, newName: string) {
  const d = await getDb();
  await d.execute('UPDATE project_boms SET module_name=? WHERE project_id=? AND module_name=?', [newName, projectId, oldName]);
  await d.execute('UPDATE modules SET name=? WHERE project_id=? AND name=?', [newName, projectId, oldName]);
}

export async function getProjectModuleSummary(projectId: number) {
  const d = await getDb();
  const boms = await d.select<any[]>(`SELECT pb.module_name, pb.quantity, CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?`, [projectId]);
  const map: Record<string, number> = {};
  boms.forEach(b => {
    const m = b.module_name || '未归类';
    map[m] = (map[m] || 0) + (b.cost || 0) * (b.quantity || 1);
  });
  return Object.entries(map).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }));
}

// ==================== Competitors ====================
export async function getCompetitors(category = '') {
  const d = await getDb();
  let q = 'SELECT * FROM competitors'; const p: any[] = [];
  if (category) { q += ' WHERE category = ?'; p.push(category); }
  q += ' ORDER BY COALESCE(sort_order, 0), created_at DESC';
  return d.select<any[]>(q, p);
}
export async function getCompetitor(id: number) { const r = await (await getDb()).select<any[]>('SELECT * FROM competitors WHERE id = ?', [id]); return r[0] || null; }
export async function saveCompetitor(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitors SET brand=?,model=?,tier=?,category=?,market_price=?,bom_cost=?,platform_fee_rate=?,remark=? WHERE id=?', [data.brand, data.model, data.tier, data.category || '未分类', data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitors (brand,model,tier,category,market_price,bom_cost,platform_fee_rate,remark) VALUES (?,?,?,?,?,?,?,?)', [data.brand, data.model, data.tier, data.category || '未分类', data.market_price || 0, data.bom_cost || 0, data.platform_fee_rate || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitor(id: number) {
  const d = await getDb();
  // 级联清理竞品 BOM（避免孤儿行）
  await d.execute('DELETE FROM competitor_boms WHERE competitor_id = ?', [id]);
  await d.execute('DELETE FROM competitors WHERE id = ?', [id]);
}
export async function getCompetitorBOMs(competitorId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM competitor_boms WHERE competitor_id = ? ORDER BY module_name, part_name', [competitorId]);
}
export async function addCompetitorBOMItem(competitorId: number, partName: string, partModel = '', estimatedCost = 0, quantity = 1, moduleName = '', ourPartName = '', ourPartModel = '', ourCost = 0, ourQuantity = 0) {
  await (await getDb()).execute('INSERT INTO competitor_boms (competitor_id, part_name, part_model, estimated_cost, quantity, module_name, our_part_name, our_part_model, our_cost, our_quantity) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [competitorId, partName, partModel, estimatedCost, quantity, moduleName, ourPartName, ourPartModel, ourCost, ourQuantity]);
}
export async function updateCompetitorBOMItem(id: number, partName: string, partModel: string, estimatedCost: number, quantity: number, moduleName: string) {
  await (await getDb()).execute('UPDATE competitor_boms SET part_name=?, part_model=?, estimated_cost=?, quantity=?, module_name=? WHERE id=?',
    [partName, partModel, estimatedCost, quantity, moduleName, id]);
}
export async function deleteCompetitorBOMItem(id: number) { await (await getDb()).execute('DELETE FROM competitor_boms WHERE id = ?', [id]); }
export async function getCompetitorParts() { return (await getDb()).select<any[]>('SELECT * FROM competitor_parts ORDER BY main_category, category, name'); }
export async function saveCompetitorPart(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE competitor_parts SET main_category=?,sub_category=?,category=?,name=?,model=?,cost=?,specs=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO competitor_parts (main_category,sub_category,category,name,model,cost,specs,remark) VALUES (?,?,?,?,?,?,?,?)', [data.main_category || '硬件类', data.sub_category || '', data.category, data.name, data.model, data.cost || 0, data.specs || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCompetitorPart(id: number) { await (await getDb()).execute('DELETE FROM competitor_parts WHERE id = ?', [id]); }

// ==================== Product Features & Scores (Radar) ====================
// type: 不传=全部；'custom'=用户自定义（旧对比雷达）；'radar'=竞争力雷达固定五维
export async function getFeatures(type?: string) {
  if (type) return (await getDb()).select<any[]>('SELECT * FROM product_features WHERE type = ? ORDER BY id', [type]);
  return (await getDb()).select<any[]>('SELECT * FROM product_features ORDER BY id');
}
export async function saveFeature(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE product_features SET name=?, weight=? WHERE id=?', [data.name, data.weight || 1, data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO product_features (name, weight) VALUES (?,?)', [data.name, data.weight || 1]); return r.lastInsertId; }
}
export async function deleteFeature(id: number) { await (await getDb()).execute('DELETE FROM product_features WHERE id = ?', [id]); }
export async function getScores(refType: string, refId: number) {
  const d = await getDb();
  const scores = await d.select<any[]>('SELECT * FROM product_scores WHERE ref_type = ? AND ref_id = ?', [refType, refId]);
  const map: Record<number, number> = {};
  scores.forEach(s => { map[s.feature_id] = s.score; });
  return map;
}
export async function saveScore(refType: string, refId: number, featureId: number, score: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT id FROM product_scores WHERE ref_type = ? AND ref_id = ? AND feature_id = ?', [refType, refId, featureId]);
  if (existing.length > 0) {
    await d.execute('UPDATE product_scores SET score = ? WHERE id = ?', [score, existing[0].id]);
  } else {
    await d.execute('INSERT INTO product_scores (ref_type, ref_id, feature_id, score) VALUES (?,?,?,?)', [refType, refId, featureId, score]);
  }
}
export async function getAllScoresForRefs(refType: string, refIds: number[]) {
  const d = await getDb();
  if (refIds.length === 0) return {} as Record<number, Record<number, number>>;
  const scores = await d.select<any[]>(`SELECT * FROM product_scores WHERE ref_type = ? AND ref_id IN (${refIds.map(() => '?').join(',')})`, [refType, ...refIds]);
  const result: Record<number, Record<number, number>> = {};
  scores.forEach(s => {
    if (!result[s.ref_id]) result[s.ref_id] = {};
    result[s.ref_id][s.feature_id] = s.score;
  });
  return result;
}

// ==================== 模块-特性关联（竞争力雷达）====================
// 模块名 → 特性（多对多，同名模块全局一致）；模块名以 project_boms 为准（与模块库单一数据源一致）
// 返回 [{ name, total }]：所有出现过且未删除的模块名，按 BOM 成本聚合降序（先配置成本高的）
export async function getModuleNames() {
  return (await getDb()).select<any[]>(`SELECT pb.module_name as name,
    SUM((CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END) * pb.quantity) as total
    FROM project_boms pb LEFT JOIN parts p ON pb.part_id = p.id
    WHERE pb.is_deleted = 0 AND pb.module_name != ''
    GROUP BY pb.module_name ORDER BY total DESC`);
}
// 全量关联：{ module_name: feature_id[] }
export async function getModuleFeatureLinks() {
  const rows = await (await getDb()).select<any[]>('SELECT module_name, feature_id FROM module_feature_links');
  const map: Record<string, number[]> = {};
  rows.forEach((r: any) => { (map[r.module_name] = map[r.module_name] || []).push(r.feature_id); });
  return map;
}
// 保存某模块的关联（先删后插，featureIds 传空数组 = 清空该模块关联）
export async function setModuleFeatureLinks(moduleName: string, featureIds: number[]) {
  const d = await getDb();
  await d.execute('DELETE FROM module_feature_links WHERE module_name = ?', [moduleName]);
  for (const fid of featureIds) {
    await d.execute('INSERT INTO module_feature_links (module_name, feature_id) VALUES (?,?)', [moduleName, fid]);
  }
}

// ==================== SKU 变体（基座项目 + 差异规则）====================
// SKU 不落完整 BOM，只存差异规则（add 加器件 / remove 减基座器件 / replace 换型号单价）
// SKU 成本 = 基座 BOM 成本 + Σ差异 → 基座变则 SKU 自动重算
export async function getSkus(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM project_skus WHERE project_id = ? ORDER BY id', [projectId]);
}
// 全部 SKU（品类→项目→SKU 树用）
export async function getAllSkus() {
  return (await getDb()).select<any[]>('SELECT * FROM project_skus ORDER BY project_id, id');
}
export async function saveSku(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE project_skus SET sku_code=?, sku_name=?, spec_desc=?, remark=? WHERE id=?',
      [data.sku_code, data.sku_name || '', data.spec_desc || '', data.remark || '', data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO project_skus (project_id, sku_code, sku_name, spec_desc, remark) VALUES (?,?,?,?,?)',
    [data.project_id, data.sku_code, data.sku_name || '', data.spec_desc || '', data.remark || '']);
  return r.lastInsertId;
}
export async function deleteSku(id: number) {
  const d = await getDb();
  await d.execute('DELETE FROM sku_diffs WHERE sku_id = ?', [id]);
  await d.execute('DELETE FROM project_skus WHERE id = ?', [id]);
}
export async function getSkuDiffs(skuId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM sku_diffs WHERE sku_id = ? ORDER BY id', [skuId]);
}
export async function saveSkuDiff(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute('UPDATE sku_diffs SET diff_type=?, module_name=?, part_name=?, part_model=?, quantity=?, unit_cost=?, remark=? WHERE id=?',
      [data.diff_type, data.module_name || '', data.part_name || '', data.part_model || '', data.quantity ?? 1, data.unit_cost || 0, data.remark || '', data.id]);
    return data.id;
  }
  const r = await d.execute('INSERT INTO sku_diffs (sku_id, diff_type, module_name, part_name, part_model, quantity, unit_cost, remark) VALUES (?,?,?,?,?,?,?,?)',
    [data.sku_id, data.diff_type, data.module_name || '', data.part_name || '', data.part_model || '', data.quantity ?? 1, data.unit_cost || 0, data.remark || '']);
  return r.lastInsertId;
}
export async function deleteSkuDiff(id: number) { await (await getDb()).execute('DELETE FROM sku_diffs WHERE id = ?', [id]); }
// 批量取多个 SKU 的差异（SKU 列表成本计算用）
export async function getAllSkuDiffs(skuIds: number[]) {
  const d = await getDb();
  if (skuIds.length === 0) return {} as Record<number, any[]>;
  const rows = await d.select<any[]>(`SELECT * FROM sku_diffs WHERE sku_id IN (${skuIds.map(() => '?').join(',')}) ORDER BY id`, skuIds);
  const map: Record<number, any[]> = {};
  rows.forEach(r => { (map[r.sku_id] = map[r.sku_id] || []).push(r); });
  return map;
}

// ==================== 器件报价比对：别名沉淀 + 识别缓存 ====================
// 名称归一化：trim + 全角→半角 + 小写 + 去空格/下划线/横线/斜杠（"DRV-100" = "DRV 100"）
export function normalizePartName(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s_\-/\\]+/g, '');
}
// 别名记录：module_name 作用域（空=全局）；source: user_confirmed=确认同一 / marked_different=标记不同（否定）
export async function getPartAliases(moduleName?: string) {
  const d = await getDb();
  if (moduleName) return d.select<any[]>('SELECT * FROM part_aliases WHERE module_name = ? OR module_name = \'\'', [moduleName]);
  return d.select<any[]>('SELECT * FROM part_aliases');
}
export async function savePartAlias(data: any) {
  await (await getDb()).execute('INSERT INTO part_aliases (module_name, alias_name, alias_model, canonical_name, canonical_model, main_category, sub_category, source) VALUES (?,?,?,?,?,?,?,?)',
    [data.module_name || '', data.alias_name, data.alias_model || '', data.canonical_name, data.canonical_model || '', data.main_category || '', data.sub_category || '', data.source || 'user_confirmed']);
}
export async function deletePartAlias(id: number) { await (await getDb()).execute('DELETE FROM part_aliases WHERE id = ?', [id]); }
// 识别缓存：按 品类+模块 唯一，指纹相同不重复识别
export async function getCompareCache(category: string, moduleName: string) {
  const r = await (await getDb()).select<any[]>('SELECT * FROM part_compare_cache WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  return r[0] || null;
}
export async function saveCompareCache(category: string, moduleName: string, fingerprint: string, resultJson: string) {
  const d = await getDb();
  await d.execute('DELETE FROM part_compare_cache WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  await d.execute('INSERT INTO part_compare_cache (category, module_name, fingerprint, result_json, identified_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))',
    [category || '', moduleName, fingerprint, resultJson]);
}
// 差异情报（后台自动识别产生，未读提醒）
// 内容与上次相同 → 保持原状态（已读不被重置）；内容变化 → 重置 unread（新情报）
export async function upsertInsight(category: string, moduleName: string, insightJson: string) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT insight_json FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  if (old[0] && old[0].insight_json === insightJson) return;
  await d.execute('DELETE FROM part_insights WHERE category = ? AND module_name = ?', [category || '', moduleName]);
  await d.execute("INSERT INTO part_insights (category, module_name, insight_json, status) VALUES (?,?,?,'unread')", [category || '', moduleName, insightJson]);
}
export async function getInsights() {
  return (await getDb()).select<any[]>('SELECT * FROM part_insights ORDER BY created_at DESC');
}
export async function getUnreadInsightCount() {
  const r = await (await getDb()).select<any[]>("SELECT COUNT(*) as c FROM part_insights WHERE status = 'unread'");
  return r[0]?.c || 0;
}
export async function markInsightRead(category: string, moduleName: string) {
  await (await getDb()).execute("UPDATE part_insights SET status = 'read' WHERE category = ? AND module_name = ?", [category || '', moduleName]);
}

// ==================== settings 读写（本地 AI / 演示生成共用） ====================
export async function getSetting(key: string, def = '') {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows[0]?.value || def;
}
export async function setSetting(key: string, value: string) {
  const db = await getDb();
  await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ==================== 本地知识条目 / 习惯库（local_ai_context）====================
// 演示生成的习惯库与本地 AI 助手共用：分类 category（'general' 默认 / 可自定义，如 演示结构/风格描述/素材模板）
export async function loadContextEntries() {
  return (await getDb()).select<any[]>('SELECT * FROM local_ai_context ORDER BY updated_at DESC');
}
export async function saveContextEntry(key: string, title: string, content: string, category = 'general') {
  await (await getDb()).execute("INSERT OR REPLACE INTO local_ai_context (key,title,content,category,updated_at) VALUES (?,?,?,?,datetime('now','localtime'))", [key, title, content, category]);
}
export async function deleteContextEntry(key: string) {
  await (await getDb()).execute("DELETE FROM local_ai_context WHERE key=?", [key]);
}

// ==================== Cost Reviews & Measures ====================
export async function getCostReviews(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_cost_reviews WHERE project_id = ? ORDER BY reviewed_at DESC', [projectId]); }
export async function saveCostReview(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_cost_reviews SET stage=?, reviewed_cost=?, reviewer=?, remark=? WHERE id=?', [data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_cost_reviews (project_id, stage, reviewed_cost, reviewer, remark) VALUES (?,?,?,?,?)', [data.project_id, data.stage, data.reviewed_cost, data.reviewer || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteCostReview(id: number) { await (await getDb()).execute('DELETE FROM project_cost_reviews WHERE id = ?', [id]); }
export async function getMeasures(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_measures WHERE project_id = ? ORDER BY created_at DESC', [projectId]); }
export async function saveMeasure(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_measures SET main_category=?,measure=?,status=?,due_date=?,owner=?,remark=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_measures (project_id, main_category, measure, status, due_date, owner, remark) VALUES (?,?,?,?,?,?,?)', [data.project_id, data.main_category, data.measure, data.status, data.due_date || '', data.owner || '', data.remark || '']); return r.lastInsertId; }
}
export async function deleteMeasure(id: number) { await (await getDb()).execute('DELETE FROM project_measures WHERE id = ?', [id]); }

// ==================== Project Targets ====================
export async function getTargets(projectId: number) { return (await getDb()).select<any[]>('SELECT * FROM project_targets WHERE project_id = ? ORDER BY domain', [projectId]); }
export async function saveTarget(data: any) {
  const d = await getDb();
  if (data.id) { await d.execute('UPDATE project_targets SET domain=?, target_cost=?, remark=? WHERE id=?', [data.domain, data.target_cost || 0, data.remark || '', data.id]); return data.id; }
  else { const r = await d.execute('INSERT INTO project_targets (project_id, domain, target_cost, remark) VALUES (?,?,?,?)', [data.project_id, data.domain, data.target_cost || 0, data.remark || '']); return r.lastInsertId; }
}
export async function deleteTarget(id: number) { await (await getDb()).execute('DELETE FROM project_targets WHERE id = ?', [id]); }

// ==================== Dashboard ====================
export async function getDashboardStats() {
  const d = await getDb();
  const totalParts = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM projects WHERE COALESCE(is_deleted, 0) = 0'))[0].c;
  const activeProjects = (await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中' AND COALESCE(is_deleted, 0) = 0"))[0].c;
  const totalCompetitors = (await d.select<{ c: number }[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const projects = await d.select<{ id: number }[]>('SELECT id FROM projects WHERE COALESCE(is_deleted, 0) = 0');
  let totalCost = 0;
  for (const p of projects) {
    const boms = await d.select<{ quantity: number; cost: number }[]>('SELECT pb.quantity, CASE WHEN pb.part_cost > 0 THEN pb.part_cost ELSE p.cost END as cost FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE pb.project_id = ?', [p.id]);
    totalCost += boms.reduce((s, b) => s + b.quantity * b.cost, 0);
  }
  const avgBomCost = projects.length > 0 ? Math.round(totalCost / projects.length * 100) / 100 : 0;
  const catDist = await d.select<{ main_category: string; c: number }[]>('SELECT main_category, COUNT(*) as c FROM parts GROUP BY main_category ORDER BY c DESC');
  const recentParts = await d.select<any[]>('SELECT * FROM parts ORDER BY updated_at DESC LIMIT 5');
  return { total_parts: totalParts, total_projects: totalProjects, active_projects: activeProjects, total_competitors: totalCompetitors, avg_bom_cost: avgBomCost, category_distribution: catDist.map(r => ({ category: r.main_category, count: r.c })), recent_parts: recentParts };
}

// ==================== Trend Tracking ====================
export { getDb };

export async function getTrendItem(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function getTrendItemByCategory(category: string, categoryType: string) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_items WHERE query_category = ? AND category_type = ?', [category, categoryType]).then(r => r[0] || null);
}

export async function getTrendItemsWithDetails() {
  const items = await (await getDb()).select<any[]>('SELECT * FROM trend_items ORDER BY query_category');
  const result = [];
  for (const item of items) {
    const mappedParts = await (await getDb()).select<any[]>('SELECT p.* FROM parts p JOIN trend_part_mapping tpm ON p.id = tpm.part_id WHERE tpm.trend_item_id = ?', [item.id]);
    result.push({ ...item, mapped_parts: mappedParts });
  }
  return result;
}

// ====== 快捷洞察（无需分解树，直接洞察单个物料行情，如"锂电池"） ======
export async function getQuickTrendItems() {
  // 确保旧库补齐缺失列（首次升级时兜底，幂等）
  try {
    await (await getDb()).execute("ALTER TABLE trend_items ADD COLUMN source_type TEXT DEFAULT 'decomposition'");
  } catch { /* 列已存在则忽略 */ }
  try {
    await (await getDb()).execute("ALTER TABLE trend_items ADD COLUMN last_queried_at TEXT DEFAULT ''");
  } catch { /* 列已存在则忽略 */ }
  return (await getDb()).select<any[]>(
    "SELECT * FROM trend_items WHERE source_type = 'quick' ORDER BY last_queried_at DESC, id DESC"
  );
}

export async function saveQuickTrendItem(data: { material_name: string; category_type?: string }) {
  const d = await getDb();
  const r = await d.execute(
    "INSERT INTO trend_items (query_category, category_type, source_type, last_queried_at) VALUES (?,?,?,?)",
    [data.material_name, data.category_type || '直接查询', 'quick', localNow()]
  );
  return r.lastInsertId;
}

export async function deleteQuickTrendItem(id: number) {
  await (await getDb()).execute('DELETE FROM trend_items WHERE id = ?', [id]);
}

export async function saveTrendItem(data: any) {
  const d = await getDb();
  // 字段口径统一：material_name（关注物料/快捷洞察入口传入）→ query_category
  const category = data.query_category ?? data.material_name ?? '';
  const sourceType = data.source_type || 'decomposition';
  const lastQueried = data.last_queried_at || data.last_updated_at || '';
  if (data.id) {
    await d.execute(
      'UPDATE trend_items SET query_category=?, category_type=?, trend_direction=?, confidence_level=?, summary=?, suggested_action=?, raw_search_results=?, last_updated_at=?, magnitude_min=?, magnitude_max=?, magnitude_reference=?, source_type=?, last_queried_at=? WHERE id=?',
      [category, data.category_type, data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, sourceType, lastQueried, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO trend_items (query_category, category_type, trend_direction, confidence_level, summary, suggested_action, raw_search_results, last_updated_at, magnitude_min, magnitude_max, magnitude_reference, source_type, last_queried_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [category, data.category_type || '直接查询', data.trend_direction, data.confidence_level, data.summary, data.suggested_action, data.raw_search_results, data.last_updated_at, data.magnitude_min, data.magnitude_max, data.magnitude_reference, sourceType, lastQueried]
    );
    return r.lastInsertId;
  }
}

export async function deleteTrendItem(id: number) {
  await (await getDb()).execute('DELETE FROM trend_items WHERE id = ?', [id]);
}

export async function addTrendMapping(trendItemId: number, partId: number) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM trend_part_mapping WHERE trend_item_id = ? AND part_id = ?', [trendItemId, partId]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO trend_part_mapping (trend_item_id, part_id) VALUES (?,?)', [trendItemId, partId]);
  }
}

export async function getTrendSources(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_sources WHERE trend_item_id = ? ORDER BY id', [trendItemId]);
}

export async function saveTrendSource(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_sources (trend_item_id, source_title, source_url, excerpt) VALUES (?,?,?,?)',
    [data.trend_item_id, data.source_title, data.source_url, data.excerpt]
  );
  return r.lastInsertId;
}

export async function clearTrendSources(trendItemId: number) {
  await (await getDb()).execute('DELETE FROM trend_sources WHERE trend_item_id = ?', [trendItemId]);
}

export async function getTrendConversations(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_conversations WHERE trend_item_id = ? ORDER BY created_at', [trendItemId]);
}

export async function saveTrendConversation(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_conversations (trend_item_id, question, answer, created_at) VALUES (?,?,?,datetime(\'now\',\'localtime\'))',
    [data.trend_item_id, data.question, data.answer]
  );
  return r.lastInsertId;
}

export async function getTrendSnapshots(trendItemId: number) {
  // 按 id DESC 排序（自增 id 单调递增，不受 query_time 字符串格式混排影响——旧数据是 ISO UTC 格式，新数据是本地时间格式，字符串排序会错乱）
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY id DESC', [trendItemId]);
}

export async function getLatestTrendSnapshot(trendItemId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_snapshots WHERE trend_item_id = ? ORDER BY id DESC LIMIT 1', [trendItemId]).then(r => r[0] || null);
}

// 生成与 SQLite datetime('now','localtime') 一致的本地时间字符串（YYYY-MM-DD HH:MM:SS）
function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function saveTrendSnapshot(data: any) {
  const d = await getDb();
  const confidenceLevel = data.confidence_level ?? data.confidence ?? '';
  const r = await d.execute(
    'INSERT INTO trend_snapshots (trend_item_id, query_time, source_type, direction, confidence, confidence_level, summary, suggested_action, skill_used, magnitude_min, magnitude_max, magnitude_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [data.trend_item_id, data.query_time ?? localNow(), data.source_type || 'direct_query', data.direction, confidenceLevel, confidenceLevel, data.summary, data.suggested_action, data.skill_used, data.magnitude_min, data.magnitude_max, data.magnitude_reference]
  );
  return r.lastInsertId;
}

export async function getTrendInsightDimensions(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_insight_dimensions WHERE trend_snapshot_id = ? ORDER BY dimension_order', [snapshotId]);
}

// 删除单个洞察快照（含关联的维度/关键事件；保留 trend_item 本身）
export async function deleteTrendSnapshot(snapshotId: number) {
  const d = await getDb();
  await d.execute('DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id = ?', [snapshotId]);
  await d.execute('DELETE FROM trend_key_events WHERE trend_snapshot_id = ?', [snapshotId]);
  await d.execute('DELETE FROM trend_snapshots WHERE id = ?', [snapshotId]);
}

export async function saveTrendInsightDimensions(snapshotId: number, dimensions: any[]) {
  const d = await getDb();
  await d.execute('DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id = ?', [snapshotId]);
  for (const dim of dimensions) {
    await d.execute(
      'INSERT INTO trend_insight_dimensions (trend_snapshot_id, dimension_type, dimension_order, content, evidence_strength, data_points, source_title, source_url) VALUES (?,?,?,?,?,?,?,?)',
      [snapshotId, dim.dimension_type, dim.dimension_order, dim.content || dim.observation, dim.evidence_strength, dim.data_points, dim.source_title, dim.source_url]
    );
  }
}

export async function getTrendKeyEvents(snapshotId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM trend_key_events WHERE trend_snapshot_id = ? ORDER BY event_date DESC', [snapshotId]);
}

export async function saveTrendKeyEvent(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO trend_key_events (trend_snapshot_id, event_date, event_description, impact_direction, source_title, source_url) VALUES (?,?,?,?,?,?)',
    [data.trend_snapshot_id, data.event_date || data.event_time, data.event_description, data.impact_direction || data.impact_level, data.source_title, data.source_url]
  );
  return r.lastInsertId;
}

export async function getMaterialCategories() {
  return (await getDb()).select<any[]>('SELECT * FROM material_categories ORDER BY category_name');
}

export async function addMaterialCategory(categoryName: string) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT * FROM material_categories WHERE category_name = ?', [categoryName]);
  if (existing.length === 0) {
    await d.execute('INSERT INTO material_categories (category_name) VALUES (?)', [categoryName]);
  }
}

export async function removeMaterialCategory(categoryName: string) {
  await (await getDb()).execute('DELETE FROM material_categories WHERE category_name = ?', [categoryName]);
}

// ==================== API Providers (compat exports used by Settings) ====================
export const PRESET_PROVIDERS = PRESET_PROVIDER_TEMPLATES;

export async function ensurePresetProviders() {
  const d = await getDb();
  try {
    await d.execute(`
      DELETE FROM api_providers
      WHERE is_preset = 1
        AND IFNULL(api_key, '') = ''
        AND EXISTS (
          SELECT 1 FROM api_providers q
          WHERE q.provider_type = api_providers.provider_type
            AND q.provider_name = api_providers.provider_name
            AND q.id <> api_providers.id
            AND (IFNULL(q.api_key, '') <> '' OR q.id < api_providers.id)
        )
    `);
  } catch {}
  let priority = 20;
  for (const preset of PRESET_PROVIDER_TEMPLATES) {
    await d.execute(
      `INSERT INTO api_providers
        (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url)
       SELECT ?,?,?,?,?,0,?,1,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM api_providers
         WHERE provider_type = ? AND provider_name = ?
       )`,
      [
        preset.provider_type, preset.provider_name, '', preset.base_url || '', (preset as any).model_name || '', priority++, preset.monthly_quota_note || '', preset.registration_url || '',
        preset.provider_type, preset.provider_name,
      ]
    );
  }
}

export async function getApiProviders() {
  return getAllApiProviders();
}

export async function saveApiProvider(data: any) {
  const normalized = {
    ...data,
    is_active: data.is_active ?? data.enabled ?? 0,
    is_preset: data.is_preset ?? 0,
    base_url: data.base_url || '',
    model_name: data.model_name || '',
    monthly_quota_note: data.monthly_quota_note || '',
    registration_url: data.registration_url || '',
  };
  if (data.id) {
    return updateApiProvider(normalized);
  }
  return addApiProvider(normalized);
}

export async function deleteApiProvider(id: number) {
  await (await getDb()).execute('DELETE FROM api_providers WHERE id = ?', [id]);
}

export async function setActiveProvider(providerType: string, providerId: number) {
  const d = await getDb();
  await d.execute('UPDATE api_providers SET is_active = 0 WHERE provider_type = ?', [providerType]);
  await d.execute('UPDATE api_providers SET is_active = 1 WHERE id = ?', [providerId]);
}

export async function updateProviderPriorities(providers: any[]) {
  const d = await getDb();
  for (let index = 0; index < providers.length; index++) {
    const item = providers[index];
    const id = typeof item === 'number' ? item : item.id;
    const priority = typeof item === 'number' ? index + 1 : (item.priority ?? index + 1);
    if (id != null) await d.execute('UPDATE api_providers SET priority = ? WHERE id = ?', [priority, id]);
  }
}

export async function getOutboundRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>('SELECT * FROM outbound_request_logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

export async function clearOutboundRequestLogs() {
  await (await getDb()).execute('DELETE FROM outbound_request_logs');
}

export async function logOutboundRequest(data: any) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO outbound_request_logs (timestamp, method, url, status_code, response_time_ms, error_message) VALUES (datetime(\'now\',\'localtime\'),?,?,?,?,?)',
    [data.method, data.url, data.status_code, data.response_time_ms, data.error_message]
  );
}

// ==================== Decomposition ====================
export async function getAllDecompositionNodes() {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree ORDER BY root_part_id, parent_id');
}

export async function getDecompositionTree(rootPartId: number) {
  const d = await getDb();
  const nodes = await d.select<any[]>('SELECT * FROM decomposition_tree WHERE root_part_id = ?', [rootPartId]);
  return nodes;
}

export async function getDecompositionNode(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE id = ?', [id]).then(r => r[0] || null);
}

export async function saveDecompositionNode(data: any) {
  const d = await getDb();
  const parentId = data.parent_id ?? null;
  let rootPartId = data.root_part_id ?? null;
  if (parentId && !rootPartId) {
    const parent = await d.select<any[]>('SELECT root_part_id FROM decomposition_tree WHERE id = ?', [parentId]);
    rootPartId = parent[0]?.root_part_id || parentId;
  }
  if (data.id) {
    await d.execute(
      'UPDATE decomposition_tree SET root_part_id=?, parent_id=?, component_name=?, cost_ratio_estimate=?, source_type=?, node_type=?, insight_status=?, trend_item_id=?, remark=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
      [rootPartId || data.id, parentId, data.component_name || data.node_name || '', data.cost_ratio_estimate ?? null, data.source_type || 'user_confirmed', data.node_type || 'structural', data.insight_status || 'pending', data.trend_item_id ?? null, data.remark || '', data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO decomposition_tree (root_part_id, parent_id, component_name, cost_ratio_estimate, source_type, node_type, insight_status, trend_item_id, remark, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'),datetime(\'now\',\'localtime\'))',
      [rootPartId, parentId, data.component_name || data.node_name || '', data.cost_ratio_estimate ?? null, data.source_type || 'user_confirmed', data.node_type || 'structural', data.insight_status || 'pending', data.trend_item_id ?? null, data.remark || '']
    );
    if (!rootPartId) await d.execute('UPDATE decomposition_tree SET root_part_id = ? WHERE id = ?', [r.lastInsertId, r.lastInsertId]);
    return r.lastInsertId;
  }
}

export async function deleteDecompositionNode(id: number) {
  await (await getDb()).execute(
    'WITH RECURSIVE descendants(id) AS (SELECT id FROM decomposition_tree WHERE id = ? UNION ALL SELECT dt.id FROM decomposition_tree dt JOIN descendants d ON dt.parent_id = d.id) DELETE FROM decomposition_tree WHERE id IN (SELECT id FROM descendants)',
    [id]
  );
}

export async function getDecompositionHistory(rootPartId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_history WHERE root_part_id = ? ORDER BY timestamp DESC', [rootPartId]);
}

export async function searchDecompositionNodes(query: string) {
  return (await getDb()).select<any[]>('SELECT * FROM decomposition_tree WHERE component_name LIKE ? ORDER BY id', [`%${query}%`]);
}

export async function saveRollupContribution(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_contributions (parent_snapshot_id, child_component_id, cost_ratio_used, direction_used, created_at) VALUES (?,?,?,?,datetime(\'now\',\'localtime\'))',
    [data.parent_snapshot_id, data.child_component_id, data.cost_ratio_used ?? null, data.direction_used || '']
  );
  return r.lastInsertId;
}

export async function saveRollupFeedback(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO rollup_feedback (component_id, component_name, ai_direction, ai_summary, ai_confidence_level, user_corrected_direction, user_corrected_confidence_level, correction_reason, user_corrected_summary, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))',
    [data.component_id, data.component_name || '', data.ai_direction || '', data.ai_summary || '', data.ai_confidence_level || '', data.user_corrected_direction || '', data.user_corrected_confidence_level || '', data.correction_reason || data.user_reason || '', data.user_corrected_summary || '']
  );
  return r.lastInsertId;
}

// ==================== Analysis Checklist ====================
export async function getAllChecklistWithLogs() {
  const d = await getDb();
  const items = await d.select<any[]>('SELECT * FROM analysis_checklist ORDER BY category, check_order');
  const logs = await d.select<any[]>('SELECT * FROM checklist_logs ORDER BY created_at DESC LIMIT 1000');
  const logMap: Record<number, any[]> = {};
  for (const log of logs) {
    const id = log.checklist_id;
    if (!logMap[id]) logMap[id] = [];
    logMap[id].push(log);
  }
  return {
    items: items.map((item: any) => ({ ...item, trigger_logs: logMap[item.id] || [] })),
    logs,
  };
}

export async function updateChecklistActive(id: number, active: boolean) {
  await (await getDb()).execute('UPDATE analysis_checklist SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

export async function deleteAnalysisChecklistItem(id: number) {
  await (await getDb()).execute('DELETE FROM analysis_checklist WHERE id = ?', [id]);
}

export async function getRollupContributions(projectId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_contributions WHERE parent_snapshot_id = ?', [projectId]);
}

export async function getAllRollupFeedback() {
  return (await getDb()).select<any[]>('SELECT * FROM rollup_feedback ORDER BY created_at DESC');
}

// ==================== Part Suppliers ====================
export async function getAllPartSuppliers() {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers ORDER BY part_id, id DESC');
}

export async function getPartSuppliers(partId: number) {
  return (await getDb()).select<any[]>('SELECT * FROM part_suppliers WHERE part_id = ? ORDER BY id DESC', [partId]);
}

// ==================== 供应商档案（含Logo） ====================
export async function getSupplierProfiles() {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles ORDER BY supplier_name');
}
export async function getSupplierProfile(name: string) {
  return (await getDb()).select<any[]>('SELECT * FROM supplier_profiles WHERE supplier_name=?', [name]).then(r => r[0] || null);
}
export async function saveSupplierProfile(data: any) {
  const d = await getDb();
  const existing = await d.select<any[]>('SELECT id FROM supplier_profiles WHERE supplier_name=?', [data.supplier_name]);
  if (existing.length) {
    await d.execute(
      "UPDATE supplier_profiles SET logo=?, category=?, contact=?, phone=?, rating=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.logo || '', data.category || '', data.contact || '', data.phone || '', data.rating || 0, data.remark || '', existing[0].id]
    );
    return existing[0].id;
  } else {
    const r = await d.execute(
      'INSERT INTO supplier_profiles (supplier_name, logo, category, contact, phone, rating, remark) VALUES (?,?,?,?,?,?,?)',
      [data.supplier_name, data.logo || '', data.category || '', data.contact || '', data.phone || '', data.rating || 0, data.remark || '']
    );
    return r.lastInsertId;
  }
}
export async function deleteSupplierProfile(id: number) {
  await (await getDb()).execute('DELETE FROM supplier_profiles WHERE id=?', [id]);
}

export async function addPartSupplier(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO part_suppliers (part_id, supplier_name, price, share_ratio, is_active, remark) VALUES (?,?,?,?,?,?)',
    [data.part_id, data.supplier_name, data.price || 0, data.share_ratio || 0, data.is_active ?? 1, data.remark || '']
  );

  // 更新器件加权成本
  await updatePartWeightedCost(data.part_id);

  return r.lastInsertId;
}

export async function updatePartSupplier(data: any) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT * FROM part_suppliers WHERE id = ?', [data.id]);
  const price = data.price || 0;
  const oldPrice = old[0]?.price || 0;

  // 价格变动时记录历史（统一写入 part_supplier_price_history，按 part_id+supplier_name 检索）
  if (old[0] && Math.abs(oldPrice - price) > 0.0001) {
    await d.execute(
      'INSERT INTO part_supplier_price_history (part_id, supplier_name, old_price, new_price, change_reason, changed_at) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'))',
      [data.part_id ?? old[0].part_id, data.supplier_name ?? old[0].supplier_name, oldPrice, price, data.change_reason || '手动更新']
    );
  }

  await d.execute(
    'UPDATE part_suppliers SET supplier_name=?, price=?, share_ratio=?, is_active=?, remark=? WHERE id=?',
    [data.supplier_name, price, data.share_ratio || 0, data.is_active ?? 1, data.remark || '', data.id]
  );

  // 更新器件加权成本
  await updatePartWeightedCost(data.part_id ?? old[0]?.part_id);

  return data.id;
}

export async function deletePartSupplier(id: number) {
  const d = await getDb();
  const old = await d.select<any[]>('SELECT part_id FROM part_suppliers WHERE id = ?', [id]);
  await d.execute('DELETE FROM part_suppliers WHERE id = ?', [id]);

  // 删除后更新器件加权成本
  if (old[0]?.part_id) {
    await updatePartWeightedCost(old[0].part_id);
  }
}

// 更新器件的加权成本
async function updatePartWeightedCost(partId: number) {
  const d = await getDb();
  const suppliers = await d.select<any[]>(
    'SELECT price, share_ratio FROM part_suppliers WHERE part_id = ? AND is_active = 1',
    [partId]
  );

  if (suppliers.length === 0) {
    // 没有启用的供应商，成本设为0
    await d.execute('UPDATE parts SET cost = 0 WHERE id = ?', [partId]);
    return;
  }

  // 计算加权成本
  const totalShare = suppliers.reduce((sum, s) => sum + (Number(s.share_ratio) || 0), 0);

  if (totalShare === 0) {
    // 所有供应商份额都是0，取第一个供应商的价格
    const firstPrice = Number(suppliers[0]?.price) || 0;
    await d.execute('UPDATE parts SET cost = ? WHERE id = ?', [firstPrice, partId]);
    return;
  }

  // 归一化并计算加权成本
  const weightedCost = suppliers.reduce((sum, s) => {
    const share = Number(s.share_ratio) || 0;
    const price = Number(s.price) || 0;
    return sum + (price * share / totalShare);
  }, 0);

  await d.execute('UPDATE parts SET cost = ? WHERE id = ?', [weightedCost, partId]);
}

// ==================== 整机供应商（ODM） ====================
// ODM 供应商：承接整机生产制造，提供部分或全部物料，报价为整机报价（project_suppliers 表）

export async function getProjectSuppliers(projectId: number) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM project_suppliers WHERE project_id = ? ORDER BY is_active DESC, id DESC',
    [projectId]
  );
}

export async function saveProjectSupplier(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      "UPDATE project_suppliers SET supplier_name=?, quoted_price=?, share_ratio=?, is_active=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.supplier_name, data.quoted_price || 0, data.share_ratio || 0, data.is_active ? 1 : 0, data.remark || '', data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO project_suppliers (project_id, supplier_name, quoted_price, share_ratio, is_active, remark) VALUES (?,?,?,?,?,?)',
      [data.project_id, data.supplier_name, data.quoted_price || 0, data.share_ratio || 0, data.is_active ? 1 : 0, data.remark || '']
    );
    return r.lastInsertId;
  }
}

export async function deleteProjectSupplier(id: number) {
  await (await getDb()).execute('DELETE FROM project_suppliers WHERE id = ?', [id]);
}

// 整机供应商报价历史（project_supplier_price_history 表）
export async function getProjectSupplierPriceHistory(supplierId: number) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM project_supplier_price_history WHERE supplier_id = ? ORDER BY changed_at DESC',
    [supplierId]
  );
}

export async function saveProjectSupplierPriceHistory(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO project_supplier_price_history (supplier_id, old_price, new_price, change_reason) VALUES (?,?,?,?)',
    [data.supplier_id, data.old_price || 0, data.new_price || 0, data.change_reason || '']
  );
  return r.lastInsertId;
}

export async function getSupplierPriceHistory(partId: number, supplierName: string) {
  return (await getDb()).select<any[]>('SELECT * FROM part_supplier_price_history WHERE part_id = ? AND supplier_name = ? ORDER BY changed_at DESC, id DESC', [partId, supplierName]);
}

// ==================== API Providers ====================
export async function getAllApiProviders() {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers ORDER BY provider_type, priority');
}

export async function getApiProvidersByType(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? ORDER BY priority', [type]);
}

export async function getActiveApiProviders(type: 'search' | 'llm') {
  return (await getDb()).select<any[]>('SELECT * FROM api_providers WHERE provider_type = ? AND is_active = 1 ORDER BY priority', [type]);
}

export async function addApiProvider(data: any) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO api_providers (provider_type, provider_name, api_key, base_url, model_name, is_active, priority, is_preset, monthly_quota_note, registration_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.provider_type, data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.is_preset ? 1 : 0, data.monthly_quota_note || '', data.registration_url || '']
  );
  return r.lastInsertId;
}

export async function updateApiProvider(data: any) {
  const d = await getDb();
  await d.execute(
    'UPDATE api_providers SET provider_name=?, api_key=?, base_url=?, model_name=?, is_active=?, priority=?, monthly_quota_note=?, registration_url=? WHERE id=?',
    [data.provider_name, data.api_key || '', data.base_url || '', data.model_name || '', data.is_active ? 1 : 0, data.priority || 0, data.monthly_quota_note || '', data.registration_url || '', data.id]
  );
  return data.id;
}

export async function toggleApiProviderActive(id: number, isActive: boolean) {
  await (await getDb()).execute('UPDATE api_providers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}

// ==================== AI Request Logs（AI请求审计日志） ====================

export async function saveAIRequestLog(data: {
  request_type: string;
  material_name?: string;
  system_prompt: string;
  user_prompt: string;
  response_summary: string;
  success: boolean;
  error_message?: string;
  provider_name?: string;      // 供应商
  model_name?: string;         // 模型
  prompt_tokens?: number;      // 输入 token
  completion_tokens?: number;  // 输出 token
  total_tokens?: number;       // 总 token
}) {
  const d = await getDb();
  const r = await d.execute(
    'INSERT INTO ai_request_logs (request_type, material_name, system_prompt, user_prompt, response_summary, success, error_message, provider_name, model_name, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      data.request_type,
      data.material_name || '',
      data.system_prompt,
      data.user_prompt,
      data.response_summary,
      data.success ? 1 : 0,
      data.error_message || '',
      data.provider_name || '',
      data.model_name || '',
      data.prompt_tokens ?? 0,
      data.completion_tokens ?? 0,
      data.total_tokens ?? 0
    ]
  );
  return r.lastInsertId;
}

/** 更新 AI 请求日志（洞察完成后把 response_summary 从"分析中..."更新为最终结果） */
export async function updateAIRequestLog(id: number, data: { response_summary?: string; success?: boolean; error_message?: string; provider_name?: string; model_name?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.response_summary !== undefined) { sets.push('response_summary=?'); vals.push(data.response_summary); }
  if (data.success !== undefined) { sets.push('success=?'); vals.push(data.success ? 1 : 0); }
  if (data.error_message !== undefined) { sets.push('error_message=?'); vals.push(data.error_message || ''); }
  if (data.provider_name !== undefined) { sets.push('provider_name=?'); vals.push(data.provider_name || ''); }
  if (data.model_name !== undefined) { sets.push('model_name=?'); vals.push(data.model_name || ''); }
  if (data.prompt_tokens !== undefined) { sets.push('prompt_tokens=?'); vals.push(data.prompt_tokens ?? 0); }
  if (data.completion_tokens !== undefined) { sets.push('completion_tokens=?'); vals.push(data.completion_tokens ?? 0); }
  if (data.total_tokens !== undefined) { sets.push('total_tokens=?'); vals.push(data.total_tokens ?? 0); }
  if (sets.length === 0) return;
  vals.push(id);
  await (await getDb()).execute(`UPDATE ai_request_logs SET ${sets.join(', ')} WHERE id=?`, vals);
}

// Token 用量记录（轻量，每次外部 LLM 调用记录一条）
export async function saveAIUsageLog(data: {
  provider_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) {
  const d = await getDb();
  await d.execute(
    'INSERT INTO ai_request_logs (request_type, material_name, system_prompt, user_prompt, response_summary, success, error_message, provider_name, model_name, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      'usage',
      '',
      '',
      '',
      '',
      1,
      '',
      data.provider_name,
      data.model_name,
      data.prompt_tokens,
      data.completion_tokens,
      data.total_tokens
    ]
  );
}

// Token 用量统计（按供应商/模型聚合）
export async function getTokenUsageStats(): Promise<{
  total: { prompt: number; completion: number; total: number; count: number };
  byProvider: { provider_name: string; model_name: string; prompt: number; completion: number; total: number; count: number }[];
  daily: { day: string; total: number }[];
}> {
  const d = await getDb();
  const rows = await d.select<any[]>(
    'SELECT provider_name, model_name, SUM(COALESCE(prompt_tokens,0)) as prompt, SUM(COALESCE(completion_tokens,0)) as completion, SUM(COALESCE(total_tokens,0)) as total, COUNT(*) as cnt FROM ai_request_logs GROUP BY provider_name, model_name ORDER BY total DESC'
  );
  const totalRow = await d.select<any[]>('SELECT SUM(COALESCE(prompt_tokens,0)) as p, SUM(COALESCE(completion_tokens,0)) as c, SUM(COALESCE(total_tokens,0)) as t, COUNT(*) as cnt FROM ai_request_logs');
  const daily = await d.select<any[]>(
    "SELECT substr(created_at,1,10) as day, SUM(COALESCE(total_tokens,0)) as total FROM ai_request_logs GROUP BY day ORDER BY day DESC LIMIT 30"
  );
  const t = totalRow[0] || { p: 0, c: 0, t: 0, cnt: 0 };
  return {
    total: { prompt: t.p || 0, completion: t.c || 0, total: t.t || 0, count: t.cnt || 0 },
    byProvider: rows || [],
    daily: daily || [],
  };
}

export async function getAllAIRequestLogs(limit = 100) {
  return (await getDb()).select<any[]>(
    'SELECT * FROM ai_request_logs ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

export async function deleteAIRequestLog(id: number) {
  await (await getDb()).execute('DELETE FROM ai_request_logs WHERE id = ?', [id]);
}

export async function clearAllAIRequestLogs() {
  await (await getDb()).execute('DELETE FROM ai_request_logs');
}

// ==================== 分类规则引擎（用户可编辑） ====================
export async function getModuleRules() {
  return (await getDb()).select<any[]>(
    'SELECT * FROM module_rules ORDER BY sort_order, id'
  );
}
export async function saveModuleRule(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      'UPDATE module_rules SET keywords=?, module=?, main_category=?, sub_category=?, sort_order=? WHERE id=?',
      [data.keywords, data.module, data.main_category, data.sub_category || '', data.sort_order || 0, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO module_rules (keywords, module, main_category, sub_category, sort_order, source) VALUES (?,?,?,?,?,?)',
      [data.keywords, data.module, data.main_category, data.sub_category || '', data.sort_order || 0, data.source || 'manual']
    );
    return r.lastInsertId;
  }
}
export async function deleteModuleRule(id: number) {
  await (await getDb()).execute('DELETE FROM module_rules WHERE id = ?', [id]);
}
export async function clearModuleRules() {
  await (await getDb()).execute('DELETE FROM module_rules');
}

// ==================== 工作日志 ====================
export async function getWorkLogs(category = '', keyword = '', startDate = '', endDate = '', workProject = '') {
  const d = await getDb();
  let q = 'SELECT * FROM work_logs WHERE 1=1';
  const p: any[] = [];
  if (category) { q += ' AND category=?'; p.push(category); }
  if (keyword) { q += ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)'; const k = `%${keyword}%`; p.push(k, k, k); }
  if (startDate) { q += ' AND date(log_date) >= ?'; p.push(startDate); }
  if (endDate) { q += ' AND date(log_date) <= ?'; p.push(endDate); }
  if (workProject) {
    if (workProject === '(无项目)') { q += " AND (work_project IS NULL OR work_project = '')"; }
    else { q += ' AND work_project=?'; p.push(workProject); }
  }
  q += ' ORDER BY log_date DESC, id DESC';
  return d.select<any[]>(q, p);
}
/** 获取范围内按项目标签聚合的工作记录（用于 AI 总结：按项目分组，无项目归入公共/其他） */
export async function getWorkLogsGroupedByProject(startDate = '', endDate = '') {
  const d = await getDb();
  let q = 'SELECT work_project, COUNT(*) as cnt FROM work_logs WHERE is_todo=0';
  const p: any[] = [];
  if (startDate) { q += ' AND date(log_date) >= ?'; p.push(startDate); }
  if (endDate) { q += ' AND date(log_date) <= ?'; p.push(endDate); }
  q += ' GROUP BY work_project ORDER BY work_project';
  const rows = await d.select<any[]>(q, p);
  const total = rows.reduce((s, r) => s + (r.cnt || 0), 0);
  return { projects: rows, total };
}
export async function getWorkLog(id: number) {
  return (await getDb()).select<any[]>('SELECT * FROM work_logs WHERE id=?', [id]).then(r => r[0] || null);
}
export async function saveWorkLog(data: any) {
  const d = await getDb();
  if (data.id) {
    await d.execute(
      "UPDATE work_logs SET log_date=?, title=?, content=?, category=?, tags=?, work_project=?, is_todo=?, done=?, updated_at=datetime('now','localtime') WHERE id=?",
      [data.log_date, data.title || '', data.content, data.category || '其他', data.tags || '', data.work_project || '', data.is_todo ? 1 : 0, data.done ? 1 : 0, data.id]
    );
    return data.id;
  } else {
    const r = await d.execute(
      'INSERT INTO work_logs (log_date, title, content, category, tags, work_project, is_todo, done) VALUES (?,?,?,?,?,?,?,?)',
      [data.log_date, data.title || '', data.content, data.category || '其他', data.tags || '', data.work_project || '', data.is_todo ? 1 : 0, data.done ? 1 : 0]
    );
    return r.lastInsertId;
  }
}
export async function toggleWorkLogDone(id: number, done: boolean) {
  await (await getDb()).execute('UPDATE work_logs SET done=? WHERE id=?', [done ? 1 : 0, id]);
}
export async function deleteWorkLog(id: number) {
  await (await getDb()).execute('DELETE FROM work_logs WHERE id=?', [id]);
}
export async function getWorkLogCategories() {  return (await getDb()).select<{ c: string }[]>('SELECT DISTINCT category FROM work_logs ORDER BY category');
}

// ==================== 工作总结保存 ====================
export async function getWorkSummaries() {
  return (await getDb()).select<any[]>('SELECT * FROM work_summaries ORDER BY created_at DESC');
}
export async function saveWorkSummary(data: any) {
  const r = await (await getDb()).execute(
    'INSERT INTO work_summaries (title, content, start_date, end_date) VALUES (?,?,?,?)',
    [data.title || '', data.content, data.start_date || '', data.end_date || '']
  );
  return r.lastInsertId;
}
export async function deleteWorkSummary(id: number) {
  await (await getDb()).execute('DELETE FROM work_summaries WHERE id=?', [id]);
}
