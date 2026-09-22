mod local_stream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Connection, Row, TypeInfo, ValueRef};
use std::collections::{HashMap, HashSet};
use std::env;
use std::future::Future;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::process::{Child, Command, Stdio};
use tauri::{Emitter, Manager, State};
use tokio::sync::{watch, RwLock};
use tokio::io::AsyncReadExt;

#[cfg(windows)]
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
#[cfg(windows)]
use windows::Win32::Foundation::{HLOCAL, LocalFree};

#[cfg(test)]
mod review_round3_test;

#[cfg(test)]
mod frontend_sql_boundary_tests {
    use super::*;

    #[test]
    fn renderer_transaction_keeps_its_connection_and_releases_write_lock() {
        tauri::async_runtime::block_on(async {
            let pool = open_frontend_sql_pool("sqlite::memory:").await.unwrap();
            assert_eq!(pool.options().get_max_connections(), 1);
            sqlx::query("CREATE TABLE notes(id INTEGER PRIMARY KEY, content TEXT)").execute(&pool).await.unwrap();
            sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO notes(content) VALUES ('first')").execute(&pool).await.unwrap();
            sqlx::query("ROLLBACK").execute(&pool).await.unwrap();
            sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO notes(content) VALUES ('saved')").execute(&pool).await.unwrap();
            sqlx::query("COMMIT").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO notes(content) VALUES ('next')").execute(&pool).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notes").fetch_one(&pool).await.unwrap();
            assert_eq!(count, 2);
            pool.close().await;
        });
    }

    #[test]
    fn portable_first_run_creates_disk_database_and_preserves_it() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("costhub-first-run-{}-{} 空格#资料", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("costhub.db");
            let url = format!("sqlite:{}", file.display());
            assert!(!file.exists());
            let pool = open_frontend_sql_pool(&url).await.unwrap();
            assert!(file.is_file());
            sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO settings VALUES('auth_password_hash','existing-password-sentinel')").execute(&pool).await.unwrap();
            pool.close().await;
            let reopened = open_frontend_sql_pool(&url).await.unwrap();
            let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='auth_password_hash'").fetch_one(&reopened).await.unwrap();
            assert_eq!(value, "existing-password-sentinel");
            reopened.close().await;
            fs::remove_dir_all(&dir).unwrap();
        });
    }

    #[test]
    fn renderer_cannot_cross_database_boundary() {
        assert!(validate_frontend_sqlite_db(&get_db_url()).is_ok());
        assert!(validate_frontend_sqlite_db("sqlite:costhub-cloud-authority.db").is_err());
        assert!(validate_frontend_sql("SELECT 1").is_ok());
        assert!(validate_frontend_sql("ATTACH DATABASE 'private.db' AS private").is_err());
        assert!(validate_frontend_sql("VACUUM INTO 'private.db'").is_err());
    }
}

#[cfg(test)]
mod execution_boundary_tests {
    use super::{clip_execution_output, execution_create_workspace, execution_exec, lexical_execution_path, ExecutionExecRequest};
    use std::path::Path;

    #[test]
    fn large_output_is_bounded_and_marked() {
        let output = clip_execution_output(&"x".repeat(20_000), 128);
        assert!(output.len() < 300);
        assert!(output.contains("输出已截断"));
    }

    #[test]
    fn relative_escape_is_rejected_before_filesystem_access() {
        let root = Path::new(r"C:\task");
        assert!(lexical_execution_path(root, Path::new(r"..\outside.txt")).is_err());
        assert_eq!(lexical_execution_path(root, Path::new(r"reports\quote.csv")).unwrap(), root.join(r"reports\quote.csv"));
    }

    #[cfg(windows)]
    #[test]
    fn long_path_prefix_stays_inside_task_boundary() {
        let root = Path::new(r"C:\task");
        assert_eq!(super::normalize_execution_input(r"\\?\C:\task\quote.xlsx"), r"C:\task\quote.xlsx");
        assert!(lexical_execution_path(root, Path::new(r"C:\outside\quote.xlsx")).is_err());
    }

    #[test]
    fn powershell_fact_check_persists_full_output() {
        let workspace = execution_create_workspace().unwrap();
        super::execution_set_enabled(workspace.clone(), true).unwrap();
        super::execution_prepare(format!("fact-{}", std::process::id())).unwrap();
        let result = tauri::async_runtime::block_on(execution_exec(ExecutionExecRequest {
            execution_id: format!("fact-{}", std::process::id()),
            workspace,
            command: "Write-Output 'quote-fact-ok'".to_string(),
            timeout_seconds: Some(10),
            shell: "powershell".to_string(),
            isolated: false,
        }, tauri::ipc::Channel::new(|_| Ok(())))).unwrap();
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["timedOut"], false);
        assert!(result["stdout"].as_str().unwrap_or_default().contains("quote-fact-ok"));
        assert!(std::path::Path::new(result["fullOutputPath"].as_str().unwrap()).exists());
    }

    #[test]
    fn packaged_skills_are_readable_and_immutable_to_file_tools() {
        let workspace = execution_create_workspace().unwrap();
        let dirs = super::execution_skill_dirs(workspace.clone()).unwrap();
        assert_eq!(dirs.len(), 1);
        let path = ".skills/analysis-charts/SKILL.md";
        let request = |op: &str| super::ExecutionFsRequest { workspace: workspace.clone(), op: op.into(), path: path.into(), second_path: String::new(), content: "overwrite".into() };
        assert!(super::execution_fs(request("read_text")).unwrap().as_str().unwrap().contains("render_analysis_chart"));
        assert!(super::execution_fs(request("write_text")).is_err());
        assert!(super::execution_fs(request("remove")).is_err());
        let missing = super::ExecutionFsRequest { path: "missing.txt".into(), ..request("exists") };
        assert_eq!(super::execution_fs(missing).unwrap(), false);
    }

    #[test]
    fn command_requires_authorization_and_cancellation_survives_registration() {
        let workspace = execution_create_workspace().unwrap();
        let run = |id: &str| ExecutionExecRequest { execution_id: id.into(), workspace: workspace.clone(), command: "Write-Output 'must-not-run'".into(), timeout_seconds: Some(5), shell: "powershell".into(), isolated: false };
        super::execution_prepare("review-not-authorized".into()).unwrap();
        let denied = tauri::async_runtime::block_on(execution_exec(run("review-not-authorized"), tauri::ipc::Channel::new(|_| Ok(()))));
        assert!(denied.unwrap_err().contains("启用"));
        super::execution_set_enabled(workspace.clone(), true).unwrap();
        super::execution_prepare("review-pre-cancelled".into()).unwrap();
        assert!(super::execution_cancel("review-pre-cancelled".into()));
        let cancelled = tauri::async_runtime::block_on(execution_exec(run("review-pre-cancelled"), tauri::ipc::Channel::new(|_| Ok(()))));
        assert!(cancelled.unwrap_err().contains("未启动"));
        super::execution_prepare("review-running-cancel".into()).unwrap();
        tauri::async_runtime::block_on(async {
            let request = ExecutionExecRequest { command: "Start-Sleep -Seconds 20".into(), timeout_seconds: Some(8), ..run("review-running-cancel") };
            let task = tokio::spawn(execution_exec(request, tauri::ipc::Channel::new(|_| Ok(()))));
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            super::execution_cancel("review-running-cancel".into());
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), task).await.unwrap().unwrap();
            assert!(result.unwrap_err().contains("取消"));
        });
    }

    #[cfg(windows)]
    #[test]
    fn appcontainer_isolated_command_is_real_and_has_no_userprofile_env() {
        let workspace = super::execution_create_isolated_workspace().unwrap();
        super::execution_set_enabled(workspace.clone(), true).unwrap();
        let id = format!("isolated-{}", std::process::id());
        super::execution_prepare(id.clone()).unwrap();
        let result = tauri::async_runtime::block_on(super::execution_exec(super::ExecutionExecRequest {
            execution_id: id,
            workspace,
            command: "const os=require('os'); console.log('isolated-ok'); process.exit(process.env.USERPROFILE ? 7 : 0)".into(),
            timeout_seconds: Some(30),
            shell: "node".into(),
            isolated: true,
        }, tauri::ipc::Channel::new(|_| Ok(())))).unwrap();
        assert_eq!(result["exitCode"], 0);
        assert!(result["isolated"].as_bool().unwrap_or(false));
        assert!(result["stdout"].as_str().unwrap_or_default().contains("isolated-ok"));
        let sentinel = super::PathBuf::from(std::env::var("USERPROFILE").unwrap()).join(format!("costhub-isolation-sentinel-{}.txt", std::process::id()));
        std::fs::write(&sentinel, "outside-task").unwrap();
        let denied_id = format!("isolated-denied-{}", std::process::id());
        let denied_workspace = super::execution_create_isolated_workspace().unwrap();
        super::execution_set_enabled(denied_workspace.clone(), true).unwrap();
        super::execution_prepare(denied_id.clone()).unwrap();
        let path_literal = serde_json::to_string(&sentinel.to_string_lossy()).unwrap();
        let denied = tauri::async_runtime::block_on(super::execution_exec(super::ExecutionExecRequest {
            execution_id: denied_id,
            workspace: denied_workspace,
            command: format!("const fs=require('fs'); const p={path_literal}; try {{ fs.readFileSync(p); console.log('leak') }} catch {{ console.log('denied') }}"),
            timeout_seconds: Some(30), shell: "node".into(), isolated: true,
        }, tauri::ipc::Channel::new(|_| Ok(())))).unwrap();
        let _ = std::fs::remove_file(sentinel);
        assert!(denied["stdout"].as_str().unwrap_or_default().contains("denied"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let net_id = format!("isolated-net-{}", std::process::id());
        let net_workspace = super::execution_create_isolated_workspace().unwrap();
        super::execution_set_enabled(net_workspace.clone(), true).unwrap();
        super::execution_prepare(net_id.clone()).unwrap();
        let net = tauri::async_runtime::block_on(super::execution_exec(super::ExecutionExecRequest {
            execution_id: net_id, workspace: net_workspace,
            command: format!("const net=require('net'); const s=net.createConnection({{host:'127.0.0.1',port:{port}}},()=>{{ console.log('leak'); process.exit(7) }}); s.on('error',()=>{{ console.log('denied'); process.exit(0) }}); setTimeout(()=>process.exit(8),1000)"),
            timeout_seconds: Some(10), shell: "node".into(), isolated: true,
        }, tauri::ipc::Channel::new(|_| Ok(())))).unwrap();
        drop(listener);
        assert!(net["stdout"].as_str().unwrap_or_default().contains("denied"));
    }
}

#[derive(Debug, Deserialize)]
struct HttpRequest {
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    #[serde(default)]
    backend: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProviderSecretRequest {
    provider_id: i64,
    secret: String,
}

#[derive(Debug, Deserialize)]
struct ProviderCloudHttpRequest {
    provider_id: i64,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    approval: CloudApproval,
    #[serde(default)]
    request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CloudApproval {
    material: String,
    category: String,
    question: String,
    reviewed: bool,
    #[serde(default)]
    grant_id: Option<i64>,
    #[serde(default)]
    payload_hash: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    scope_level: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudHttpRequest {
    url: String,
    method: String,
    body: Option<String>,
    approval: CloudApproval,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindCloudApprovalGrantRequest {
    material: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    payload_hash: Option<String>,
    #[serde(default)]
    scope_level: Option<String>,
    #[serde(default)]
    request_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCloudApprovalGrantRequest {
    scope_level: String,
    material: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    preview_json: String,
    #[serde(default)]
    expires_minutes: i64,
    #[serde(default)]
    request_url: String,
    #[serde(default)]
    request_method: String,
    /// "theme" = 可复用主题票（同一公开检索主题在有效期内不再重复询问）；缺省 "payload" = 一次性精确载荷票。
    #[serde(default)]
    grant_class: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct CloudApprovalGrantResponse {
    id: i64,
    scope_level: String,
    material: String,
    category: String,
    question: String,
    payload_hash: String,
    expires_at: String,
    request_url: String,
    request_method: String,
    #[serde(default)]
    grant_class: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpResponse {
    status: u16,
    body: String,
    success: bool,
}

static HTTP_CANCEL: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
struct ProviderCloudCancelRegistry {
    active: HashMap<String, watch::Sender<bool>>,
    pending: HashSet<String>,
}

static PROVIDER_CLOUD_CANCEL: OnceLock<Mutex<ProviderCloudCancelRegistry>> = OnceLock::new();
static LLAMA_SERVER: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct LlamaServerConfig { executable: String, model_path: String, port: u16, context_size: u32, gpu_layers: i32, threads: u32, batch_size: u32, reasoning: String, #[serde(default)] mmproj: String }

fn llama_log_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("应用目录不可用")?.join("llama-server.log"))
}

#[tauri::command]
fn llama_server_log() -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = llama_log_path()?;
    if !path.exists() { return Ok("尚无本次应用的 llama-server 日志".into()); }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(16384))).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn llama_server_status() -> Result<serde_json::Value, String> {
    let mut guard = LLAMA_SERVER.get_or_init(|| Mutex::new(None)).lock().map_err(|e| e.to_string())?;
    let running = guard.as_mut().map(|child| child.try_wait().map(|x| x.is_none()).unwrap_or(false)).unwrap_or(false);
    if !running { *guard = None; }
    Ok(serde_json::json!({ "running": running }))
}

#[tauri::command]
fn llama_server_start(config: LlamaServerConfig) -> Result<serde_json::Value, String> {
    if config.port == 0 || config.context_size > 1048576 || config.threads == 0 || config.threads > 256 || config.batch_size == 0 || config.batch_size > 8192 || config.gpu_layers < 0 || config.gpu_layers > 999 || !["on", "off", "auto"].contains(&config.reasoning.as_str()) { return Err("llama.cpp 参数范围无效".into()); }
    let app_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = app_exe.parent().ok_or("应用目录不可用")?;
    let resolve = |value: &str| { let path = PathBuf::from(value); if path.is_absolute() { path } else { root.join(path) } };
    if config.model_path.trim().is_empty() { return Err("请选择 GGUF 模型文件".into()); }
    let exe = resolve(&config.executable); let model = resolve(&config.model_path);
    if !exe.is_file() || exe.file_name().and_then(|x| x.to_str()).map(|x| !x.eq_ignore_ascii_case("llama-server.exe")).unwrap_or(true) { return Err("llama-server.exe 路径无效".into()); }
    if !model.is_file() { return Err("GGUF 模型文件不存在".into()); }
    let mut guard = LLAMA_SERVER.get_or_init(|| Mutex::new(None)).lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() { if child.try_wait().map_err(|e| e.to_string())?.is_none() { return Err("模型服务已在运行；修改启动参数后请先停止再启动".into()); } }
    let mut command = Command::new(&exe);
    if !config.mmproj.trim().is_empty() { let mmproj = resolve(&config.mmproj); if !mmproj.is_file() { return Err("视觉投影文件不存在".into()); } command.arg("--mmproj").arg(mmproj); }
    let log = std::fs::File::create(llama_log_path()?).map_err(|e| e.to_string())?;
    command.arg("-m").arg(&model).arg("-c").arg(config.context_size.to_string()).arg("-ngl").arg(config.gpu_layers.to_string()).arg("-t").arg(config.threads.to_string()).arg("-b").arg(config.batch_size.to_string()).arg("--host").arg("127.0.0.1").arg("--port").arg(config.port.to_string()).arg("--reasoning").arg(&config.reasoning).stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let child = command.spawn().map_err(|e| format!("启动 llama-server 失败：{e}"))?; let pid = child.id(); *guard = Some(child); Ok(serde_json::json!({ "running": true, "pid": pid }))
}

#[tauri::command]
fn llama_server_stop() -> Result<serde_json::Value, String> { let mut guard = LLAMA_SERVER.get_or_init(|| Mutex::new(None)).lock().map_err(|e| e.to_string())?; if let Some(mut child) = guard.take() { let _ = child.kill(); let _ = child.wait(); } Ok(serde_json::json!({ "running": false })) }
static EXEC_CANCEL: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();

fn http_cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    HTTP_CANCEL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn provider_cloud_cancel_registry() -> &'static Mutex<ProviderCloudCancelRegistry> {
    PROVIDER_CLOUD_CANCEL.get_or_init(|| Mutex::new(ProviderCloudCancelRegistry { active: HashMap::new(), pending: HashSet::new() }))
}

fn exec_cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    EXEC_CANCEL.get_or_init(|| Mutex::new(HashMap::new()))
}

struct HttpCancelGuard(String);

impl Drop for HttpCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = http_cancel_registry().lock() {
            registry.remove(&self.0);
        }
    }
}

fn get_db_url() -> String {
    let exe_path = env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
    let db_path = exe_dir.join("costhub.db");
    format!("sqlite:{}", db_path.display())
}

#[derive(Default)]
struct FrontendSqlitePools(RwLock<HashMap<String, SqlitePool>>);

#[derive(Debug, Deserialize)]
struct FrontendSqlRequest {
    db: String,
    query: String,
    #[serde(default)]
    values: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendSqlExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn validate_frontend_sqlite_db(db: &str) -> Result<(), String> {
    if db == get_db_url() {
        Ok(())
    } else {
        Err("数据库访问已拒绝：渲染层只能访问主业务数据库".to_string())
    }
}

fn sql_keyword(query: &str, keyword: &str) -> bool {
    query.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').any(|token| token.eq_ignore_ascii_case(keyword))
}

fn validate_frontend_sql(query: &str) -> Result<(), String> {
    if sql_keyword(query, "attach") || sql_keyword(query, "detach") || query.to_ascii_lowercase().contains("vacuum into") || sql_keyword(query, "load_extension") {
        return Err("数据库访问已拒绝：渲染层不能挂载、导出或加载其他数据库".to_string());
    }
    Ok(())
}

async fn frontend_sql_pool(db: &str, state: &State<'_, FrontendSqlitePools>) -> Result<SqlitePool, String> {
    validate_frontend_sqlite_db(db)?;
    state.0.read().await.get(db).cloned().ok_or_else(|| "数据库连接尚未加载".to_string())
}

fn bind_frontend_sql<'q>(query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, value: serde_json::Value) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match value {
        serde_json::Value::Null => query.bind(None::<String>),
        serde_json::Value::String(value) => query.bind(value),
        serde_json::Value::Number(value) => if let Some(value) = value.as_i64() { query.bind(value) } else { query.bind(value.as_f64().unwrap_or_default()) },
        serde_json::Value::Bool(value) => query.bind(if value { 1_i64 } else { 0_i64 }),
        value => query.bind(value.to_string()),
    }
}

fn sqlite_row_value(row: &SqliteRow, index: usize) -> Result<serde_json::Value, String> {
    let raw = row.try_get_raw(index).map_err(|error| error.to_string())?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }
    match raw.type_info().name() {
        "INTEGER" | "BOOLEAN" => row.try_get::<i64, _>(index).map(serde_json::Value::from).map_err(|error| error.to_string()),
        "REAL" => row.try_get::<f64, _>(index).map(serde_json::Value::from).map_err(|error| error.to_string()),
        "BLOB" => row.try_get::<Vec<u8>, _>(index).map(|value| serde_json::Value::Array(value.into_iter().map(serde_json::Value::from).collect())).map_err(|error| error.to_string()),
        _ => row.try_get::<String, _>(index).map(serde_json::Value::from).map_err(|error| error.to_string()),
    }
}

#[tauri::command]
async fn sql_load(db: String, state: State<'_, FrontendSqlitePools>) -> Result<String, String> {
    validate_frontend_sqlite_db(&db)?;
    let mut pools = state.0.write().await;
    if pools.contains_key(&db) {
        return Ok(db);
    }
    let pool = open_frontend_sql_pool(&db).await.map_err(|error| format!("无法打开或创建数据库 {db}：{error}。请将 EXE 放入本机可写文件夹后重试；不要直接在压缩包内运行。"))?;
    pools.insert(db.clone(), pool);
    Ok(db)
}

async fn open_frontend_sql_pool(db: &str) -> Result<SqlitePool, sqlx::Error> {
    // Use the actual portable filename, not URL query parsing (#/? in folder names).
    let options = if db == "sqlite::memory:" { db.parse::<SqliteConnectOptions>()? }
        else { SqliteConnectOptions::new().filename(db.strip_prefix("sqlite:").unwrap_or(db)) };
    let options = options.create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal).busy_timeout(Duration::from_secs(5));
    // ponytail: legacy BEGIN/COMMIT calls need one persistent connection; use transaction-scoped commands before increasing concurrency.
    SqlitePoolOptions::new().max_connections(1).idle_timeout(None).max_lifetime(None).connect_with(options).await
}

