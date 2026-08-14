use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_sql;
use futures_util::StreamExt;

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
    exe_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf()
}

fn backups_dir() -> PathBuf {
    db_dir().join("backups")
}

/// 创建数据库备份（复制 costhub.db 及 WAL 文件到 backups/）
#[tauri::command]
fn backup_database() -> Result<String, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let ts = chrono_now_compact();
    let db_path = db_dir().join("costhub.db");
    if !db_path.exists() {
        return Err("数据库文件不存在".to_string());
    }
    let dest = dir.join(format!("costhub-backup-{ts}.db"));
    fs::copy(&db_path, &dest).map_err(|e| format!("复制数据库失败: {e}"))?;
    // 若存在 WAL 文件也一并备份（未 checkpoint 的数据）
    let wal = db_dir().join("costhub.db-wal");
    if wal.exists() {
        let _ = fs::copy(&wal, dir.join(format!("costhub-backup-{ts}.db-wal")));
    }
    Ok(dest.file_name().unwrap_or_default().to_string_lossy().to_string())
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
            .filter_map(|p| {
                fs::metadata(&p).ok().map(|m| (p, m.len()))
            })
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
        let _ = fs::copy(&db_path, db_dir().join(format!("costhub-pre-restore-{ts}.db")));
    }
    // 移除 WAL/SHM 避免残留数据干扰
    let _ = fs::remove_file(db_dir().join("costhub.db-wal"));
    let _ = fs::remove_file(db_dir().join("costhub.db-shm"));
    fs::copy(&src, &db_path).map_err(|e| format!("恢复失败: {e}"))?;
    Ok(format!("已从 {backup_name} 恢复，请重启应用生效"))
}

