// 由 _tools/split-db.mjs 自动生成（db.ts 按域拆分）
// 手工修改请改对应域文件；新增函数请更新 _tools/split-db.mjs 的 DOMAINS 映射

import Database from './sql';
import { invoke } from '@tauri-apps/api/core';



let db: Database | null = null;


let dbUrl: string | null = null;




// 迁移采用 SQLite 原生 user_version，避免再维护一张“迁移表”。新版本如需变更 schema 只递增该值。
const SCHEMA_VERSION = 2;


// ====== 数据锁（登录门禁） ======
// 解锁前：所有查询返回空数据、所有写入静默跳过 —— 密码错误也能进入应用，但不显示任何数据
let dataLocked = true;


let rawDb: Database | null = null;
let rawDbLoading: Promise<Database> | null = null;

 // 绕过拦截的原始实例（仅登录/改密码/锁状态用）
const AUTH_KEY = 'auth_password_hash';


const AUTH_CHANGED_KEY = 'auth_password_changed';

 // 是否已改过密码（控制首次提示）
const AUTH_USERNAME_KEY = 'auth_username';

        // 用户名（可自定义，默认 admin）
const DEFAULT_PASSWORD = '666666';


const DEFAULT_USERNAME = 'admin';

const SQLITE_RETRY_DELAYS = [100, 250, 500];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function isSqliteLockedError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return text.includes('database is locked') || text.includes('database table is locked') || text.includes('sqlite_busy') || /\bcode\s*[:=]\s*5\b/.test(text);
}

export async function executeWithSqliteRetry<T>(operation: () => Promise<T>, maxRetries = SQLITE_RETRY_DELAYS.length, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (!isSqliteLockedError(error) || attempt >= maxRetries) throw error;
      await wait(SQLITE_RETRY_DELAYS[Math.min(attempt, SQLITE_RETRY_DELAYS.length - 1)]);
    }
  }
  throw lastError;
}

export function executeSqliteWrite(d: Database, query: string, bindValues?: unknown[]) {
  return executeWithSqliteRetry(() => d.execute(query, bindValues));
}



export function isDataLocked(): boolean { return dataLocked; }


export function setDataLocked(locked: boolean) { dataLocked = locked; }

// 数据库恢复前关闭两个连接；恢复完成后页面会重载，失败时也可按需重新连接。
async function closeDbConnections(): Promise<void> {
  const main = db;
  const raw = rawDb;
  db = null;
  rawDb = null;

  try { await main?.close(); } catch { }
  try { await raw?.close(); } catch { }
}



async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}



// 获取原始数据库实例（绕过数据锁，仅供登录/认证流程使用）
async function getRawDb(): Promise<Database> {
  if (rawDb) return rawDb;
  if (!rawDbLoading) {
    rawDbLoading = (async () => {
      const real = await Database.load(await getDbUrl());
      await configureDbConnection(real);
      await ensureSchema(real);

      rawDb = real;
      return real;
    })().finally(() => { rawDbLoading = null; });
  }
  return rawDbLoading;
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
    const real = await getRawDb();
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
  return db;
}



async function ignoreSchemaError(task: Promise<any>) {
  try { await task; } catch { }
}

async function prepareSchemaUpgrade(d: Database) {
  let current = 0;
  try { current = Number((await d.select<any[]>('PRAGMA user_version'))[0]?.user_version || 0); } catch { }
  if (current >= SCHEMA_VERSION) return { needed: false, backupPath: '' };
  const startedAt = new Date().toISOString();
  let target: { name: string; path: string } | null = null;
  try {
    const tables = await d.select<any[]>("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1");
    if (tables.length) {
      target = await invoke<{ name: string; path: string }>('create_backup_target');
      await d.execute('VACUUM INTO ?', [target.path]);
      console.info(`[schema] v${SCHEMA_VERSION} backup=${target.path} started=${startedAt}`);
    }
  } catch (error) {
    console.warn(`[schema] v${SCHEMA_VERSION} backup failed started=${startedAt}`, error);
    if (target?.name) await invoke('delete_backup', { backupName: target.name }).catch(() => undefined);
  }
  return { needed: true, backupPath: target?.path || '' };
}


