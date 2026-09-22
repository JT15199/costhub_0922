use sqlx::sqlite::SqlitePoolOptions;

fn main() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        // Same per-call pool execution as sql_execute. Synthetic shared-memory database only.
        let pool = SqlitePoolOptions::new().max_connections(5).min_connections(2)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE probe (value INTEGER)").execute(&pool).await.unwrap();
        sqlx::query("BEGIN").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO probe VALUES (1)").execute(&pool).await.unwrap();
        let rollback = sqlx::query("ROLLBACK").execute(&pool).await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM probe").fetch_one(&pool).await.unwrap();
        println!("rollback_ok={}, rows_after_rollback={}", rollback.is_ok(), count);
        assert_eq!(count, 0, "A transaction must roll back every write issued between BEGIN and ROLLBACK");
    });
}