/// 删除指定备份
#[tauri::command]
fn delete_backup(backup_name: String) -> Result<(), String> {
    if backup_name.contains("..") || backup_name.contains('/') || backup_name.contains('\\') {
        return Err("非法的备份文件名".to_string());
    }
    let p = backups_dir().join(&backup_name);
    fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))
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
fn chrono_now_compact() -> String {    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
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
        format!("{}\\Programs\\Ollama\\ollama.exe", env::var("LOCALAPPDATA").unwrap_or_default()),
        format!("{}\\Ollama\\ollama.exe", env::var("ProgramFiles").unwrap_or_default()),
        format!("{}\\Ollama\\ollama.exe", env::var("ProgramFiles(x86)").unwrap_or_default()),
        format!("{}\\Ollama\\ollama.exe", env::var("USERPROFILE").unwrap_or_default()),
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
    f.write_all(full_script.as_bytes()).map_err(|e| format!("写入脚本失败: {e}"))?;
    drop(f);

    // 通过 UAC 提权执行
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile", "-Command",
            &format!(
                "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'",
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
            if let Ok(s) = std::fs::read_to_string(&result_path) { content = s; }
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
    // 用 netsh 查询规则，同时检查命令是否成功执行
    let out = std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule", &format!("name={}", OLLAMA_BLOCK_RULE)])
        .output()
        .map_err(|e| format!("无法查询防火墙规则: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    // 查询成功：stdout 包含规则名即为已封禁
    let queryOk = out.status.success();
    let blocked = if queryOk {
        stdout.contains(OLLAMA_BLOCK_RULE) && stdout.contains("Block")
    } else {
        // 查询失败（多半是权限）：保守起见返回 true（假设已封禁），避免误导用户
        true
    };
    Ok(serde_json::json!({
        "ollama_found": exe.is_some(),
        "ollama_path": exe.unwrap_or_default(),
        "blocked": blocked,
        "rule_name": OLLAMA_BLOCK_RULE,
        "query_error": if queryOk { String::new() } else { stderr.clone() },
    }))
}

#[tauri::command]
async fn ollama_net_set_block(block: bool) -> Result<serde_json::Value, String> {
    let exe = match find_ollama_exe() {
        Some(e) => e,
        None => return Err("未找到 ollama.exe，请先安装 Ollama".to_string()),
    };
    // 拼 PowerShell 脚本，用 UAC 提权执行 netsh（避免卡 UI，async 下在后台线程运行）
    let script = if block {
        format!(
            "netsh advfirewall firewall delete rule name={0} 2>$null; netsh advfirewall firewall add rule name={0} dir=out action=block program=\"{1}\" profile=any enable=yes; exit $LASTEXITCODE",
            OLLAMA_BLOCK_RULE, exe
        )
    } else {
        format!(
            "netsh advfirewall firewall delete rule name={0}; exit $LASTEXITCODE",
            OLLAMA_BLOCK_RULE
        )
    };
    let code = run_ps1_elevated(&script)?;
    let blocked = block;
    Ok(serde_json::json!({ "ok": true, "blocked": blocked, "detail": code }))
}

// 构建 HTTP 客户端（与老版本兼容：native-tls + 系统证书；仅附加环境变量代理支持）
// 注意：不用 rustls（不走 Windows 系统证书库，公司网络 SSL 拦截环境下会 TLS 失败）
// 本地/内网地址（Ollama localhost 或内网 Ollama 服务器）：永远直连、不走任何代理。
// 公司代理环境（HTTP_PROXY 环境变量 / Squid 透明网关）会把请求转发到代理服务器，
// 代理连"它自己机器"的 localhost/内网地址失败 → 504。这里强制本地请求用无代理 client 根治。
fn is_local_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let Some(host) = parsed.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" { return true; }
    // 私有网段：内网 Ollama 服务器直连，不过公司代理（代理转发内网会 504）
    if host.starts_with("10.") || host.starts_with("192.168.") { return true; }
    if host.starts_with("172.") {
        if let Some(second) = host.split('.').nth(1).and_then(|s| s.parse::<u16>().ok()) {
            if (16..=31).contains(&second) { return true; }
        }
    }
    false
}

fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder();
    // 流式接口需要宽松的总超时（默认 30s 对慢速模型不够）；普通请求给足 20 分钟
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    // 依次尝试 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 环境变量
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(v) = env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                if let Ok(proxy) = reqwest::Proxy::all(&v) {
                    // 本地地址不走代理（否则 localhost Ollama 会被代理拦截）：
                    // NO_PROXY 环境变量 + 强制排除 localhost/127.0.0.1/::1
                    let no_proxy = env::var("NO_PROXY").or_else(|_| env::var("no_proxy")).unwrap_or_default();
                    let combined = if no_proxy.trim().is_empty() {
                        "localhost,127.0.0.1,::1".to_string()
                    } else {
                        format!("{no_proxy},localhost,127.0.0.1,::1")
                    };
                    let np = reqwest::NoProxy::from_string(&combined);
                    builder = builder.proxy(proxy.no_proxy(np));
                    break;
                }
            }
        }
    }
    builder.build().map_err(|e| format!("HTTP client initialization failed: {e}"))
}

