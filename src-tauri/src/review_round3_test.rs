use super::*;

#[test]
fn review_c1_scope_must_not_accept_appended_private_text() {
    tauri::async_runtime::block_on(async {
        let path = std::env::temp_dir().join(format!("costhub-review3-c1-{}-{}.db", std::process::id(), chrono::Utc::now().timestamp_micros()));
        let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
        sqlx::query("CREATE TABLE ai_approval_grants (id INTEGER PRIMARY KEY, scope_level TEXT, material TEXT, category TEXT, question TEXT, payload_hash TEXT, expires_at TEXT, revoked_at TEXT, request_url TEXT, request_method TEXT, consumed_at TEXT)").execute(&mut db).await.unwrap();
        let url = "https://google.serper.dev/search";
        let hash = approval_payload_hash("MLCC", "", "公开行情");
        sqlx::query("INSERT INTO ai_approval_grants VALUES (1,'C1','MLCC','','公开行情',?,'2099-01-01 00:00:00','',?,'POST','')").bind(&hash).bind(url).execute(&mut db).await.unwrap();
        let model_hash = approval_payload_hash("M27", "公开型号", "公开规格");
        sqlx::query("INSERT INTO ai_approval_grants VALUES (2,'C1_PUBLIC_MODEL','M27','公开型号','公开规格',?,'2099-01-01 00:00:00','',?,'GET','')").bind(&model_hash).bind(url).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let mut request = CloudHttpRequest {
            url: url.into(), method: "POST".into(), body: Some(r#"{"q":"MLCC 公开行情"}"#.into()),
            approval: CloudApproval { material: "MLCC".into(), category: "".into(), question: "公开行情".into(), reviewed: true, grant_id: Some(1), payload_hash: Some(hash), expires_at: Some("2099-01-01 00:00:00".into()), scope_level: Some("C1".into()) },
        };
        let legitimate = validate_cloud_request_with_grant_at_path(&request, &path).await;
        request.body = Some(r#"{"q":"MLCC COSTHUB_DUMMY_SECRET 123.45"}"#.into());
        let changed = validate_cloud_request_with_grant_at_path(&request, &path).await;
        let model_request = CloudHttpRequest {
            url: format!("{url}?q=M27%20%E5%85%AC%E5%BC%80%E8%A7%84%E6%A0%BC"), method: "GET".into(), body: None,
            approval: CloudApproval { material: "M27".into(), category: "公开型号".into(), question: "公开规格".into(), reviewed: true, grant_id: Some(2), payload_hash: Some(model_hash), expires_at: Some("2099-01-01 00:00:00".into()), scope_level: Some("C1_PUBLIC_MODEL".into()) },
        };
        let model_ok = validate_cloud_request_with_grant_at_path(&model_request, &path).await;
        let model_tampered = validate_cloud_request_with_grant_at_path(&CloudHttpRequest { url: format!("{url}?q=M27%20COSTHUB_DUMMY_SECRET"), ..model_request }, &path).await;
        // Synthetic data only: non-query fields must not carry unapproved text either.
        request.body = Some(r#"{"q":"MLCC 公开行情","hl":"COSTHUB_DUMMY_SECRET_12345"}"#.into());
        let body_side_channel = validate_cloud_request_with_grant_at_path(&request, &path).await;
        request.body = Some(r#"{"q":"MLCC 公开行情"}"#.into());
        request.url = format!("{url}?hl=COSTHUB_DUMMY_SECRET_12345");
        let url_side_channel = validate_cloud_request_with_grant_at_path(&request, &path).await;
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
        assert!(legitimate.is_ok(), "合法公开主题应通过：{legitimate:?}");
        assert!(changed.is_err(), "批准公开主题后追加未审批文本应拒绝，实际结果：{changed:?}");
        assert!(model_ok.is_ok(), "受控公开型号查询应通过：{model_ok:?}");
        assert!(model_tampered.is_err(), "公开型号 URL 查询词篡改应拒绝：{model_tampered:?}");
        assert!(body_side_channel.is_err() && url_side_channel.is_err(), "非查询字段也必须拒绝未审批文本：body={body_side_channel:?}, url={url_side_channel:?}");
    });
}