#[tauri::command]
async fn sql_select(request: FrontendSqlRequest, state: State<'_, FrontendSqlitePools>) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    validate_frontend_sqlite_db(request.db.as_str())?;
    validate_frontend_sql(request.query.as_str())?;
    let pool = frontend_sql_pool(request.db.as_str(), &state).await?;
    let mut query = sqlx::query(&request.query);
    for value in request.values {
        query = bind_frontend_sql(query, value);
    }
    let rows = query.fetch_all(&pool).await.map_err(|error| format!("数据库查询失败: {error}"))?;
    rows.iter().map(|row| row.columns().iter().enumerate().map(|(index, column)| sqlite_row_value(row, index).map(|value| (column.name().to_string(), value))).collect::<Result<serde_json::Map<_, _>, _>>()).collect()
}

#[tauri::command]
async fn sql_execute(request: FrontendSqlRequest, state: State<'_, FrontendSqlitePools>) -> Result<FrontendSqlExecuteResult, String> {
    validate_frontend_sqlite_db(request.db.as_str())?;
    validate_frontend_sql(request.query.as_str())?;
    let pool = frontend_sql_pool(request.db.as_str(), &state).await?;
    let mut query = sqlx::query(&request.query);
    for value in request.values {
        query = bind_frontend_sql(query, value);
    }
    let result = query.execute(&pool).await.map_err(|error| format!("数据库写入失败: {error}"))?;
    Ok(FrontendSqlExecuteResult { rows_affected: result.rows_affected(), last_insert_id: result.last_insert_rowid() })
}

#[tauri::command]
async fn sql_close(db: String, state: State<'_, FrontendSqlitePools>) -> Result<bool, String> {
    validate_frontend_sqlite_db(&db)?;
    if let Some(pool) = state.0.write().await.remove(&db) {
        pool.close().await;
    }
    Ok(true)
}

#[tauri::command]
fn get_db_path() -> String {
    get_db_url()
}

// Pi 的本机执行环境只允许访问应用创建的任务目录。cwd 不是安全边界，
// 但这层路径校验能阻止普通文件工具越界和 junction/symlink 绕过。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionFsRequest {
    workspace: String,
    op: String,
    path: String,
    #[serde(default)]
    second_path: String,
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionExecRequest {
    execution_id: String,
    workspace: String,
    command: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    shell: String,
    #[serde(default)]
    isolated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionFileInfo {
    name: String,
    path: String,
    kind: String,
    size: u64,
    mtime_ms: u128,
}

fn execution_root() -> PathBuf {
    db_dir().join("ai-workspaces")
}

#[cfg(windows)]
fn isolated_execution_root() -> Result<PathBuf, String> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(isolated_execution_root_once).clone()
}

#[cfg(windows)]
fn isolated_execution_root_once() -> Result<PathBuf, String> {
    use windows::Win32::{Foundation::{HLOCAL, LocalFree}, Security::{Authorization::ConvertSidToStringSidW, FreeSid, Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath}}};
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let name = wide("CostHub.Agent");
    let label = wide("CostHub Agent");
    let description = wide("CostHub isolated script task");
    unsafe {
        let sid = CreateAppContainerProfile(windows::core::PCWSTR(name.as_ptr()), windows::core::PCWSTR(label.as_ptr()), windows::core::PCWSTR(description.as_ptr()), None)
            .or_else(|_| DeriveAppContainerSidFromAppContainerName(windows::core::PCWSTR(name.as_ptr())))
            .map_err(|e| format!("无法创建 AppContainer: {e}"))?;
        let mut sid_text = windows::core::PWSTR::null();
        ConvertSidToStringSidW(sid, &mut sid_text).map_err(|e| format!("无法转换 AppContainer SID: {e}"))?;
        let result = GetAppContainerFolderPath(sid_text);
        let _ = LocalFree(Some(HLOCAL(sid_text.0 as *mut _)));
        let _ = FreeSid(sid);
        let path_text = result.map_err(|e| format!("无法取得 AppContainer 任务目录: {e}"))?;
        let path = path_text.to_string().map_err(|e| e.to_string());
        let _ = LocalFree(Some(HLOCAL(path_text.0 as *mut _)));
        let path = PathBuf::from(path?);
        fs::create_dir_all(&path).map_err(|e| format!("创建隔离任务根目录失败: {e}"))?;
        Ok(path)
    }
}

#[cfg(not(windows))]
fn isolated_execution_root() -> Result<PathBuf, String> { Err("当前平台没有可用的 Windows AppContainer 隔离器".into()) }

fn path_is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn lexical_execution_path(root: &Path, input: &Path) -> Result<PathBuf, String> {
    let relative = if input.is_absolute() {
        input.strip_prefix(root).map_err(|_| "文件路径越过任务目录边界".to_string())?
    } else {
        input
    };
    let mut result = root.to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if result == root { return Err("文件路径越过任务目录边界".to_string()); }
                result.pop();
            }
            std::path::Component::Normal(value) => result.push(value),
            _ => return Err("文件路径格式不受支持".to_string()),
        }
    }
    Ok(result)
}

fn canonical_execution_root(workspace: &str) -> Result<PathBuf, String> {
    let workspace = fs::canonicalize(normalize_execution_input(workspace))
        .map(|path| PathBuf::from(normalize_execution_input(&path.to_string_lossy())))
        .map_err(|e| format!("任务目录不存在: {e}"))?;
    let roots = [
        fs::canonicalize(normalize_execution_input(&execution_root().to_string_lossy()))
            .ok()
            .map(|path| PathBuf::from(normalize_execution_input(&path.to_string_lossy()))),
        isolated_execution_root().ok().and_then(|path| fs::canonicalize(normalize_execution_input(&path.to_string_lossy())).ok()).map(|path| PathBuf::from(normalize_execution_input(&path.to_string_lossy()))),
    ];
    if let Some(root) = roots.iter().flatten().find(|root| path_is_within(&workspace, root)) {
        let relative = workspace.strip_prefix(&root).unwrap_or(Path::new("")).to_path_buf();
        return Ok(PathBuf::from(normalize_execution_input(&root.join(relative).to_string_lossy())));
    }
    Err(format!("执行目录必须位于当前任务隔离目录内: {}", workspace.display()))
}

fn normalize_execution_input(input: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = input.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    input.to_string()
}

fn resolve_execution_path(workspace: &str, input: &str, allow_missing: bool) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_execution_root(workspace)?;
    let raw = PathBuf::from(normalize_execution_input(input));
    let candidate = lexical_execution_path(&root, &raw)?;
    let addressed = if candidate.exists() {
        fs::canonicalize(&candidate)
            .map(|path| PathBuf::from(normalize_execution_input(&path.to_string_lossy())))
            .map_err(|e| format!("路径不可用: {e}"))?
    } else if allow_missing {
        let mut parent = candidate.parent().ok_or_else(|| "路径没有父目录".to_string())?;
        while !parent.exists() {
            parent = parent.parent().ok_or_else(|| "路径没有可用父目录".to_string())?;
        }
        let canonical_parent = fs::canonicalize(parent)
            .map(|path| PathBuf::from(normalize_execution_input(&path.to_string_lossy())))
            .map_err(|e| format!("父目录不可用: {e}"))?;
        if !path_is_within(&canonical_parent, &root) { return Err("文件路径越过任务目录边界".to_string()); }
        candidate
    } else {
        return Err(format!("文件不存在: {}", candidate.display()));
    };
    if !path_is_within(&addressed, &root) {
        return Err("文件路径越过任务目录边界".to_string());
    }
    Ok((root, addressed))
}

fn file_info(path: &Path) -> Result<ExecutionFileInfo, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let kind = if metadata.is_file() { "file" } else if metadata.is_dir() { "directory" } else if metadata.file_type().is_symlink() { "symlink" } else { "other" };
    let mtime_ms = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or_default();
    Ok(ExecutionFileInfo { name: path.file_name().and_then(|v| v.to_str()).unwrap_or_default().to_string(), path: path.to_string_lossy().to_string(), kind: kind.to_string(), size: metadata.len(), mtime_ms })
}

#[tauri::command]
fn execution_create_workspace() -> Result<String, String> {
    fs::create_dir_all(execution_root()).map_err(|e| format!("创建任务目录失败: {e}"))?;
    let base = chrono_now_compact();
    for index in 0..100 {
        let path = execution_root().join(format!("{base}-{}-{index}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return fs::canonicalize(path).map(|p| p.to_string_lossy().to_string()).map_err(|e| format!("解析任务目录失败: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建任务目录失败: {e}")),
        }
    }
    Err("无法分配唯一任务目录".to_string())
}

#[tauri::command]
fn execution_create_isolated_workspace() -> Result<String, String> {
    let root = isolated_execution_root()?;
    let base = chrono_now_compact();
    for index in 0..100 {
        let path = root.join(format!("{base}-{}-{index}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return fs::canonicalize(path).map(|p| p.to_string_lossy().to_string()).map_err(|e| format!("解析隔离任务目录失败: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建隔离任务目录失败: {e}")),
        }
    }
    Err("无法分配唯一隔离任务目录".to_string())
}

#[tauri::command]
fn execution_skill_dirs(workspace: String) -> Result<Vec<String>, String> {
    let root = canonical_execution_root(&workspace)?;
    // Compiled resources work in portable EXE and installed builds without Node or a CDN.
    for (name, content) in [
        ("quote-analysis", include_str!("../../public/skills/quote-analysis/SKILL.md")),
        ("analysis-charts", include_str!("../../public/skills/analysis-charts/SKILL.md")),
    ] {
        let (_, path) = resolve_execution_path(&workspace, &format!(".skills/{name}/SKILL.md"), true)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
    }
    Ok(vec![root.join(".skills").to_string_lossy().into_owned()])
}

static EXEC_ENABLED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
#[cfg(windows)]
static ISOLATED_PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
#[tauri::command]
fn execution_set_enabled(workspace: String, enabled: bool) -> Result<(), String> {
    let root = canonical_execution_root(&workspace)?;
    let mut allowed = EXEC_ENABLED.get_or_init(|| Mutex::new(HashSet::new())).lock().map_err(|e| e.to_string())?;
    if enabled { allowed.insert(root); } else { allowed.remove(&root); }
    Ok(())
}

fn find_executable(name: &str) -> Option<String> {
    let locator = if cfg!(windows) { "where.exe" } else { "which" };
    let mut command = std::process::Command::new(locator);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command.arg(name).output().ok().filter(|output| output.status.success()).and_then(|output| String::from_utf8_lossy(&output.stdout).lines().next().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string))
}

fn executable_version(path: &str, args: &[&str]) -> String {
    let mut command = std::process::Command::new(path);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command.args(args).output().ok().map(|output| {
        let text = String::from_utf8_lossy(if output.stdout.is_empty() { &output.stderr } else { &output.stdout });
        text.lines().next().unwrap_or_default().trim().to_string()
    }).unwrap_or_default()
}

#[tauri::command]
fn execution_dependencies() -> serde_json::Value {
    let candidates = [
        ("powershell", if cfg!(windows) { "powershell.exe" } else { "sh" }, vec!["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
        ("python", if cfg!(windows) { "python.exe" } else { "python3" }, vec!["--version"]),
        ("node", "node", vec!["--version"]),
        ("git", if cfg!(windows) { "git.exe" } else { "git" }, vec!["--version"]),
        ("bash", if cfg!(windows) { "bash.exe" } else { "bash" }, vec!["--version"]),
    ];
    let mut result = serde_json::Map::new();
    for (name, command, args) in candidates {
        let path = find_executable(command);
        result.insert(name.to_string(), serde_json::json!({ "available": path.is_some(), "path": path.clone().unwrap_or_default(), "version": path.as_deref().map(|value| executable_version(value, &args)).unwrap_or_default() }));
    }
    serde_json::Value::Object(result)
}

#[tauri::command]
fn execution_fs(request: ExecutionFsRequest) -> Result<serde_json::Value, String> {
    let allow_missing = matches!(request.op.as_str(), "exists" | "absolute" | "join" | "write_text" | "write_binary" | "append_text" | "append_binary" | "mkdir");
    let (root, path) = resolve_execution_path(&request.workspace, &request.path, allow_missing)?;
    let mutation = matches!(request.op.as_str(), "write_text" | "write_binary" | "append_text" | "append_binary" | "rename" | "mkdir" | "remove");
    if mutation && (path == root || path.starts_with(root.join(".skills"))) { return Err("任务根目录与内置 Skills 为受保护资源".into()); }
    if matches!(request.op.as_str(), "write_text" | "write_binary" | "append_text" | "append_binary") {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?; }
    }
    match request.op.as_str() {
        "absolute" => Ok(serde_json::json!(path.to_string_lossy().to_string())),
        "join" => Ok(serde_json::json!(path.to_string_lossy().to_string())),
        "read_text" => fs::read_to_string(&path).map(serde_json::Value::String).map_err(|e| format!("读取文件失败: {e}")),
        "read_binary" => fs::read(&path).map(|data| serde_json::json!({ "base64": base64::engine::general_purpose::STANDARD.encode(data) })).map_err(|e| format!("读取文件失败: {e}")),
        "write_text" => { fs::write(&path, request.content).map_err(|e| format!("写入文件失败: {e}"))?; Ok(serde_json::Value::Null) }
        "write_binary" => {
            let data = base64::engine::general_purpose::STANDARD.decode(request.content).map_err(|e| format!("二进制内容无效: {e}"))?;
            fs::write(&path, data).map_err(|e| format!("写入文件失败: {e}"))?;
            Ok(serde_json::Value::Null)
        }
        "append_text" => { use std::io::Write; let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("打开文件失败: {e}"))?; file.write_all(request.content.as_bytes()).map_err(|e| format!("追加文件失败: {e}"))?; Ok(serde_json::Value::Null) }
        "append_binary" => { use std::io::Write; let data = base64::engine::general_purpose::STANDARD.decode(request.content).map_err(|e| format!("二进制内容无效: {e}"))?; let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("打开文件失败: {e}"))?; file.write_all(&data).map_err(|e| format!("追加文件失败: {e}"))?; Ok(serde_json::Value::Null) }
        "rename" => { let (_, target) = resolve_execution_path(&request.workspace, &request.second_path, true)?; if target == root || target.starts_with(root.join(".skills")) { return Err("目标为受保护资源".into()); } fs::rename(&path, target).map_err(|e| format!("重命名失败: {e}"))?; Ok(serde_json::Value::Null) }
        "info" => Ok(serde_json::to_value(file_info(&path)?).unwrap_or(serde_json::Value::Null)),
        "canonical" => fs::canonicalize(&path).map(|p| serde_json::json!(p.to_string_lossy().to_string())).map_err(|e| format!("解析真实路径失败: {e}")),
        "exists" => Ok(serde_json::json!(path.exists())),
        "list" => {
            if !path.is_dir() { return Err("目标不是目录".to_string()); }
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path).map_err(|e| format!("列举目录失败: {e}"))? {
                let child = entry.map_err(|e| format!("读取目录项失败: {e}"))?.path();
                entries.push(file_info(&child)?);
            }
            Ok(serde_json::to_value(entries).unwrap_or(serde_json::Value::Array(Vec::new())))
        }
        "mkdir" => { fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {e}"))?; Ok(serde_json::Value::Null) }
        "remove" => { if path.is_dir() { fs::remove_dir(&path) } else { fs::remove_file(&path) }.map_err(|e| format!("删除失败: {e}"))?; Ok(serde_json::Value::Null) }
        _ => Err(format!("不支持的文件操作: {}", request.op)),
    }
}

fn clip_execution_output(text: &str, limit: usize) -> String {
    // ponytail: fixed 12KB UI preview; full output is already persisted beside the task.
    if text.len() <= limit { return text.to_string(); }
    let mut end = limit;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}\n[输出已截断，完整输出见任务目录 .costhub-output]", &text[..end])
}

async fn kill_execution_process(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        { let _ = tokio::process::Command::new("taskkill").creation_flags(0x08000000).args(["/PID", &pid.to_string(), "/T", "/F"]).output().await; }
        #[cfg(not(windows))]
        { let _ = child.kill().await; }
    }
}

#[tauri::command]
fn execution_prepare(execution_id: String) -> Result<(), String> {
    if execution_id.is_empty() || execution_id.len() > 100 || !execution_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("执行 ID 不合法".into()); }
    let mut registry = exec_cancel_registry().lock().map_err(|e| e.to_string())?;
    if registry.len() >= 64 || registry.contains_key(&execution_id) { return Err("执行队列已满或 ID 重复".into()); }
    registry.insert(execution_id, watch::channel(false).0);
    Ok(())
}

struct ExecutionGuard(String);
impl Drop for ExecutionGuard {
    fn drop(&mut self) { if let Ok(mut registry) = exec_cancel_registry().lock() { registry.remove(&self.0); } }
}

#[cfg(windows)]
struct ExecutionJob(isize);
#[cfg(windows)]
impl ExecutionJob {
    fn attach(pid: u32) -> Result<Self, String> {
        use windows::Win32::{Foundation::CloseHandle, System::{JobObjects::*, Threading::*}};
        unsafe {
            let handle = CreateJobObjectW(None, windows::core::PCWSTR::null()).map_err(|e| e.to_string())?;
            let job = Self(handle.0 as isize);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32).map_err(|e| e.to_string())?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).map_err(|e| e.to_string())?;
            let result = AssignProcessToJobObject(handle, process).map_err(|e| e.to_string());
            let _ = CloseHandle(process);
            result?;
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for ExecutionJob {
    fn drop(&mut self) { unsafe { let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(self.0 as *mut _)); } }
}

async fn capture_execution<R: tokio::io::AsyncRead + Unpin>(mut reader: R, path: PathBuf, stream: &'static str, output: Option<tauri::ipc::Channel<serde_json::Value>>) -> Result<String, String> {
    use std::io::Write;
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut preview = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut total = 0usize;
    loop {
        let n = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        total += n;
        if total > 32 * 1024 * 1024 { return Err("命令输出超过 32MB，已停止；已有输出保留在任务目录".into()); }
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        preview.extend_from_slice(&buffer[..n]);
        if preview.len() > 12000 { preview.drain(..preview.len()-12000); }
        if let Some(channel) = &output { let _ = channel.send(serde_json::json!({"stream": stream, "text": String::from_utf8_lossy(&buffer[..n])})); }
    }
    Ok(format!("{}{}", if total > 12000 { "[仅显示末尾 12KB；全文见文件]\n" } else { "" }, String::from_utf8_lossy(&preview)))
}

