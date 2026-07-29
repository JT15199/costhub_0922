use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::time::Duration;
use tauri_plugin_sql::{Migration, MigrationKind};

#[derive(Debug, Deserialize)]
struct HttpRequest {
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpResponse {
    status: u16,
    body: String,
    success: bool,
}

fn get_db_url() -> String {
    let exe_path = env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
    let db_path = exe_dir.join("monitor_cost.db");
    format!("sqlite:{}", db_path.display())
}

#[tauri::command]
fn get_db_path() -> String {
    get_db_url()
}

async fn send_http(method: &str, request: HttpRequest) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client initialization failed: {e}"))?;
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let mut builder = client.request(http_method, &request.url);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body.into_bytes());
    }
    let response = builder
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    Ok(HttpResponse {
        status: status.as_u16(),
        body,
        success: status.is_success(),
    })
}

#[tauri::command]
async fn http_get(request: HttpRequest) -> Result<HttpResponse, String> {
    send_http("GET", request).await
}

#[tauri::command]
async fn http_post(request: HttpRequest) -> Result<HttpResponse, String> {
    send_http("POST", request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create all tables v2",
            sql: "
                CREATE TABLE IF NOT EXISTS parts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    main_category TEXT DEFAULT '硬件类',
                    sub_category TEXT DEFAULT '',
                    category TEXT NOT NULL,
                    name TEXT NOT NULL,
                    model TEXT NOT NULL,
                    cost REAL NOT NULL DEFAULT 0,
                    specs TEXT DEFAULT '',
                    projects TEXT DEFAULT '',
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    updated_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    project_type TEXT DEFAULT '在研',
                    tier TEXT DEFAULT '主流级',
                    status TEXT DEFAULT '进行中',
                    screen_size TEXT DEFAULT '',
                    resolution TEXT DEFAULT '',
                    refresh_rate TEXT DEFAULT '',
                    panel_type TEXT DEFAULT '',
                    platform_fee_rate REAL DEFAULT 0,
                    profit_rate REAL DEFAULT 0,
                    image TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS modules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    module_category TEXT DEFAULT '未分类',
                    description TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS module_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    module_id INTEGER NOT NULL,
                    part_id INTEGER,
                    part_name TEXT NOT NULL,
                    part_model TEXT DEFAULT '',
                    main_category TEXT DEFAULT '硬件类',
                    sub_category TEXT DEFAULT '',
                    cost REAL DEFAULT 0,
                    quantity INTEGER DEFAULT 1,
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS project_boms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    part_id INTEGER NOT NULL,
                    module_name TEXT DEFAULT '',
                    quantity INTEGER DEFAULT 1,
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS part_price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    part_id INTEGER NOT NULL,
                    old_cost REAL NOT NULL,
                    new_cost REAL NOT NULL,
                    changed_at TEXT DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS competitors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    brand TEXT NOT NULL,
                    model TEXT NOT NULL,
                    tier TEXT DEFAULT '主流级',
                    market_price REAL DEFAULT 0,
                    bom_cost REAL DEFAULT 0,
                    platform_fee_rate REAL DEFAULT 0,
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS competitor_boms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    competitor_id INTEGER NOT NULL,
                    part_id INTEGER,
                    part_name TEXT NOT NULL,
                    part_model TEXT DEFAULT '',
                    module_name TEXT DEFAULT '',
                    estimated_cost REAL DEFAULT 0,
                    quantity INTEGER DEFAULT 1,
                    is_mapped INTEGER DEFAULT 0,
                    our_part_name TEXT DEFAULT '',
                    our_part_model TEXT DEFAULT '',
                    our_cost REAL DEFAULT 0,
                    our_quantity INTEGER DEFAULT 0,
                    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS competitor_parts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    main_category TEXT DEFAULT '硬件类',
                    sub_category TEXT DEFAULT '',
                    category TEXT NOT NULL,
                    name TEXT NOT NULL,
                    model TEXT NOT NULL,
                    cost REAL DEFAULT 0,
                    specs TEXT DEFAULT '',
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    updated_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS project_cost_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    stage TEXT NOT NULL,
                    reviewed_cost REAL NOT NULL,
                    reviewer TEXT DEFAULT '',
                    reviewed_at TEXT DEFAULT (datetime('now','localtime')),
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
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
                );
                CREATE TABLE IF NOT EXISTS project_targets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    domain TEXT NOT NULL,
                    target_cost REAL DEFAULT 0,
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS project_measures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    main_category TEXT NOT NULL,
                    measure TEXT NOT NULL,
                    status TEXT DEFAULT '待执行',
                    due_date TEXT DEFAULT '',
                    owner TEXT DEFAULT '',
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    updated_at TEXT DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS product_features (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    weight REAL DEFAULT 1.0,
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS product_scores (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ref_type TEXT NOT NULL,
                    ref_id INTEGER NOT NULL,
                    feature_id INTEGER NOT NULL,
                    score REAL DEFAULT 0,
                    FOREIGN KEY (feature_id) REFERENCES product_features(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT DEFAULT ''
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add project_targets table",
            sql: "CREATE TABLE IF NOT EXISTS project_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, domain TEXT NOT NULL, target_cost REAL DEFAULT 0, remark TEXT DEFAULT '', FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add ref_project_id to project_boms",
            sql: "ALTER TABLE project_boms ADD COLUMN ref_project_id INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add api_providers table",
            sql: "CREATE TABLE IF NOT EXISTS api_providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_type TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                api_key TEXT DEFAULT '',
                base_url TEXT DEFAULT '',
                model_name TEXT DEFAULT '',
                is_active INTEGER DEFAULT 0,
                priority INTEGER DEFAULT 0,
                is_preset INTEGER DEFAULT 0,
                monthly_quota_note TEXT DEFAULT '',
                registration_url TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "restore CostHub2 runtime tables",
            sql: "
                CREATE TABLE IF NOT EXISTS trend_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    query_category TEXT NOT NULL,
                    category_type TEXT DEFAULT '直接查询',
                    trend_direction TEXT DEFAULT '',
                    confidence_level TEXT DEFAULT '',
                    summary TEXT DEFAULT '',
                    suggested_action TEXT DEFAULT '',
                    raw_search_results TEXT DEFAULT '',
                    last_updated_at TEXT DEFAULT '',
                    magnitude_min REAL DEFAULT NULL,
                    magnitude_max REAL DEFAULT NULL,
                    magnitude_reference TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS trend_part_mapping (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_item_id INTEGER NOT NULL,
                    part_id INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS trend_sources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_item_id INTEGER NOT NULL,
                    source_title TEXT DEFAULT '',
                    source_url TEXT DEFAULT '',
                    excerpt TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS trend_conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_item_id INTEGER NOT NULL,
                    question TEXT DEFAULT '',
                    answer TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS trend_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_item_id INTEGER NOT NULL,
                    query_time TEXT DEFAULT (datetime('now','localtime')),
                    source_type TEXT DEFAULT 'direct_query',
                    direction TEXT DEFAULT '',
                    confidence TEXT DEFAULT '',
                    confidence_level TEXT DEFAULT '',
                    summary TEXT DEFAULT '',
                    suggested_action TEXT DEFAULT '',
                    skill_used TEXT DEFAULT '',
                    magnitude_min REAL DEFAULT NULL,
                    magnitude_max REAL DEFAULT NULL,
                    magnitude_reference TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS trend_insight_dimensions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_snapshot_id INTEGER NOT NULL,
                    dimension_type TEXT DEFAULT '',
                    dimension_order INTEGER DEFAULT 0,
                    content TEXT DEFAULT '',
                    evidence_strength TEXT DEFAULT '',
                    data_points TEXT DEFAULT '',
                    source_title TEXT DEFAULT '',
                    source_url TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS trend_key_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trend_snapshot_id INTEGER NOT NULL,
                    event_date TEXT DEFAULT '',
                    event_description TEXT DEFAULT '',
                    impact_direction TEXT DEFAULT '',
                    source_title TEXT DEFAULT '',
                    source_url TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS material_categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category_name TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS part_suppliers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    part_id INTEGER NOT NULL,
                    supplier_name TEXT NOT NULL,
                    unit_price REAL DEFAULT 0,
                    price REAL DEFAULT 0,
                    moq INTEGER DEFAULT 0,
                    lead_time TEXT DEFAULT '',
                    priority INTEGER DEFAULT 0,
                    share_ratio REAL DEFAULT 0,
                    is_active INTEGER DEFAULT 1,
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS supplier_price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    part_id INTEGER NOT NULL,
                    supplier_name TEXT NOT NULL,
                    old_price REAL DEFAULT 0,
                    new_price REAL DEFAULT 0,
                    change_reason TEXT DEFAULT '',
                    changed_at TEXT DEFAULT (datetime('now','localtime'))
                );
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
                );
                CREATE TABLE IF NOT EXISTS decomposition_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    root_part_id INTEGER NOT NULL,
                    timestamp TEXT DEFAULT (datetime('now','localtime')),
                    summary TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS rollup_contributions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    parent_snapshot_id INTEGER NOT NULL,
                    child_component_id INTEGER NOT NULL,
                    cost_ratio_used REAL DEFAULT NULL,
                    direction_used TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS rollup_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    component_id INTEGER NOT NULL,
                    component_name TEXT DEFAULT '',
                    ai_direction TEXT DEFAULT '',
                    ai_summary TEXT DEFAULT '',
                    ai_confidence_level TEXT DEFAULT '',
                    user_corrected_direction TEXT DEFAULT '',
                    user_corrected_confidence_level TEXT DEFAULT '',
                    correction_reason TEXT DEFAULT '',
                    user_corrected_summary TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS analysis_checklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT DEFAULT '',
                    check_order INTEGER DEFAULT 0,
                    item_description TEXT NOT NULL,
                    strength_level TEXT DEFAULT 'observing',
                    trigger_count INTEGER DEFAULT 0,
                    first_triggered_at TEXT DEFAULT '',
                    last_triggered_at TEXT DEFAULT '',
                    is_active INTEGER DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS checklist_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    checklist_id INTEGER NOT NULL,
                    question_snippet TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS outbound_request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT DEFAULT (datetime('now','localtime')),
                    method TEXT DEFAULT '',
                    url TEXT DEFAULT '',
                    status_code INTEGER DEFAULT 0,
                    response_time_ms INTEGER DEFAULT 0,
                    error_message TEXT DEFAULT ''
                );
            ",
            kind: MigrationKind::Up,
        },
    ];

    let db_url = get_db_url();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db_url, migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_db_path, http_get, http_post])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
