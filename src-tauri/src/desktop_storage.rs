//! Desktop persistence: the existing ew-writing.db plus immutable, hash-addressed assets.
//! Legacy browser data is copied into staging, verified, then committed in ONE transaction.
//! Never delete legacy data. Migration completion lives in SQLite, not browser storage.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager,
};

pub fn root(app: &crate::DesktopAppHandle) -> Result<PathBuf, String> {
    // Same directory as tauri-plugin-sql; do not create a second ew-writing.db.
    app.path().app_config_dir().map_err(|e| e.to_string())
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub async fn connect_at(root: &Path) -> Result<SqliteConnection, String> {
    connect_with_creation(root, true).await
}
/// 写事务一律 BEGIN IMMEDIATE：先读后写的 deferred 事务在另一个连接（前端 sql 插件的
/// 连接池）持有写锁时会立刻报 database is locked，busy_timeout 对这种升级冲突不生效。
/// IMMEDIATE 在开始时就排队等写锁，等待受 busy_timeout 约束。
pub(crate) async fn begin_write(
    db: &mut SqliteConnection,
) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>, String> {
    db.begin_with("BEGIN IMMEDIATE").await.map_err(error)
}
pub(crate) async fn connect_existing_at(root: &Path) -> Result<SqliteConnection, String> {
    connect_with_creation(root, false).await
}
async fn connect_with_creation(root: &Path, create: bool) -> Result<SqliteConnection, String> {
    if create {
        fs::create_dir_all(root).map_err(error)?;
    }
    // WAL 显式写死：前端 sql 插件和这里的 Rust 连接同时开着这个文件，
    // 只有 WAL 下读写才互不阻塞。写事务另见 begin_write。
    let options = SqliteConnectOptions::new()
        .filename(root.join("ew-writing.db"))
        .create_if_missing(create)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(15));
    let mut db = SqliteConnection::connect_with(&options)
        .await
        .map_err(error)?;
    let has_meta: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='desktop_meta'",
    )
    .fetch_one(&mut db)
    .await
    .map_err(error)?;
    if has_meta > 0 {
        let version: Option<String> =
            sqlx::query_scalar("SELECT value FROM desktop_meta WHERE key='storage-schema-version'")
                .fetch_optional(&mut db)
                .await
                .map_err(error)?;
        if let Some(version) = version {
            let version = version.parse::<i64>().map_err(|_| "存储版本标记无效")?;
            if version > crate::storage_migration::CURRENT_VERSION {
                return Err("数据由更新版本创建，请升级应用；未修改原数据".into());
            }
        }
    }
    for sql in [
        "CREATE TABLE IF NOT EXISTS desktop_records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))",
        "CREATE TABLE IF NOT EXISTS desktop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS desktop_migration_stage (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))",
    ] { sqlx::query(sql).execute(&mut db).await.map_err(error)?; }
    ensure_core_schema(&mut db).await?;
    Ok(db)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub key: Value,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreDump {
    pub namespace: String,
    pub records: Vec<Record>,
}

fn key_text(key: &Value) -> Result<String, String> {
    if !key.is_string() && !key.is_number() {
        return Err("记录标识必须是字符串或数字".into());
    }
    serde_json::to_string(key).map_err(error)
}
pub(crate) async fn rows(
    db: &mut SqliteConnection,
    namespace: &str,
    staging: bool,
) -> Result<Vec<Record>, String> {
    let table = if staging {
        "desktop_migration_stage"
    } else {
        "desktop_records"
    };
    let result = sqlx::query(&format!(
        "SELECT key,value FROM {table} WHERE namespace=? ORDER BY key"
    ))
    .bind(namespace)
    .fetch_all(db)
    .await
    .map_err(error)?;
    result
        .iter()
        .map(|row| {
            Ok(Record {
                key: serde_json::from_str(row.get::<&str, _>("key")).map_err(error)?,
                value: row.get("value"),
            })
        })
        .collect()
}
pub(crate) fn validate_value(root: &Path, value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            if let Some(path) = map.get("__ewAsset").and_then(Value::as_str) {
                let file = asset_path(root, path)?;
                let data = fs::read(file).map_err(|e| format!("附件缺失或无法读取 {path}：{e}"))?;
                let digest = format!("{:x}", Sha256::digest(&data));
                if map.get("sha256").and_then(Value::as_str) != Some(digest.as_str()) {
                    return Err(format!("附件校验失败：{path}"));
                }
            } else {
                for item in map.values() {
                    validate_value(root, item)?;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_value(root, item)?;
            }
        }
        _ => (),
    }
    Ok(())
}