#[cfg(windows)]
fn isolated_command(shell: &str, command: &str, cwd: &Path, execution_id: &str) -> Result<(i32, Vec<u8>, Vec<u8>), String> {
    use std::io::Read;
    use std::os::windows::io::FromRawHandle;
    use std::thread;
    use windows::Win32::{Foundation::{CloseHandle, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT, SetHandleInformation}, Security::{FreeSid, GetTokenInformation, Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName}, TokenIsAppContainer, TOKEN_ACCESS_MASK, TOKEN_QUERY, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES}, System::{Pipes::CreatePipe, Threading::{CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken, TerminateProcess, UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, WaitForSingleObject}}};
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let name = wide("CostHub.Agent");
    let label = wide("CostHub Agent");
    let description = wide("CostHub isolated script task");
    let sid = unsafe { CreateAppContainerProfile(windows::core::PCWSTR(name.as_ptr()), windows::core::PCWSTR(label.as_ptr()), windows::core::PCWSTR(description.as_ptr()), None).or_else(|_| DeriveAppContainerSidFromAppContainerName(windows::core::PCWSTR(name.as_ptr()))) }.map_err(|e| format!("无法创建脚本隔离容器: {e}"))?;
    let (read_in, write_in) = unsafe { let mut r = HANDLE::default(); let mut w = HANDLE::default(); CreatePipe(&mut r, &mut w, Some(&SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() }), 0).map(|_| (r, w)).map_err(|e| e.to_string())? };
    let (read_out, write_out) = unsafe { let mut r = HANDLE::default(); let mut w = HANDLE::default(); CreatePipe(&mut r, &mut w, Some(&SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() }), 0).map(|_| (r, w)).map_err(|e| e.to_string())? };
    let (read_err, write_err) = unsafe { let mut r = HANDLE::default(); let mut w = HANDLE::default(); CreatePipe(&mut r, &mut w, Some(&SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() }), 0).map(|_| (r, w)).map_err(|e| e.to_string())? };
    unsafe { SetHandleInformation(write_in, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| e.to_string())?; SetHandleInformation(read_out, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| e.to_string())?; SetHandleInformation(read_err, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| e.to_string())?; }
    let mut env_entries = Vec::<String>::new();
    let profile_root = cwd.parent().unwrap_or(cwd).to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let profile_temp = format!(r"{profile_root}\Temp");
    let _ = fs::create_dir_all(&profile_temp);
    env_entries.extend([
        format!("LOCALAPPDATA={profile_root}"), format!("APPDATA={profile_root}"), format!("TEMP={profile_temp}"), format!("TMP={profile_temp}"),
        format!("SystemRoot={}", std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())),
        format!("WINDIR={}", std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())),
    ]);
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"] {
        if key == "SystemRoot" || key == "WINDIR" || key == "TEMP" || key == "TMP" { continue; }
        if let Ok(value) = std::env::var(key) { env_entries.push(format!("{key}={value}")); }
    }
    env_entries.sort_by_key(|value| value.to_ascii_uppercase());
    let mut env = Vec::<u16>::new();
    for value in env_entries { env.extend(wide(&value)); }
    env.push(0);
    let python = shell.eq_ignore_ascii_case("python");
    let node = shell.eq_ignore_ascii_case("node");
    let executable = if python { find_executable("python.exe").unwrap_or_else(|| "python.exe".into()) } else if node { find_executable("node.exe").unwrap_or_else(|| "node.exe".into()) } else if shell.eq_ignore_ascii_case("bash") { "bash.exe".to_string() } else { find_executable("pwsh.exe").unwrap_or_else(|| format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))) };
    let quote_arg = |value: &str| format!(r#""{}""#, value.replace('"', r#"\""#));
    let command_line = if python { format!(r#""{executable}" -c {}"#, quote_arg(command)) } else if node { format!(r#""{executable}" -e {}"#, quote_arg(command)) } else if shell.eq_ignore_ascii_case("bash") { format!("{executable} -lc {command}") } else { format!(r#""{executable}" -NoProfile -NonInteractive -Command {command}"#) };
    let executable_wide = wide(&executable);
    let mut command_line = wide(&command_line);
    let mut attributes_size = 0usize;
    unsafe { let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attributes_size); }
    let mut attributes = vec![0u8; attributes_size];
    let attribute_list = LPPROC_THREAD_ATTRIBUTE_LIST(attributes.as_mut_ptr() as *mut std::ffi::c_void);
    let capabilities = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attribute_list;
    startup.StartupInfo.hStdInput = read_in;
    startup.StartupInfo.hStdOutput = write_out;
    startup.StartupInfo.hStdError = write_err;
    let mut process = PROCESS_INFORMATION::default();
    let cwd_text = cwd.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let cwd_wide = wide(&cwd_text);
    let spawn = unsafe {
        InitializeProcThreadAttributeList(Some(attribute_list), 1, None, &mut attributes_size).map_err(|e| windows::core::Error::new(e.code(), format!("属性列表: {e}")))
            .and_then(|_| UpdateProcThreadAttribute(attribute_list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, Some(&capabilities as *const _ as _), std::mem::size_of::<SECURITY_CAPABILITIES>(), None, None).map_err(|e| windows::core::Error::new(e.code(), format!("隔离能力: {e}"))))
            .and_then(|_| CreateProcessW(windows::core::PCWSTR(executable_wide.as_ptr()), Some(windows::core::PWSTR(command_line.as_mut_ptr())), None, None, true, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, Some(env.as_ptr() as _), windows::core::PCWSTR(cwd_wide.as_ptr()), &startup.StartupInfo, &mut process).map_err(|e| windows::core::Error::new(e.code(), format!("创建进程: {e}"))))
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list); let _ = CloseHandle(read_in); let _ = CloseHandle(write_in); let _ = CloseHandle(write_out); let _ = CloseHandle(write_err); }
    if let Err(error) = spawn { unsafe { let _ = CloseHandle(read_out); let _ = CloseHandle(read_err); let _ = FreeSid(sid); } return Err(format!("隔离脚本启动失败: {error}")); }
    let mut token = HANDLE::default();
    let mut is_appcontainer = 0u32;
    let mut token_size = 0u32;
    let verified = unsafe { OpenProcessToken(process.hProcess, TOKEN_ACCESS_MASK(TOKEN_QUERY.0), &mut token).is_ok() && GetTokenInformation(token, TokenIsAppContainer, Some(&mut is_appcontainer as *mut _ as _), std::mem::size_of::<u32>() as u32, &mut token_size).is_ok() && is_appcontainer != 0 };
    unsafe { let _ = CloseHandle(token); }
    if !verified { unsafe { let _ = TerminateProcess(process.hProcess, 1); let _ = WaitForSingleObject(process.hProcess, 5000); let _ = CloseHandle(process.hThread); let _ = CloseHandle(process.hProcess); let _ = CloseHandle(read_out); let _ = CloseHandle(read_err); let _ = FreeSid(sid); } return Err("隔离进程未获得 AppContainer token，已拒绝运行".into()); }
    ISOLATED_PIDS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|e| e.to_string())?.insert(execution_id.to_string(), process.dwProcessId);
    let stdout_handle = read_out.0 as usize;
    let stderr_handle = read_err.0 as usize;
    let stdout_thread = thread::spawn(move || unsafe { let mut file = std::fs::File::from_raw_handle(stdout_handle as _); let mut data = Vec::new(); file.read_to_end(&mut data).map(|_| data).map_err(|e| e.to_string()) });
    let stderr_thread = thread::spawn(move || unsafe { let mut file = std::fs::File::from_raw_handle(stderr_handle as _); let mut data = Vec::new(); file.read_to_end(&mut data).map(|_| data).map_err(|e| e.to_string()) });
    unsafe { let _ = WaitForSingleObject(process.hProcess, u32::MAX); }
    let mut exit_code = 1u32;
    unsafe { let _ = GetExitCodeProcess(process.hProcess, &mut exit_code); let _ = CloseHandle(process.hThread); let _ = CloseHandle(process.hProcess); let _ = FreeSid(sid); }
    if let Ok(mut pids) = ISOLATED_PIDS.get_or_init(|| Mutex::new(HashMap::new())).lock() { pids.remove(execution_id); }
    let stdout = stdout_thread.join().map_err(|_| "隔离脚本 stdout 读取线程失败".to_string())??;
    let stderr = stderr_thread.join().map_err(|_| "隔离脚本 stderr 读取线程失败".to_string())??;
    if stdout.len() + stderr.len() > 32 * 1024 * 1024 { return Err("命令输出超过 32MB，已停止；已有输出保留在任务目录".into()); }
    Ok((exit_code as i32, stdout, stderr))
}

#[cfg(not(windows))]
fn isolated_command(_shell: &str, _command: &str, _cwd: &Path, _execution_id: &str) -> Result<(i32, Vec<u8>, Vec<u8>), String> { Err("当前平台没有可用的 AppContainer 脚本隔离器".into()) }

#[tauri::command]
async fn execution_exec(request: ExecutionExecRequest, output: tauri::ipc::Channel<serde_json::Value>) -> Result<serde_json::Value, String> {
    let _guard = ExecutionGuard(request.execution_id.clone());
    let mut cancel_rx = exec_cancel_registry().lock().map_err(|e| e.to_string())?.get(&request.execution_id).ok_or("执行未注册")?.subscribe();
    if *cancel_rx.borrow() { return Err("命令已取消，未启动".into()); }
    let (_, cwd) = resolve_execution_path(&request.workspace, ".", false)?;
    if !EXEC_ENABLED.get_or_init(|| Mutex::new(HashSet::new())).lock().map_err(|e| e.to_string())?.contains(&cwd) { return Err("请先在当前会话启用本机命令执行".into()); }
    let timeout = request.timeout_seconds.unwrap_or(120).clamp(1, 600);
    let requested_shell = request.shell.clone();
    let shell = if request.shell.eq_ignore_ascii_case("bash") { if cfg!(windows) { "bash.exe" } else { "bash" } } else if cfg!(windows) { "powershell.exe" } else { "sh" };
    if request.isolated {
        let (_, output_dir) = resolve_execution_path(&request.workspace, ".costhub-output", true)?;
        fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
        let stdout_path = output_dir.join(format!("{}.stdout.txt", request.execution_id));
        let stderr_path = output_dir.join(format!("{}.stderr.txt", request.execution_id));
        let id = request.execution_id.clone();
        let command = request.command.clone();
        let cwd_for_worker = cwd.clone();
        let worker = tokio::task::spawn_blocking(move || isolated_command(&requested_shell, &command, &cwd_for_worker, &id));
        tokio::pin!(worker);
        let result = tokio::select! {
            result = &mut worker => result.map_err(|e| e.to_string())??,
            _ = cancel_rx.changed() => { execution_cancel(request.execution_id.clone()); return Err("隔离命令已取消".into()); },
            _ = tokio::time::sleep(Duration::from_secs(timeout)) => { execution_cancel(request.execution_id.clone()); return Err(format!("隔离命令超过 {timeout} 秒，已停止")); },
        };
        let (exit_code, stdout_bytes, stderr_bytes) = result;
        fs::write(&stdout_path, &stdout_bytes).map_err(|e| e.to_string())?;
        fs::write(&stderr_path, &stderr_bytes).map_err(|e| e.to_string())?;
        for (stream, bytes) in [("stdout", &stdout_bytes), ("stderr", &stderr_bytes)] {
            for chunk in bytes.chunks(8192) { let _ = output.send(serde_json::json!({"stream": stream, "text": String::from_utf8_lossy(chunk)})); }
        }
        let stdout = clip_execution_output(&String::from_utf8_lossy(&stdout_bytes), 12000);
        let stderr = clip_execution_output(&String::from_utf8_lossy(&stderr_bytes), 12000);
        return Ok(serde_json::json!({"stdout":stdout,"stderr":stderr,"exitCode":exit_code,"cancelled":false,"timedOut":false,"isolated":true,"fullOutputPath":stdout_path.to_string_lossy(),"stderrPath":stderr_path.to_string_lossy()}));
    }
    let mut command = tokio::process::Command::new(shell);
    if request.shell.eq_ignore_ascii_case("bash") || !cfg!(windows) { command.args(["-lc", request.command.as_str()]); } else { command.args(["-NoProfile", "-NonInteractive", "-Command", request.command.as_str()]); }
    command.current_dir(&cwd).kill_on_drop(true).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)] { command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| format!("无法启动命令: {e}"))?;
    #[cfg(windows)]
    let _job = match ExecutionJob::attach(child.id().ok_or("进程没有 ID")?) { Ok(job) => job, Err(e) => { kill_execution_process(&mut child).await; return Err(format!("无法建立进程树生命周期: {e}")); } };
    let stdout = child.stdout.take().ok_or("无法读取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法读取 stderr")?;
    let (_, output_dir) = resolve_execution_path(&request.workspace, ".costhub-output", true)?;
    fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let stdout_path = output_dir.join(format!("{}.stdout.txt", request.execution_id));
    let stderr_path = output_dir.join(format!("{}.stderr.txt", request.execution_id));
    let result = {
        let completion = async {
            tokio::try_join!(
                async { child.wait().await.map_err(|e| e.to_string()) },
                capture_execution(stdout, stdout_path.clone(), "stdout", Some(output.clone())),
                capture_execution(stderr, stderr_path.clone(), "stderr", Some(output.clone()))
            )
        };
        tokio::pin!(completion);
        tokio::select! {
            result = &mut completion => result,
            _ = cancel_rx.changed() => Err("命令已取消".into()),
            _ = tokio::time::sleep(Duration::from_secs(timeout)) => Err(format!("命令超过 {timeout} 秒，已停止")),
        }
    };
    match result {
        Ok((status, stdout, stderr)) => Ok(serde_json::json!({"stdout":stdout,"stderr":stderr,"exitCode":status.code().unwrap_or(-1),"cancelled":false,"timedOut":false,"fullOutputPath":stdout_path.to_string_lossy(),"stderrPath":stderr_path.to_string_lossy()})),
        Err(error) => { kill_execution_process(&mut child).await; Err(format!("{error}；输出文件：{}、{}", stdout_path.display(), stderr_path.display())) }
    }
}

#[tauri::command]
fn execution_cancel(execution_id: String) -> bool {
    let found = exec_cancel_registry().lock().ok().and_then(|registry| registry.get(&execution_id).cloned()).map(|sender| { sender.send_replace(true); true }).unwrap_or(false);
    #[cfg(windows)]
    if let Ok(pids) = ISOLATED_PIDS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        if let Some(pid) = pids.get(&execution_id).copied() {
            use windows::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE}};
            unsafe { if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) { let _ = TerminateProcess(process, 1); let _ = CloseHandle(process); } }
        }
    }
    found
}

#[tauri::command]
fn execution_open_path(workspace: String, path: String) -> Result<(), String> {
    let (_, target) = resolve_execution_path(&workspace, &path, false)?;
    if cfg!(windows) { std::process::Command::new("explorer.exe").arg(target).spawn().map_err(|e| format!("打开任务产物失败: {e}"))?; }
    else { std::process::Command::new("xdg-open").arg(target).spawn().map_err(|e| format!("打开任务产物失败: {e}"))?; }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialInsightDeleteRequest {
    #[serde(default)]
    root_node_ids: Vec<i64>,
    #[serde(default)]
    trend_item_ids: Vec<i64>,
    #[serde(default)]
    subject_keys: Vec<String>,
}

fn is_sqlite_locked_message(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    text.contains("database is locked")
        || text.contains("database table is locked")
        || text.contains("sqlite_busy")
        || text.contains("(code: 5)")
}

async fn delete_material_insight_subjects_once(
    db_path: &Path,
    request: &MaterialInsightDeleteRequest,
) -> Result<(), sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let mut transaction = connection.begin().await?;

    let result: Result<(), sqlx::Error> = async {
        sqlx::query("CREATE TABLE IF NOT EXISTS analysis_item_meta (item_key TEXT PRIMARY KEY, domain TEXT DEFAULT '', object_type TEXT DEFAULT '', object_id TEXT DEFAULT '', object_name TEXT DEFAULT '', favorite INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now','localtime')))")
            .execute(&mut *transaction).await?;
        let legacy_tables: HashSet<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('component_decomposition', 'component_decomposition_history', 'component_trend_mapping', 'followup_pattern_log', 'rollup_contributions', 'rollup_feedback')")
            .fetch_all(&mut *transaction).await?.into_iter().collect();
        for root_id in request.root_node_ids.iter().copied().filter(|id| *id > 0).collect::<HashSet<_>>() {
            sqlx::query("WITH RECURSIVE descendants(id) AS (SELECT id FROM decomposition_tree WHERE id = ? UNION ALL SELECT dt.id FROM decomposition_tree dt JOIN descendants d ON dt.parent_id = d.id) DELETE FROM decomposition_tree WHERE id IN (SELECT id FROM descendants)")
                .bind(root_id).execute(&mut *transaction).await?;
        }
        for trend_id in request.trend_item_ids.iter().copied().filter(|id| *id > 0).collect::<HashSet<_>>() {
            if legacy_tables.contains("component_decomposition") {
                if legacy_tables.contains("component_decomposition_history") {
                    sqlx::query("DELETE FROM component_decomposition_history WHERE component_id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM component_decomposition WHERE trend_item_id = ? UNION ALL SELECT c.id FROM component_decomposition c JOIN descendants d ON c.parent_id = d.id) SELECT id FROM descendants)").bind(trend_id).execute(&mut *transaction).await?;
                }
                if legacy_tables.contains("rollup_feedback") {
                    sqlx::query("DELETE FROM rollup_feedback WHERE component_id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM component_decomposition WHERE trend_item_id = ? UNION ALL SELECT c.id FROM component_decomposition c JOIN descendants d ON c.parent_id = d.id) SELECT id FROM descendants)").bind(trend_id).execute(&mut *transaction).await?;
                }
                if legacy_tables.contains("rollup_contributions") {
                    sqlx::query("DELETE FROM rollup_contributions WHERE child_component_id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM component_decomposition WHERE trend_item_id = ? UNION ALL SELECT c.id FROM component_decomposition c JOIN descendants d ON c.parent_id = d.id) SELECT id FROM descendants) OR parent_snapshot_id IN (SELECT id FROM trend_snapshots WHERE trend_item_id = ?)").bind(trend_id).bind(trend_id).execute(&mut *transaction).await?;
                }
                if legacy_tables.contains("component_trend_mapping") {
                    sqlx::query("DELETE FROM component_trend_mapping WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
                }
                if legacy_tables.contains("followup_pattern_log") {
                    sqlx::query("DELETE FROM followup_pattern_log WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
                }
                sqlx::query("WITH RECURSIVE descendants(id) AS (SELECT id FROM component_decomposition WHERE trend_item_id = ? UNION ALL SELECT c.id FROM component_decomposition c JOIN descendants d ON c.parent_id = d.id) DELETE FROM component_decomposition WHERE id IN (SELECT id FROM descendants)").bind(trend_id).execute(&mut *transaction).await?;
            }
            sqlx::query("DELETE FROM trend_insight_dimensions WHERE trend_snapshot_id IN (SELECT id FROM trend_snapshots WHERE trend_item_id = ?)").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_key_events WHERE trend_snapshot_id IN (SELECT id FROM trend_snapshots WHERE trend_item_id = ?)").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_snapshots WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_sources WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_conversations WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_part_mapping WHERE trend_item_id = ?").bind(trend_id).execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM trend_items WHERE id = ?").bind(trend_id).execute(&mut *transaction).await?;
        }
        for key in request.subject_keys.iter().collect::<HashSet<_>>() {
            sqlx::query("DELETE FROM analysis_item_meta WHERE item_key = ?").bind(format!("material_subject:{key}")).execute(&mut *transaction).await?;
        }
        Ok(())
    }.await;

    if let Err(error) = result {
        let _ = transaction.rollback().await;
        return Err(error);
    }
    transaction.commit().await
}

#[tauri::command]
async fn delete_material_insight_subjects(
    request: MaterialInsightDeleteRequest,
) -> Result<(), String> {
    if request.root_node_ids.is_empty()
        && request.trend_item_ids.is_empty()
        && request.subject_keys.is_empty()
    {
        return Err("删除目标为空".to_string());
    }
    let db_path = db_dir().join("costhub.db");
    let retry_delays = [100_u64, 250, 500];
    for attempt in 0..=retry_delays.len() {
        match delete_material_insight_subjects_once(&db_path, &request).await {
            Ok(()) => return Ok(()),
            Err(error)
                if is_sqlite_locked_message(&error.to_string()) && attempt < retry_delays.len() =>
            {
                tokio::time::sleep(Duration::from_millis(retry_delays[attempt])).await;
            }
            Err(error) => return Err(format!("SQLite 删除失败: {error}")),
        }
    }
    Err("SQLite 删除失败：超过最大重试次数".to_string())
}

// ========== 数据备份与恢复（exe 同目录 backups/ 文件夹） ==========
fn db_dir() -> PathBuf {
    let exe_path = env::current_exe().unwrap_or_default();
    exe_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf()
}

fn cloud_authority_db_path() -> PathBuf {
    db_dir().join("costhub-cloud-authority.db")
}

async fn cloud_authority_db() -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(cloud_authority_db_path())
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await
    .map_err(|e| format!("打开云端授权库失败：{e}"))
}

async fn ensure_cloud_grant_table(db: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("CREATE TABLE IF NOT EXISTS ai_approval_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_level TEXT DEFAULT 'C1', material TEXT NOT NULL, category TEXT DEFAULT '', question TEXT DEFAULT '', payload_hash TEXT DEFAULT '', expires_at TEXT DEFAULT '', revoked_at TEXT DEFAULT '', request_url TEXT DEFAULT '', request_method TEXT DEFAULT '', consumed_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))")
        .execute(&mut *db)
        .await
        .map_err(|e| format!("创建云端授权表失败：{e}"))?;
    // 老库补列（建表是 IF NOT EXISTS，不会自动加列）：grant_class 区分"一次性精确载荷票"与"可复用主题票"。
    let _ = sqlx::query("ALTER TABLE ai_approval_grants ADD COLUMN grant_class TEXT DEFAULT 'payload'")
        .execute(&mut *db)
        .await;
    sqlx::query("CREATE TABLE IF NOT EXISTS cloud_security_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')))")
        .execute(&mut *db)
        .await
        .map_err(|e| format!("创建云端安全设置失败：{e}"))?;
    Ok(())
}