async function ensureSchema(d: Database) {
  const migration = await prepareSchemaUpgrade(d);
  // ===== 核心表建表（取代 Rust migration 系统）=====
  // 全部用 ignoreSchemaError 包裹，已存在的表会静默跳过
  const coreCreate = [
    `CREATE TABLE IF NOT EXISTS category_spec_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER DEFAULT 0, category_name TEXT NOT NULL, field_key TEXT NOT NULL, field_label TEXT NOT NULL, data_type TEXT NOT NULL DEFAULT 'text', unit TEXT DEFAULT '', options_json TEXT DEFAULT '[]', group_name TEXT DEFAULT '基础规格', sort_order INTEGER DEFAULT 0, required INTEGER DEFAULT 0, compare_direction TEXT DEFAULT 'manual', active INTEGER DEFAULT 1, UNIQUE(category_name, field_key))`,
    `CREATE TABLE IF NOT EXISTS project_spec_values (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, field_id INTEGER NOT NULL, value_text TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, field_id))`,
    `CREATE TABLE IF NOT EXISTS project_bom_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_no INTEGER NOT NULL, version_name TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL DEFAULT 'manual', source_ref_id INTEGER DEFAULT 0, stage TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', data_fingerprint TEXT NOT NULL DEFAULT '', total_cost REAL DEFAULT 0, sku_snapshot_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now','localtime')), frozen_at TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_bom_version_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, source_bom_id INTEGER DEFAULT 0, canonical_part_id INTEGER DEFAULT 0, module_name TEXT DEFAULT '', part_name TEXT DEFAULT '', part_model TEXT DEFAULT '', specs TEXT DEFAULT '', quantity REAL DEFAULT 1, unit_cost REAL DEFAULT 0, line_total REAL DEFAULT 0, cost_layer TEXT NOT NULL DEFAULT 'material', relation_key TEXT DEFAULT '', raw_json TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS project_change_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, trigger_type TEXT NOT NULL DEFAULT 'other', trigger_field TEXT DEFAULT '', before_value TEXT DEFAULT '', after_value TEXT DEFAULT '', source_version_id INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', confidence REAL DEFAULT 0, rationale TEXT DEFAULT '', implemented_version_id INTEGER DEFAULT 0, implementation_evidence_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now','localtime')), confirmed_at TEXT DEFAULT '', implemented_at TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_change_package_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'add', before_line_id INTEGER DEFAULT 0, after_part_id INTEGER DEFAULT 0, module_name TEXT DEFAULT '', quantity_before REAL DEFAULT 0, quantity_after REAL DEFAULT 0, cost_before REAL DEFAULT 0, cost_after REAL DEFAULT 0, dependency_role TEXT NOT NULL DEFAULT 'optional', evidence_json TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS cost_baseline_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER DEFAULT 0, baseline_type TEXT NOT NULL, category TEXT DEFAULT '', scope_key TEXT NOT NULL, source_type TEXT NOT NULL, source_ref_id INTEGER DEFAULT 0, value REAL DEFAULT 0, comparable_rule_json TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'candidate', rationale TEXT DEFAULT '', confirmed_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS project_target_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_no INTEGER NOT NULL, target_cost REAL DEFAULT 0, baseline_cost REAL DEFAULT 0, challenge_gap REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', source_version_ids TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now','localtime')), frozen_at TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS data_change_history (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, project_id INTEGER DEFAULT 0, module_name TEXT DEFAULT '', field_key TEXT NOT NULL, field_label TEXT DEFAULT '', old_value TEXT DEFAULT '', new_value TEXT DEFAULT '', source TEXT DEFAULT 'manual', changed_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS parts (id INTEGER PRIMARY KEY AUTOINCREMENT, main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', category TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, specs TEXT DEFAULT '', projects TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, project_type TEXT DEFAULT '在研', stage TEXT DEFAULT 'Charter', category TEXT DEFAULT '未分类', tier TEXT DEFAULT '主流级', status TEXT DEFAULT '进行中', screen_size TEXT DEFAULT '', resolution TEXT DEFAULT '', refresh_rate TEXT DEFAULT '', panel_type TEXT DEFAULT '', specs TEXT DEFAULT '', target_price REAL DEFAULT 0, financial_target_cost REAL DEFAULT 0, charter_assumptions TEXT DEFAULT '', reference_project_id INTEGER DEFAULT 0, platform_fee_rate REAL DEFAULT 0, profit_rate REAL DEFAULT 0, image TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS modules (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, module_category TEXT DEFAULT '未分类', description TEXT DEFAULT '', category TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS module_items (id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER NOT NULL, part_id INTEGER, part_name TEXT NOT NULL, part_model TEXT DEFAULT '', main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', cost REAL DEFAULT 0, quantity INTEGER DEFAULT 1, remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_boms (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, part_id INTEGER NOT NULL, module_name TEXT DEFAULT '', quantity INTEGER DEFAULT 1, cost REAL DEFAULT 0, remark TEXT DEFAULT '', is_reference INTEGER DEFAULT 0, reference_remark TEXT DEFAULT '', is_deleted INTEGER DEFAULT 0, deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '', ref_project_id INTEGER DEFAULT 0, custom_data TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS project_bom_custom_columns (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, field_key TEXT NOT NULL, title TEXT NOT NULL, data_type TEXT NOT NULL DEFAULT 'text', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, field_key))`,
    `CREATE TABLE IF NOT EXISTS part_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, old_cost REAL NOT NULL, new_cost REAL NOT NULL, changed_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS competitors (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, model TEXT NOT NULL, tier TEXT DEFAULT '主流级', category TEXT DEFAULT '未分类', screen_size TEXT DEFAULT '', resolution TEXT DEFAULT '', refresh_rate TEXT DEFAULT '', panel_type TEXT DEFAULT '', specs TEXT DEFAULT '', market_price REAL DEFAULT 0, bom_cost REAL DEFAULT 0, platform_fee_rate REAL DEFAULT 0, remark TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS competitor_boms (id INTEGER PRIMARY KEY AUTOINCREMENT, competitor_id INTEGER NOT NULL, part_id INTEGER, part_name TEXT NOT NULL, part_model TEXT DEFAULT '', module_name TEXT DEFAULT '', estimated_cost REAL DEFAULT 0, quantity INTEGER DEFAULT 1, price_state TEXT DEFAULT 'unknown', quantity_state TEXT DEFAULT 'confirmed', is_mapped INTEGER DEFAULT 0, our_part_name TEXT DEFAULT '', our_part_model TEXT DEFAULT '', our_cost REAL DEFAULT 0, our_quantity INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS competitor_parts (id INTEGER PRIMARY KEY AUTOINCREMENT, main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '', category TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, cost REAL DEFAULT 0, specs TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_cost_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, stage TEXT NOT NULL, reviewed_cost REAL NOT NULL, reviewer TEXT DEFAULT '', reviewed_at TEXT DEFAULT (datetime('now','localtime')), remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_cost_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, snapshot_type TEXT DEFAULT 'bom_change', change_reason TEXT DEFAULT '', bom_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, platform_fee_rate REAL DEFAULT 0, profit_rate REAL DEFAULT 0, module_count INTEGER DEFAULT 0, item_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, domain TEXT NOT NULL, target_cost REAL DEFAULT 0, remark TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS production_cost_savings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_code TEXT DEFAULT '', project_name TEXT DEFAULT '', project_bom_id INTEGER DEFAULT 0, part_id INTEGER DEFAULT 0, part_name TEXT DEFAULT '', part_model TEXT DEFAULT '', module_name TEXT DEFAULT '', saving_year INTEGER NOT NULL, unit_saving REAL DEFAULT 0, annual_shipments INTEGER DEFAULT 0, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS project_measures (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, main_category TEXT NOT NULL, measure TEXT NOT NULL, status TEXT DEFAULT '待执行', due_date TEXT DEFAULT '', owner TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, weight REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL, feature_id INTEGER NOT NULL, score REAL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS module_feature_links (id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT NOT NULL, feature_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(module_name, feature_id))`,
    `CREATE TABLE IF NOT EXISTS project_module_feature_links (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, module_name TEXT NOT NULL, feature_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, module_name, feature_id))`,
    `CREATE TABLE IF NOT EXISTS project_competitive_dimensions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, feature_id INTEGER NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, feature_id))`,
    `CREATE TABLE IF NOT EXISTS project_skus (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, sku_code TEXT NOT NULL, sku_name TEXT DEFAULT '', spec_desc TEXT DEFAULT '', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS sku_diffs (id INTEGER PRIMARY KEY AUTOINCREMENT, sku_id INTEGER NOT NULL, diff_type TEXT NOT NULL, module_name TEXT DEFAULT '', part_name TEXT DEFAULT '', part_model TEXT DEFAULT '', new_model TEXT DEFAULT '', quantity REAL DEFAULT 1, unit_cost REAL DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT DEFAULT '', alias_name TEXT NOT NULL, alias_model TEXT DEFAULT '', canonical_name TEXT NOT NULL, canonical_model TEXT DEFAULT '', main_category TEXT DEFAULT '', sub_category TEXT DEFAULT '', source TEXT DEFAULT 'user_confirmed', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_compare_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT '', module_name TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT DEFAULT '', identified_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(category, module_name))`,
    `CREATE TABLE IF NOT EXISTS ai_think_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT DEFAULT (datetime('now','localtime')), finished_at TEXT DEFAULT '', status TEXT DEFAULT 'running', topic TEXT DEFAULT '', overview TEXT DEFAULT '', thoughts TEXT DEFAULT '', tools_json TEXT DEFAULT '[]', clouds_json TEXT DEFAULT '[]', conclusion TEXT DEFAULT '', error TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ai_bridge_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_key TEXT NOT NULL,
      material_name TEXT NOT NULL,
      category TEXT DEFAULT '',
      question TEXT DEFAULT '',
      cloud_result TEXT DEFAULT '',
      cloud_prompt TEXT DEFAULT '',
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
      severity TEXT DEFAULT 'info',
      impact_amount REAL DEFAULT 0,
      impact_band TEXT DEFAULT 'low',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      skill_id TEXT DEFAULT '',
      skill_version TEXT DEFAULT '',
      status TEXT DEFAULT 'running',
      question TEXT DEFAULT '',
      data_fingerprint TEXT DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      warning TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      conclusion TEXT DEFAULT '',
      evidence_json TEXT DEFAULT '[]',
      confidence TEXT DEFAULT 'low',
      assumptions_json TEXT DEFAULT '[]',
      expected_impact_json TEXT DEFAULT '',
      action_json TEXT DEFAULT '{}',
      data_gaps_json TEXT DEFAULT '[]',
      risks_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open',
      source TEXT DEFAULT 'local_rule',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_recommendation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      usefulness TEXT DEFAULT '',
      adoption_status TEXT DEFAULT '',
      actual_saving REAL DEFAULT NULL,
      actual_result TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_approval_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_level TEXT NOT NULL DEFAULT 'C1',
      material TEXT NOT NULL,
      category TEXT DEFAULT '',
      question TEXT DEFAULT '',
      payload_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT DEFAULT '',
      request_url TEXT DEFAULT '',
      request_method TEXT DEFAULT '',
      consumed_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_egress_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER DEFAULT 0,
      target TEXT DEFAULT '',
      model TEXT DEFAULT '',
      payload_hash TEXT DEFAULT '',
      fields_json TEXT DEFAULT '[]',
      status TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_eval_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fixture_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      score REAL DEFAULT 0,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS part_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT '', module_name TEXT NOT NULL, insight_json TEXT DEFAULT '', status TEXT DEFAULT 'unread', handled_json TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(category, module_name))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS api_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_type TEXT NOT NULL, provider_name TEXT NOT NULL, api_key TEXT DEFAULT '', base_url TEXT DEFAULT '', model_name TEXT DEFAULT '', is_active INTEGER DEFAULT 0, priority INTEGER DEFAULT 0, is_preset INTEGER DEFAULT 0, monthly_quota_note TEXT DEFAULT '', registration_url TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, price REAL DEFAULT 0, share_ratio REAL DEFAULT 0, is_active INTEGER DEFAULT 1, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS supplier_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT NOT NULL UNIQUE, logo TEXT DEFAULT '', category TEXT DEFAULT '', contact TEXT DEFAULT '', phone TEXT DEFAULT '', rating INTEGER DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS part_supplier_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, old_price REAL DEFAULT 0, new_price REAL DEFAULT 0, changed_at TEXT DEFAULT (datetime('now','localtime')), change_reason TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, quoted_price REAL DEFAULT 0, share_ratio REAL DEFAULT 0, is_active INTEGER DEFAULT 1, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_supplier_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, old_price REAL DEFAULT 0, new_price REAL DEFAULT 0, changed_at TEXT DEFAULT (datetime('now','localtime')), change_reason TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS project_spec_baselines (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_no INTEGER NOT NULL DEFAULT 1, fingerprint TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}', changed_fields_json TEXT NOT NULL DEFAULT '[]', source_type TEXT NOT NULL DEFAULT 'quote_import', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS tender_rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, round_no INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL DEFAULT '摸底报价', stage TEXT NOT NULL DEFAULT '摸底报价', spec_baseline_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS supplier_quote_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, tender_round_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, batch_no INTEGER NOT NULL DEFAULT 1, source_file_name TEXT NOT NULL DEFAULT '', source_file_hash TEXT NOT NULL, quoted_at TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'imported', currency TEXT NOT NULL DEFAULT 'CNY', tax_mode TEXT NOT NULL DEFAULT 'exclusive', pricing_mode TEXT NOT NULL DEFAULT 'one_time', total_amount REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, source_file_hash))`,
    `CREATE TABLE IF NOT EXISTS supplier_quote_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, source_row INTEGER NOT NULL, raw_name TEXT NOT NULL DEFAULT '', raw_model TEXT DEFAULT '', raw_specs TEXT DEFAULT '', module_name TEXT DEFAULT '', quantity REAL DEFAULT 1, unit_price REAL DEFAULT 0, line_total REAL DEFAULT 0, remark TEXT DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}', canonical_key TEXT NOT NULL DEFAULT '', relation_type TEXT NOT NULL DEFAULT 'unmatched', match_confidence REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS quote_line_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, quote_line_id INTEGER NOT NULL, canonical_part_id INTEGER DEFAULT NULL, relation_type TEXT NOT NULL, confidence REAL DEFAULT 0, spec_diff_json TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT 'rule', remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_process_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT DEFAULT '', actor TEXT DEFAULT 'local_user', created_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS negotiation_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, quote_line_id INTEGER DEFAULT NULL, module_name TEXT DEFAULT '', material_name TEXT NOT NULL, specs TEXT DEFAULT '', benchmark_supplier TEXT DEFAULT '', benchmark_price REAL DEFAULT 0, target_supplier TEXT DEFAULT '', target_price REAL DEFAULT 0, current_price REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(project_id, quote_line_id, target_supplier))`,
    `CREATE TABLE IF NOT EXISTS tender_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL UNIQUE, selected_supplier TEXT DEFAULT '', final_quote REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', rationale TEXT DEFAULT '', review_summary TEXT DEFAULT '', decided_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))` ,
    `CREATE TABLE IF NOT EXISTS cost_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, change_type TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL, ref_name TEXT DEFAULT '', supplier_name TEXT DEFAULT '', old_value REAL DEFAULT 0, new_value REAL DEFAULT 0, change_reason TEXT DEFAULT '', impact_scope TEXT DEFAULT '', changed_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT DEFAULT '#3B82F6', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS project_group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, project_id INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trend_items (id INTEGER PRIMARY KEY AUTOINCREMENT, query_category TEXT NOT NULL, category_type TEXT DEFAULT '直接查询', trend_direction TEXT DEFAULT '', confidence_level TEXT DEFAULT '', summary TEXT DEFAULT '', suggested_action TEXT DEFAULT '', raw_search_results TEXT DEFAULT '', last_updated_at TEXT DEFAULT '', magnitude_min REAL DEFAULT NULL, magnitude_max REAL DEFAULT NULL, magnitude_reference TEXT DEFAULT '', last_queried_at TEXT DEFAULT '', source_type TEXT DEFAULT 'decomposition', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, source_title TEXT DEFAULT '', source_url TEXT DEFAULT '', excerpt TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, question TEXT DEFAULT '', answer TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS trend_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_item_id INTEGER NOT NULL, query_time TEXT DEFAULT (datetime('now','localtime')), source_type TEXT DEFAULT 'direct_query', direction TEXT DEFAULT '', confidence TEXT DEFAULT '', confidence_level TEXT DEFAULT '', summary TEXT DEFAULT '', suggested_action TEXT DEFAULT '', skill_used TEXT DEFAULT '', magnitude_min REAL DEFAULT NULL, magnitude_max REAL DEFAULT NULL, magnitude_reference TEXT DEFAULT '', result_json TEXT DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS trend_insight_dimensions (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_snapshot_id INTEGER NOT NULL, dimension_type TEXT DEFAULT '', dimension_order INTEGER DEFAULT 0, content TEXT DEFAULT '', evidence_strength TEXT DEFAULT '', data_points TEXT DEFAULT '', source_title TEXT DEFAULT '', source_url TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS trend_key_events (id INTEGER PRIMARY KEY AUTOINCREMENT, trend_snapshot_id INTEGER NOT NULL, event_date TEXT DEFAULT '', event_description TEXT DEFAULT '', impact_direction TEXT DEFAULT '', source_title TEXT DEFAULT '', source_url TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS trend_part_mapping (id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, trend_item_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS rollup_contributions (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_snapshot_id INTEGER NOT NULL, child_component_id INTEGER NOT NULL, cost_ratio_used REAL DEFAULT NULL, direction_used TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS rollup_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, component_id INTEGER NOT NULL, component_name TEXT DEFAULT '', ai_direction TEXT DEFAULT '', ai_summary TEXT DEFAULT '', ai_confidence_level TEXT DEFAULT '', user_corrected_direction TEXT DEFAULT '', user_corrected_confidence_level TEXT DEFAULT '', correction_reason TEXT DEFAULT '', user_corrected_summary TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS ai_request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, request_type TEXT NOT NULL, material_name TEXT DEFAULT '', system_prompt TEXT DEFAULT '', user_prompt TEXT DEFAULT '', response_summary TEXT DEFAULT '', success INTEGER DEFAULT 1, error_message TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS material_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS local_ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '新对话', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')), pi_state_json TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS local_ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS local_ai_context (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS local_ai_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT DEFAULT 'general', source_session INTEGER DEFAULT 0, hit_count INTEGER DEFAULT 0, last_used_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS module_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, keywords TEXT NOT NULL, module TEXT NOT NULL, main_category TEXT NOT NULL, sub_category TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now','localtime')))`,
    `CREATE TABLE IF NOT EXISTS work_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, log_date TEXT DEFAULT (datetime('now','localtime')), title TEXT DEFAULT '', content TEXT NOT NULL, category TEXT DEFAULT '其他', tags TEXT DEFAULT '', is_todo INTEGER DEFAULT 0, done INTEGER DEFAULT 0, stage TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
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
  await ignoreSchemaError(d.execute("ALTER TABLE projects ADD COLUMN specs TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE sku_diffs ADD COLUMN new_model TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN screen_size TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN resolution TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN refresh_rate TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN panel_type TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN specs TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_bridge_logs ADD COLUMN cloud_prompt TEXT DEFAULT ''"));
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
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN result_json TEXT DEFAULT '{}'"));

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
  await ignoreSchemaError(d.execute("ALTER TABLE supplier_profiles ADD COLUMN province TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE supplier_profiles ADD COLUMN city TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE supplier_profiles ADD COLUMN longitude REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE supplier_profiles ADD COLUMN latitude REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE supplier_profiles ADD COLUMN address TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("CREATE TABLE IF NOT EXISTS supplier_sites (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT NOT NULL, site_name TEXT NOT NULL DEFAULT '总部 / 主厂', address TEXT DEFAULT '', province TEXT DEFAULT '', city TEXT DEFAULT '', longitude REAL DEFAULT 0, latitude REAL DEFAULT 0, contact TEXT DEFAULT '', phone TEXT DEFAULT '', is_primary INTEGER DEFAULT 0, remark TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))"));

  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN source_type TEXT DEFAULT 'direct_query'"));
  await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN confidence_level TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE modules ADD COLUMN module_category TEXT DEFAULT '未分类'"));

  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN correction_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE rollup_feedback ADD COLUMN user_corrected_summary TEXT DEFAULT ''"));

  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN component_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_messages ADD COLUMN reasoning TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_sessions ADD COLUMN pi_state_json TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_messages ADD COLUMN artifacts_json TEXT DEFAULT '[]'"));
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_memory ADD COLUMN category TEXT DEFAULT 'general'"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_request_logs ADD COLUMN request_channel TEXT DEFAULT 'unknown'"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_request_logs ADD COLUMN provider_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_request_logs ADD COLUMN model_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN prompt_tokens INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN completion_tokens INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_request_logs ADD COLUMN total_tokens INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_approval_grants ADD COLUMN request_url TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_approval_grants ADD COLUMN request_method TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_approval_grants ADD COLUMN consumed_at TEXT DEFAULT ''"));
  // 自主巡视去重：issue_key 表示同一个问题，evidence_fingerprint 表示该问题当前证据版本。
  // 旧 fingerprint 保留兼容，历史记录首次启动时回填为稳定问题键和当前证据。
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN issue_key TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN evidence_fingerprint TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("UPDATE ai_advisor_insights SET issue_key = COALESCE(NULLIF(issue_key, ''), fingerprint), evidence_fingerprint = COALESCE(NULLIF(evidence_fingerprint, ''), fingerprint) WHERE COALESCE(issue_key, '') = '' OR COALESCE(evidence_fingerprint, '') = ''"));
  // 演示生成习惯库（v2.3.19+）：local_ai_context 加分类列（演示结构/风格描述/素材模板等），默认 general
  await ignoreSchemaError(d.execute("ALTER TABLE local_ai_context ADD COLUMN category TEXT DEFAULT 'general'"));
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN is_todo INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN done INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN work_project TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN record_type TEXT DEFAULT 'work_progress'"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN impact TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN next_action TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN evidence_json TEXT DEFAULT '[]'"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN importance TEXT DEFAULT 'normal'"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN due_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE work_logs ADD COLUMN stage TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_item ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_dimension ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_run ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("UPDATE work_logs SET project_id = COALESCE((SELECT p.id FROM projects p WHERE p.name = work_logs.work_project OR p.code = work_logs.work_project LIMIT 1), 0) WHERE COALESCE(project_id, 0) = 0 AND COALESCE(work_project, '') <> ''"));
  await ignoreSchemaError(d.execute("UPDATE voice_item SET project_id = COALESCE((SELECT p.id FROM projects p WHERE p.name = voice_item.product OR p.code = voice_item.product LIMIT 1), 0) WHERE COALESCE(project_id, 0) = 0 AND COALESCE(product, '') <> ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_summaries ADD COLUMN summary_type TEXT DEFAULT 'period'"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_summaries ADD COLUMN project_filter TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_summaries ADD COLUMN source_log_ids_json TEXT DEFAULT '[]'"));
  await ignoreSchemaError(d.execute("ALTER TABLE work_summaries ADD COLUMN updated_at TEXT DEFAULT (datetime('now','localtime'))"));
  await ignoreSchemaError(d.execute(`CREATE TABLE IF NOT EXISTS analysis_item_meta (item_key TEXT PRIMARY KEY, domain TEXT DEFAULT '', object_type TEXT DEFAULT '', object_id TEXT DEFAULT '', object_name TEXT DEFAULT '', favorite INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now','localtime')))`));
  await ignoreSchemaError(d.execute(`CREATE TABLE IF NOT EXISTS analysis_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_type TEXT NOT NULL DEFAULT 'ai_analysis', title TEXT NOT NULL, summary TEXT DEFAULT '', data_json TEXT NOT NULL DEFAULT '{}', source_json TEXT NOT NULL DEFAULT '[]', data_fingerprint TEXT DEFAULT '', source_version_ids TEXT DEFAULT '{}', session_id INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`));
  await ignoreSchemaError(d.execute("ALTER TABLE analysis_artifacts ADD COLUMN data_fingerprint TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE analysis_artifacts ADD COLUMN source_version_ids TEXT DEFAULT '{}'"));
  await ignoreSchemaError(d.execute("ALTER TABLE projects ADD COLUMN category TEXT DEFAULT '未分类'"));
  await ignoreSchemaError(d.execute("ALTER TABLE projects ADD COLUMN stage TEXT DEFAULT 'Charter'"));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN target_price REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN financial_target_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE projects ADD COLUMN charter_assumptions TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN reference_project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN cost_ratio_estimate REAL DEFAULT NULL'));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN source_type TEXT DEFAULT 'user_confirmed'"));
  await ignoreSchemaError(d.execute("ALTER TABLE decomposition_tree ADD COLUMN insight_status TEXT DEFAULT 'pending'"));
  await ignoreSchemaError(d.execute('ALTER TABLE decomposition_tree ADD COLUMN trend_item_id INTEGER DEFAULT NULL'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE projects ADD COLUMN is_deleted INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE competitors ADD COLUMN sort_order INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE competitors ADD COLUMN category TEXT DEFAULT '未分类'"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN cost_layer TEXT DEFAULT 'material'"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_reference INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN reference_remark TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_deleted INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN deleted_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN deleted_by TEXT DEFAULT ''"));
  // project_boms 快照列（v2.3.19+ 写入，保证 模块库/项目页 读同一份数据，避免两页偏差）
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_model TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN part_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN price_state TEXT DEFAULT 'unknown'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN main_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN sub_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN part_specs TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_boms ADD COLUMN is_module_item INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN custom_data TEXT DEFAULT '{}'"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_targets ADD COLUMN version_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_targets ADD COLUMN baseline_cost REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_targets ADD COLUMN opportunity_amount REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_targets ADD COLUMN allocated_challenge REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_targets ADD COLUMN override_reason TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_targets ADD COLUMN status TEXT DEFAULT 'draft'"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_measures ADD COLUMN forecast_saving REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE project_measures ADD COLUMN realized_saving REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_measures ADD COLUMN realized_evidence TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE production_cost_savings ADD COLUMN project_bom_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE production_cost_savings ADD COLUMN project_code TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE production_cost_savings ADD COLUMN project_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE production_cost_savings ADD COLUMN part_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE production_cost_savings ADD COLUMN part_name TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE production_cost_savings ADD COLUMN part_model TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE production_cost_savings ADD COLUMN module_name TEXT DEFAULT ''"));
  // 同一项目/年度允许记录多个器件的降本收益，年度目标只在手账全局维护。
  try {
    const table = (await d.select<any[]>("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_cost_savings'"))[0];
    if (/UNIQUE\s*\(\s*project_id\s*,\s*saving_year\s*\)/i.test(String(table?.sql || ''))) {
      await d.execute('BEGIN IMMEDIATE');
      await d.execute('ALTER TABLE production_cost_savings RENAME TO production_cost_savings_legacy');
      await d.execute(`CREATE TABLE production_cost_savings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_code TEXT DEFAULT '', project_name TEXT DEFAULT '', project_bom_id INTEGER DEFAULT 0, part_id INTEGER DEFAULT 0, part_name TEXT DEFAULT '', part_model TEXT DEFAULT '', module_name TEXT DEFAULT '', saving_year INTEGER NOT NULL, unit_saving REAL DEFAULT 0, annual_shipments INTEGER DEFAULT 0, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`);
      await d.execute('INSERT INTO production_cost_savings (id, project_id, project_code, project_name, project_bom_id, part_id, part_name, part_model, module_name, saving_year, unit_saving, annual_shipments, note, created_at, updated_at) SELECT id, project_id, project_code, project_name, project_bom_id, part_id, part_name, part_model, module_name, saving_year, unit_saving, annual_shipments, note, created_at, updated_at FROM production_cost_savings_legacy');
      await d.execute('DROP TABLE production_cost_savings_legacy');
      await d.execute('COMMIT');
    }
  } catch (error) {
    await d.execute('ROLLBACK').catch(() => {});
    console.warn('production_cost_savings schema migration skipped:', error);
  }
  await ignoreSchemaError(d.execute('ALTER TABLE work_logs ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_item ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_dimension ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_run ADD COLUMN project_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN first_seen_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN last_seen_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN last_notified_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_advisor_insights ADD COLUMN occurrence_count INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN dismissed_fingerprint TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN severity TEXT DEFAULT 'info'"));
  await ignoreSchemaError(d.execute('ALTER TABLE ai_advisor_insights ADD COLUMN impact_amount REAL DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE ai_advisor_insights ADD COLUMN impact_band TEXT DEFAULT 'low'"));
  // project_boms 时间列（v2.3.19+）：快照回溯对比用；旧数据默认补当前时间
  await ignoreSchemaError(d.execute("ALTER TABLE project_boms ADD COLUMN created_at TEXT DEFAULT (datetime('now','localtime'))"));
  // 成本事实与版本快照补齐：unknown 不再被当成 0，旧行按已有器件/快照信息回填。
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_version_lines ADD COLUMN price_state TEXT DEFAULT 'unknown'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_version_lines ADD COLUMN main_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_version_lines ADD COLUMN sub_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_version_lines ADD COLUMN source_created_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN platform_fee_rate REAL DEFAULT 0"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN spec_baseline_id INTEGER DEFAULT 0"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN project_snapshot_json TEXT DEFAULT '{}'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN sku_snapshot_json TEXT DEFAULT '[]'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN cost_status TEXT DEFAULT 'confirmed'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_bom_versions ADD COLUMN missing_cost_count INTEGER DEFAULT 0"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN bom_version_id INTEGER DEFAULT 0"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN data_fingerprint TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN bom_snapshot_json TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN cost_status TEXT DEFAULT 'confirmed'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN missing_cost_count INTEGER DEFAULT 0"));
  await ignoreSchemaError(d.execute('ALTER TABLE project_change_packages ADD COLUMN implemented_version_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE project_change_packages ADD COLUMN implementation_evidence_json TEXT DEFAULT '{}'"));
  await ignoreSchemaError(d.execute("ALTER TABLE project_change_packages ADD COLUMN implemented_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("UPDATE project_boms SET price_state=CASE WHEN COALESCE(price_state,'unknown') NOT IN ('confirmed','unknown','invalid') THEN 'unknown' WHEN COALESCE(price_state,'unknown')='unknown' AND COALESCE(part_cost,0)>0 THEN 'confirmed' ELSE COALESCE(price_state,'unknown') END"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitor_boms ADD COLUMN price_state TEXT DEFAULT 'unknown'"));
  await ignoreSchemaError(d.execute("ALTER TABLE competitor_boms ADD COLUMN quantity_state TEXT DEFAULT 'confirmed'"));
  await ignoreSchemaError(d.execute("UPDATE competitor_boms SET price_state=CASE WHEN COALESCE(price_state,'unknown')='unknown' AND COALESCE(estimated_cost,0)>0 THEN 'confirmed' ELSE COALESCE(price_state,'unknown') END, quantity_state=CASE WHEN COALESCE(quantity,0)>=0 THEN 'confirmed' ELSE 'invalid' END"));
  // 器件供应商价格历史：补充 part_id/supplier_name 列（历史 bug：写入用了不存在的 supplier_price_history 表，
  // 此表从未写入过数据——统一写入 part_supplier_price_history 并按 part_id+supplier_name 检索）
  await ignoreSchemaError(d.execute('ALTER TABLE part_supplier_price_history ADD COLUMN part_id INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE part_supplier_price_history ADD COLUMN supplier_name TEXT DEFAULT ''"));
  // 竞争力雷达（v2.3.19+）：product_features 区分特性体系——custom=用户自定义（旧对比雷达）、radar=全局默认五维；项目可在 project_competitive_dimensions 覆盖名称/启用状态。
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN type TEXT DEFAULT 'custom'"));
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN project_id INTEGER DEFAULT 0"));
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN kano_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN decision TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE product_features ADD COLUMN rationale TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE product_features ADD COLUMN confirmed INTEGER DEFAULT 0'));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_item ADD COLUMN source_platform TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_item ADD COLUMN source_product TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_item ADD COLUMN collected_at TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_dimension ADD COLUMN kano_category TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_dimension ADD COLUMN decision TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute("ALTER TABLE voice_dimension ADD COLUMN rationale TEXT DEFAULT ''"));
  await ignoreSchemaError(d.execute('ALTER TABLE voice_dimension ADD COLUMN confirmed INTEGER DEFAULT 0'));

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

  // 历史全局配置只作为迁移来源；成本长城实际按项目保存维度和支撑模块，避免项目间互相污染。
  await ignoreSchemaError(d.execute(`
    INSERT OR IGNORE INTO project_competitive_dimensions (project_id, feature_id, name, sort_order, enabled)
    SELECT p.id, f.id, f.name, f.id, 1
    FROM projects p CROSS JOIN product_features f
    WHERE COALESCE(p.is_deleted, 0) = 0 AND f.type = 'radar' AND COALESCE(f.project_id, 0) = 0
  `));
  await ignoreSchemaError(d.execute(`
    INSERT OR IGNORE INTO project_module_feature_links (project_id, module_name, feature_id)
    SELECT p.id, l.module_name, l.feature_id
    FROM projects p CROSS JOIN module_feature_links l
    WHERE COALESCE(p.is_deleted, 0) = 0
  `));

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
  await ignoreSchemaError(d.execute("ALTER TABLE project_cost_snapshots ADD COLUMN stage TEXT DEFAULT ''"));
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
    'CREATE INDEX IF NOT EXISTS idx_spec_baselines_project ON project_spec_baselines(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_tender_rounds_project ON tender_rounds(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_quote_batches_project ON supplier_quote_batches(project_id, tender_round_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_quote_lines_batch ON supplier_quote_lines(batch_id)',
    'CREATE INDEX IF NOT EXISTS idx_quote_lines_key ON supplier_quote_lines(canonical_key)',
    'CREATE INDEX IF NOT EXISTS idx_quote_matches_line ON quote_line_matches(quote_line_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_process_events_project ON project_process_events(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_negotiation_items_project ON negotiation_items(project_id, status, id)',
    'CREATE INDEX IF NOT EXISTS idx_tender_decisions_project ON tender_decisions(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_trend_snapshots_item ON trend_snapshots(trend_item_id)',
    'CREATE INDEX IF NOT EXISTS idx_trend_sources_item ON trend_sources(trend_item_id)',
    'CREATE INDEX IF NOT EXISTS idx_decomposition_tree_parent ON decomposition_tree(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_work_logs_date ON work_logs(log_date)',
    'CREATE INDEX IF NOT EXISTS idx_competitor_boms_comp ON competitor_boms(competitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_sku_diffs_sku ON sku_diffs(sku_id)',
    'CREATE INDEX IF NOT EXISTS idx_cost_change_log_type ON cost_change_log(change_type)',
    'CREATE INDEX IF NOT EXISTS idx_ai_request_logs_type ON ai_request_logs(request_type)',
    'CREATE INDEX IF NOT EXISTS idx_ai_advisor_issue_key ON ai_advisor_insights(issue_key)',
    'CREATE INDEX IF NOT EXISTS idx_data_change_history_entity ON data_change_history(entity_type, entity_id, changed_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_data_change_history_project ON data_change_history(project_id, changed_at DESC)',
  ];
  for (const sql of indexSql) {
    await ignoreSchemaError(d.execute(sql));
  }
  if (migration.needed) {
    await ignoreSchemaError(d.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`));
    console.info(`[schema] v${SCHEMA_VERSION} applied${migration.backupPath ? ` backup=${migration.backupPath}` : ' backup=unavailable'}`);
  }
}



export interface DataChangeHistoryInput {
  entityType: string;
  entityId: number;
  projectId?: number;
  moduleName?: string;
  fieldKey: string;
  fieldLabel?: string;
  oldValue: unknown;
  newValue: unknown;
  source?: string;
}

async function configureDbConnection(connection: Database) {
  await executeWithSqliteRetry(() => connection.execute('PRAGMA busy_timeout=5000'));
  await executeWithSqliteRetry(() => connection.execute('PRAGMA journal_mode=WAL'));
}

/** 记录一条可读的字段级变更，供项目/BOM/器件的历史按钮查看。 */
export async function logDataChange(input: DataChangeHistoryInput) {
  const oldValue = input.oldValue == null ? '' : String(input.oldValue);
  const newValue = input.newValue == null ? '' : String(input.newValue);
  if (oldValue === newValue) return 0;
  const d = await getDb();
  const result = await d.execute(
    `INSERT INTO data_change_history
      (entity_type, entity_id, project_id, module_name, field_key, field_label, old_value, new_value, source)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [input.entityType, input.entityId, input.projectId || 0, input.moduleName || '', input.fieldKey, input.fieldLabel || input.fieldKey, oldValue, newValue, input.source || 'manual']
  );
  return result.lastInsertId || 0;
}

export async function getDataChangeHistory(entityType: string, entityId: number, limit = 100) {
  return (await getDb()).select<any[]>(
    `SELECT * FROM data_change_history
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY changed_at DESC, id DESC LIMIT ?`,
    [entityType, entityId, limit]
  );
}

export async function getProjectChangeHistory(projectId: number, limit = 200) {
  return (await getDb()).select<any[]>(
    `SELECT * FROM data_change_history
     WHERE project_id = ?
     ORDER BY changed_at DESC, id DESC LIMIT ?`,
    [projectId, limit]
  );
}

// 生成与 SQLite datetime('now','localtime') 一致的本地时间字符串（YYYY-MM-DD HH:MM:SS）
function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export { getDb, getRawDb, closeDbConnections, sha256, localNow, dataLocked, AUTH_KEY, AUTH_CHANGED_KEY, AUTH_USERNAME_KEY, DEFAULT_PASSWORD, DEFAULT_USERNAME };
