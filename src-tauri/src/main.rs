// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ⚠️ 远程桌面（RDP/jumper）修复（2026-08-18 用户反馈）：远程会话下 WebView2 硬件加速渲染常导致
    // 白屏/闪烁/弹窗显示异常——远程时禁用 GPU 加速，本地控制台保持 GPU（动画流畅）
    #[cfg(target_os = "windows")]
    {
        let session = std::env::var("SESSIONNAME").unwrap_or_default();
        if !session.is_empty() && !session.eq_ignore_ascii_case("Console") {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
        }
    }
    app_lib::run();
}