/// 主题票最长 7 天（用户明确"审批过的不要再重复审批"）；精确载荷票维持 30 分钟。
const CLOUD_THEME_GRANT_MAX_MINUTES: i64 = 10_080;
const CLOUD_PAYLOAD_GRANT_MAX_MINUTES: i64 = 30;

const CLOUD_NETWORK_MODE_KEY: &str = "cloud_network_mode";

async fn read_cloud_network_mode() -> Result<String, String> {
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    let row = sqlx::query("SELECT value FROM cloud_security_settings WHERE key=?")
        .bind(CLOUD_NETWORK_MODE_KEY)
        .fetch_optional(&mut db)
        .await
        .map_err(|e| format!("读取云端安全设置失败：{e}"))?;
    Ok(row
        .and_then(|value| value.try_get::<String, _>("value").ok())
        .filter(|value| matches!(value.as_str(), "preview" | "auto"))
        .unwrap_or_else(|| "local_only".to_string()))
}

async fn require_cloud_network_enabled() -> Result<(), String> {
    match read_cloud_network_mode().await {
        Ok(mode) if matches!(mode.as_str(), "preview" | "auto") => Ok(()),
        Ok(_) => Err("公司纯本地模式已启用：云端授权和发送均已关闭".to_string()),
        Err(error) => Err(format!("云端策略读取失败，已拒绝云端操作：{error}")),
    }
}

#[tauri::command]
async fn get_cloud_network_mode() -> Result<String, String> {
    read_cloud_network_mode().await
}

#[tauri::command]
async fn set_cloud_network_mode(mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "local_only" | "preview" | "auto") {
        return Err("云端网络模式无效".to_string());
    }
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    sqlx::query("INSERT INTO cloud_security_settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
        .bind(CLOUD_NETWORK_MODE_KEY)
        .bind(mode)
        .execute(&mut db)
        .await
        .map_err(|e| format!("保存云端安全设置失败：{e}"))?;
    Ok(())
}

fn backups_dir() -> PathBuf {
    db_dir().join("backups")
}

/// 预留数据库备份路径。实际快照由前端通过同一 SQLite 连接执行 VACUUM INTO，
/// 避免运行中分别复制 db/WAL 造成不一致。
#[tauri::command]
fn create_backup_target() -> Result<serde_json::Value, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    // 仅保留最近 10 份自动备份，避免便携目录无限增长；文件名含本地时间，字典序即时间序。
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut old: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().map(|ext| ext == "db").unwrap_or(false))
            .collect();
        old.sort();
        while old.len() >= 10 {
            if let Some(path) = old.first().cloned() {
                let _ = fs::remove_file(&path);
                old.remove(0);
            }
        }
    }
    let ts = chrono_now_compact();
    if !db_dir().join("costhub.db").exists() {
        return Err("数据库文件不存在".to_string());
    }
    let name = format!("costhub-backup-{ts}.db");
    let dest = dir.join(&name);
    if dest.exists() {
        return Err("同名备份已存在，请稍后重试".to_string());
    }
    Ok(serde_json::json!({ "name": name, "path": dest.to_string_lossy() }))
}

/// 列出所有备份文件（按时间倒序）
#[tauri::command]
fn list_backups() -> Vec<serde_json::Value> {
    let dir = backups_dir();
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<(PathBuf, u64)> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
            .filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m.len())))
            .collect();
        files.sort_by(|a, b| b.0.file_name().cmp(&a.0.file_name()));
        for (p, size) in files {
            out.push(serde_json::json!({
                "name": p.file_name().unwrap_or_default().to_string_lossy(),
                "size": size,
                "path": p.to_string_lossy(),
            }));
        }
    }
    out
}

/// 从备份恢复：先把当前库备份为 .pre-restore，再用备份文件替换当前库
#[tauri::command]
fn restore_database(backup_name: String) -> Result<String, String> {
    // 防路径穿越
    if backup_name.contains("..") || backup_name.contains('/') || backup_name.contains('\\') {
        return Err("非法的备份文件名".to_string());
    }
    let src = backups_dir().join(&backup_name);
    if !src.exists() {
        return Err("备份文件不存在".to_string());
    }
    let db_path = db_dir().join("costhub.db");
    // 先备份当前库（恢复前保护）
    if db_path.exists() {
        let ts = chrono_now_compact();
        let _ = fs::copy(
            &db_path,
            db_dir().join(format!("costhub-pre-restore-{ts}.db")),
        );
    }
    // 移除 WAL/SHM 避免残留数据干扰
    let _ = fs::remove_file(db_dir().join("costhub.db-wal"));
    let _ = fs::remove_file(db_dir().join("costhub.db-shm"));
    fs::copy(&src, &db_path).map_err(|e| format!("恢复失败: {e}"))?;
    // 兼容旧版“主库 + WAL”备份；新版 VACUUM INTO 备份不再产生 sidecar。
    let backup_wal = backups_dir().join(format!("{backup_name}-wal"));
    if backup_wal.exists() {
        fs::copy(&backup_wal, db_dir().join("costhub.db-wal"))
            .map_err(|e| format!("恢复 WAL 失败: {e}"))?;
    }
    Ok(format!("已从 {backup_name} 恢复，请重启应用生效"))
}

/// 删除指定备份
#[tauri::command]
fn delete_backup(backup_name: String) -> Result<(), String> {
    if backup_name.contains("..") || backup_name.contains('/') || backup_name.contains('\\') {
        return Err("非法的备份文件名".to_string());
    }
    let p = backups_dir().join(&backup_name);
    fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))?;
    let _ = fs::remove_file(backups_dir().join(format!("{backup_name}-wal")));
    Ok(())
}

// ========== Excel 导出文件保存（前端生成 xlsx → base64 → 存 exports/） ==========
fn configured_export_dir(target_dir: Option<String>) -> Result<PathBuf, String> {
    let dir = target_dir.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(db_dir);
    if !dir.exists() { return Err(format!("文件保存位置不存在：{}", dir.display())); }
    if !dir.is_dir() { return Err(format!("文件保存位置不是文件夹：{}", dir.display())); }
    fs::canonicalize(&dir).map_err(|e| format!("无法解析文件保存位置：{e}"))
}

fn next_export_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() { return candidate; }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("export");
    let ext = path.extension().and_then(|v| v.to_str()).map(|v| format!(".{v}")).unwrap_or_default();
    for index in 1..10000 {
        let next = dir.join(format!("{stem} ({index}){ext}"));
        if !next.exists() { return next; }
    }
    dir.join(format!("{stem}-{}{}", chrono_now_compact(), ext))
}

/// 保存前端生成的导出文件（base64）到用户选定的工作文件夹；默认是 exe 所在文件夹。
#[tauri::command]
fn save_export_file(file_name: String, base64_data: String, target_dir: Option<String>) -> Result<String, String> {
    // 防路径穿越
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法的文件名".to_string());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("解码失败: {e}"))?;
    let protected = ["costhub.db", "costhub.db-wal", "costhub.db-shm", "costhub-cloud-authority.db"];
    if protected.iter().any(|name| name.eq_ignore_ascii_case(&file_name)) { return Err("不能覆盖程序数据库或授权文件".to_string()); }
    let dir = configured_export_dir(target_dir)?;
    let dest = next_export_path(&dir, &file_name);
    fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(dest.file_name().unwrap_or_default().to_string_lossy().to_string())
}

#[tauri::command]
fn open_exported_file(target_dir: Option<String>, file_name: String) -> Result<(), String> {
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法的文件名".to_string());
    }
    let dir = configured_export_dir(target_dir)?;
    let path = dir.join(&file_name);
    if !path.is_file() { return Err(format!("文件不存在或不是文件：{}", path.display())); }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy().to_string()])
            .spawn()
            .map_err(|e| format!("打开文件失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_exported_file(target_dir: Option<String>, file_name: String) -> Result<(), String> {
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法的文件名".to_string());
    }
    let dir = configured_export_dir(target_dir)?;
    let path = dir.join(&file_name);
    if !path.is_file() { return Err(format!("文件不存在或不是文件：{}", path.display())); }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("定位文件失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn pick_ai_work_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择 AI 工作文件夹'; $d.ShowNewFolderButton=$true; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}"#;
        let output = Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .map_err(|e| format!("打开文件夹选择器失败: {e}"))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() { return Ok(None); }
        return Ok(Some(path));
    }
    #[cfg(not(target_os = "windows"))]
    { Ok(None) }
}

#[tauri::command]
fn get_default_ai_work_folder() -> Result<String, String> { Ok(db_dir().to_string_lossy().to_string()) }

#[tauri::command]
fn open_ai_work_folder(path: Option<String>) -> Result<(), String> {
    let dir = configured_export_dir(path)?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&dir).spawn().map_err(|e| format!("打开文件夹失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn validate_ai_work_folder(path: String) -> Result<String, String> {
    Ok(configured_export_dir(Some(path))?.to_string_lossy().to_string())
}

/// 列出 exports/ 目录下的导出文件
#[tauri::command]
fn list_exports(target_dir: Option<String>) -> Vec<serde_json::Value> {
    let dir = configured_export_dir(target_dir).unwrap_or_else(|_| db_dir());
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<(PathBuf, u64)> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|value| value.to_str()).map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "xlsx" | "html" | "pptx" | "svg" | "csv" | "json")).unwrap_or(false))
            .filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m.len())))
            .collect();
        files.sort_by(|a, b| b.0.file_name().cmp(&a.0.file_name()));
        for (p, size) in files {
            out.push(serde_json::json!({
                "name": p.file_name().unwrap_or_default().to_string_lossy(),
                "size": size,
            }));
        }
    }
    out
}

/// 打开导出文件所在目录（资源管理器）
#[tauri::command]
fn open_exports_dir() -> Result<(), String> {
    let dir = db_dir();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    Ok(())
}

// 紧凑时间戳：YYYYMMDD-HHMMSS（不引入 chrono 依赖，用系统时间）
fn chrono_now_compact() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // 转换为本地时间的近似（UTC+8）
    let local = secs + 8 * 3600;
    let days = local / 86400;
    let rem = local % 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ========== Ollama 联网隔离（防火墙规则管理） ==========
const OLLAMA_BLOCK_RULE: &str = "CostHub_Block_Ollama_Outbound";

// 查找 ollama.exe 的常见安装路径
fn find_ollama_exe() -> Option<String> {
    let candidates = [
        format!(
            "{}\\Programs\\Ollama\\ollama.exe",
            env::var("LOCALAPPDATA").unwrap_or_default()
        ),
        format!(
            "{}\\Ollama\\ollama.exe",
            env::var("ProgramFiles").unwrap_or_default()
        ),
        format!(
            "{}\\Ollama\\ollama.exe",
            env::var("ProgramFiles(x86)").unwrap_or_default()
        ),
        format!(
            "{}\\Ollama\\ollama.exe",
            env::var("USERPROFILE").unwrap_or_default()
        ),
    ];
    for c in candidates.iter() {
        if std::path::Path::new(c).exists() {
            return Some(c.clone());
        }
    }
    None
}