async fn send_http(method: &str, request: HttpRequest) -> Result<HttpResponse, String> {
    // 本地回环（Ollama）→ 无代理直连，根治公司代理导致 localhost 请求被转发 → 504
    let client = if is_local_url(&request.url) {
        eprintln!("[costhub-http] local direct-connect (proxy bypassed): {}", request.url);
        reqwest::Client::builder().build().map_err(|e| format!("HTTP client initialization failed: {e}"))?
    } else {
        build_http_client(1200)?
    };
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
    let code = status.as_u16();
    // 诊断：非成功状态（尤其 504/502 网关类）提前抓响应头，定位返回方是 Ollama 还是中间代理/网关
    let resp_headers = if code == 504 || code == 502 || code == 408 {
        let hdrs: Vec<String> = response.headers().iter()
            .filter(|(n, _)| {
                let n = n.as_str().to_ascii_lowercase();
                matches!(n.as_str(), "server" | "via" | "x-cache" | "x-served-by" | "x-proxy-id" | "x-cache-lookup" | "squid" | "x-squid-error")
            })
            .map(|(n, v)| format!("{}={}", n.as_str(), v.to_str().unwrap_or("?")))
            .collect();
        hdrs.join("; ")
    } else { String::new() };

    // 改进错误处理：提供更详细的错误信息
    let body = match response.text().await {
        Ok(text) => text,
        Err(e) => {
            let error_detail = format!(
                "Failed to read response body: {}. This may be caused by: \
                1) Response timeout (current limit: 120s), \
                2) Invalid response encoding, \
                3) Network interruption. \
                Please check if the API endpoint is correct and the response is not too large.",
                e
            );
            return Err(error_detail);
        }
    };

    // 诊断：504/502/408 打印代理标识头 + 正文片段，实锤返回方（Ollama JSON vs 公司代理 HTML 错误页）
    if code == 504 || code == 502 || code == 408 {
        let snippet: String = body.chars().take(160).collect();
        eprintln!(
            "[costhub-http] {} {} -> HTTP {}（疑似代理/网关返回） headers[{}] body[:160]={}",
            method, request.url, code, resp_headers, snippet
        );
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
    // 流式读取：不设总超时（模型持续吐 token 时不会误杀），与老版本 Client::new() 行为一致
    // 本地回环（Ollama）→ 无代理直连（公司代理会导致 localhost 被转发 → 504/假失败）
    let client = if is_local_url(&url) {
        eprintln!("[costhub-http] local direct-connect (proxy bypassed): {}", url);
        reqwest::Client::builder().build().map_err(|e| format!("HTTP client initialization failed: {e}"))?
    } else {
        build_http_client(0)?
    };
    let mut builder = client.post(&url);
    for (k, v) in &headers { builder = builder.header(k, v); }
    let response = builder.body(body).send().await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        app.emit(&format!("llm-error-{}", event_id), err_body.clone()).ok();
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
                    if line.is_empty() { continue; }
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
                        if let Some(delta) = v.get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|ch| ch.get("delta"))
                        {
                            if let Some(rc) = delta.get("reasoning_content").and_then(|x| x.as_str()) {
                                if !rc.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-reasoning-{}", event_id), rc.to_string()).ok();
                                }
                            }
                            if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                                if !c.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-token-{}", event_id), c.to_string()).ok();
                                }
                            }
                        }
                        // 方案B：Ollama 原生格式 message.content / message.thinking
                        else if let Some(msg) = v.get("message") {
                            if let Some(t) = msg.get("thinking").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-reasoning-{}", event_id), t.to_string()).ok();
                                }
                            }
                            if let Some(c) = msg.get("content").and_then(|x| x.as_str()) {
                                if !c.is_empty() {
                                    emitted_any = true;
                                    app.emit(&format!("llm-token-{}", event_id), c.to_string()).ok();
                                }
                            }
                            if v.get("done").and_then(|x| x.as_bool()).unwrap_or(false) {
                                // 检测是否因长度截断（done_reason=length 或 finish_reason=length）
                                let truncated = v.get("done_reason").and_then(|x| x.as_str()).map(|s| s == "length").unwrap_or(false)
                                    || v.get("finish_reason").and_then(|x| x.as_str()).map(|s| s == "length").unwrap_or(false);
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
                app.emit(&format!("llm-error-{}", event_id), e.to_string()).ok();
                return Err(e.to_string());
            }
        }
    }
    // 流结束但一个 token 都没发出 → 视为异常，emit 错误而不是静默 done
    if !emitted_any {
        app.emit(&format!("llm-error-{}", event_id), "模型未返回任何内容（空响应）").ok();
        return Err("empty response".to_string());
    }
    app.emit(&format!("llm-done-{}", event_id), "").ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default().build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_db_path, http_get, http_post, http_stream, ollama_net_status, ollama_net_set_block, backup_database, list_backups, restore_database, delete_backup, save_export_file, list_exports, open_exports_dir])
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