async fn ensure_core_schema(db: &mut SqliteConnection) -> Result<(), String> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS local_books(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,title TEXT NOT NULL,groupId TEXT,mergeStatus TEXT NOT NULL,deletedAt TEXT,updateTime TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS local_book_groups(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,deletedAt TEXT,sortNo INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS local_volumes(id INTEGER PRIMARY KEY,bookId TEXT NOT NULL,payload TEXT NOT NULL,deletedAt TEXT,sortNo INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS local_chapters(id INTEGER PRIMARY KEY,bookId TEXT NOT NULL,volumeId TEXT NOT NULL,payload TEXT NOT NULL,deletedAt TEXT,sortNo INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS chapter_contents(storageKey TEXT PRIMARY KEY,userId TEXT NOT NULL,bookId TEXT NOT NULL,chapterId INTEGER NOT NULL,payload TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 0,conflict INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL,lastBackedUpAt INTEGER NOT NULL DEFAULT 0,wordCount INTEGER NOT NULL DEFAULT 0,textWordCount INTEGER)",
        "CREATE TABLE IF NOT EXISTS chapter_versions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,chapterId INTEGER NOT NULL,createdAt INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS sync_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    ] { sqlx::query(sql).execute(&mut *db).await.map_err(error)?; }
    let columns = sqlx::query("PRAGMA table_info(chapter_contents)")
        .fetch_all(&mut *db)
        .await
        .map_err(error)?;
    for (name, definition) in [
        ("lastBackedUpAt", "INTEGER NOT NULL DEFAULT 0"),
        ("wordCount", "INTEGER NOT NULL DEFAULT 0"),
        ("textWordCount", "INTEGER"),
    ] {
        if !columns.iter().any(|row| row.get::<&str, _>("name") == name) {
            sqlx::query(&format!(
                "ALTER TABLE chapter_contents ADD COLUMN {name} {definition}"
            ))
            .execute(&mut *db)
            .await
            .map_err(error)?;
        }
    }
    Ok(())
}
pub(crate) fn validate_core_record(table: &str, value: &Value) -> Result<(), String> {
    let invalid = || format!("旧数据记录结构无效：{table}，未覆盖原数据");
    if !value.is_object() {
        return Err(invalid());
    }
    let valid_id = |field: &str| {
        value[field]
            .as_i64()
            .or_else(|| value[field].as_str().and_then(|v| v.parse::<i64>().ok()))
            .is_some_and(|id| id != 0 && id.unsigned_abs() <= 9_007_199_254_740_991)
    };
    let string = |field: &str| value[field].is_string();
    let valid = match table {
        "local_books" | "local_book_groups" => valid_id("id") && string("title"),
        "local_volumes" => valid_id("id") && valid_id("bookId") && string("title"),
        "local_chapters" => {
            valid_id("id") && valid_id("bookId") && valid_id("volumeId") && string("title")
        }
        "chapter_contents" => {
            string("storageKey")
                && string("userId")
                && valid_id("bookId")
                && valid_id("chapterId")
                && string("textContent")
        }
        "chapter_versions" => {
            string("id")
                && valid_id("chapterId")
                && string("textContent")
                && value["createdAt"].is_number()
        }
        "sync_settings" => string("key") && string("value"),
        _ => false,
    };
    if !valid {
        return Err(invalid());
    }
    Ok(())
}

/// Imports one row of the legacy browser library (IndexedDB copy of books / drafts).
///
/// SQLite has been the active desktop store since the library left IndexedDB, so the
/// browser copy is at best stale. A row that cannot be imported — malformed, or already
/// present in SQLite with different content — is skipped rather than failing the whole
/// migration: its exact bytes stay in `desktop_migration_stage` and in IndexedDB, and the
/// reason is returned so the receipt can record it. A single odd row must never keep the
/// app from starting.
async fn import_legacy_core(
    db: &mut SqliteConnection,
    table: &str,
    record: &Record,
) -> Result<Option<String>, String> {
    let key = if let Some(text) = record.key.as_str() {
        text.to_string()
    } else {
        record.key.to_string()
    };
    let skipped = |reason: &str| Ok(Some(format!("{table}/{key}：{reason}")));
    let Ok(value) = serde_json::from_str::<Value>(&record.value) else {
        return skipped("旧记录 JSON 损坏，未导入");
    };
    if validate_core_record(table, &value).is_err() {
        return skipped("旧记录结构无效，未导入");
    }
    let (key_column, payload_column) = match table {
        "local_books" | "local_book_groups" | "local_volumes" | "local_chapters"
        | "chapter_versions" => ("id", "payload"),
        "chapter_contents" => ("storageKey", "payload"),
        "sync_settings" => ("key", "value"),
        _ => return Err("未知旧数据表".into()),
    };
    if value.get(key_column) != Some(&record.key) {
        return skipped("旧记录标识与内容不一致，未导入");
    }
    let old: Option<String> = sqlx::query_scalar(&format!(
        "SELECT {payload_column} FROM {table} WHERE {key_column}=?"
    ))
    .bind(&key)
    .fetch_optional(&mut *db)
    .await
    .map_err(error)?;
    if let Some(old) = old {
        // Legacy browser settings (backup paths, lastBackupAt, derived word-count
        // caches, etc.) are naturally different and must not overwrite current choices.
        if table == "sync_settings" {
            return Ok(None);
        }
        let same = serde_json::from_str::<Value>(&old).is_ok_and(|current| current == value);
        if !same {
            return skipped("SQLite 已有同编号的不同内容，保留 SQLite 版本");
        }
        return Ok(None);
    }
    let string = |name: &str| -> Value {
        if value[name].is_null() {
            Value::String(String::new())
        } else if value[name].is_string() {
            value[name].clone()
        } else {
            Value::String(value[name].to_string())
        }
    };
    let number = |name: &str| -> Value {
        value[name]
            .as_i64()
            .map(Value::from)
            .unwrap_or(Value::from(0))
    };
    let payload = Value::String(record.value.clone());
    let (columns,params)=match table {
        "local_books"=>("id,payload,title,groupId,mergeStatus,deletedAt,updateTime",vec![record.key.clone(),payload,string("title"),value["groupId"].clone(),value.get("mergeStatus").cloned().unwrap_or(json!("local")),value["deletedAt"].clone(),string("updateTime")]),
        "local_book_groups"=>("id,payload,deletedAt,sortNo",vec![record.key.clone(),payload,value["deletedAt"].clone(),number("sortNo")]),
        "local_volumes"=>("id,bookId,payload,deletedAt,sortNo",vec![record.key.clone(),string("bookId"),payload,value["deletedAt"].clone(),number("sortNo")]),
        "local_chapters"=>("id,bookId,volumeId,payload,deletedAt,sortNo",vec![record.key.clone(),string("bookId"),string("volumeId"),payload,value["deletedAt"].clone(),number("sortNo")]),
        "chapter_contents"=>("storageKey,userId,bookId,chapterId,payload,dirty,conflict,updatedAt,lastBackedUpAt,wordCount,textWordCount",vec![record.key.clone(),string("userId"),string("bookId"),number("chapterId"),payload,json!(value["dirty"].as_bool().unwrap_or(false)),json!(value["conflict"].as_bool().unwrap_or(false)),number("updatedAt"),number("lastBackedUpAt"),number("wordCount"),value["textWordCount"].clone()]),
        "chapter_versions"=>("id,payload,chapterId,createdAt",vec![record.key.clone(),payload,number("chapterId"),number("createdAt")]),
        _=>("key,value",vec![record.key.clone(),string("value")]),
    };
    let placeholders = vec!["?"; params.len()].join(",");
    execute_statements(
        db,
        vec![SqlStatement {
            sql: format!("INSERT INTO {table}({columns}) VALUES({placeholders})"),
            params,
        }],
    )
    .await?;
    Ok(None)
}

#[tauri::command]
pub async fn desktop_store_read(
    app: crate::DesktopAppHandle,
    namespace: String,
    staging: Option<bool>,
) -> Result<Vec<Record>, String> {
    rows(
        &mut connect_at(&root(&app)?).await?,
        &namespace,
        staging.unwrap_or(false),
    )
    .await
}
#[tauri::command]
pub async fn desktop_store_get(
    app: crate::DesktopAppHandle,
    namespace: String,
    key: Value,
) -> Result<Option<String>, String> {
    let mut db = connect_at(&root(&app)?).await?;
    sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
        .bind(namespace)
        .bind(key_text(&key)?)
        .fetch_optional(&mut db)
        .await
        .map_err(error)
}
#[tauri::command]
pub async fn desktop_store_write(
    app: crate::DesktopAppHandle,
    namespace: String,
    records: Vec<Record>,
    remove: Vec<Value>,
    replace: bool,
    staging: Option<bool>,
) -> Result<(), String> {
    if staging.unwrap_or(false) {
        return Err("迁移写入必须使用有效迁移会话".into());
    }
    write_at(
        &root(&app)?,
        &namespace,
        records,
        remove,
        replace,
        staging.unwrap_or(false),
    )
    .await
}
pub async fn write_at(
    root: &Path,
    namespace: &str,
    records: Vec<Record>,
    remove: Vec<Value>,
    replace: bool,
    staging: bool,
) -> Result<(), String> {
    let mut db = connect_at(root).await?;
    let table = if staging {
        "desktop_migration_stage"
    } else {
        "desktop_records"
    };
    for record in &records {
        key_text(&record.key)?;
        let value: Value = serde_json::from_str(&record.value).map_err(error)?;
        validate_value(root, &value)?;
    }
    let mut tx = begin_write(&mut db).await?;
    if replace {
        sqlx::query(&format!("DELETE FROM {table} WHERE namespace=?"))
            .bind(namespace)
            .execute(&mut *tx)
            .await
            .map_err(error)?;
    }
    for key in remove {
        sqlx::query(&format!("DELETE FROM {table} WHERE namespace=? AND key=?"))
            .bind(namespace)
            .bind(key_text(&key)?)
            .execute(&mut *tx)
            .await
            .map_err(error)?;
    }
    for record in records {
        sqlx::query(&format!(
            "INSERT OR REPLACE INTO {table}(namespace,key,value) VALUES(?,?,?)"
        ))
        .bind(namespace)
        .bind(key_text(&record.key)?)
        .bind(record.value)
        .execute(&mut *tx)
        .await
        .map_err(error)?;
    }
    tx.commit().await.map_err(error)
}

/// Applies verified staging rows to the live tables. Returns notes for legacy-library rows
/// that were deliberately skipped (see `import_legacy_core`); they are kept in staging.
pub(crate) async fn apply_migration_records(
    root: &Path,
    db: &mut SqliteConnection,
    expected: &[StoreDump],
) -> Result<Vec<String>, String> {
    let mut skipped = Vec::new();
    // Exact keys AND payloads, not just record counts; no INSERT OR REPLACE over migrated data.
    for store in expected {
        let found = rows(&mut *db, &store.namespace, true).await?;
        if found.len() != store.records.len() {
            return Err(format!("迁移数量校验失败：{}", store.namespace));
        }
        for record in &store.records {
            let actual = found
                .iter()
                .find(|item| item.key == record.key)
                .ok_or("迁移缺少记录")?;
            if actual.value != record.value {
                return Err(format!("迁移内容校验失败：{}", store.namespace));
            }
            validate_value(root, &serde_json::from_str(&record.value).map_err(error)?)?;
            if store.namespace == "core-cover-assets" {
                let cover: Value = serde_json::from_str(&record.value).map_err(error)?;
                let old = cover["original"].as_str().ok_or("封面迁移缺少原始记录")?;
                let result =
                    sqlx::query("UPDATE local_books SET payload=? WHERE id=? AND payload=?")
                        .bind(cover["book"].to_string())
                        .bind(record.key.as_i64().ok_or("书籍标识无效")?)
                        .bind(old)
                        .execute(&mut *db)
                        .await
                        .map_err(error)?;
                if result.rows_affected() != 1 {
                    return Err("封面迁移时书籍内容发生变化，已撤回迁移".into());
                }
                continue;
            }
            if let Some(table) = store.namespace.strip_prefix("legacy-core/") {
                if let Some(note) = import_legacy_core(&mut *db, table, record).await? {
                    skipped.push(note);
                }
                continue;
            }
            let old: Option<String> =
                sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
                    .bind(&store.namespace)
                    .bind(key_text(&record.key)?)
                    .fetch_optional(&mut *db)
                    .await
                    .map_err(error)?;
            if old.is_some() && old.as_deref() != Some(record.value.as_str()) {
                return Err("已有新存储数据与迁移数据冲突，原数据保留".into());
            }
            sqlx::query("INSERT OR IGNORE INTO desktop_records(namespace,key,value) VALUES(?,?,?)")
                .bind(&store.namespace)
                .bind(key_text(&record.key)?)
                .bind(&record.value)
                .execute(&mut *db)
                .await
                .map_err(error)?;
        }
    }
    if expected
        .iter()
        .any(|store| store.namespace == "legacy-core/chapter_contents" && !store.records.is_empty())
    {
        sqlx::query("DELETE FROM sync_settings WHERE key='wordCountBackfilled'")
            .execute(&mut *db)
            .await
            .map_err(error)?;
    }
    Ok(skipped)
}

fn asset_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 3
        || parts[0] != "assets"
        || !["fonts", "images", "files"].contains(&parts[1])
        || !parts[2]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
        || parts[2].contains("..")
    {
        return Err("非法资源路径".into());
    }
    Ok(root.join(path))
}
pub fn save_asset(root: &Path, kind: &str, extension: &str, bytes: &[u8]) -> Result<Value, String> {
    if !["fonts", "images", "files"].contains(&kind)
        || extension.is_empty()
        || !extension.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("非法资源类型".into());
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let relative = format!("assets/{kind}/{hash}.{extension}");
    let path = asset_path(root, &relative)?;
    fs::create_dir_all(path.parent().ok_or("缺少资源目录")?).map_err(error)?;
    if path.exists() {
        if fs::read(&path).map_err(error)? != bytes {
            return Err("同名资源校验失败，未覆盖原文件".into());
        }
    } else {
        let tmp = path.with_extension(format!(
            "{}.tmp-{}",
            extension,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(error)?
                .as_nanos()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(error)?;
        file.write_all(bytes).map_err(error)?;
        file.sync_all().map_err(error)?;
        fs::rename(&tmp, &path).map_err(error)?;
    }
    Ok(json!({"__ewAsset":relative,"sha256":hash,"size":bytes.len()}))
}
#[tauri::command]
pub fn desktop_asset_write(
    app: crate::DesktopAppHandle,
    request: Request<'_>,
) -> Result<Value, String> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("资源必须使用二进制传输".into());
    };
    save_asset(
        &root(&app)?,
        &header("x-ew-kind"),
        &header("x-ew-extension"),
        bytes,
    )
}
// 大文件读取加哈希会阻塞主线程；(async) 让它跑在线程池上
#[tauri::command(async)]
pub fn desktop_asset_read(
    app: crate::DesktopAppHandle,
    path: String,
    sha256: String,
) -> Result<Response, String> {
    let bytes = fs::read(asset_path(&root(&app)?, &path)?).map_err(error)?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err(format!("资源校验失败：{path}"));
    }
    Ok(Response::new(bytes))
}

/// Explicit batch on one connection. JS plugin execute() calls can use different pool connections.
#[derive(Deserialize)]
pub struct SqlStatement {
    pub sql: String,
    pub params: Vec<Value>,
}
pub async fn execute_statements(
    db: &mut SqliteConnection,
    statements: Vec<SqlStatement>,
) -> Result<(), String> {
    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.params {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Bool(v) => query.bind(v),
                Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
                Value::Number(v) => query.bind(v.as_f64().ok_or("非法数字")?),
                Value::String(v) => query.bind(v),
                _ => return Err("SQL 参数必须是标量".into()),
            };
        }
        query.execute(&mut *db).await.map_err(error)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_sql_transaction(
    app: crate::DesktopAppHandle,
    statements: Vec<SqlStatement>,
) -> Result<(), String> {
    let mut db = connect_at(&root(&app)?).await?;
    let mut tx = begin_write(&mut db).await?;
    execute_statements(&mut tx, statements).await?;
    tx.commit().await.map_err(error)
}

pub async fn apply_stores(
    root: &Path,
    db: &mut SqliteConnection,
    stores: &[StoreDump],
    replace: bool,
) -> Result<(), String> {
    for store in stores {
        if replace {
            sqlx::query("DELETE FROM desktop_records WHERE namespace=?")
                .bind(&store.namespace)
                .execute(&mut *db)
                .await
                .map_err(error)?;
        }
        for record in &store.records {
            validate_value(root, &serde_json::from_str(&record.value).map_err(error)?)?;
            sqlx::query(
                "INSERT OR REPLACE INTO desktop_records(namespace,key,value) VALUES(?,?,?)",
            )
            .bind(&store.namespace)
            .bind(key_text(&record.key)?)
            .bind(&record.value)
            .execute(&mut *db)
            .await
            .map_err(error)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_store_batch(
    app: crate::DesktopAppHandle,
    stores: Vec<StoreDump>,
    replace: bool,
) -> Result<(), String> {
    let root = root(&app)?;
    let mut db = connect_at(&root).await?;
    let mut tx = begin_write(&mut db).await?;
    apply_stores(&root, &mut tx, &stores, replace).await?;
    tx.commit().await.map_err(error)
}
async fn compare_write_at(
    root: &Path,
    namespace: &str,
    key: Value,
    expected: Option<String>,
    value: String,
) -> Result<bool, String> {
    validate_value(root, &serde_json::from_str(&value).map_err(error)?)?;
    let mut db = connect_at(root).await?;
    let mut tx = begin_write(&mut db).await?;
    let key = key_text(&key)?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(namespace)
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(error)?;
    if current != expected {
        return Ok(false);
    }
    sqlx::query("INSERT OR REPLACE INTO desktop_records(namespace,key,value) VALUES(?,?,?)")
        .bind(namespace)
        .bind(key)
        .bind(value)
        .execute(&mut *tx)
        .await
        .map_err(error)?;
    tx.commit().await.map_err(error)?;
    Ok(true)
}
#[tauri::command]
pub async fn desktop_store_compare_write(
    app: crate::DesktopAppHandle,
    namespace: String,
    key: Value,
    expected: Option<String>,
    value: String,
) -> Result<bool, String> {
    compare_write_at(&root(&app)?, &namespace, key, expected, value).await
}

async fn payloads(db: &mut SqliteConnection, table: &str) -> Result<Vec<Value>, String> {
    let values: Vec<String> = sqlx::query_scalar(&format!("SELECT payload FROM {table}"))
        .fetch_all(db)
        .await
        .map_err(error)?;
    values
        .into_iter()
        .map(|s| {
            let value: Value = serde_json::from_str(&s)
                .map_err(|e| format!("{table} 中存在损坏数据，停止备份：{e}"))?;
            if !value.is_object()
                || (table == "chapter_contents"
                    && (!value["textContent"].is_string()
                        || (value.get("title").is_some() && !value["title"].is_string())))
            {
                return Err(format!("{table} 中存在损坏记录，停止备份；原记录未修改"));
            }
            Ok(value)
        })
        .collect()
}
#[tauri::command]
pub async fn desktop_storage_snapshot(app: crate::DesktopAppHandle) -> Result<Value, String> {
    snapshot_at(&root(&app)?).await
}
pub async fn snapshot_at(root: &Path) -> Result<Value, String> {
    let mut db = connect_at(root).await?;
    let mut tx = db.begin().await.map_err(error)?;
    let library = json!({"groups":payloads(&mut tx,"local_book_groups").await?,"books":payloads(&mut tx,"local_books").await?,"volumes":payloads(&mut tx,"local_volumes").await?,"chapters":payloads(&mut tx,"local_chapters").await?});
    let settings = sqlx::query("SELECT key,value FROM sync_settings")
        .fetch_all(&mut *tx)
        .await
        .map_err(error)?
        .iter()
        .map(|r| json!({"key":r.get::<String,_>("key"),"value":r.get::<String,_>("value")}))
        .collect::<Vec<_>>();
    let writing = json!({"chapters":payloads(&mut tx,"chapter_contents").await?,"versions":payloads(&mut tx,"chapter_versions").await?,"settings":settings});
    let namespaces: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT namespace FROM desktop_records")
            .fetch_all(&mut *tx)
            .await
            .map_err(error)?;
    let mut stores = Vec::new();
    for namespace in namespaces {
        stores.push(StoreDump {
            records: rows(&mut tx, &namespace, false).await?,
            namespace,
        });
    }
    tx.commit().await.map_err(error)?;
    Ok(json!({"library":library,"writing":writing,"stores":stores}))
}

fn prompt_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir).map_err(error)? {
        let entry = entry.map_err(error)?;
        if entry.file_type().map_err(error)?.is_symlink() {
            return Err("提示词目录含符号链接，请使用实际文件后再恢复".into());
        }
        let path = entry.path();
        if path.is_dir() {
            out.extend(prompt_files(&path)?)
        } else if ["md", "txt"].contains(
            &path
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
        ) {
            out.push(path)
        }
    }
    Ok(out)
}
fn copy_prompts(source: &Path, target: &Path) -> Result<(), String> {
    for file in prompt_files(source)? {
        let dest = target.join(file.strip_prefix(source).map_err(error)?);
        fs::create_dir_all(dest.parent().ok_or("缺少提示词目录")?).map_err(error)?;
        fs::copy(&file, &dest).map_err(error)?;
        // Windows FlushFileBuffers requires a writable handle.
        fs::OpenOptions::new()
            .write(true)
            .open(dest)
            .map_err(error)?
            .sync_all()
            .map_err(error)?;
    }
    Ok(())
}
/// The journal survives a crash between file replacement and the SQLite COMMIT.
/// SQLite's commit token decides whether to keep new files or restore old ones.
pub async fn recover_restore_at(root: &Path, prompts: &Path) -> Result<(), String> {
    let journal = root.join("pending-restore");
    if !journal.exists() {
        return Ok(());
    }
    let marker = journal.join("ready.json");
    if !marker.exists() {
        fs::remove_dir_all(journal).map_err(error)?;
        return Ok(());
    }
    let token: String =
        serde_json::from_slice(&fs::read(&marker).map_err(error)?).map_err(error)?;
    let mut db = connect_at(root).await?;
    let committed: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_meta WHERE key='restore-commit'")
            .fetch_optional(&mut db)
            .await
            .map_err(error)?;
    if committed.as_deref() != Some(token.as_str()) {
        for file in prompt_files(prompts)? {
            fs::remove_file(file).map_err(error)?;
        }
        copy_prompts(&journal.join("prompts"), prompts)?;
    }
    fs::remove_dir_all(journal).map_err(error)
}
#[tauri::command]
pub async fn desktop_recover_restore(app: crate::DesktopAppHandle) -> Result<(), String> {
    recover_restore_at(&root(&app)?, &crate::prompt_dir_path()?).await
}
#[derive(Deserialize)]
pub struct LegacyRestoreBase {
    statements: Vec<SqlStatement>,
    stores: Vec<StoreDump>,
}
#[tauri::command]
pub async fn desktop_restore_apply(
    app: crate::DesktopAppHandle,
    statements: Vec<SqlStatement>,
    stores: Vec<StoreDump>,
    replace: bool,
    session: String,
    mode: String,
    legacy_base: Option<LegacyRestoreBase>,
) -> Result<usize, String> {
    if app.webview_windows().len() > 1 {
        return Err("请先关闭独立的大纲、预览等窗口，再恢复数据".into());
    }
    if legacy_base.is_some()
        != matches!(
            crate::storage_migration::desktop_storage_session()?,
            Some(crate::storage_migration::RuntimeStorage::Legacy { .. })
        )
    {
        return Err("恢复来源与当前存储模式不一致，未修改数据".into());
    }
    let root = root(&app)?;
    let prompts = crate::prompt_dir_path()?;
    let result = restore_at(
        &root,
        &prompts,
        statements,
        stores,
        replace,
        legacy_base,
        || crate::full_backup::full_restore_apply_prompts(session, mode),
    )
    .await;
    if result.is_ok() {
        crate::storage_migration::use_restored_storage()?;
    }
    result
}

async fn restore_at<F: FnOnce() -> Result<usize, String> + Send>(
    root: &Path,
    prompts: &Path,
    statements: Vec<SqlStatement>,
    stores: Vec<StoreDump>,
    replace: bool,
    legacy_base: Option<LegacyRestoreBase>,
    apply_prompts: F,
) -> Result<usize, String> {
    recover_restore_at(&root, &prompts).await?;
    if legacy_base.is_some() {
        let inspection = crate::storage_migration::inspect_at(root).await?;
        if !matches!(
            inspection.state,
            crate::storage_migration::StartupState::NeedsInventory
                | crate::storage_migration::StartupState::Retry
        ) {
            return Err("当前数据已切换或状态不明确，未覆盖已有内容".into());
        }
    }
    let journal = root.join("pending-restore");
    fs::create_dir(&journal).map_err(error)?;
    copy_prompts(&prompts, &journal.join("prompts"))?;
    let token = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(error)?
        .as_nanos()
        .to_string();
    let mut ready = fs::File::create(journal.join("ready.pending")).map_err(error)?;
    ready
        .write_all(serde_json::to_string(&token).map_err(error)?.as_bytes())
        .map_err(error)?;
    ready.sync_all().map_err(error)?;
    drop(ready);
    fs::rename(journal.join("ready.pending"), journal.join("ready.json")).map_err(error)?;
    let mut db = connect_at(&root).await?;
    let result = async {
        let mut tx = begin_write(&mut db).await?;
        if let Some(base) = legacy_base {
            execute_statements(&mut tx, base.statements).await?;
            apply_stores(&root, &mut tx, &base.stores, false).await?;
        }
        execute_statements(&mut tx, statements).await?;
        apply_stores(&root, &mut tx, &stores, replace).await?;
        crate::storage_migration::complete_restore(&mut tx, &token).await?;
        let count = apply_prompts()?;
        sqlx::query("INSERT OR REPLACE INTO desktop_meta(key,value) VALUES('restore-commit',?)")
            .bind(&token)
            .execute(&mut *tx)
            .await
            .map_err(error)?;
        tx.commit().await.map_err(error)?;
        Ok::<_, String>(count)
    }
    .await;
    // Close connection before recovery so any uncommitted SQL is rolled back first.
    let close_result = db.close().await;
    if let Err(recovery) = recover_restore_at(&root, &prompts).await {
        return Err(format!(
            "恢复需要修复后才能继续使用，旧数据已保留：{recovery}"
        ));
    }
    close_result.map_err(|e| format!("恢复需要修复后才能继续使用，数据库关闭失败：{e}"))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "ew-storage-test-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn record(key: Value, value: Value) -> Record {
        Record {
            key,
            value: value.to_string(),
        }
    }

    // Exercise the data-copy primitive separately from the versioned startup protocol.
    async fn apply_fixture(root: &Path, expected: Vec<StoreDump>) -> Result<(), String> {
        let mut db = connect_at(root).await?;
        let mut tx = db.begin().await.map_err(error)?;
        apply_migration_records(root, &mut tx, &expected).await?;
        sqlx::query("INSERT OR REPLACE INTO desktop_meta(key,value) VALUES('browser-migration-v1','complete')").execute(&mut *tx).await.map_err(error)?;
        tx.commit().await.map_err(error)
    }

    #[test]
    fn migration_verifies_payload_then_commits_marker_and_records_together() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let original = record(
                json!("run:-1"),
                json!({"id":-1,"title":"工作流原文","unknownFutureField":{"保留":true}}),
            );
            write_at(
                &root.0,
                "ew-local-workflow/kv",
                vec![original.clone()],
                vec![],
                true,
                true,
            )
            .await
            .unwrap();
            let wrong = StoreDump {
                namespace: "ew-local-workflow/kv".into(),
                records: vec![record(json!("run:-1"), json!({"title":"被截断"}))],
            };
            assert!(apply_fixture(&root.0, vec![wrong]).await.is_err());
            let mut db = connect_at(&root.0).await.unwrap();
            assert!(rows(&mut db, "ew-local-workflow/kv", false)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM desktop_meta")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                0
            );
            let expected = StoreDump {
                namespace: "ew-local-workflow/kv".into(),
                records: vec![original.clone()],
            };
            apply_fixture(&root.0, vec![expected.clone()])
                .await
                .unwrap();
            assert_eq!(
                rows(&mut db, "ew-local-workflow/kv", false).await.unwrap()[0].value,
                original.value
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM desktop_meta WHERE key='browser-migration-v1'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "complete"
            );
            // Old source is retained, but cannot overwrite newer desktop edits on retry.
            write_at(
                &root.0,
                "ew-local-workflow/kv",
                vec![record(json!("run:-1"), json!({"title":"迁移后的新稿"}))],
                vec![],
                false,
                false,
            )
            .await
            .unwrap();
            assert!(apply_fixture(&root.0, vec![expected]).await.is_err());
            assert_eq!(
                rows(&mut db, "ew-local-workflow/kv", true).await.unwrap()[0].value,
                original.value
            );
        });
    }

    #[test]
    fn legacy_core_conflict_keeps_sqlite_row_and_still_imports_other_stores() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = connect_at(&root.0).await.unwrap();
            let original = json!({"id":-1,"title":"SQLite原书"});
            sqlx::query("INSERT INTO local_books(id,payload,title,mergeStatus,updateTime) VALUES(-1,?,'SQLite原书','local','')").bind(original.to_string()).execute(&mut db).await.unwrap();
            let incoming = record(json!(-1), json!({"id":-1,"title":"另一份旧稿"}));
            let core = StoreDump {
                namespace: "legacy-core/local_books".into(),
                records: vec![incoming.clone()],
            };
            let refs = StoreDump {
                namespace: "ew-local-reference/book-reference".into(),
                records: vec![record(json!("-1"), json!({"characters":[{"name":"角色"}]}))],
            };
            for store in [&core, &refs] {
                write_at(
                    &root.0,
                    &store.namespace,
                    store.records.clone(),
                    vec![],
                    true,
                    true,
                )
                .await
                .unwrap();
            }
            // 旧浏览器库里同编号的不同内容不再让迁移失败：SQLite 为准，其它库照常导入
            apply_fixture(&root.0, vec![refs, core]).await.unwrap();
            assert_eq!(
                rows(&mut db, "ew-local-reference/book-reference", false)
                    .await
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT payload FROM local_books WHERE id=-1")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                original.to_string()
            );
            // 旧稿留在暂存表里，没有丢
            assert_eq!(
                rows(&mut db, "legacy-core/local_books", true)
                    .await
                    .unwrap()[0]
                    .value,
                incoming.value
            );
        });
    }

    #[test]
    fn legacy_settings_differences_do_not_block_startup_or_overwrite_current_settings() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = connect_at(&root.0).await.unwrap();
            let current = r#"{"backupEnabled":true,"backupDir":"/desktop/backups","backupRetention":20,"lastBackupAt":900}"#;
            let legacy =
                r#"{"backupEnabled":false,"backupDir":"","backupRetention":5,"lastBackupAt":100}"#;
            for (key, value) in [
                ("localWritingSettings", current),
                ("bookWordCounts:guest", r#"{"-1":500}"#),
                ("wordCountBackfilled", "true"),
            ] {
                sqlx::query("INSERT INTO sync_settings(key,value) VALUES(?,?)")
                    .bind(key)
                    .bind(value)
                    .execute(&mut db)
                    .await
                    .unwrap();
            }
            let draft = json!({"storageKey":"guest:-1:-2","userId":"guest","bookId":"-1","chapterId":-2,"textContent":"原正文一字不改","updatedAt":123});
            sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt) VALUES('guest:-1:-2','guest','-1',-2,?,123)").bind(draft.to_string()).execute(&mut db).await.unwrap();
            let settings = StoreDump {
                namespace: "legacy-core/sync_settings".into(),
                records: vec![
                    record(
                        json!("localWritingSettings"),
                        json!({"key":"localWritingSettings","value":legacy}),
                    ),
                    record(
                        json!("bookWordCounts:guest"),
                        json!({"key":"bookWordCounts:guest","value":"{\"-1\":100}"}),
                    ),
                    record(
                        json!("wordCountBackfilled"),
                        json!({"key":"wordCountBackfilled","value":"false"}),
                    ),
                    record(
                        json!("legacyOnlySetting"),
                        json!({"key":"legacyOnlySetting","value":"旧库独有设置"}),
                    ),
                ],
            };
            write_at(
                &root.0,
                &settings.namespace,
                settings.records.clone(),
                vec![],
                true,
                true,
            )
            .await
            .unwrap();
            apply_fixture(&root.0, vec![settings.clone()])
                .await
                .unwrap();
            for (key, value) in [
                ("localWritingSettings", current),
                ("bookWordCounts:guest", r#"{"-1":500}"#),
                ("wordCountBackfilled", "true"),
                ("legacyOnlySetting", "旧库独有设置"),
            ] {
                assert_eq!(
                    sqlx::query_scalar::<_, String>("SELECT value FROM sync_settings WHERE key=?")
                        .bind(key)
                        .fetch_one(&mut db)
                        .await
                        .unwrap(),
                    value
                );
            }
            let archived = rows(&mut db, &settings.namespace, true).await.unwrap();
            for item in &settings.records {
                assert_eq!(
                    archived
                        .iter()
                        .find(|row| row.key == item.key)
                        .unwrap()
                        .value,
                    item.value
                );
            }
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT payload FROM chapter_contents WHERE storageKey='guest:-1:-2'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                draft.to_string()
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM desktop_meta WHERE key='browser-migration-v1'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "complete"
            );
        });
    }

    #[test]
    fn legacy_writing_settings_are_imported_when_sqlite_has_no_settings() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let legacy =
                r#"{"backupEnabled":true,"backupDir":"/previous/backups","backupRetention":30}"#;
            let settings = StoreDump {
                namespace: "legacy-core/sync_settings".into(),
                records: vec![record(
                    json!("localWritingSettings"),
                    json!({"key":"localWritingSettings","value":legacy}),
                )],
            };
            write_at(
                &root.0,
                &settings.namespace,
                settings.records.clone(),
                vec![],
                true,
                true,
            )
            .await
            .unwrap();
            apply_fixture(&root.0, vec![settings]).await.unwrap();
            let mut db = connect_at(&root.0).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='localWritingSettings'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                legacy
            );
        });
    }

    #[test]
    fn stale_browser_library_rows_never_block_migration_and_sqlite_wins() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt) VALUES('guest:-1:-2','guest','-1',-2,?,200)")
                .bind(json!({"storageKey":"guest:-1:-2","userId":"guest","bookId":"-1","chapterId":-2,"textContent":"SQLite 里的新正文","updatedAt":200}).to_string())
                .execute(&mut db)
                .await
                .unwrap();
            let stale = json!({"storageKey":"guest:-1:-2","userId":"guest","bookId":"-1","chapterId":-2,"textContent":"浏览器里的旧正文","updatedAt":100});
            let malformed = json!({"storageKey":"guest:-1:-3","userId":"guest","bookId":"-1","chapterId":0,"textContent":"缺少合法章节号"});
            let stores = vec![StoreDump {
                namespace: "legacy-core/chapter_contents".into(),
                records: vec![
                    record(json!("guest:-1:-2"), stale),
                    record(json!("guest:-1:-3"), malformed),
                ],
            }];
            for store in &stores {
                write_at(
                    &root.0,
                    &store.namespace,
                    store.records.clone(),
                    vec![],
                    true,
                    true,
                )
                .await
                .unwrap();
            }
            let mut tx = db.begin().await.unwrap();
            let notes = apply_migration_records(&root.0, &mut tx, &stores)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            assert_eq!(notes.len(), 2, "两条都应被跳过而不是让迁移失败：{notes:?}");
            let payloads: Vec<String> =
                sqlx::query_scalar("SELECT payload FROM chapter_contents ORDER BY storageKey")
                    .fetch_all(&mut db)
                    .await
                    .unwrap();
            assert_eq!(payloads.len(), 1);
            assert!(payloads[0].contains("SQLite 里的新正文"));
            // 被跳过的旧记录仍留在暂存表里，没有丢
            assert_eq!(
                rows(&mut db, "legacy-core/chapter_contents", true)
                    .await
                    .unwrap()
                    .len(),
                2
            );
        });
    }

    #[test]
    fn legacy_core_import_preserves_full_text_and_history() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let draft = json!({"storageKey":"guest:-1:-2","userId":"guest","bookId":"-1","chapterId":-2,"textContent":"完整正文\n换行与标点！","contentJson":{"type":"doc","content":[]},"updatedAt":123});
            let version =
                json!({"id":"v1","chapterId":-2,"createdAt":100,"textContent":"更早正文"});
            let stores = vec![
                StoreDump {
                    namespace: "legacy-core/chapter_contents".into(),
                    records: vec![record(json!("guest:-1:-2"), draft.clone())],
                },
                StoreDump {
                    namespace: "legacy-core/chapter_versions".into(),
                    records: vec![record(json!("v1"), version.clone())],
                },
            ];
            for store in &stores {
                write_at(
                    &root.0,
                    &store.namespace,
                    store.records.clone(),
                    vec![],
                    true,
                    true,
                )
                .await
                .unwrap();
            }
            apply_fixture(&root.0, stores).await.unwrap();
            let snapshot = snapshot_at(&root.0).await.unwrap();
            assert_eq!(snapshot["writing"]["chapters"][0], draft);
            assert_eq!(snapshot["writing"]["versions"][0], version);
        });
    }

    #[test]
    fn assets_are_immutable_and_verified_before_migration_commit() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let data = b"test font binary\0\xff";
            let asset = save_asset(&root.0, "fonts", "otf", data).unwrap();
            let path = asset["__ewAsset"].as_str().unwrap();
            assert_eq!(fs::read(root.0.join(path)).unwrap(), data);
            assert_eq!(save_asset(&root.0, "fonts", "otf", data).unwrap(), asset);
            let row = record(json!("font-1"), asset);
            write_at(
                &root.0,
                "ew-font-store/files",
                vec![row.clone()],
                vec![],
                true,
                true,
            )
            .await
            .unwrap();
            let path = serde_json::from_str::<Value>(&row.value).unwrap()["__ewAsset"]
                .as_str()
                .unwrap()
                .to_string();
            fs::write(root.0.join(path), b"damaged").unwrap();
            assert!(apply_fixture(
                &root.0,
                vec![StoreDump {
                    namespace: "ew-font-store/files".into(),
                    records: vec![row]
                }]
            )
            .await
            .unwrap_err()
            .contains("附件校验失败"));
            assert!(asset_path(&root.0, "assets/fonts/../../outside").is_err());
        });
    }

    #[test]
    fn a_failed_restore_sql_batch_does_not_delete_original_rows() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO sync_settings(key,value) VALUES('original','原设置')")
                .execute(&mut db)
                .await
                .unwrap();
            let mut tx = db.begin().await.unwrap();
            assert!(execute_statements(
                &mut tx,
                vec![
                    SqlStatement {
                        sql: "DELETE FROM sync_settings".into(),
                        params: vec![]
                    },
                    SqlStatement {
                        sql: "INSERT INTO nonexistent VALUES(1)".into(),
                        params: vec![]
                    }
                ]
            )
            .await
            .is_err());
            tx.rollback().await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='original'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "原设置"
            );
        });
    }

    #[test]
    fn interrupted_file_restore_rolls_back_unless_sqlite_committed() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let prompts = root.0.join("user-prompts");
            fs::create_dir_all(&prompts).unwrap();
            for committed in [false, true] {
                let journal = root.0.join("pending-restore");
                fs::create_dir_all(journal.join("prompts")).unwrap();
                fs::write(journal.join("prompts/正文.md"), "原提示词").unwrap();
                fs::write(journal.join("ready.json"), "\"commit-test\"").unwrap();
                fs::write(prompts.join("正文.md"), "新提示词").unwrap();
                if committed {
                    let mut db = connect_at(&root.0).await.unwrap();
                    sqlx::query("INSERT INTO desktop_meta(key,value) VALUES('restore-commit','commit-test')").execute(&mut db).await.unwrap();
                }
                recover_restore_at(&root.0, &prompts).await.unwrap();
                assert_eq!(
                    fs::read_to_string(prompts.join("正文.md")).unwrap(),
                    if committed {
                        "新提示词"
                    } else {
                        "原提示词"
                    }
                );
                recover_restore_at(&root.0, &prompts).await.unwrap();
            }
        });
    }
    #[test]
    fn full_restore_failure_reverts_database_settings_and_prompt_files() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let prompts = root.0.join("user-prompts");
            fs::create_dir_all(&prompts).unwrap();
            fs::write(prompts.join("正文.md"), "原提示词").unwrap();
            let mut db = connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO sync_settings(key,value) VALUES('original','原设置')")
                .execute(&mut db)
                .await
                .unwrap();
            write_at(
                &root.0,
                "app-settings",
                vec![record(json!("ew-theme"), json!("light"))],
                vec![],
                false,
                false,
            )
            .await
            .unwrap();
            let stores = vec![StoreDump {
                namespace: "app-settings".into(),
                records: vec![record(json!("ew-theme"), json!("dark"))],
            }];
            let fail = restore_at(
                &root.0,
                &prompts,
                vec![SqlStatement {
                    sql: "DELETE FROM sync_settings".into(),
                    params: vec![],
                }],
                stores.clone(),
                true,
                None,
                || {
                    fs::write(prompts.join("正文.md"), "写到一半").unwrap();
                    Err("模拟文件写入失败".into())
                },
            )
            .await;
            assert!(fail.unwrap_err().contains("模拟文件写入失败"));
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='original'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "原设置"
            );
            assert_eq!(
                rows(&mut db, "app-settings", false).await.unwrap()[0].value,
                "\"light\""
            );
            assert_eq!(
                fs::read_to_string(prompts.join("正文.md")).unwrap(),
                "原提示词"
            );
            restore_at(
                &root.0,
                &prompts,
                vec![SqlStatement {
                    sql: "UPDATE sync_settings SET value='新设置'".into(),
                    params: vec![],
                }],
                stores,
                true,
                None,
                || {
                    fs::write(prompts.join("正文.md"), "新提示词").unwrap();
                    Ok(1)
                },
            )
            .await
            .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='original'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "新设置"
            );
            assert_eq!(
                rows(&mut db, "app-settings", false).await.unwrap()[0].value,
                "\"dark\""
            );
            assert_eq!(
                fs::read_to_string(prompts.join("正文.md")).unwrap(),
                "新提示词"
            );
        });
    }
    #[test]
    fn legacy_restore_switch_and_completion_receipt_are_atomic() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let prompts = root.0.join("prompts-fixture");
            let mut db = connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO sync_settings(key,value) VALUES('original','old')")
                .execute(&mut db)
                .await
                .unwrap();
            let baseline = || {
                Some(LegacyRestoreBase {
                    statements: vec![SqlStatement {
                        sql: "UPDATE sync_settings SET value='continued'".into(),
                        params: vec![],
                    }],
                    stores: vec![StoreDump {
                        namespace: "ew-local-reference/book-reference".into(),
                        records: vec![record(
                            json!("-1"),
                            json!({"version":1,"bookId":"-1","characters":[],"commonWords":[{"id":1,"text":"新词条"}]}),
                        )],
                    }],
                })
            };
            assert!(restore_at(
                &root.0,
                &prompts,
                vec![],
                vec![],
                false,
                baseline(),
                || Err("simulated write failure".into())
            )
            .await
            .is_err());
            assert!(rows(&mut db, "ew-local-reference/book-reference", false)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='original'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "old"
            );
            assert_eq!(
                crate::storage_migration::inspect_at(&root.0)
                    .await
                    .unwrap()
                    .state,
                crate::storage_migration::StartupState::NeedsInventory
            );
            restore_at(&root.0, &prompts, vec![], vec![], false, baseline(), || {
                Ok(0)
            })
            .await
            .unwrap();
            assert_eq!(
                crate::storage_migration::inspect_at(&root.0)
                    .await
                    .unwrap()
                    .state,
                crate::storage_migration::StartupState::Ready
            );
            assert_eq!(
                rows(&mut db, "ew-local-reference/book-reference", false)
                    .await
                    .unwrap()
                    .len(),
                1
            );
            // A second restore refreshes the same authoritative receipt; it must remain bootable.
            restore_at(&root.0, &prompts, vec![], vec![], false, None, || Ok(0))
                .await
                .unwrap();
            assert_eq!(
                crate::storage_migration::inspect_at(&root.0)
                    .await
                    .unwrap()
                    .state,
                crate::storage_migration::StartupState::Ready
            );
        });
    }

    #[test]
    fn stale_reference_write_does_not_overwrite_another_window() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let original = json!({"outline":"原大纲","characters":[]}).to_string();
            assert!(
                compare_write_at(&root.0, "reference", json!("book"), None, original.clone())
                    .await
                    .unwrap()
            );
            let first = json!({"outline":"窗口一修改","characters":[]}).to_string();
            assert!(compare_write_at(
                &root.0,
                "reference",
                json!("book"),
                Some(original.clone()),
                first.clone()
            )
            .await
            .unwrap());
            let second = json!({"outline":"原大纲","characters":["新角色"]}).to_string();
            assert!(
                !compare_write_at(&root.0, "reference", json!("book"), Some(original), second)
                    .await
                    .unwrap()
            );
            let mut db = connect_at(&root.0).await.unwrap();
            assert_eq!(
                rows(&mut db, "reference", false).await.unwrap()[0].value,
                first
            );
        });
    }

    #[test]
    fn isolated_desktop_validation_fixture() {
        let Ok(dir) = std::env::var("EW_DESKTOP_VALIDATION_FIXTURE") else {
            return;
        };
        assert!(dir.ends_with("com.yichuang.writing.storage-safety-test"));
        let root = Path::new(&dir);
        assert!(
            !root.join("ew-writing.db").exists(),
            "fixture must not replace existing data"
        );
        tauri::async_runtime::block_on(async {
            let mut db = connect_at(root).await.unwrap();
            let book = json!({"id":-101,"title":"迁移安全验收","coverUrl":"data:image/png;base64,invalid-fixture!","authorId":"guest","localOnly":true,"mergeStatus":"local","tags":[],"wordCount":12,"chapterCount":1,"lastChapterId":-103,"createTime":"2026-10-08T12:00:00Z","updateTime":"2026-10-08T12:00:00Z"});
            let volume = json!({"id":-102,"bookId":"-101","title":"第一卷","sortNo":1,"authorId":"guest","localOnly":true});
            let chapter = json!({"id":-103,"bookId":"-101","volumeId":"-102","title":"第一章","sortNo":1,"wordCount":12,"authorId":"guest","localOnly":true});
            let draft = json!({"storageKey":"guest:-101:-103","userId":"guest","bookId":"-101","chapterId":-103,"title":"第一章","textContent":"这是升级前的原稿，必须完整保留。","contentJson":null,"localVersion":1,"updatedAt":1791451200000i64,"localOnly":true});
            sqlx::query("INSERT INTO local_books(id,payload,title,mergeStatus,updateTime) VALUES(-101,?,'迁移安全验收','local','2026-10-08')").bind(book.to_string()).execute(&mut db).await.unwrap();
            sqlx::query(
                "INSERT INTO local_volumes(id,bookId,payload,sortNo) VALUES(-102,'-101',?,1)",
            )
            .bind(volume.to_string())
            .execute(&mut db)
            .await
            .unwrap();
            sqlx::query("INSERT INTO local_chapters(id,bookId,volumeId,payload,sortNo) VALUES(-103,'-101','-102',?,1)").bind(chapter.to_string()).execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt) VALUES('guest:-101:-103','guest','-101',-103,?,1791451200000)").bind(draft.to_string()).execute(&mut db).await.unwrap();
            db.close().await.unwrap();
        });
    }
}

#[tauri::command]
pub async fn desktop_core_books(app: crate::DesktopAppHandle) -> Result<Vec<Record>, String> {
    let Some(mut db) = crate::storage_migration::open_existing(&root(&app)?).await? else {
        return Ok(vec![]);
    };
    let has_books: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_books'",
    )
    .fetch_one(&mut db)
    .await
    .map_err(error)?;
    if has_books == 0 {
        return Ok(vec![]);
    }
    let rows = sqlx::query("SELECT id,payload FROM local_books")
        .fetch_all(&mut db)
        .await
        .map_err(error)?;
    Ok(rows
        .iter()
        .map(|row| Record {
            key: json!(row.get::<i64, _>("id")),
            value: row.get("payload"),
        })
        .collect())
}