// 以管理员权限(UAC)执行一段 PowerShell 脚本，脚本应把结果写入 result 文件
// 返回 result 文件内容
fn run_ps1_elevated(script: &str) -> Result<String, String> {
    use std::io::Write;
    let temp = env::var("TEMP").unwrap_or_else(|_| ".".to_string());
    let ps_path = format!("{}\\costhub_netlock.ps1", temp);
    let result_path = format!("{}\\costhub_netlock_result.txt", temp);
    let _ = std::fs::remove_file(&result_path);

    // 写脚本
    let full_script = format!(
        "{} \nSet-Content -Encoding UTF8 -Path '{}' -Value $LASTEXITCODE\n",
        script, result_path
    );
    // 写入临时脚本文件
    let mut f = std::fs::File::create(&ps_path).map_err(|e| format!("无法写入临时脚本: {e}"))?;
    f.write_all(full_script.as_bytes())
        .map_err(|e| format!("写入脚本失败: {e}"))?;
    drop(f);

    // 通过 UAC 提权执行
    let mut command = std::process::Command::new("powershell.exe");
    // PowerShell is used only as a short-lived helper. Keep its console hidden
    // so checking or applying the local firewall policy never interrupts the
    // desktop workflow with a flashing terminal window.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let status = command
        .args([
            "-NoProfile", "-Command",
            &format!(
                "Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'",
                ps_path
            ),
        ])
        .status()
        .map_err(|e| format!("无法启动提权进程: {e}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&ps_path);
        return Err("需要管理员授权，或用户取消了授权窗口".to_string());
    }

    // 等待结果文件出现（最多 10 秒）
    let mut content = String::new();
    for _ in 0..40 {
        if std::path::Path::new(&result_path).exists() {
            if let Ok(s) = std::fs::read_to_string(&result_path) {
                content = s;
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = std::fs::remove_file(&result_path);
    let _ = std::fs::remove_file(&ps_path);
    Ok(content.trim().to_string())
}

#[tauri::command]
fn ollama_net_status() -> Result<serde_json::Value, String> {
    let exe = find_ollama_exe();
    // PowerShell 按规则属性判断，避免 netsh 输出随 Windows 显示语言变化。
    let query = format!(
        "$r=Get-NetFirewallRule -DisplayName '{}' -ErrorAction SilentlyContinue | Where-Object {{$_.Enabled -eq 'True' -and $_.Direction -eq 'Outbound' -and $_.Action -eq 'Block'}}; if($r){{'BLOCKED'}}",
        OLLAMA_BLOCK_RULE
    );
    let mut command = std::process::Command::new("powershell.exe");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = command
        .args(["-NoProfile", "-Command", &query])
        .output()
        .map_err(|e| format!("无法查询防火墙规则: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let query_ok = out.status.success();
    // 查询失败时必须按未隔离处理：没有可验证的防火墙规则就不能发送成本提示词。
    let blocked = query_ok && stdout.contains("BLOCKED");
    Ok(serde_json::json!({
        "ollama_found": exe.is_some(),
        "ollama_path": exe.unwrap_or_default(),
        "blocked": blocked,
        "rule_name": OLLAMA_BLOCK_RULE,
        "query_error": if query_ok { String::new() } else { stderr.clone() },
    }))
}

#[tauri::command]
async fn ollama_net_enable_block() -> Result<serde_json::Value, String> {
    let exe = match find_ollama_exe() {
        Some(e) => e,
        None => return Err("未找到 ollama.exe，请先安装 Ollama".to_string()),
    };
    // 拼 PowerShell 脚本，用 UAC 提权执行 netsh（避免卡 UI，async 下在后台线程运行）
    // 只提供“锁定”，不向前端暴露解除能力；若确需更新模型，应退出 CostHub 后由管理员手工管理规则。
    let script = format!(
        "netsh advfirewall firewall delete rule name={0} 2>$null; netsh advfirewall firewall add rule name={0} dir=out action=block program=\"{1}\" profile=any enable=yes; exit $LASTEXITCODE",
        OLLAMA_BLOCK_RULE, exe
    );
    let code = run_ps1_elevated(&script)?;
    Ok(serde_json::json!({ "ok": true, "blocked": true, "detail": code }))
}

fn require_ollama_isolated() -> Result<(), String> {
    let status = ollama_net_status()?;
    if status
        .get("blocked")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        http_log("BLOCKED prompt delivery: Ollama outbound firewall isolation is not verified");
        Err("安全策略已阻止发送：请先到“设置 → 本地 AI”一键锁定 Ollama 外网，确认防火墙隔离后才能让模型读取成本数据".to_string())
    }
}

#[tauri::command]
fn list_security_events() -> Vec<String> {
    let path = db_dir().join("costhub-http.log");
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .rev()
        .filter(|line| line.contains("BLOCKED"))
        .take(50)
        .map(str::to_string)
        .collect()
}

// 机密模式网络边界：应用的 HTTP 命令只允许访问本机回环地址。
// 这是 Rust 侧最终闸门，前端提示词、Skill、模型工具调用都无法绕过。
fn http_log(msg: &str) {
    eprintln!("[costhub-http] {}", msg);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("costhub-http.log"))
            {
                use std::io::Write;
                let _ = writeln!(f, "{} {}", chrono::Local::now().format("%H:%M:%S"), msg);
            }
        }
    }
}

fn normalize_loopback_url(url: &str) -> Result<reqwest::Url, String> {
    let mut parsed =
        reqwest::Url::parse(url).map_err(|_| "网络请求已拦截：URL 无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("网络请求已拦截：只允许本机 HTTP/HTTPS".to_string());
    }
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    match host.as_str() {
        // localhost 强制改写为字面量，避免 hosts/DNS 被篡改后解析到非本机地址。
        "localhost" => parsed
            .set_host(Some("127.0.0.1"))
            .map_err(|_| "网络请求已拦截：本机地址无效".to_string())?,
        "127.0.0.1" | "::1" => {}
        _ => {
            http_log(&format!(
                "BLOCKED outbound target: {}://{}",
                parsed.scheme(),
                host
            ));
            return Err(
                "机密模式已拦截外部网络请求：仅允许本机 Ollama（127.0.0.1 / ::1）".to_string(),
            );
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod network_policy_tests {
    use super::{
        approval_payload_hash, normalize_loopback_url, provider_binding_for_config,
        provider_endpoint_matches, register_provider_cloud_cancel, safe_provider_headers,
        validate_cloud_request, cancel_provider_cloud_http_request, provider_cloud_select, CloudApproval, CloudHttpRequest,
        Sha256,
    };
    use sha2::Digest;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::task::Poll;

    #[test]
    fn allows_only_loopback_targets() {
        assert_eq!(
            normalize_loopback_url("http://localhost:11434/api/tags")
                .unwrap()
                .host_str(),
            Some("127.0.0.1")
        );
        assert!(normalize_loopback_url("http://127.0.0.1:11434/api/tags").is_ok());
        assert!(normalize_loopback_url("http://[::1]:11434/api/tags").is_ok());
        assert!(normalize_loopback_url("https://api.example.com/v1/chat").is_err());
        assert!(normalize_loopback_url("http://192.168.1.8:11434/api/chat").is_err());
        assert!(normalize_loopback_url("http://10.0.0.8:11434/api/chat").is_err());
    }

    #[test]
    fn cloud_gateway_requires_review_scope_and_allowlisted_host() {
        let safe = CloudHttpRequest {
            url: "https://api.tavily.com/search".into(),
            method: "POST".into(),
            body: Some(r#"{"query":"液晶面板 公开市场趋势"}"#.into()),
            approval: CloudApproval {
                material: "液晶面板".into(),
                category: "硬件类".into(),
                question: "公开市场趋势".into(),
                reviewed: true,
                grant_id: Some(1),
                payload_hash: Some(approval_payload_hash("液晶面板", "硬件类", "公开市场趋势")),
                expires_at: Some("2099-01-01 00:00:00".into()),
                scope_level: Some("C1".into()),
            },
        };
        assert!(validate_cloud_request(&safe).is_ok());
        let leaked = CloudHttpRequest {
            body: Some(r#"{"query":"液晶面板","project_code":"M270","bom_cost":900}"#.into()),
            ..safe
        };
        assert!(validate_cloud_request(&leaked).is_err());
    }

    #[test]
    fn c2_gateway_accepts_abstract_body_and_rejects_tampering() {
        let body = r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"只基于抽象等级特征回答。"},{"role":"user","content":"{\"scope_level\":\"C2\",\"domain\":\"显示器产品\",\"features\":{\"refresh_band\":\"high\",\"size_band\":\"medium\"},\"question\":\"判断公开市场趋势\"}"}]}"#;
        let safe = CloudHttpRequest {
            url: "https://api.deepseek.com/chat/completions".into(),
            method: "POST".into(),
            body: Some(body.into()),
            approval: CloudApproval {
                material: "显示器产品".into(),
                category: "C2".into(),
                question: "判断公开市场趋势".into(),
                reviewed: true,
                grant_id: Some(2),
                payload_hash: Some(format!("{:x}", Sha256::digest(body.as_bytes()))),
                expires_at: Some("2099-01-01 00:00:00".into()),
                scope_level: Some("C2".into()),
            },
        };
        assert!(validate_cloud_request(&safe).is_ok());
        let tampered = CloudHttpRequest {
            body: Some(body.replace("high", "low")),
            ..safe
        };
        assert!(validate_cloud_request(&tampered).is_err());
    }

    #[test]
    fn cloud_safe_context_accepts_fixed_public_projection_only() {
        let body = r#"{"model":"public-model","messages":[{"role":"system","content":"你是 CostHub 公共信息助手。只能依据本次提供的公开内容回答；不要索取、推断或复原任何本地项目、BOM、报价、成本、供应商、文件或内部工具信息。证据不足时明确说明未知。"},{"role":"user","content":"公开市场趋势"}]}"#;
        let safe = CloudHttpRequest {
            url: "https://api.deepseek.com/chat/completions".into(),
            method: "POST".into(),
            body: Some(body.into()),
            approval: CloudApproval {
                material: "公开上下文".into(),
                category: "公开模型上下文".into(),
                question: "仅依据已批准公开内容回答用户问题".into(),
                reviewed: true,
                grant_id: Some(3),
                payload_hash: Some(format!("{:x}", Sha256::digest(body.as_bytes()))),
                expires_at: Some("2099-01-01 00:00:00".into()),
                scope_level: Some("C1_PUBLIC_CONTEXT".into()),
            },
        };
        assert!(validate_cloud_request(&safe).is_ok());
        let leaked = CloudHttpRequest { body: Some(body.replace("公开市场趋势", "project_code=M270")), ..safe };
        assert!(validate_cloud_request(&leaked).is_err());
    }

    #[test]
    fn provider_binding_fixes_endpoint_auth_and_rejects_caller_headers() {
        let (endpoint, mode, name) = provider_binding_for_config("search", "Serper", "https://google.serper.dev").unwrap();
        assert_eq!(endpoint, "https://google.serper.dev/search");
        assert_eq!((mode.as_str(), name.as_str()), ("header", "X-API-KEY"));
        let actual = reqwest::Url::parse("https://google.serper.dev/search?q=x").unwrap();
        assert!(provider_endpoint_matches(&endpoint, &actual));
        assert!(!provider_endpoint_matches(&endpoint, &reqwest::Url::parse("https://api.tavily.com/search").unwrap()));
        assert!(safe_provider_headers(std::collections::HashMap::from([("Authorization".into(), "caller-token".into())])).is_err());
    }

    #[test]
    fn provider_cloud_cancel_covers_active_and_pre_start_races() {
        let active_id = format!("test-active-{}", std::process::id());
        let (receiver, guard) = register_provider_cloud_cancel(&active_id).unwrap();
        assert!(cancel_provider_cloud_http_request(active_id).unwrap());
        assert!(*receiver.borrow());
        drop(guard);

        let pending_id = format!("test-pending-{}", std::process::id());
        assert!(!cancel_provider_cloud_http_request(pending_id.clone()).unwrap());
        let (receiver, guard) = register_provider_cloud_cancel(&pending_id).unwrap();
        assert!(*receiver.borrow());
        drop(guard);
    }

    #[test]
    fn provider_cloud_cancel_stops_before_send_and_during_response_read() {
        tauri::async_runtime::block_on(async {
            let before_register = format!("test-before-register-{}", std::process::id());
            assert!(!cancel_provider_cloud_http_request(before_register.clone()).unwrap());
            let (mut receiver, guard) = register_provider_cloud_cancel(&before_register).unwrap();
            let started = Arc::new(AtomicBool::new(false));
            let started_in_future = started.clone();
            let result = provider_cloud_select(&mut receiver, async move {
                started_in_future.store(true, Ordering::SeqCst);
                Ok::<_, String>(())
            }).await;
            assert!(result.is_err());
            assert!(!started.load(Ordering::SeqCst));
            drop(guard);

            let after_register = format!("test-after-register-{}", std::process::id());
            let (mut receiver, guard) = register_provider_cloud_cancel(&after_register).unwrap();
            assert!(cancel_provider_cloud_http_request(after_register).unwrap());
            let started = Arc::new(AtomicBool::new(false));
            let started_in_future = started.clone();
            let result = provider_cloud_select(&mut receiver, async move {
                started_in_future.store(true, Ordering::SeqCst);
                Ok::<_, String>(())
            }).await;
            assert!(result.is_err());
            assert!(!started.load(Ordering::SeqCst));
            drop(guard);

            let during_read = format!("test-during-read-{}", std::process::id());
            let (mut receiver, guard) = register_provider_cloud_cancel(&during_read).unwrap();
            let read_started = Arc::new(AtomicBool::new(false));
            let read_started_in_future = read_started.clone();
            let read_request_id = during_read.clone();
            let result = provider_cloud_select(&mut receiver, std::future::poll_fn(move |_cx| {
                read_started_in_future.store(true, Ordering::SeqCst);
                cancel_provider_cloud_http_request(read_request_id.clone()).unwrap();
                Poll::Pending::<Result<(), String>>
            })).await;
            assert!(result.is_err());
            assert!(read_started.load(Ordering::SeqCst));
            drop(guard);
        });
    }
}

#[cfg(test)]
mod cloud_grant_tests {
    use super::{validate_cloud_request_with_grant_at_path, CloudApproval, CloudHttpRequest, Sha256};
    use sha2::Digest;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode};
    use sqlx::{Connection, Executor};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn test_path() -> PathBuf { std::env::temp_dir().join(format!("costhub-cloud-grant-{}.db", std::process::id())) }

    async fn connect(path: &Path) -> SqliteConnection {
        SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(path).create_if_missing(true).journal_mode(SqliteJournalMode::Wal).busy_timeout(Duration::from_secs(1)),
        ).await.unwrap()
    }

    async fn grant(path: &Path, id: i64, body: &str, url: &str, revoked: &str, expires: &str) {
        let mut db = connect(path).await;
        sqlx::query("INSERT INTO ai_approval_grants (id, scope_level, material, category, question, payload_hash, expires_at, revoked_at, request_url, request_method, consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id).bind("C2").bind("显示器产品").bind("C2").bind("判断公开市场趋势")
            .bind(format!("{:x}", Sha256::digest(body.as_bytes()))).bind(expires).bind(revoked).bind(url).bind("POST").bind("")
            .execute(&mut db).await.unwrap();
        db.close().await.unwrap();
    }

    fn request(body: &str, url: &str, grant_id: i64) -> CloudHttpRequest {
        CloudHttpRequest {
            url: url.into(), method: "POST".into(), body: Some(body.into()),
            approval: CloudApproval {
                material: "显示器产品".into(), category: "C2".into(), question: "判断公开市场趋势".into(), reviewed: true,
                grant_id: Some(grant_id), payload_hash: Some(format!("{:x}", Sha256::digest(body.as_bytes()))), expires_at: Some("2099-01-01 00:00:00".into()), scope_level: Some("C2".into()),
            },
        }
    }

    async fn prepare(path: &Path) {
        let mut db = connect(path).await;
        db.execute("CREATE TABLE ai_approval_grants (id INTEGER PRIMARY KEY, scope_level TEXT, material TEXT, category TEXT, question TEXT, payload_hash TEXT, expires_at TEXT, revoked_at TEXT, request_url TEXT, request_method TEXT, consumed_at TEXT)").await.unwrap();
        db.close().await.unwrap();
    }

    #[test]
    fn grant_gate_rejects_invalid_binding_and_consumes_c2_once() {
        tauri::async_runtime::block_on(async {
            let path = test_path();
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("db-wal"));
            let _ = fs::remove_file(path.with_extension("db-shm"));
            prepare(&path).await;
            let body = r#"{"model":"deepseek-chat","messages":[{"role":"system","content":"只基于抽象等级特征回答。"},{"role":"user","content":"{\"scope_level\":\"C2\",\"domain\":\"显示器产品\",\"features\":{\"refresh_band\":\"high\"},\"question\":\"判断公开市场趋势\"}"}]}"#;
            let url = "https://api.deepseek.com/chat/completions";
            grant(&path, 1, body, url, "", "2099-01-01 00:00:00").await;
            assert!(validate_cloud_request_with_grant_at_path(&request(body, url, 1), &path).await.is_ok());
            assert!(validate_cloud_request_with_grant_at_path(&request(body, url, 1), &path).await.is_err(), "重放必须在发送前失败");

            grant(&path, 2, body, url, "", "2099-01-01 00:00:00").await;
            assert!(validate_cloud_request_with_grant_at_path(&request(&body.replace("high", "low"), url, 2), &path).await.is_err());
            grant(&path, 3, body, url, "", "2099-01-01 00:00:00").await;
            assert!(validate_cloud_request_with_grant_at_path(&request(body, "https://api.deepseek.com/other", 3), &path).await.is_err());
            grant(&path, 4, body, url, "2026-09-03 00:00:00", "2099-01-01 00:00:00").await;
            assert!(validate_cloud_request_with_grant_at_path(&request(body, url, 4), &path).await.is_err());
            grant(&path, 5, body, url, "", "2020-01-01 00:00:00").await;
            assert!(validate_cloud_request_with_grant_at_path(&request(body, url, 5), &path).await.is_err());
            assert!(validate_cloud_request_with_grant_at_path(&request(body, url, 999), &path).await.is_err());
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("db-wal"));
            let _ = fs::remove_file(path.with_extension("db-shm"));
        });
    }
}

#[cfg(test)]
mod material_insight_delete_tests {
    use super::{
        delete_material_insight_subjects_once, is_sqlite_locked_message,
        MaterialInsightDeleteRequest,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode};
    use sqlx::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("costhub-{name}-{}.db", std::process::id()))
    }

    async fn connect(path: &PathBuf) -> SqliteConnection {
        SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(1)),
        )
        .await
        .unwrap()
    }

    #[test]
    fn deletes_material_subject_data_atomically() {
        tauri::async_runtime::block_on(async {
            let path = test_path("delete");
            let _ = fs::remove_file(&path);
            let mut db = connect(&path).await;
            for schema in [
                "CREATE TABLE decomposition_tree (id INTEGER PRIMARY KEY, parent_id INTEGER, component_name TEXT, trend_item_id INTEGER)",
                "CREATE TABLE trend_items (id INTEGER PRIMARY KEY, query_category TEXT)",
                "CREATE TABLE trend_snapshots (id INTEGER PRIMARY KEY, trend_item_id INTEGER)",
                "CREATE TABLE trend_insight_dimensions (id INTEGER PRIMARY KEY, trend_snapshot_id INTEGER)",
                "CREATE TABLE trend_key_events (id INTEGER PRIMARY KEY, trend_snapshot_id INTEGER)",
                "CREATE TABLE trend_sources (id INTEGER PRIMARY KEY, trend_item_id INTEGER)",
                "CREATE TABLE trend_conversations (id INTEGER PRIMARY KEY, trend_item_id INTEGER)",
                "CREATE TABLE trend_part_mapping (id INTEGER PRIMARY KEY, trend_item_id INTEGER)",
                "CREATE TABLE component_decomposition (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES component_decomposition(id), trend_item_id INTEGER REFERENCES trend_items(id))",
                "CREATE TABLE component_decomposition_history (id INTEGER PRIMARY KEY, component_id INTEGER REFERENCES component_decomposition(id) ON DELETE CASCADE)",
                "CREATE TABLE component_trend_mapping (id INTEGER PRIMARY KEY, component_id INTEGER, trend_item_id INTEGER REFERENCES trend_items(id) ON DELETE CASCADE)",
                "CREATE TABLE followup_pattern_log (id INTEGER PRIMARY KEY, trend_item_id INTEGER REFERENCES trend_items(id) ON DELETE CASCADE)",
                "CREATE TABLE rollup_contributions (id INTEGER PRIMARY KEY, parent_snapshot_id INTEGER REFERENCES trend_snapshots(id) ON DELETE CASCADE, child_component_id INTEGER REFERENCES component_decomposition(id) ON DELETE CASCADE)",
                "CREATE TABLE rollup_feedback (id INTEGER PRIMARY KEY, component_id INTEGER REFERENCES component_decomposition(id) ON DELETE CASCADE)",
                "CREATE TABLE analysis_item_meta (item_key TEXT PRIMARY KEY)",
            ] { sqlx::query(schema).execute(&mut db).await.unwrap(); }
            for insert in [
                "INSERT INTO decomposition_tree VALUES (1,NULL,'父节点',10)",
                "INSERT INTO decomposition_tree VALUES (2,1,'子节点',11)",
                "INSERT INTO trend_items VALUES (10,'父节点')",
                "INSERT INTO trend_items VALUES (11,'子节点')",
                "INSERT INTO trend_snapshots VALUES (100,11)",
                "INSERT INTO trend_insight_dimensions VALUES (101,100)",
                "INSERT INTO trend_key_events VALUES (102,100)",
                "INSERT INTO trend_sources VALUES (103,11)",
                "INSERT INTO trend_conversations VALUES (104,11)",
                "INSERT INTO trend_part_mapping VALUES (105,11)",
                "INSERT INTO component_decomposition VALUES (201,NULL,NULL)",
                "INSERT INTO component_decomposition VALUES (202,201,11)",
                "INSERT INTO component_decomposition VALUES (203,202,NULL)",
                "INSERT INTO component_decomposition_history VALUES (204,202)",
                "INSERT INTO component_trend_mapping VALUES (205,202,11)",
                "INSERT INTO followup_pattern_log VALUES (206,11)",
                "INSERT INTO rollup_contributions VALUES (207,100,202)",
                "INSERT INTO rollup_feedback VALUES (208,202)",
                "INSERT INTO analysis_item_meta VALUES ('material_subject:tree:1')",
            ] {
                sqlx::query(insert).execute(&mut db).await.unwrap();
            }
            db.close().await.unwrap();

            delete_material_insight_subjects_once(
                &path,
                &MaterialInsightDeleteRequest {
                    root_node_ids: vec![1, 1],
                    trend_item_ids: vec![10, 11, 10],
                    subject_keys: vec!["tree:1".into(), "tree:1".into()],
                },
            )
            .await
            .unwrap();

            let mut check = connect(&path).await;
            for table in [
                "decomposition_tree",
                "trend_items",
                "trend_snapshots",
                "trend_insight_dimensions",
                "trend_key_events",
                "trend_sources",
                "trend_conversations",
                "trend_part_mapping",
                "analysis_item_meta",
            ] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&mut check)
                    .await
                    .unwrap();
                assert_eq!(count, 0, "{table} should be empty");
            }
            let remaining_components: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM component_decomposition")
                    .fetch_one(&mut check)
                    .await
                    .unwrap();
            assert_eq!(
                remaining_components, 1,
                "unrelated legacy component should remain"
            );
            for table in [
                "component_decomposition_history",
                "component_trend_mapping",
                "followup_pattern_log",
                "rollup_contributions",
                "rollup_feedback",
            ] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&mut check)
                    .await
                    .unwrap();
                assert_eq!(count, 0, "{table} should be empty");
            }
            check.close().await.unwrap();
            let _ = fs::remove_file(&path);
        });
    }

    #[test]
    fn failed_delete_rolls_back_parent_tree() {
        tauri::async_runtime::block_on(async {
            let path = test_path("rollback");
            let _ = fs::remove_file(&path);
            let mut db = connect(&path).await;
            sqlx::query("CREATE TABLE decomposition_tree (id INTEGER PRIMARY KEY, parent_id INTEGER, component_name TEXT, trend_item_id INTEGER)").execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO decomposition_tree VALUES (1,NULL,'父节点',10)")
                .execute(&mut db)
                .await
                .unwrap();
            db.close().await.unwrap();
            let result = delete_material_insight_subjects_once(
                &path,
                &MaterialInsightDeleteRequest {
                    root_node_ids: vec![1],
                    trend_item_ids: vec![10],
                    subject_keys: vec![],
                },
            )
            .await;
            assert!(result.is_err());
            let mut check = connect(&path).await;
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decomposition_tree")
                .fetch_one(&mut check)
                .await
                .unwrap();
            assert_eq!(count, 1);
            check.close().await.unwrap();
            let _ = fs::remove_file(&path);
        });
    }

    #[test]
    fn recognizes_lock_errors_without_treating_other_errors_as_busy() {
        assert!(is_sqlite_locked_message(
            "error returned from database: (code: 5) database is locked"
        ));
        assert!(is_sqlite_locked_message("database table is locked"));
        assert!(!is_sqlite_locked_message("constraint failed"));
    }

    #[test]
    fn parses_frontend_camel_case_delete_request() {
        let request: MaterialInsightDeleteRequest = serde_json::from_str(
            r#"{"rootNodeIds":[1],"trendItemIds":[10,11],"subjectKeys":["tree:1"]}"#,
        )
        .unwrap();
        assert_eq!(request.root_node_ids, vec![1]);
        assert_eq!(request.trend_item_ids, vec![10, 11]);
        assert_eq!(request.subject_keys, vec!["tree:1"]);
    }
}

fn build_loopback_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        // 禁止本机服务用 30x 把请求导向公网；重定向必须由调用方显式处理且仍会经过本闸门。
        .redirect(reqwest::redirect::Policy::none());
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    builder
        .build()
        .map_err(|e| format!("HTTP client initialization failed: {e}"))
}

const CLOUD_HOST_ALLOWLIST: &[&str] = &[
    "api.tavily.com",
    "google.serper.dev",
    "api.search.brave.com",
    "api.bochaai.com",
    "api.bing.microsoft.com",
    "www.searchapi.io",
    "api.exa.ai",
    "api.deepseek.com",
    "api.openai.com",
    "api.siliconflow.cn",
    "open.bigmodel.cn",
    "api.moonshot.cn",
    "dashscope.aliyuncs.com",
    "ark.cn-beijing.volces.com",
    "api.hunyuan.cloud.tencent.com",
    "generativelanguage.googleapis.com",
    "api.groq.com",
    "openrouter.ai",
    "api-inference.modelscope.cn",
];

