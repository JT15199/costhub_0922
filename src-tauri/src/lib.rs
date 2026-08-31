use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_sql;

#[derive(Debug, Deserialize)]
struct HttpRequest {
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudApproval {
    material: String,
    category: String,
    question: String,
    reviewed: bool,
}

#[derive(Debug, Deserialize)]
struct CloudHttpRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    approval: CloudApproval,
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
    let db_path = exe_dir.join("costhub.db");
    format!("sqlite:{}", db_path.display())
}

#[tauri::command]
fn get_db_path() -> String {
    get_db_url()
}

// ========== 数据备份与恢复（exe 同目录 backups/ 文件夹） ==========
fn db_dir() -> PathBuf {
    let exe_path = env::current_exe().unwrap_or_default();
    exe_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf()
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
/// 保存前端生成的导出文件（base64）到 exe 同目录 exports/，返回实际文件名
#[tauri::command]
fn save_export_file(file_name: String, base64_data: String) -> Result<String, String> {
    // 防路径穿越
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法的文件名".to_string());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("解码失败: {e}"))?;
    let dir = db_dir().join("exports");
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let dest = dir.join(&file_name);
    fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(file_name)
}

/// 列出 exports/ 目录下的导出文件
#[tauri::command]
fn list_exports() -> Vec<serde_json::Value> {
    let dir = db_dir().join("exports");
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<(PathBuf, u64)> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
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
    let dir = db_dir().join("exports");
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
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
    use super::{normalize_loopback_url, validate_cloud_request, CloudApproval, CloudHttpRequest};
    use std::collections::HashMap;

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
            headers: HashMap::new(),
            body: Some(r#"{"query":"液晶面板 公开市场趋势"}"#.into()),
            approval: CloudApproval {
                material: "液晶面板".into(),
                category: "硬件类".into(),
                question: "公开市场趋势".into(),
                reviewed: true,
            },
        };
        assert!(validate_cloud_request(&safe).is_ok());
        let leaked = CloudHttpRequest {
            body: Some(r#"{"query":"液晶面板","project_code":"M270","bom_cost":900}"#.into()),
            ..safe
        };
        assert!(validate_cloud_request(&leaked).is_err());
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

fn validate_cloud_request(request: &CloudHttpRequest) -> Result<reqwest::Url, String> {
    if !request.approval.reviewed {
        return Err("云端请求已拦截：尚未通过发送前审查/审批".to_string());
    }
    let material = request.approval.material.trim();
    let category = request.approval.category.trim();
    let question = request.approval.question.trim();
    if material.is_empty()
        || material.chars().count() > 80
        || category.chars().count() > 50
        || question.chars().count() > 200
    {
        return Err("云端请求已拦截：审批范围无效或过长".to_string());
    }
    if material.chars().any(|c| c.is_ascii_digit()) || category.chars().any(|c| c.is_ascii_digit())
    {
        return Err("云端请求已拦截：物料名/品类疑似包含型号或规格数字".to_string());
    }
    let body = request.body.as_deref().unwrap_or_default();
    if body.len() > 200_000 {
        return Err("云端请求已拦截：请求体超过安全上限".to_string());
    }
    let body_lower = body.to_ascii_lowercase();
    let forbidden = [
        "project_code",
        "supplier_name",
        "bom_cost",
        "market_price",
        "part_model",
        "项目代号",
        "内部成本",
        "我司成本",
        "¥",
        "￥",
    ];
    if forbidden
        .iter()
        .any(|token| body_lower.contains(&token.to_ascii_lowercase()))
    {
        return Err("云端请求已拦截：请求体疑似包含项目、供应商、型号或成本字段".to_string());
    }
    let parsed =
        reqwest::Url::parse(&request.url).map_err(|_| "云端请求已拦截：URL 无效".to_string())?;
    let decoded_query = parsed
        .query_pairs()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");
    // 请求必须与本次已审查的公开主题相关，不能拿一张空白审批票发送其他内容。
    let related = body.contains(material)
        || decoded_query.contains(material)
        || (!category.is_empty() && (body.contains(category) || decoded_query.contains(category)));
    if !related {
        return Err("云端请求已拦截：请求内容与已审批主题不一致".to_string());
    }
    if parsed.scheme() != "https" {
        return Err("云端请求已拦截：只允许 HTTPS".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !CLOUD_HOST_ALLOWLIST.contains(&host.as_str()) {
        http_log(&format!("BLOCKED cloud host: {}", host));
        return Err(format!("云端请求已拦截：目标域名不在白名单（{}）", host));
    }
    Ok(parsed)
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

#[tauri::command]
async fn cloud_http_request(request: CloudHttpRequest) -> Result<HttpResponse, String> {
    let safe_url = validate_cloud_request(&request)?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "云端请求方法无效".to_string())?;
    if !matches!(method, reqwest::Method::GET | reqwest::Method::POST) {
        return Err("云端请求已拦截：只允许 GET/POST".to_string());
    }
    let client = build_cloud_client(1200)?;
    let mut builder = client.request(method, safe_url);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| format!("受控云端请求失败: {e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取云端响应失败: {e}"))?;
    Ok(HttpResponse {
        status: status.as_u16(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        success: status.is_success(),
    })
}

async fn send_http(method: &str, request: HttpRequest) -> Result<HttpResponse, String> {
    let safe_url = normalize_loopback_url(&request.url)?;
    if method.eq_ignore_ascii_case("POST") {
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
) -> Result<(), String> {
    let safe_url = normalize_loopback_url(&url)?;
    require_ollama_isolated()?;
    http_log(&format!("loopback stream direct-connect: {}", safe_url));
    // 流式读取不设总超时；无代理、无重定向，只能连本机回环。
    let client = build_loopback_client(0)?;
    let mut builder = client.post(safe_url);
    for (k, v) in &headers {
        builder = builder.header(k, v);
    }
    let response = builder
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        app.emit(&format!("llm-error-{}", event_id), err_body.clone())
            .ok();
        return Err(format!("HTTP {}: {}", status, err_body));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut emitted_any = false; // 是否发出过任何 token/reasoning
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();
                    if line.is_empty() {
                        continue;
                    }
                    // 兼容两种格式：
                    //  1) OpenAI SSE: "data: {...}" 或 "data: [DONE]"
                    //  2) Ollama 原生 NDJSON: {...} （无 data: 前缀）
                    let data = if let Some(d) = line.strip_prefix("data: ") {
                        let d = d.trim();
                        if d == "[DONE]" {
                            app.emit(&format!("llm-done-{}", event_id), "").ok();
                            return Ok(());
                        }
                        d.to_string()
                    } else {
                        line.clone()
                    };
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                        // 方案A：OpenAI 格式 choices[0].delta
                        if let Some(delta) = v
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|ch| ch.get("delta"))
                        {
                            if let Some(rc) =
                                delta.get("reasoning_content").and_then(|x| x.as_str())
                            {
                                if !rc.is_empty() {
                                    emitted_any = true;
                                    app.emit(
                                        &format!("llm-reasoning-{}", event_id),
                                        rc.to_string(),
                                    )
                                    .ok();
                                }
                            }
                            if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                                if !c.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-token-{}", event_id), c.to_string())
                                        .ok();
                                }
                            }
                        }
                        // 方案B：Ollama 原生格式 message.content / message.thinking / message.tool_calls
                        else if let Some(msg) = v.get("message") {
                            // 工具调用（本地模型自主调用云端助手）：Ollama 在 message.tool_calls 返回
                            if let Some(tcs) = msg.get("tool_calls") {
                                if let Some(arr) = tcs.as_array() {
                                    if !arr.is_empty() {
                                        emitted_any = true;
                                        app.emit(
                                            &format!("llm-toolcalls-{}", event_id),
                                            tcs.to_string(),
                                        )
                                        .ok();
                                    }
                                }
                            }
                            if let Some(t) = msg.get("thinking").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-reasoning-{}", event_id), t.to_string())
                                        .ok();
                                }
                            }
                            if let Some(c) = msg.get("content").and_then(|x| x.as_str()) {
                                if !c.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-token-{}", event_id), c.to_string())
                                        .ok();
                                }
                            }
                            if v.get("done").and_then(|x| x.as_bool()).unwrap_or(false) {
                                // 检测是否因长度截断（done_reason=length 或 finish_reason=length）
                                let truncated = v
                                    .get("done_reason")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s == "length")
                                    .unwrap_or(false)
                                    || v.get("finish_reason")
                                        .and_then(|x| x.as_str())
                                        .map(|s| s == "length")
                                        .unwrap_or(false);
                                if truncated {
                                    app.emit(&format!("llm-truncated-{}", event_id), "").ok();
                                }
                                app.emit(&format!("llm-done-{}", event_id), "").ok();
                                return Ok(());
                            }
                        }
                    }
                }
            }
            Err(e) => {
                app.emit(&format!("llm-error-{}", event_id), e.to_string())
                    .ok();
                return Err(e.to_string());
            }
        }
    }
    // 流结束但一个 token 都没发出 → 视为异常，emit 错误而不是静默 done
    if !emitted_any {
        app.emit(
            &format!("llm-error-{}", event_id),
            "模型未返回任何内容（空响应）",
        )
        .ok();
        return Err("empty response".to_string());
    }
    app.emit(&format!("llm-done-{}", event_id), "").ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_db_path,
            http_get,
            http_post,
            http_stream,
            cloud_http_request,
            ollama_net_status,
            ollama_net_enable_block,
            list_security_events,
            create_backup_target,
            list_backups,
            restore_database,
            delete_backup,
            save_export_file,
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
