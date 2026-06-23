use std::env;
use tauri_plugin_sql::{Migration, MigrationKind};

fn get_db_url() -> String {
    let exe_path = env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
    let db_path = exe_dir.join("monitor_cost.db");
    format!("sqlite:{}", db_path.display())
}

#[tauri::command]
fn get_db_path() -> String { get_db_url() }

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
                    brand TEXT NOT NULL, model TEXT NOT NULL,
                    tier TEXT DEFAULT '主流级', market_price REAL DEFAULT 0,
                    bom_cost REAL DEFAULT 0, platform_fee_rate REAL DEFAULT 0,
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS competitor_boms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    competitor_id INTEGER NOT NULL, part_id INTEGER,
                    part_name TEXT NOT NULL, part_model TEXT DEFAULT '',
                    module_name TEXT DEFAULT '', estimated_cost REAL DEFAULT 0,
                    quantity INTEGER DEFAULT 1, is_mapped INTEGER DEFAULT 0,
                    our_part_name TEXT DEFAULT '', our_part_model TEXT DEFAULT '',
                    our_cost REAL DEFAULT 0, our_quantity INTEGER DEFAULT 0,
                    FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS competitor_parts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    main_category TEXT DEFAULT '硬件类', sub_category TEXT DEFAULT '',
                    category TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL,
                    cost REAL DEFAULT 0, specs TEXT DEFAULT '', remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    updated_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS project_cost_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL, stage TEXT NOT NULL,
                    reviewed_cost REAL NOT NULL, reviewer TEXT DEFAULT '',
                    reviewed_at TEXT DEFAULT (datetime('now','localtime')),
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
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
                    main_category TEXT NOT NULL, measure TEXT NOT NULL,
                    status TEXT DEFAULT '待执行', due_date TEXT DEFAULT '',
                    owner TEXT DEFAULT '', remark TEXT DEFAULT '',
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
                    key TEXT PRIMARY KEY, value TEXT DEFAULT ''
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
            description: "change quantity to REAL for decimal support",
            sql: "
                -- For project_boms: add new REAL column, copy data, then replace
                ALTER TABLE project_boms ADD COLUMN quantity_real REAL DEFAULT 1;
                UPDATE project_boms SET quantity_real = quantity;
                -- SQLite doesn't support DROP COLUMN before 3.35.0, so we recreate the table
                CREATE TABLE IF NOT EXISTS project_boms_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    part_id INTEGER NOT NULL,
                    module_name TEXT DEFAULT '',
                    quantity REAL DEFAULT 1,
                    remark TEXT DEFAULT '',
                    ref_project_id INTEGER DEFAULT 0,
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
                );
                INSERT INTO project_boms_new (id, project_id, part_id, module_name, quantity, remark, ref_project_id)
                    SELECT id, project_id, part_id, module_name, quantity_real, remark, ref_project_id FROM project_boms;
                DROP TABLE project_boms;
                ALTER TABLE project_boms_new RENAME TO project_boms;

                -- For module_items: same process
                ALTER TABLE module_items ADD COLUMN quantity_real REAL DEFAULT 1;
                UPDATE module_items SET quantity_real = quantity;
                CREATE TABLE IF NOT EXISTS module_items_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    module_id INTEGER NOT NULL,
                    part_id INTEGER,
                    part_name TEXT NOT NULL,
                    part_model TEXT DEFAULT '',
                    main_category TEXT DEFAULT '硬件类',
                    sub_category TEXT DEFAULT '',
                    cost REAL DEFAULT 0,
                    quantity REAL DEFAULT 1,
                    remark TEXT DEFAULT '',
                    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
                );
                INSERT INTO module_items_new (id, module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity, remark)
                    SELECT id, module_id, part_id, part_name, part_model, main_category, sub_category, cost, quantity_real, remark FROM module_items;
                DROP TABLE module_items;
                ALTER TABLE module_items_new RENAME TO module_items;
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add cost column to project_boms for per-entry cost ",
            sql: "ALTER TABLE project_boms ADD COLUMN cost REAL DEFAULT NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add sort_order to projects for manual ordering ",
            sql: "ALTER TABLE projects ADD COLUMN sort_order REAL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add sort_order to competitors for manual ordering ",
            sql: "ALTER TABLE competitors ADD COLUMN sort_order REAL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "create project_groups and project_group_members tables ",
            sql: "
                CREATE TABLE IF NOT EXISTS project_groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS project_group_members (
                    group_id INTEGER NOT NULL,
                    project_id INTEGER NOT NULL,
                    PRIMARY KEY (group_id, project_id),
                    FOREIGN KEY (group_id) REFERENCES project_groups(id) ON DELETE CASCADE,
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "create cost_snapshots table ",
            sql: "
                CREATE TABLE IF NOT EXISTS cost_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    snapshot_type TEXT DEFAULT 'auto',
                    snapshot_date TEXT NOT NULL,
                    snapshot_name TEXT DEFAULT '',
                    snapshot_desc TEXT DEFAULT '',
                    total_cost REAL NOT NULL,
                    bom_cost REAL NOT NULL,
                    fee_rate REAL DEFAULT 0,
                    profit_rate REAL DEFAULT 0,
                    final_price REAL DEFAULT 0,
                    cost_breakdown TEXT DEFAULT '{}',
                    bom_data TEXT DEFAULT '[]',
                    parts_count INTEGER DEFAULT 0,
                    remark TEXT DEFAULT '',
                    created_at TEXT DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_project ON cost_snapshots(project_id);
                CREATE INDEX IF NOT EXISTS idx_snapshots_date ON cost_snapshots(snapshot_date);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add bom_data and snapshot_name to cost_snapshots ",
            sql: "ALTER TABLE cost_snapshots ADD COLUMN bom_data TEXT DEFAULT '[]'",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "add snapshot_name column ",
            sql: "ALTER TABLE cost_snapshots ADD COLUMN snapshot_name TEXT DEFAULT ''",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add snapshot_desc column ",
            sql: "ALTER TABLE cost_snapshots ADD COLUMN snapshot_desc TEXT DEFAULT ''",
            kind: MigrationKind::Up,
        },
    ];

    let db_url = get_db_url();
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().add_migrations(&db_url, migrations).build())
        .invoke_handler(tauri::generate_handler![get_db_path])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