/// 在受信任的后端签发授权票：C1 绑定规范化主题，C2 绑定完整脱敏请求体。
/// 前端不再直接写 ai_approval_grants，也不能自带 payload_hash 冒充签发结果。
#[tauri::command]
async fn create_cloud_approval_grant(
    request: CreateCloudApprovalGrantRequest,
) -> Result<CloudApprovalGrantResponse, String> {
    require_cloud_network_enabled().await?;
    let scope = request.scope_level.trim().to_uppercase();
    if !matches!(scope.as_str(), "C1" | "C1_PUBLIC_MODEL" | "C1_PUBLIC_CONTEXT" | "C1_NATIVE_SEARCH" | "C2") {
        return Err("云端授权作用域无效".to_string());
    }
    let material = request.material.trim().to_string();
    let category = request.category.trim().to_string();
    let question = request.question.trim().to_string();
    if material.is_empty() || material.chars().count() > 80 || category.chars().count() > 50 {
        return Err("云端授权主题无效或过长".to_string());
    }
    if scope == "C2" {
        if question.is_empty() || question.chars().count() > 600 {
            return Err("C2 授权问题无效或过长".to_string());
        }
    } else if question.chars().count() > 200 {
        return Err("公开检索问题无效或过长".to_string());
    }
    if scope != "C1_PUBLIC_MODEL" && scope != "C1_PUBLIC_CONTEXT" && scope != "C1_NATIVE_SEARCH" && material.chars().any(|c| c.is_ascii_digit()) {
        return Err("物料名疑似包含型号或规格数字".to_string());
    }
    let preview_json = request.preview_json.trim().to_string();
    let mut full_search_body: Option<String> = None;
    if scope == "C2" {
        if preview_json.is_empty() || preview_json.len() > 200_000 {
            return Err("C2 授权必须包含受审查的脱敏请求体".to_string());
        }
        validate_c2_body(&preview_json, &material, &question)?;
    } else if scope == "C1_PUBLIC_CONTEXT" {
        if preview_json.is_empty() || preview_json.len() > 200_000 {
            return Err("CloudSafe 授权必须包含受审查的实际请求体".to_string());
        }
        validate_public_context_body(&preview_json)?;
    } else if scope == "C1_NATIVE_SEARCH" {
        if preview_json.is_empty() || preview_json.len() > 200_000 {
            return Err("原生搜索授权必须包含受审查的实际请求体".to_string());
        }
        validate_native_search_body(&preview_json, &material, &question)?;
    } else if !preview_json.is_empty() && preview_json.len() > 200_000 {
        return Err("公开检索审批载荷过大".to_string());
    }

    let request_url = request.request_url.trim().to_string();
    if (scope == "C2" || scope == "C1_PUBLIC_CONTEXT" || scope == "C1_NATIVE_SEARCH") && request_url.is_empty() {
        return Err("该授权必须绑定请求 URL".to_string());
    }
    if !request_url.is_empty() {
        let parsed = reqwest::Url::parse(&request_url).map_err(|_| "云端授权 URL 无效".to_string())?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        if parsed.scheme() != "https" || !CLOUD_HOST_ALLOWLIST.contains(&host.as_str()) {
            return Err("云端授权 URL 不在 HTTPS 白名单".to_string());
        }
        if scope == "C1_NATIVE_SEARCH" && !parsed.path().trim_end_matches('/').ends_with("/responses") {
            return Err("原生搜索授权只允许绑定 /responses 端点".to_string());
        }
    }
    let request_method = request.request_method.trim().to_uppercase();
    if !request_method.is_empty() && !matches!(request_method.as_str(), "GET" | "POST") {
        return Err("云端授权方法只允许 GET/POST".to_string());
    }
    if (scope == "C2" || scope == "C1_PUBLIC_CONTEXT" || scope == "C1_NATIVE_SEARCH") && request_method != "POST" {
        return Err("该授权只允许绑定 POST 请求".to_string());
    }
    if (scope == "C1" || scope == "C1_PUBLIC_MODEL") && !preview_json.is_empty() {
        if request_url.is_empty() || (request_method != "GET" && request_method != "POST") {
            return Err("公开检索完整授权必须绑定 URL 和 GET/POST 方法".to_string());
        }
        let preview: serde_json::Value = serde_json::from_str(&preview_json)
            .map_err(|_| "公开检索完整授权载荷必须是合法 JSON".to_string())?;
        let preview_method = preview.get("method").and_then(|value| value.as_str()).unwrap_or("").to_ascii_uppercase();
        let preview_url = preview.get("url").and_then(|value| value.as_str()).unwrap_or("");
        if preview_method != request_method || preview_url != request_url {
            return Err("公开检索完整授权的 URL/方法不一致".to_string());
        }
        full_search_body = Some(preview.get("body").and_then(|value| value.as_str()).unwrap_or("").to_string());
    }
    // 授权分级：theme = 公开检索主题票（同一主题有效期内不再重复询问，最长 7 天）；
    // 其余（含 C1_PUBLIC_CONTEXT / C2 这类整份正文哈希票）保持 30 分钟一次性语义。
    let grant_class = match request.grant_class.trim().to_ascii_lowercase().as_str() {
        "theme" => "theme",
        _ => "payload",
    };
    if grant_class == "theme" && scope != "C1" && scope != "C1_PUBLIC_MODEL" {
        return Err("长效主题授权只支持公开检索主题（C1 / 公开型号）".to_string());
    }
    let max_minutes = if grant_class == "theme" { CLOUD_THEME_GRANT_MAX_MINUTES } else { CLOUD_PAYLOAD_GRANT_MAX_MINUTES };
    let minutes = request.expires_minutes.clamp(1, max_minutes);
    let payload_hash = if scope == "C2" || scope == "C1_PUBLIC_CONTEXT" || scope == "C1_NATIVE_SEARCH" {
        format!("{:x}", Sha256::digest(preview_json.as_bytes()))
    } else if let Some(body) = full_search_body.as_deref() {
        c1_search_payload_hash(&request_method, &request_url, Some(body))
    } else {
        approval_payload_hash(&material, &category, &question)
    };
    let mut connection = cloud_authority_db().await.map_err(|e| format!("创建云端授权失败：{e}"))?;
    ensure_cloud_grant_table(&mut connection).await.map_err(|e| format!("创建云端授权失败：{e}"))?;
    sqlx::query("INSERT INTO ai_approval_grants (scope_level, material, category, question, payload_hash, expires_at, request_url, request_method, grant_class) VALUES (?,?,?,?,?,datetime('now','localtime',?),?,?,?)")
        .bind(&scope)
        .bind(&material)
        .bind(&category)
        .bind(&question)
        .bind(&payload_hash)
        .bind(format!("+{minutes} minutes"))
        .bind(&request_url)
        .bind(&request_method)
        .bind(grant_class)
        .execute(&mut connection)
        .await
        .map_err(|e| format!("创建云端授权失败：无法写入授权记录：{e}"))?;
    let row = sqlx::query("SELECT id, expires_at FROM ai_approval_grants WHERE rowid=last_insert_rowid()")
        .fetch_one(&mut connection)
        .await
        .map_err(|e| format!("创建云端授权失败：无法读取授权记录：{e}"))?;
    Ok(CloudApprovalGrantResponse {
        id: row.try_get("id").unwrap_or_default(),
        scope_level: scope,
        material,
        category,
        question,
        payload_hash,
        expires_at: row.try_get("expires_at").unwrap_or_default(),
        request_url,
        request_method,
        grant_class: grant_class.to_string(),
    })
}

#[tauri::command]
async fn get_valid_cloud_approval_grant(
    request: FindCloudApprovalGrantRequest,
) -> Result<Option<CloudApprovalGrantResponse>, String> {
    require_cloud_network_enabled().await?;
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    let rows = sqlx::query("SELECT id, scope_level, material, category, question, payload_hash, expires_at, request_url, request_method, COALESCE(grant_class,'payload') AS grant_class FROM ai_approval_grants WHERE material=? AND category=? AND question=? AND COALESCE(revoked_at,'')='' AND expires_at > datetime('now','localtime') ORDER BY id DESC LIMIT 50")
        .bind(request.material.trim())
        .bind(request.category.trim())
        .bind(request.question.trim())
        .fetch_all(&mut db)
        .await
        .map_err(|e| format!("读取云端授权失败：{e}"))?;
    for row in rows {
        let scope = row.try_get::<String, _>("scope_level").unwrap_or_default();
        let payload_hash = row.try_get::<String, _>("payload_hash").unwrap_or_default();
        let request_url = row.try_get::<String, _>("request_url").unwrap_or_default();
        if request.scope_level.as_deref().is_some_and(|value| value != scope)
            || request.payload_hash.as_deref().is_some_and(|value| value != payload_hash)
            || request.request_url.as_deref().is_some_and(|value| value != request_url)
        {
            continue;
        }
        return Ok(Some(CloudApprovalGrantResponse {
            id: row.try_get("id").unwrap_or_default(),
            scope_level: scope,
            material: row.try_get("material").unwrap_or_default(),
            category: row.try_get("category").unwrap_or_default(),
            question: row.try_get("question").unwrap_or_default(),
            payload_hash,
            expires_at: row.try_get("expires_at").unwrap_or_default(),
            request_url,
            request_method: row.try_get("request_method").unwrap_or_default(),
            grant_class: row.try_get("grant_class").unwrap_or_else(|_| "payload".to_string()),
        }));
    }
    Ok(None)
}

#[tauri::command]
async fn revoke_cloud_approval_grant(id: i64) -> Result<(), String> {
    if id <= 0 { return Ok(()); }
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    sqlx::query("UPDATE ai_approval_grants SET revoked_at=datetime('now','localtime') WHERE id=?")
        .bind(id)
        .execute(&mut db)
        .await
        .map_err(|e| format!("撤销云端授权失败：{e}"))?;
    Ok(())
}

#[tauri::command]
async fn get_active_cloud_approval_grants() -> Result<Vec<CloudApprovalGrantResponse>, String> {
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    let rows = sqlx::query("SELECT id, scope_level, material, category, question, payload_hash, expires_at, request_url, request_method, COALESCE(grant_class,'payload') AS grant_class FROM ai_approval_grants WHERE COALESCE(revoked_at,'')='' AND expires_at > datetime('now','localtime') ORDER BY id DESC")
        .fetch_all(&mut db)
        .await
        .map_err(|e| format!("读取云端授权失败：{e}"))?;
    Ok(rows.into_iter().map(|row| CloudApprovalGrantResponse {
        id: row.try_get("id").unwrap_or_default(),
        scope_level: row.try_get("scope_level").unwrap_or_default(),
        material: row.try_get("material").unwrap_or_default(),
        category: row.try_get("category").unwrap_or_default(),
        question: row.try_get("question").unwrap_or_default(),
        payload_hash: row.try_get("payload_hash").unwrap_or_default(),
        expires_at: row.try_get("expires_at").unwrap_or_default(),
        request_url: row.try_get("request_url").unwrap_or_default(),
        request_method: row.try_get("request_method").unwrap_or_default(),
        grant_class: row.try_get("grant_class").unwrap_or_else(|_| "payload".to_string()),
    }).collect())
}

#[tauri::command]
async fn revoke_active_cloud_approval_grants() -> Result<(), String> {
    let mut db = cloud_authority_db().await?;
    ensure_cloud_grant_table(&mut db).await?;
    sqlx::query("UPDATE ai_approval_grants SET revoked_at=datetime('now','localtime') WHERE COALESCE(revoked_at,'')='' AND expires_at > datetime('now','localtime')")
        .execute(&mut db)
        .await
        .map_err(|e| format!("撤销云端授权失败：{e}"))?;
    Ok(())
}

fn validate_cloud_request(request: &CloudHttpRequest) -> Result<reqwest::Url, String> {
    validate_cloud_request_internal(request, false)
}

fn validate_cloud_request_with_injected_secret(request: &CloudHttpRequest) -> Result<reqwest::Url, String> {
    validate_cloud_request_internal(request, true)
}

fn validate_cloud_request_internal(request: &CloudHttpRequest, allow_injected_secret: bool) -> Result<reqwest::Url, String> {
    if !request.approval.reviewed {
        return Err("云端请求已拦截：尚未通过发送前审查/审批".to_string());
    }
    let grant_id = request
        .approval
        .grant_id
        .ok_or_else(|| "云端请求已拦截：缺少授权记录".to_string())?;
    let payload_hash = request.approval.payload_hash.as_deref().unwrap_or_default();
    let expires_at = request.approval.expires_at.as_deref().unwrap_or_default();
    if grant_id <= 0 || payload_hash.len() != 64 || expires_at.is_empty() {
        return Err("云端请求已拦截：授权记录无效".to_string());
    }
    let expires = chrono::NaiveDateTime::parse_from_str(expires_at, "%Y-%m-%d %H:%M:%S")
        .map_err(|_| "云端请求已拦截：授权有效期无效".to_string())?;
    if expires <= chrono::Local::now().naive_local() {
        return Err("云端请求已拦截：授权已过期".to_string());
    }
    let body = request.body.as_deref().unwrap_or_default();
    if body.len() > 200_000 {
        return Err("云端请求已拦截：请求体超过安全上限".to_string());
    }
    let material = request.approval.material.trim();
    let category = request.approval.category.trim();
    let question = request.approval.question.trim();
    if request.approval.scope_level.as_deref() == Some("C2") {
        let body_digest = Sha256::digest(body.as_bytes());
        if payload_hash != format!("{body_digest:x}") {
            return Err("云端请求已拦截：C2 请求体哈希不匹配".to_string());
        }
        validate_c2_body(body, material, question)?;
    } else if request.approval.scope_level.as_deref() == Some("C1_PUBLIC_CONTEXT") {
        let body_digest = Sha256::digest(body.as_bytes());
        if payload_hash != format!("{body_digest:x}") {
            return Err("云端请求已拦截：CloudSafe 实际请求体哈希不匹配".to_string());
        }
        validate_public_context_body(body)?;
    } else if request.approval.scope_level.as_deref() == Some("C1_NATIVE_SEARCH") {
        let body_digest = Sha256::digest(body.as_bytes());
        if payload_hash != format!("{body_digest:x}") {
            return Err("云端请求已拦截：原生搜索实际请求体哈希不匹配".to_string());
        }
        validate_native_search_body(body, material, question)?;
    } else {
        let theme_hash = approval_payload_hash(material, category, question);
        let full_hash = c1_search_payload_hash(&request.method, &request.url, request.body.as_deref());
        if payload_hash != theme_hash && payload_hash != full_hash {
            return Err("云端请求已拦截：授权 payload 哈希不匹配".to_string());
        }
    }
    if material.is_empty()
        || material.chars().count() > 80
        || category.chars().count() > 50
        || question.chars().count() > 200
    {
        return Err("云端请求已拦截：审批范围无效或过长".to_string());
    }
    let scope = request.approval.scope_level.as_deref().unwrap_or("C1");
    if !matches!(scope, "C1" | "C1_PUBLIC_MODEL" | "C1_PUBLIC_CONTEXT" | "C1_NATIVE_SEARCH" | "C2") {
        return Err("云端请求已拦截：授权作用域无效".to_string());
    }
    if scope != "C1_PUBLIC_MODEL" && scope != "C1_PUBLIC_CONTEXT" && scope != "C1_NATIVE_SEARCH"
        && (material.chars().any(|c| c.is_ascii_digit())
            || (scope != "C2" && category.chars().any(|c| c.is_ascii_digit())))
    {
        return Err("云端请求已拦截：物料名/品类疑似包含型号或规格数字".to_string());
    }
    if scope == "C1_PUBLIC_CONTEXT" {
        validate_public_context_body(body)?;
    } else if scope == "C1_NATIVE_SEARCH" {
        validate_native_search_body(body, material, question)?;
    }
    if scope != "C2" && scope != "C1_NATIVE_SEARCH" {
        let body_lower = body.to_ascii_lowercase();
        // 公开行情正文可以合法出现货币符号；只拦截本地数据字段和明确的内部数据标签。
        let forbidden = [
            "project_code",
            "supplier_name",
            "bom_cost",
            "market_price",
            "part_model",
            "项目代号",
            "内部成本",
            "我司成本",
        ];
        if forbidden
            .iter()
            .any(|token| body_lower.contains(&token.to_ascii_lowercase()))
        {
            return Err("云端请求已拦截：请求体疑似包含项目、供应商、型号或成本字段".to_string());
        }
    }
    let parsed =
        reqwest::Url::parse(&request.url).map_err(|_| "云端请求已拦截：URL 无效".to_string())?;
    let decoded_query = parsed
        .query_pairs()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");
    if scope != "C2" && scope != "C1_PUBLIC_CONTEXT" && scope != "C1_NATIVE_SEARCH" {
        validate_public_search_fields(body, &parsed, allow_injected_secret)?;
        validate_public_query_binding(body, &parsed, material, question)?;
    }
    // 请求必须与本次已审查的公开主题相关，不能拿一张空白审批票发送其他内容。
    if scope != "C2" && scope != "C1_NATIVE_SEARCH" {
        let related = if scope == "C1_PUBLIC_CONTEXT" {
            body.contains("\"messages\"")
        } else {
            body.contains(material)
                || decoded_query.contains(material)
                || (!category.is_empty()
                    && (body.contains(category) || decoded_query.contains(category)))
        };
        if !related {
            return Err("云端请求已拦截：请求内容与已审批主题不一致".to_string());
        }
    }
    if parsed.scheme() != "https" {
        return Err("云端请求已拦截：只允许 HTTPS".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !CLOUD_HOST_ALLOWLIST.contains(&host.as_str()) {
        http_log(&format!("BLOCKED cloud host: {}", host));
        return Err(format!("云端请求已拦截：目标域名不在白名单（{}）", host));
    }
    if scope != "C2" && parsed.path().contains("..") {
        return Err("云端请求已拦截：检索路径无效".to_string());
    }
    Ok(parsed)
}

fn validate_public_scalar(key: &str, value: &str, allow_injected_secret: bool) -> bool {
    match key {
        "freshness" => matches!(value, "Month" | "pm" | "oneMonth"),
        "search_depth" => value == "basic",
        "max_results" | "num" | "numResults" | "count" => value.parse::<u64>().map(|n| (1..=20).contains(&n)).unwrap_or(false),
        "gl" => value == "cn",
        "hl" => matches!(value, "zh-CN" | "zh-hans"),
        "mkt" => value == "zh-CN",
        "tbs" => value == "qdr:m3",
        "search_lang" => value == "zh-hans",
        "summary" => value == "true",
        "include_answer" => value == "false",
        "type" => value == "auto",
        "engine" => value == "google",
        "api_key" => allow_injected_secret && !value.is_empty() && value.len() <= 512 && !value.chars().any(|c| c.is_control()),
        _ => false,
    }
}

fn validate_public_search_fields(body: &str, url: &reqwest::Url, allow_injected_secret: bool) -> Result<(), String> {
    let query_keys = ["query", "q", "search", "keyword", "text"];
    if !body.trim().is_empty() {
        let value: serde_json::Value = serde_json::from_str(body)
            .map_err(|_| "云端请求已拦截：公开检索请求体必须是合法 JSON".to_string())?;
        let object = value
            .as_object()
            .ok_or_else(|| "云端请求已拦截：公开检索请求体结构无效".to_string())?;
        for (key, value) in object {
            if query_keys.contains(&key.as_str()) {
                if value.as_str().is_none() {
                    return Err("云端请求已拦截：公开检索查询词必须是文本".to_string());
                }
                continue;
            }
            let valid = match key.as_str() {
                "contents" => value.as_object().is_some_and(|object| object.len() == 1
                    && object.get("text").and_then(|text| text.as_object()).is_some_and(|text| {
                        text.len() == 1 && text.get("maxCharacters").and_then(|n| n.as_u64()) == Some(500)
                    })),
                "summary" | "include_answer" => value.is_boolean(),
                "max_results" | "num" | "numResults" | "count" => value.as_u64().is_some_and(|n| (1..=20).contains(&n)),
                _ => value.as_str().is_some_and(|text| validate_public_scalar(key, text, allow_injected_secret)),
            };
            if !valid {
                return Err(format!("云端请求已拦截：公开检索字段 {key} 的类型或取值无效"));
            }
        }
    }
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("云端请求已拦截：URL 查询参数重复".to_string());
        }
        if !query_keys.contains(&key.as_ref()) && !validate_public_scalar(&key, &value, allow_injected_secret) {
            return Err(format!("云端请求已拦截：URL 查询参数 {key} 的取值无效"));
        }
    }
    Ok(())
}

fn normalize_public_query(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// C1 请求只允许后端可复算的“物料 + 已批准问题”查询词，避免调用方在已批准主题后拼接私有文本。
/// 固定分页/地区参数仍由各搜索适配器携带；查询正文和 URL 查询参数必须与批准内容一致。
fn validate_public_query_binding(body: &str, url: &reqwest::Url, material: &str, question: &str) -> Result<(), String> {
    let expected = normalize_public_query(&format!("{material} {question}"));
    let query_keys = ["query", "q", "search", "keyword", "text"];
    let mut found = false;
    if !body.trim().is_empty() {
        let value: serde_json::Value = serde_json::from_str(body)
            .map_err(|_| "云端请求已拦截：公开检索请求体必须是合法 JSON".to_string())?;
        let object = value
            .as_object()
            .ok_or_else(|| "云端请求已拦截：公开检索请求体结构无效".to_string())?;
        for key in query_keys {
            if let Some(query) = object.get(key) {
                let query = query
                    .as_str()
                    .ok_or_else(|| "云端请求已拦截：公开检索查询词必须是文本".to_string())?;
                found = true;
                if normalize_public_query(query) != expected {
                    return Err("云端请求已拦截：查询词超出已批准的公开主题范围".to_string());
                }
            }
        }
    }
    for (key, value) in url.query_pairs() {
        if query_keys.contains(&key.as_ref()) {
            found = true;
            if normalize_public_query(&value) != expected {
                return Err("云端请求已拦截：URL 查询词超出已批准的公开主题范围".to_string());
            }
        }
    }
    if !found {
        return Err("云端请求已拦截：缺少与批准主题绑定的公开查询词".to_string());
    }
    Ok(())
}

async fn validate_cloud_request_with_grant(request: &CloudHttpRequest) -> Result<reqwest::Url, String> {
    validate_cloud_request_with_grant_at_path(request, &cloud_authority_db_path()).await
}

async fn validate_cloud_request_with_grant_at_path(request: &CloudHttpRequest, db_path: &Path) -> Result<reqwest::Url, String> {
    let url = validate_cloud_request(request)?;
    let grant_id = request.approval.grant_id.ok_or_else(|| "云端请求已拦截：缺少授权记录".to_string())?;
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options).await.map_err(|e| format!("云端请求已拦截：无法读取授权记录：{e}"))?;
    let grant = sqlx::query("SELECT scope_level, material, category, question, payload_hash, expires_at, revoked_at, request_url, request_method, consumed_at FROM ai_approval_grants WHERE id=?")
        .bind(grant_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| format!("云端请求已拦截：读取授权记录失败：{e}"))?
        .ok_or_else(|| "云端请求已拦截：授权记录不存在".to_string())?;
    let scope: String = grant.try_get("scope_level").unwrap_or_default();
    let material: String = grant.try_get("material").unwrap_or_default();
    let category: String = grant.try_get("category").unwrap_or_default();
    let question: String = grant.try_get("question").unwrap_or_default();
    let payload_hash: String = grant.try_get("payload_hash").unwrap_or_default();
    let expires_at: String = grant.try_get("expires_at").unwrap_or_default();
    let revoked_at: String = grant.try_get("revoked_at").unwrap_or_default();
    let request_url: String = grant.try_get("request_url").unwrap_or_default();
    let request_method: String = grant.try_get("request_method").unwrap_or_default();
    let consumed_at: String = grant.try_get("consumed_at").unwrap_or_default();
    let request_scope = request.approval.scope_level.as_deref().unwrap_or("C1");
    if !revoked_at.trim().is_empty() || scope != request_scope || material.trim() != request.approval.material.trim() || category.trim() != request.approval.category.trim() || question.trim() != request.approval.question.trim() || payload_hash != request.approval.payload_hash.as_deref().unwrap_or_default() {
        return Err("云端请求已拦截：授权记录与请求范围不一致或已撤销".to_string());
    }
    let grant_expires = chrono::NaiveDateTime::parse_from_str(&expires_at, "%Y-%m-%d %H:%M:%S").map_err(|_| "云端请求已拦截：授权记录有效期无效".to_string())?;
    if grant_expires <= chrono::Local::now().naive_local() {
        return Err("云端请求已拦截：授权记录已过期".to_string());
    }
    if request_scope != "C2" && !request_url.trim().is_empty() {
        let expected = reqwest::Url::parse(request_url.trim()).map_err(|_| "云端请求已拦截：授权端点无效".to_string())?;
        let same_endpoint = expected.scheme() == url.scheme()
            && expected.host_str() == url.host_str()
            && expected.port_or_known_default() == url.port_or_known_default()
            && expected.path().trim_end_matches('/') == url.path().trim_end_matches('/');
        if !same_endpoint {
            return Err("云端请求已拦截：实际 URL 未包含在授权端点中".to_string());
        }
        let allowed_query_keys = ["q", "query", "search", "keyword", "text", "freshness", "search_depth", "max_results", "num", "numResults", "count", "engine", "search_lang", "api_key", "key", "token", "gl", "hl", "mkt", "tbs"];
        if url.query_pairs().any(|(key, value)| {
            let key_ok = allowed_query_keys.contains(&key.as_ref());
            let value_lower = value.to_ascii_lowercase();
            !key_ok || ["project_code", "supplier_name", "bom_cost", "market_price", "part_model", "项目代号", "内部成本", "我司成本"].iter().any(|token| value_lower.contains(&token.to_ascii_lowercase()))
        }) {
            return Err("云端请求已拦截：URL 查询参数不在公开检索白名单".to_string());
        }
        if !request_method.trim().is_empty() && request_method.trim().to_ascii_uppercase() != request.method.trim().to_ascii_uppercase() {
            return Err("云端请求已拦截：请求方法未包含在授权内容中".to_string());
        }
    }
    if request_scope == "C2" {
        let expected_url = request_url.trim();
        let actual_url = url.as_str();
        if expected_url.is_empty() || expected_url != actual_url || request_method.trim().to_ascii_uppercase() != request.method.trim().to_ascii_uppercase() {
            return Err("云端请求已拦截：实际 URL 或方法未包含在授权内容中".to_string());
        }
        if !consumed_at.trim().is_empty() {
            return Err("云端请求已拦截：C2 单次授权已使用".to_string());
        }
        let mut transaction = connection.begin().await.map_err(|e| format!("云端请求已拦截：授权消费失败：{e}"))?;
        let consumed = sqlx::query("UPDATE ai_approval_grants SET consumed_at=datetime('now','localtime') WHERE id=? AND scope_level='C2' AND COALESCE(consumed_at,'')=''")
            .bind(grant_id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| format!("云端请求已拦截：授权消费失败：{e}"))?;
        if consumed.rows_affected() != 1 {
            transaction.rollback().await.ok();
            return Err("云端请求已拦截：C2 单次授权已使用".to_string());
        }
        transaction.commit().await.map_err(|e| format!("云端请求已拦截：授权消费失败：{e}"))?;
    }
    Ok(url)
}

fn validate_native_search_body(body: &str, material: &str, _question: &str) -> Result<(), String> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "原生搜索请求体不是合法 JSON".to_string())?;
    let object = root
        .as_object()
        .ok_or_else(|| "原生搜索请求体结构无效".to_string())?;
    let allowed_keys = ["model", "tools", "input", "max_output_tokens"];
    if !object.keys().all(|key| allowed_keys.contains(&key.as_str())) {
        return Err("原生搜索请求体包含未批准的字段".to_string());
    }
    let model = object.get("model").and_then(|value| value.as_str()).unwrap_or("");
    if model.is_empty() || model.len() > 120 {
        return Err("原生搜索模型字段无效".to_string());
    }
    let tools = object
        .get("tools")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "原生搜索缺少 tools".to_string())?;
    if tools.len() != 1 {
        return Err("原生搜索只允许一个 web_search 工具".to_string());
    }
    let tool = tools[0]
        .as_object()
        .ok_or_else(|| "原生搜索工具结构无效".to_string())?;
    if tool.len() != 1 || tool.get("type").and_then(|value| value.as_str()) != Some("web_search") {
        return Err("原生搜索只允许 web_search".to_string());
    }
    let input = object
        .get("input")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "原生搜索缺少 input 消息".to_string())?;
    if input.is_empty() || input.len() > 8 {
        return Err("原生搜索消息数量无效".to_string());
    }
    for message in input {
        let message_object = message
            .as_object()
            .ok_or_else(|| "原生搜索消息结构无效".to_string())?;
        if !message_object.keys().all(|key| matches!(key.as_str(), "role" | "content")) {
            return Err("原生搜索消息包含额外字段".to_string());
        }
        let role = message_object.get("role").and_then(|value| value.as_str()).unwrap_or_default();
        let content = message_object.get("content").and_then(|value| value.as_str()).unwrap_or_default();
        if !matches!(role, "system" | "user" | "assistant") || content.is_empty() || content.len() > 12_000 {
            return Err("原生搜索消息字段无效".to_string());
        }
        let lower = content.to_ascii_lowercase();
        let forbidden = [
            "project_code",
            "supplier_name",
            "bom_cost",
            "market_price",
            "part_model",
            "项目代号",
            "内部成本",
            "我司成本",
        ];
        if forbidden
            .iter()
            .any(|token| lower.contains(&token.to_ascii_lowercase()))
        {
            return Err("原生搜索消息疑似包含本地业务字段".to_string());
        }
    }
    let max_output = object
        .get("max_output_tokens")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "原生搜索缺少 max_output_tokens".to_string())?;
    if max_output == 0 || max_output > 8000 {
        return Err("原生搜索 max_output_tokens 无效".to_string());
    }
    if !body.contains(material.trim()) {
        return Err("原生搜索请求未包含已批准的物料主题".to_string());
    }
    Ok(())
}

fn validate_public_context_body(body: &str) -> Result<(), String> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "云端请求已拦截：CloudSafe 请求体不是合法 JSON".to_string())?;
    let object = root
        .as_object()
        .ok_or_else(|| "云端请求已拦截：CloudSafe 请求体结构无效".to_string())?;
    if !object.keys().all(|key| matches!(key.as_str(), "model" | "messages")) {
        return Err("云端请求已拦截：CloudSafe 只允许模型和消息字段".to_string());
    }
    if object.get("model").and_then(|value| value.as_str()).map(|value| value.is_empty() || value.len() > 120).unwrap_or(true) {
        return Err("云端请求已拦截：CloudSafe 模型字段无效".to_string());
    }
    let messages = object
        .get("messages")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "云端请求已拦截：CloudSafe 缺少消息".to_string())?;
    if messages.is_empty() || messages.len() > 64 {
        return Err("云端请求已拦截：CloudSafe 消息数量无效".to_string());
    }
    let mut has_safe_system = false;
    for message in messages {
        let message_object = message
            .as_object()
            .ok_or_else(|| "云端请求已拦截：CloudSafe 消息结构无效".to_string())?;
        if !message_object.keys().all(|key| matches!(key.as_str(), "role" | "content")) {
            return Err("云端请求已拦截：CloudSafe 消息包含额外字段".to_string());
        }
        let role = message_object.get("role").and_then(|value| value.as_str()).unwrap_or_default();
        let content = message_object.get("content").and_then(|value| value.as_str()).unwrap_or_default();
        if !matches!(role, "system" | "user" | "assistant") || content.is_empty() || content.len() > 12_000 {
            return Err("云端请求已拦截：CloudSafe 消息字段无效".to_string());
        }
        let fixed_system = content == "你是 CostHub 公共信息助手。只能依据本次提供的公开内容回答；不要索取、推断或复原任何本地项目、BOM、报价、成本、供应商、文件或内部工具信息。证据不足时明确说明未知。";
        if fixed_system {
            has_safe_system = true;
        }
        let forbidden = [
            "project_code", "supplier_name", "bom_cost", "market_price", "part_model",
            "项目代号", "供应商报价", "目标成本", "内部成本", "我司成本", "BOM",
        ];
        if !fixed_system && forbidden.iter().any(|token| content.to_ascii_lowercase().contains(&token.to_ascii_lowercase())) {
            return Err("云端请求已拦截：CloudSafe 消息疑似包含本地业务字段".to_string());
        }
    }
    if !has_safe_system {
        return Err("云端请求已拦截：CloudSafe 缺少固定系统边界".to_string());
    }
    Ok(())
}

struct ProviderCloudCancelGuard(String);

impl Drop for ProviderCloudCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = provider_cloud_cancel_registry().lock() {
            registry.active.remove(&self.0);
        }
    }
}

fn register_provider_cloud_cancel(request_id: &str) -> Result<(watch::Receiver<bool>, ProviderCloudCancelGuard), String> {
    let (sender, receiver) = watch::channel(false);
    let mut registry = provider_cloud_cancel_registry().lock().map_err(|_| "云端请求取消注册表不可用".to_string())?;
    let cancelled_before_start = registry.pending.remove(request_id);
    registry.active.insert(request_id.to_string(), sender.clone());
    if cancelled_before_start { let _ = sender.send(true); }
    Ok((receiver, ProviderCloudCancelGuard(request_id.to_string())))
}

#[tauri::command]
fn cancel_provider_cloud_http_request(request_id: String) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() { return Err("云端请求缺少 request_id".into()); }
    let mut registry = provider_cloud_cancel_registry().lock().map_err(|_| "云端请求取消注册表不可用".to_string())?;
    if let Some(sender) = registry.active.get(request_id).cloned() {
        sender.send(true).map_err(|_| "云端请求已经结束".to_string())?;
        Ok(true)
    } else {
        // 记录尚未进入网络 future 的取消，避免取消与注册之间的竞态导致请求仍被发送。
        registry.pending.insert(request_id.to_string());
        Ok(false)
    }
}

async fn provider_cloud_select<T, F>(cancel_rx: &mut watch::Receiver<bool>, request: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    if *cancel_rx.borrow() {
        return Err("受控云端请求已取消，网络 future 已终止".into());
    }
    tokio::select! {
        biased;
        _ = cancel_rx.changed() => Err("受控云端请求已取消，网络 future 已终止".into()),
        result = request => result,
    }
}

fn validate_c2_body(body: &str, material: &str, question: &str) -> Result<(), String> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "云端请求已拦截：C2 请求体不是合法 JSON".to_string())?;
    let object = root
        .as_object()
        .ok_or_else(|| "云端请求已拦截：C2 请求体结构无效".to_string())?;
    if !object
        .keys()
        .all(|key| matches!(key.as_str(), "model" | "messages"))
    {
        return Err("云端请求已拦截：C2 只允许模型和抽象消息字段".to_string());
    }
    let model = object
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if model.is_empty() || model.len() > 120 {
        return Err("云端请求已拦截：C2 模型字段无效".to_string());
    }
    let messages = object
        .get("messages")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "云端请求已拦截：C2 缺少消息".to_string())?;
    if messages.len() != 2 {
        return Err("云端请求已拦截：C2 只允许一条系统消息和一条用户消息".to_string());
    }
    let user_content = messages
        .iter()
        .find_map(|message| {
            (message.get("role").and_then(|value| value.as_str()) == Some("user"))
                .then(|| message.get("content").and_then(|value| value.as_str()))
                .flatten()
        })
        .ok_or_else(|| "云端请求已拦截：C2 缺少用户抽象特征".to_string())?;
    for message in messages {
        let role = message
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let content = message
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if !matches!(role, "system" | "user")
            || content.is_empty()
            || (role == "system" && contains_c2_forbidden(content))
        {
            return Err("云端请求已拦截：C2 消息包含非抽象内容".to_string());
        }
    }
    let payload: serde_json::Value = serde_json::from_str(user_content)
        .map_err(|_| "云端请求已拦截：C2 抽象特征不是合法 JSON".to_string())?;
    let payload_object = payload
        .as_object()
        .ok_or_else(|| "云端请求已拦截：C2 抽象特征结构无效".to_string())?;
    if !payload_object.keys().all(|key| {
        matches!(
            key.as_str(),
            "scope_level" | "domain" | "features" | "question"
        )
    }) || payload_object
        .get("scope_level")
        .and_then(|value| value.as_str())
        != Some("C2")
    {
        return Err("云端请求已拦截：C2 抽象字段不完整".to_string());
    }
    let domain = payload_object
        .get("domain")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let abstract_question = payload_object
        .get("question")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if domain != material
        || abstract_question != question
        || domain.is_empty()
        || domain.len() > 240
        || abstract_question.len() > 600
        || contains_c2_forbidden(domain)
        || contains_c2_forbidden(abstract_question)
    {
        return Err("云端请求已拦截：C2 审批主题与请求体不一致".to_string());
    }
    let features = payload_object
        .get("features")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "云端请求已拦截：C2 特征必须是对象".to_string())?;
    if features.is_empty() || features.len() > 9 {
        return Err("云端请求已拦截：C2 特征数量无效".to_string());
    }
    for (key, value) in features {
        if !matches!(
            key.as_str(),
            "size_band"
                | "resolution_band"
                | "refresh_band"
                | "panel_band"
                | "tier_band"
                | "module_band"
                | "supply_signal"
                | "demand_signal"
                | "availability_signal"
        ) || !matches!(
            value.as_str(),
            Some("low") | Some("medium") | Some("high") | Some("unknown")
        ) {
            return Err("云端请求已拦截：C2 特征不在白名单".to_string());
        }
    }
    Ok(())
}

fn contains_c2_forbidden(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_ascii_digit() || matches!(ch, '¥' | '￥' | '$'))
        || [
            "项目",
            "物料编码",
            "型号",
            "规格",
            "供应商",
            "公司",
            "客户",
            "BOM",
            "成本",
            "价格",
            "报价",
            "金额",
            "采购",
            "订单",
            "合同",
        ]
        .iter()
        .any(|token| {
            value
                .to_ascii_lowercase()
                .contains(&token.to_ascii_lowercase())
        })
}

fn approval_payload_hash(material: &str, category: &str, question: &str) -> String {
    let canonical = serde_json::json!({ "material": material.trim(), "category": category.trim(), "question": question.trim() }).to_string();
    let digest = Sha256::digest(canonical.as_bytes());
    format!("{digest:x}")
}

/// C1 公开检索完整绑定：批准与发送必须使用完全相同的 method/url/body。
fn c1_search_payload_hash(method: &str, url: &str, body: Option<&str>) -> String {
    let canonical = format!(
        "{}\n{}\n{}",
        method.trim().to_ascii_uppercase(),
        url.trim(),
        body.unwrap_or("")
    );
    let digest = Sha256::digest(canonical.as_bytes());
    format!("{digest:x}")
}

fn build_cloud_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                if let Ok(proxy) = reqwest::Proxy::all(value.trim()) {
                    builder = builder.proxy(proxy);
                    break;
                }
            }
        }
    }
    builder
        .build()
        .map_err(|e| format!("云端安全客户端初始化失败: {e}"))
}

#[cfg(windows)]
fn protect_provider_secret(secret: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = secret.as_bytes();
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| format!("保护供应商密钥失败: {e}"))?;
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut std::ffi::c_void)));
        Ok(base64::engine::general_purpose::STANDARD.encode(protected))
    }
}

#[cfg(not(windows))]
fn protect_provider_secret(_secret: &str) -> Result<String, String> {
    Err("供应商密钥保险库仅支持 Windows DPAPI".to_string())
}

#[cfg(windows)]
fn unprotect_provider_secret(protected: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(protected).map_err(|e| format!("读取供应商密钥失败: {e}"))?;
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| format!("解锁供应商密钥失败: {e}"))?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut std::ffi::c_void)));
        String::from_utf8(plain).map_err(|e| format!("供应商密钥编码无效: {e}"))
    }
}

#[cfg(not(windows))]
fn unprotect_provider_secret(_protected: &str) -> Result<String, String> {
    Err("供应商密钥保险库仅支持 Windows DPAPI".to_string())
}

async fn provider_secret_db() -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(cloud_authority_db_path())
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await
    .map_err(|e| format!("打开供应商密钥保险库失败: {e}"))
}

struct ProviderBinding {
    endpoint: String,
    secret_mode: String,
    secret_name: String,
    protected_secret: String,
}

fn provider_binding_for_config(provider_type: &str, provider_name: &str, base_url: &str) -> Result<(String, String, String), String> {
    let name = provider_name.trim().to_ascii_lowercase();
    let kind = if name.contains("tavily") { "tavily" }
        else if name.contains("bing") { "bing" }
        else if name.contains("brave") { "brave" }
        else if name.contains('博') || name.contains("bocha") { "bocha" }
        else if name.contains("exa") { "exa" }
        else if name.contains("searchapi") { "searchapi" }
        else if name.contains("serper") { "serper" }
        else { "llm" };
    let mut endpoint = base_url.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        endpoint = match kind {
            "tavily" => "https://api.tavily.com/search",
            "bing" => "https://api.bing.microsoft.com/v7.0/search",
            "serper" => "https://google.serper.dev/search",
            "brave" => "https://api.search.brave.com/res/v1/web/search",
            "bocha" => "https://api.bochaai.com/v1/web-search",
            "exa" => "https://api.exa.ai/search",
            "searchapi" => "https://www.searchapi.io/api/v1/search",
            _ if provider_type == "llm" && name.contains("openai") => "https://api.openai.com/v1/chat/completions",
            _ => "https://api.deepseek.com/v1/chat/completions",
        }.to_string();
    }
    if provider_type == "llm" && !endpoint.ends_with("/chat/completions") {
        endpoint.push_str("/chat/completions");
    } else if kind == "serper" && !endpoint.contains("/search") {
        endpoint.push_str("/search");
    }
    let parsed = reqwest::Url::parse(&endpoint).map_err(|_| "供应商端点无效".to_string())?;
    if parsed.scheme() != "https" || !CLOUD_HOST_ALLOWLIST.contains(&parsed.host_str().unwrap_or_default()) {
        return Err("供应商端点必须是 HTTPS 白名单地址".to_string());
    }
    let placement = match kind {
        "tavily" => ("body", "api_key"),
        "bing" => ("header", "Ocp-Apim-Subscription-Key"),
        "brave" => ("header", "X-Subscription-Token"),
        "bocha" => ("bearer", ""),
        "exa" => ("header", "x-api-key"),
        "searchapi" => ("query", "api_key"),
        "serper" => ("header", "X-API-KEY"),
        _ => ("bearer", ""),
    };
    Ok((endpoint, placement.0.to_string(), placement.1.to_string()))
}

async fn load_provider_config(provider_id: i64) -> Result<(String, String, String), String> {
    let options = SqliteConnectOptions::new()
        .filename(db_dir().join("costhub.db"))
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await.map_err(|e| format!("读取供应商配置失败：{e}"))?;
    let row = sqlx::query("SELECT provider_type, provider_name, base_url FROM api_providers WHERE id=?")
        .bind(provider_id)
        .fetch_optional(&mut db)
        .await
        .map_err(|e| format!("读取供应商配置失败：{e}"))?
        .ok_or_else(|| "供应商配置不存在，请先保存供应商设置".to_string())?;
    Ok((row.try_get("provider_type").unwrap_or_default(), row.try_get("provider_name").unwrap_or_default(), row.try_get("base_url").unwrap_or_default()))
}

fn provider_endpoint_matches(expected: &str, actual: &reqwest::Url) -> bool {
    let Ok(expected) = reqwest::Url::parse(expected) else { return false; };
    expected.scheme() == actual.scheme()
        && expected.host_str() == actual.host_str()
        && expected.port_or_known_default() == actual.port_or_known_default()
        && {
            let expected_path = expected.path().trim_end_matches('/');
            let actual_path = actual.path().trim_end_matches('/');
            // LLM 供应商可以额外使用同 host 的 /responses 端点；请求体仍必须通过原生搜索审批。
            let native_sibling = expected_path.ends_with("/chat/completions")
                && actual_path.ends_with("/responses");
            actual_path == expected_path || actual_path.starts_with(&format!("{expected_path}/")) || native_sibling
        }
}

fn safe_provider_headers(input: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let mut output = HashMap::new();
    for (name, value) in input {
        let lower = name.to_ascii_lowercase();
        if !matches!(lower.as_str(), "accept" | "content-type") {
            return Err("云端请求已拦截：调用方只能提供 Accept/Content-Type 请求头".to_string());
        }
        if value.contains('\r') || value.contains('\n') {
            return Err("云端请求已拦截：请求头包含非法字符".to_string());
        }
        let normalized = value.trim().to_ascii_lowercase();
        if normalized != "application/json" {
            return Err("云端请求已拦截：Accept/Content-Type 只能使用 application/json".to_string());
        }
        output.insert(if lower == "accept" { "Accept".to_string() } else { "Content-Type".to_string() }, "application/json".to_string());
    }
    Ok(output)
}

fn query_escape(value: &str) -> String {
    value.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

async fn ensure_provider_secret_table(db: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("CREATE TABLE IF NOT EXISTS provider_secrets (provider_id INTEGER PRIMARY KEY, protected_secret TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now','localtime')))" )
        .execute(&mut *db).await.map_err(|e| format!("初始化供应商密钥保险库失败: {e}"))?;
    sqlx::query("ALTER TABLE provider_secrets ADD COLUMN endpoint TEXT DEFAULT ''").execute(&mut *db).await.ok();
    sqlx::query("ALTER TABLE provider_secrets ADD COLUMN secret_mode TEXT DEFAULT ''").execute(&mut *db).await.ok();
    sqlx::query("ALTER TABLE provider_secrets ADD COLUMN secret_name TEXT DEFAULT ''").execute(&mut *db).await.ok();
    Ok(())
}

// 旧版本已保存的 DPAPI 密钥只有 protected_secret；首次读取时补齐当前供应商绑定，避免被误报为未配置。
async fn repair_provider_secret_binding(db: &mut SqliteConnection, provider_id: i64) -> Result<(), String> {
    let Some(row) = sqlx::query("SELECT protected_secret, endpoint, secret_mode FROM provider_secrets WHERE provider_id = ?")
        .bind(provider_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(|e| format!("读取供应商密钥失败: {e}"))?
    else { return Ok(()); };
    let protected: String = row.try_get("protected_secret").unwrap_or_default();
    let endpoint: String = row.try_get("endpoint").unwrap_or_default();
    let secret_mode: String = row.try_get("secret_mode").unwrap_or_default();
    if protected.is_empty() || (!endpoint.is_empty() && !secret_mode.is_empty()) { return Ok(()); }
    let (provider_type, provider_name, base_url) = load_provider_config(provider_id).await?;
    let (endpoint, secret_mode, secret_name) = provider_binding_for_config(&provider_type, &provider_name, &base_url)?;
    sqlx::query("UPDATE provider_secrets SET endpoint=?, secret_mode=?, secret_name=?, updated_at=datetime('now','localtime') WHERE provider_id=?")
        .bind(endpoint)
        .bind(secret_mode)
        .bind(secret_name)
        .bind(provider_id)
        .execute(&mut *db)
        .await
        .map_err(|e| format!("修复供应商密钥绑定失败: {e}"))?;
    Ok(())
}

async fn migrate_legacy_provider_secret(db: &mut SqliteConnection, provider_id: i64) -> Result<(), String> {
    let existing = sqlx::query("SELECT protected_secret FROM provider_secrets WHERE provider_id = ?")
        .bind(provider_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(|e| format!("读取供应商密钥失败: {e}"))?;
    if existing.and_then(|row| row.try_get::<String, _>("protected_secret").ok()).is_some_and(|value| !value.is_empty()) { return Ok(()); }
    let options = SqliteConnectOptions::new()
        .filename(db_dir().join("costhub.db"))
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let mut source = SqliteConnection::connect_with(&options).await.map_err(|e| format!("读取旧供应商密钥失败: {e}"))?;
    let Some(row) = sqlx::query("SELECT provider_type, provider_name, base_url, api_key FROM api_providers WHERE id=?")
        .bind(provider_id)
        .fetch_optional(&mut source)
        .await
        .map_err(|e| format!("读取旧供应商密钥失败: {e}"))?
    else { return Ok(()); };
    let secret: String = row.try_get("api_key").unwrap_or_default();
    if secret.trim().is_empty() || secret.trim() == "__vault__" || secret.trim_start().starts_with('{') { return Ok(()); }
    let provider_type: String = row.try_get("provider_type").unwrap_or_default();
    let provider_name: String = row.try_get("provider_name").unwrap_or_default();
    let base_url: String = row.try_get("base_url").unwrap_or_default();
    let (endpoint, secret_mode, secret_name) = provider_binding_for_config(&provider_type, &provider_name, &base_url)?;
    let protected = protect_provider_secret(secret.trim())?;
    sqlx::query("INSERT INTO provider_secrets(provider_id, protected_secret, endpoint, secret_mode, secret_name, updated_at) VALUES(?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(provider_id) DO UPDATE SET protected_secret=excluded.protected_secret, endpoint=excluded.endpoint, secret_mode=excluded.secret_mode, secret_name=excluded.secret_name, updated_at=excluded.updated_at")
        .bind(provider_id)
        .bind(protected)
        .bind(endpoint)
        .bind(secret_mode)
        .bind(secret_name)
        .execute(&mut *db)
        .await
        .map_err(|e| format!("迁移供应商密钥失败: {e}"))?;
    sqlx::query("UPDATE api_providers SET api_key='__vault__' WHERE id=?")
        .bind(provider_id)
        .execute(&mut source)
        .await
        .map_err(|e| format!("清理旧供应商密钥失败: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn save_provider_secret(request: ProviderSecretRequest) -> Result<(), String> {
    if request.provider_id <= 0 { return Err("供应商 ID 无效".to_string()); }
    let secret = request.secret.trim();
    let mut db = provider_secret_db().await?;
    ensure_provider_secret_table(&mut db).await?;
    if secret.is_empty() {
        sqlx::query("DELETE FROM provider_secrets WHERE provider_id = ?").bind(request.provider_id).execute(&mut db).await.map_err(|e| format!("清除供应商密钥失败: {e}"))?;
    } else {
        let (provider_type, provider_name, base_url) = load_provider_config(request.provider_id).await?;
        let (endpoint, secret_mode, secret_name) = provider_binding_for_config(&provider_type, &provider_name, &base_url)?;
        let protected = protect_provider_secret(secret)?;
        sqlx::query("INSERT INTO provider_secrets(provider_id, protected_secret, endpoint, secret_mode, secret_name, updated_at) VALUES(?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(provider_id) DO UPDATE SET protected_secret=excluded.protected_secret, endpoint=excluded.endpoint, secret_mode=excluded.secret_mode, secret_name=excluded.secret_name, updated_at=excluded.updated_at")
            .bind(request.provider_id).bind(protected).bind(endpoint).bind(secret_mode).bind(secret_name).execute(&mut db).await.map_err(|e| format!("保存供应商密钥失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn provider_secret_status(provider_id: i64) -> Result<bool, String> {
    if provider_id <= 0 { return Ok(false); }
    let mut db = provider_secret_db().await?;
    ensure_provider_secret_table(&mut db).await?;
    migrate_legacy_provider_secret(&mut db, provider_id).await?;
    repair_provider_secret_binding(&mut db, provider_id).await?;
    let row = sqlx::query("SELECT protected_secret, endpoint, secret_mode FROM provider_secrets WHERE provider_id = ?")
        .bind(provider_id).fetch_optional(&mut db).await.map_err(|e| format!("读取供应商密钥状态失败: {e}"))?;
    Ok(row.map(|r| !r.get::<String, _>("protected_secret").is_empty() && !r.get::<String, _>("endpoint").is_empty() && !r.get::<String, _>("secret_mode").is_empty()).unwrap_or(false))
}

#[tauri::command]
async fn delete_provider_secret(provider_id: i64) -> Result<(), String> {
    if provider_id <= 0 { return Ok(()); }
    let mut db = provider_secret_db().await?;
    ensure_provider_secret_table(&mut db).await?;
    sqlx::query("DELETE FROM provider_secrets WHERE provider_id = ?").bind(provider_id).execute(&mut db).await.map_err(|e| format!("清除供应商密钥失败: {e}"))?;
    Ok(())
}

async fn read_provider_binding(db: &mut SqliteConnection, provider_id: i64) -> Result<ProviderBinding, String> {
    ensure_provider_secret_table(db).await?;
    migrate_legacy_provider_secret(db, provider_id).await?;
    repair_provider_secret_binding(db, provider_id).await?;
    let row = sqlx::query("SELECT protected_secret, endpoint, secret_mode, secret_name FROM provider_secrets WHERE provider_id = ?")
        .bind(provider_id).fetch_optional(db).await.map_err(|e| format!("读取供应商密钥失败: {e}"))?
        .ok_or_else(|| "供应商密钥未配置，请在设置中重新录入".to_string())?;
    let binding = ProviderBinding {
        protected_secret: row.get("protected_secret"),
        endpoint: row.get("endpoint"),
        secret_mode: row.get("secret_mode"),
        secret_name: row.get("secret_name"),
    };
    if binding.endpoint.is_empty() || binding.secret_mode.is_empty() { return Err("供应商凭据缺少后端端点绑定，请在设置中重新录入".to_string()); }
    Ok(binding)
}

#[tauri::command]
async fn provider_cloud_http_request(request: ProviderCloudHttpRequest) -> Result<HttpResponse, String> {
    require_cloud_network_enabled().await?;
    let request_id = request.request_id.trim().to_string();
    let mut db = provider_secret_db().await?;
    let binding = read_provider_binding(&mut db, request.provider_id).await?;
    let final_approval = request.approval.clone();
    let requested_url = validate_cloud_request(&CloudHttpRequest { url: request.url.clone(), method: request.method.clone(), body: request.body.clone(), approval: request.approval.clone() })?;
    if !provider_endpoint_matches(&binding.endpoint, &requested_url) {
        return Err("云端请求已拦截：供应商身份与请求端点不匹配".to_string());
    }
    let safe_url = validate_cloud_request_with_grant(&CloudHttpRequest { url: request.url.clone(), method: request.method.clone(), body: request.body.clone(), approval: request.approval }).await?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "云端请求方法无效".to_string())?;
    if !matches!(method, reqwest::Method::GET | reqwest::Method::POST) { return Err("云端请求已拦截：只允许 GET/POST".to_string()); }
    let mut url = safe_url.to_string();
    let mut headers = safe_provider_headers(request.headers)?;
    let mut body = request.body;
    let secret = unprotect_provider_secret(&binding.protected_secret)?;
    match binding.secret_mode.as_str() {
        "bearer" => { headers.insert("Authorization".to_string(), format!("Bearer {secret}")); }
        "header" => { headers.insert(binding.secret_name.clone(), secret); }
        "query" => { let sep = if url.contains('?') { '&' } else { '?' }; url.push(sep); url.push_str(&query_escape(&binding.secret_name)); url.push('='); url.push_str(&query_escape(&secret)); }
        "body" => { let field = if binding.secret_name.trim().is_empty() { "api_key" } else { binding.secret_name.as_str() }; let mut value: serde_json::Value = serde_json::from_str(body.as_deref().unwrap_or("{}" )).map_err(|_| "供应商请求体不是 JSON".to_string())?; value[field] = serde_json::Value::String(secret); body = Some(value.to_string()); }
        _ => return Err("供应商密钥注入方式无效".to_string()),
    }
    validate_cloud_request_with_injected_secret(&CloudHttpRequest { url: url.clone(), method: method.to_string(), body: body.clone(), approval: final_approval })?;
    let client = build_cloud_client(1200)?;
    let mut builder = client.request(method, url);
    for (name, value) in headers { builder = builder.header(name, value); }
    if let Some(body) = body { builder = builder.body(body); }
    let (mut cancel_rx, _cancel_guard) = if request_id.is_empty() {
        (None, None)
    } else {
        let (receiver, guard) = register_provider_cloud_cancel(&request_id)?;
        (Some(receiver), Some(guard))
    };
    let response = if let Some(cancel_rx) = cancel_rx.as_mut() {
        provider_cloud_select(cancel_rx, async {
            builder.send().await.map_err(|e| format!("受控云端请求失败: {e}"))
        }).await
    } else {
        builder.send().await.map_err(|e| format!("受控云端请求失败: {e}"))
    }?;
    let status = response.status();
    let bytes = if let Some(cancel_rx) = cancel_rx.as_mut() {
        provider_cloud_select(cancel_rx, async {
            response.bytes().await.map_err(|e| format!("读取云端响应失败: {e}"))
        }).await
    } else {
        response.bytes().await.map_err(|e| format!("读取云端响应失败: {e}"))
    }?;
    Ok(HttpResponse { status: status.as_u16(), body: String::from_utf8_lossy(&bytes).into_owned(), success: status.is_success() })
}

async fn send_http(method: &str, request: HttpRequest) -> Result<HttpResponse, String> {
    let safe_url = normalize_loopback_url(&request.url)?;
    if method.eq_ignore_ascii_case("POST") && request.backend.as_deref() != Some("llama.cpp") {
        require_ollama_isolated()?;
    }
    http_log(&format!("loopback direct-connect: {}", safe_url));
    let client = build_loopback_client(1200)?;
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let mut builder = client.request(http_method, safe_url.clone());
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
    let code = status.as_u16();
    // 诊断：非成功状态（尤其 504/502 网关类）提前抓响应头，定位返回方是 Ollama 还是中间代理/网关
    let resp_headers = if code == 504 || code == 502 || code == 408 {
        let hdrs: Vec<String> = response
            .headers()
            .iter()
            .filter(|(n, _)| {
                let n = n.as_str().to_ascii_lowercase();
                matches!(
                    n.as_str(),
                    "server"
                        | "via"
                        | "x-cache"
                        | "x-served-by"
                        | "x-proxy-id"
                        | "x-cache-lookup"
                        | "squid"
                        | "x-squid-error"
                )
            })
            .map(|(n, v)| format!("{}={}", n.as_str(), v.to_str().unwrap_or("?")))
            .collect();
        hdrs.join("; ")
    } else {
        String::new()
    };

    // 读取响应体：宽容解码——网络截断导致的多字节字符被切断/非 UTF-8 内容不再硬失败
    //（否则前端报"HTTP 0: error decoding response body"吓人错误），转 lossy 字符串交给前端 JSON 解析兜底；
    // 仅真实读取中断（连接断开）才报错
    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let error_detail = format!(
                "Failed to read response body: {}. This may be caused by: \
                1) Network interruption / connection closed mid-body, \
                2) Response too large. \
                (total request timeout: 20 minutes)",
                e
            );
            return Err(error_detail);
        }
    };
    let mut body = String::from_utf8_lossy(&bytes).into_owned();

    // 诊断：504/502/408 打印代理标识头 + 正文片段，实锤返回方（Ollama JSON vs 公司代理 HTML 错误页）。
    // 诊断同时塞进返回 body 开头 → 前端报错弹窗直接显示，无需打开日志文件
    if code == 504 || code == 502 || code == 408 {
        let snippet: String = body.chars().take(160).collect();
        let diag = format!(
            "{} {} -> HTTP {} loopback=yes(no-proxy) headers[{}] body[:160]={}",
            method, safe_url, code, resp_headers, snippet
        );
        http_log(&diag);
        body = format!("[costhub-diag] {}\n---\n{}", diag, body);
    }

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
fn cancel_http_stream(event_id: String) -> Result<(), String> {
    let sender = http_cancel_registry()
        .lock()
        .map_err(|_| "HTTP cancel registry unavailable".to_string())?
        .get(&event_id)
        .cloned();
    if let Some(sender) = sender {
        sender.send(true).map_err(|_| "HTTP stream already stopped".to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn http_post(request: HttpRequest) -> Result<HttpResponse, String> {
    send_http("POST", request).await
}

#[tauri::command]
async fn http_stream(
    app: tauri::AppHandle,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    event_id: String,
    backend: Option<String>,
) -> Result<(), String> {
    let safe_url = normalize_loopback_url(&url)?;
    if backend.as_deref() != Some("llama.cpp") {
        require_ollama_isolated()?;
    }
    http_log(&format!("loopback stream direct-connect: {}", safe_url));
    // 流式读取不设总超时；无代理、无重定向，只能连本机回环。
    let client = build_loopback_client(0)?;
    let mut builder = client.post(safe_url);
    for (k, v) in &headers {
        builder = builder.header(k, v);
    }
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    http_cancel_registry()
        .lock()
        .map_err(|_| "HTTP cancel registry unavailable".to_string())?
        .insert(event_id.clone(), cancel_tx);
    let _cancel_guard = HttpCancelGuard(event_id.clone());
    let response = tokio::select! {
        result = builder.body(body).send() => result.map_err(|e| format!("Request failed: {e}")),
        _ = cancel_rx.changed() => {
            app.emit(&format!("llm-error-{}", event_id), "用户已停止本地模型请求").ok();
            return Err("local request cancelled".to_string());
        }
    }?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        app.emit(&format!("llm-error-{}", event_id), err_body.clone())
            .ok();
        return Err(format!("HTTP {}: {}", status, err_body));
    }
    let mut stream = response.bytes_stream();
    let mut decoder = local_stream::LocalStreamDecoder::default();
    loop {
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = cancel_rx.changed() => return Err("用户已停止本地模型请求".into()),
        };
        let events = match next {
            Some(Ok(bytes)) => decoder.push(&bytes),
            Some(Err(error)) => Err(error.to_string()),
            None => decoder.finish(),
        }?;
        for (event, payload) in events { app.emit(&format!("{event}-{event_id}"), payload).ok(); }
        if decoder.done { return Ok(()); }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(FrontendSqlitePools::default())
        .invoke_handler(tauri::generate_handler![
            get_db_path,
            execution_create_workspace,
            execution_prepare,
            execution_set_enabled,
            execution_skill_dirs,
            execution_dependencies,
            execution_fs,
    execution_exec,
            execution_create_isolated_workspace,
            execution_cancel,
            execution_open_path,
            sql_load,
            sql_select,
            sql_execute,
            sql_close,
            delete_material_insight_subjects,
            http_get,
            cancel_http_stream,
            http_post,
            http_stream,
            get_cloud_network_mode,
            set_cloud_network_mode,
            create_cloud_approval_grant,
            get_valid_cloud_approval_grant,
            revoke_cloud_approval_grant,
            get_active_cloud_approval_grants,
            revoke_active_cloud_approval_grants,
            provider_cloud_http_request,
            cancel_provider_cloud_http_request,
            save_provider_secret,
            provider_secret_status,
            delete_provider_secret,
            ollama_net_status,
            ollama_net_enable_block,
            llama_server_status,
            llama_server_log,
            llama_server_start,
            llama_server_stop,
            list_security_events,
            create_backup_target,
            list_backups,
            restore_database,
            delete_backup,
            save_export_file,
            open_exported_file,
            reveal_exported_file,
            get_default_ai_work_folder,
            pick_ai_work_folder,
            validate_ai_work_folder,
            open_ai_work_folder,
            list_exports,
            open_exports_dir
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 启用开发者工具（包括生产环境，方便调试）
            if let Some(_window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                _window.open_devtools();
                // 在release模式下，用户可以通过右键菜单打开
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
