//! Versioned startup migration protocol. Inspection is read-only; only an explicit
//! plan may initialize/migrate. The migration receipt is committed with the data.
use crate::desktop_storage::{self, Record, StoreDump};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const CURRENT_VERSION: i64 = 1;
const VERSION_KEY: &str = "storage-schema-version";
const LEGACY_KEY: &str = "browser-migration-v1";
const CORE_TABLES: [(&str, &str, &str); 7] = [
    ("local_books", "id", "payload"),
    ("local_book_groups", "id", "payload"),
    ("local_volumes", "id", "payload"),
    ("local_chapters", "id", "payload"),
    ("chapter_contents", "storageKey", "payload"),
    ("chapter_versions", "id", "payload"),
    ("sync_settings", "key", "value"),
];
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn invalid(message: &str) -> String {
    format!("本地存储状态异常，未自动覆盖数据：{message}")
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
fn run_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        now(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationSpec {
    id: String,
    from_version: i64,
    to_version: i64,
    stores: Vec<StoreSpec>,
    settings_namespace: String,
    cover_namespace: String,
}
#[derive(Deserialize)]
struct StoreSpec {
    namespace: String,
}
fn spec() -> MigrationSpec {
    serde_json::from_str(include_str!("../../src/storage/migrations/desktop-v1.json"))
        .expect("bundled migration specification")
}
fn namespaces() -> Vec<String> {
    let s = spec();
    s.stores
        .into_iter()
        .map(|v| v.namespace)
        .chain([s.cover_namespace, s.settings_namespace])
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDigest {
    pub count: u64,
    pub digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceManifest {
    pub migration_id: String,
    pub from_version: i64,
    pub target_version: i64,
    pub sources: BTreeMap<String, SourceDigest>,
}
fn validate_manifest(manifest: &SourceManifest) -> Result<(), String> {
    let s = spec();
    if manifest.migration_id != s.id
        || manifest.from_version != s.from_version
        || manifest.target_version != s.to_version
    {
        return Err(invalid("迁移任务版本不匹配"));
    }
    let expected: BTreeSet<_> = namespaces().into_iter().collect();
    if manifest.sources.keys().cloned().collect::<BTreeSet<_>>() != expected {
        return Err(invalid("旧数据清单缺项或包含未知模块"));
    }
    if manifest
        .sources
        .values()
        .any(|v| v.digest.len() != 64 || !v.digest.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid("旧数据清单校验值无效"));
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupState {
    Ready,
    NeedsInventory,
    Retry,
    AdoptLegacyReceipt,
    RepairReceipt,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub state: StartupState,
    pub token: String,
    pub pending_restore: bool,
    pub sqlite_records: u64,
    pub sqlite_content_records: u64,
    pub baseline: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    id: String,
    from_version: i64,
    to_version: i64,
    status: String,
    origin: String,
    run_id: String,
    baseline: String,
    manifest: String,
    backup_path: String,
    started_at: String,
    completed_at: Option<String>,
    error: Option<String>,
    /// 提交时被跳过的旧库记录（内容仍在暂存表与 IndexedDB），供事后核对
    #[serde(default)]
    notes: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub action: String,
    pub run_id: String,
    pub backup_path: String,
}

pub async fn open_existing(root: &Path) -> Result<Option<SqliteConnection>, String> {
    let path = root.join("ew-writing.db");
    match fs::metadata(&path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err(invalid("数据库路径不是文件")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法检查本地数据库：{e}")),
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(10));
    SqliteConnection::connect_with(&options)
        .await
        .map(Some)
        .map_err(|e| format!("无法读取本地数据库，未创建替代库：{e}"))
}
async fn tables(db: &mut SqliteConnection) -> Result<BTreeSet<String>, String> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT name FROM sqlite_master WHERE type='table'")
            .fetch_all(db)
            .await
            .map_err(err)?
            .into_iter()
            .collect(),
    )
}
async fn metadata(
    db: &mut SqliteConnection,
    tables: &BTreeSet<String>,
    key: &str,
) -> Result<Option<String>, String> {
    if !tables.contains("desktop_meta") {
        return Ok(None);
    }
    sqlx::query_scalar("SELECT value FROM desktop_meta WHERE key=?")
        .bind(key)
        .fetch_optional(db)
        .await
        .map_err(err)
}
async fn receipt(
    db: &mut SqliteConnection,
    tables: &BTreeSet<String>,
) -> Result<Option<Receipt>, String> {
    if !tables.contains("desktop_migrations") {
        return Ok(None);
    }
    let values = sqlx::query("SELECT id,receipt FROM desktop_migrations")
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
    if values.len() > 1 {
        return Err(invalid("存在当前程序无法识别的迁移记录，请使用兼容版本"));
    }
    let Some(raw) = values.first() else {
        return Ok(None);
    };
    let r: Receipt =
        serde_json::from_str(raw.get::<&str, _>("receipt")).map_err(|_| invalid("迁移记录损坏"))?;
    if r.to_version > CURRENT_VERSION {
        return Err("数据由更新版本创建，请升级应用；未修改原数据".into());
    }
    let s = spec();
    if raw.get::<&str, _>("id") != r.id || r.run_id.is_empty() {
        return Err(invalid("迁移记录标识不一致"));
    }
    if !["adopted", "restored"].contains(&r.origin.as_str()) {
        let source: SourceManifest =
            serde_json::from_str(&r.manifest).map_err(|_| invalid("迁移源清单损坏"))?;
        validate_manifest(&source)?;
    }
    if r.id != s.id
        || r.from_version != s.from_version
        || r.to_version != s.to_version
        || !["running", "failed", "complete"].contains(&r.status.as_str())
        || !["migrated", "initialized", "adopted", "restored"].contains(&r.origin.as_str())
    {
        return Err(invalid("迁移记录的版本或状态不受支持"));
    }
    if r.origin == "restored"
        && (r.status != "complete"
            || metadata(db, tables, "restore-commit").await?.as_deref() != Some(r.run_id.as_str()))
    {
        return Err(invalid("恢复完成凭据不一致"));
    }
    if r.status == "complete" && r.completed_at.is_none() {
        return Err(invalid("迁移完成记录不完整"));
    }
    Ok(Some(r))
}
async fn count(
    db: &mut SqliteConnection,
    table: &str,
    present: &BTreeSet<String>,
) -> Result<u64, String> {
    if !present.contains(table) {
        return Ok(0);
    }
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(db)
        .await
        .map_err(err)?;
    Ok(n as u64)
}
async fn check_schema(
    db: &mut SqliteConnection,
    present: &BTreeSet<String>,
    current: bool,
) -> Result<(), String> {
    let required: [(&str, &[&str]); 10] = [
        (
            "local_books",
            &[
                "id",
                "payload",
                "title",
                "groupId",
                "mergeStatus",
                "deletedAt",
                "updateTime",
            ],
        ),
        (
            "local_book_groups",
            &["id", "payload", "deletedAt", "sortNo"],
        ),
        (
            "local_volumes",
            &["id", "bookId", "payload", "deletedAt", "sortNo"],
        ),
        (
            "local_chapters",
            &["id", "bookId", "volumeId", "payload", "deletedAt", "sortNo"],
        ),
        (
            "chapter_contents",
            &[
                "storageKey",
                "userId",
                "bookId",
                "chapterId",
                "payload",
                "dirty",
                "conflict",
                "updatedAt",
            ],
        ),
        (
            "chapter_versions",
            &["id", "payload", "chapterId", "createdAt"],
        ),
        ("sync_settings", &["key", "value"]),
        ("desktop_records", &["namespace", "key", "value"]),
        ("desktop_meta", &["key", "value"]),
        ("desktop_migration_stage", &["namespace", "key", "value"]),
    ];
    for (table, columns) in required {
        if !present.contains(table) {
            if current {
                return Err(invalid(&format!("新版数据缺少表 {table}")));
            }
            continue;
        }
        let actual = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *db)
            .await
            .map_err(err)?;
        let primary: BTreeSet<&str> = actual
            .iter()
            .filter(|row| row.get::<i64, _>("pk") > 0)
            .map(|row| row.get::<&str, _>("name"))
            .collect();
        let expected_primary: BTreeSet<&str> = match table {
            "desktop_records" | "desktop_migration_stage" => {
                ["namespace", "key"].into_iter().collect()
            }
            "chapter_contents" => ["storageKey"].into_iter().collect(),
            "desktop_meta" | "sync_settings" => ["key"].into_iter().collect(),
            _ => ["id"].into_iter().collect(),
        };
        if primary != expected_primary {
            return Err(invalid(&format!("数据表 {table} 的唯一标识约束不受支持")));
        }
        if columns
            .iter()
            .any(|name| !actual.iter().any(|row| row.get::<&str, _>("name") == *name))
        {
            return Err(invalid(&format!("数据表 {table} 结构不受支持")));
        }
    }
    if current {
        let columns = sqlx::query("PRAGMA table_info(chapter_contents)")
            .fetch_all(&mut *db)
            .await
            .map_err(err)?;
        if ["lastBackedUpAt", "wordCount", "textWordCount"]
            .iter()
            .any(|name| {
                !columns
                    .iter()
                    .any(|row| row.get::<&str, _>("name") == *name)
            })
        {
            return Err(invalid("新版正文数据表结构不完整"));
        }
    }
    Ok(())
}
async fn data_fingerprint(
    db: &mut SqliteConnection,
    present: &BTreeSet<String>,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    for (table, key, payload) in CORE_TABLES {
        hash.update(table.as_bytes());
        if !present.contains(table) {
            continue;
        }
        let rows = sqlx::query(&format!(
            "SELECT CAST({key} AS TEXT) AS k,{payload} AS v FROM {table} ORDER BY {key}"
        ))
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
        // 只对现有行做指纹，不做内容校验：这里跑在每次启动检查里，一条历史上写坏的
        // 记录不能让应用永远打不开。结构校验只在导入旧库记录时进行（import_legacy_core）。
        for row in rows {
            hash.update(
                serde_json::to_vec(&json!([
                    row.get::<String, _>("k"),
                    row.get::<String, _>("v")
                ]))
                .map_err(err)?,
            );
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
async fn has_managed_covers(
    db: &mut SqliteConnection,
    present: &BTreeSet<String>,
) -> Result<bool, String> {
    if !present.contains("local_books") {
        return Ok(false);
    }
    let rows: Vec<String> = sqlx::query_scalar("SELECT payload FROM local_books")
        .fetch_all(db)
        .await
        .map_err(err)?;
    for raw in rows {
        // 损坏的书籍记录当作"没有托管封面"，不能因此卡住启动检查
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if value["coverUrl"].get("__ewAsset").is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}
pub async fn inspect_at(root: &Path) -> Result<Inspection, String> {
    let pending = root.join("pending-restore").exists();
    let Some(mut db) = open_existing(root).await? else {
        if pending || root.join("assets").exists() || root.join("recovery").exists() {
            return Err(invalid("数据库缺失，但仍有附件或恢复记录；请先恢复数据库"));
        }
        return Ok(Inspection {
            state: StartupState::NeedsInventory,
            token: "new-database".into(),
            pending_restore: false,
            sqlite_records: 0,
            sqlite_content_records: 0,
            baseline: hash(
                CORE_TABLES
                    .iter()
                    .map(|(table, _, _)| *table)
                    .collect::<Vec<_>>()
                    .join(""),
            ),
        });
    };
    let mut tx = db.begin().await.map_err(err)?;
    let present = tables(&mut tx).await?;
    let version = metadata(&mut tx, &present, VERSION_KEY)
        .await?
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| invalid("存储版本标记无效"))
        })
        .transpose()?;
    if version.is_some_and(|v| v > CURRENT_VERSION) {
        return Err("数据由更新版本创建，请升级应用；未修改原数据".into());
    }
    if version.is_some_and(|v| v < 0) {
        return Err(invalid("存储版本标记无效"));
    }
    let legacy = metadata(&mut tx, &present, LEGACY_KEY).await?;
    if legacy.as_deref().is_some_and(|v| v != "complete") {
        return Err(invalid("旧版迁移完成标记无效"));
    }
    let r = receipt(&mut tx, &present).await?;
    let health: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(&mut *tx)
        .await
        .map_err(err)?;
    if health != ["ok"] {
        return Err(invalid("数据库完整性检查未通过"));
    }
    let mut core_count = 0;
    for (table, _, _) in CORE_TABLES {
        core_count += count(&mut tx, table, &present).await?;
    }
    let content_count = core_count - count(&mut tx, "sync_settings", &present).await?;
    let modern = count(&mut tx, "desktop_records", &present).await?;
    let stage_count = count(&mut tx, "desktop_migration_stage", &present).await?;
    // 未标记版本、也没有任何迁移记录的库，只有在没有可识别旧数据时才会被按全新安装初始化；
    // 此时若还有不认识的表，说明它不是本应用建的库，拒绝初始化。
    // 含旧数据的库一律走迁移：迁移前整库备份、不删任何表，所以开源前旧版本留下的
    // chapter_conflicts / sync_outbox 等额外表会原样保留，不能因为它们把用户挡在外面。
    if r.is_none() && legacy.is_none() && version.unwrap_or(0) == 0 && core_count == 0 {
        let known: BTreeSet<&str> = CORE_TABLES
            .iter()
            .map(|(table, _, _)| *table)
            .chain([
                "chapter_conflicts",
                "sync_outbox",
                "desktop_records",
                "desktop_meta",
                "desktop_migration_stage",
                "desktop_migrations",
                "desktop_migration_parts",
                "_sqlx_migrations",
            ])
            .collect();
        if present
            .iter()
            .any(|table| !table.starts_with("sqlite_") && !known.contains(table.as_str()))
        {
            return Err(invalid(
                "未标记版本的数据库含未知数据表，不能按全新安装处理",
            ));
        }
    }
    let state = match &r {
        Some(r) if r.status == "complete" => {
            if version.is_some_and(|v| v != CURRENT_VERSION) {
                return Err(invalid("完成记录与存储版本矛盾"));
            }
            if version == Some(CURRENT_VERSION) && legacy.as_deref() == Some("complete") {
                StartupState::Ready
            } else {
                StartupState::RepairReceipt
            }
        }
        Some(_) => {
            if version.unwrap_or(0) != 0
                || legacy.is_some()
                || modern > 0
                || has_managed_covers(&mut tx, &present).await?
            {
                return Err(invalid("未完成迁移记录与新版数据并存，拒绝再次导入旧库"));
            }
            StartupState::Retry
        }
        None if legacy.as_deref() == Some("complete") => StartupState::AdoptLegacyReceipt,
        None => {
            if version.unwrap_or(0) != 0
                || modern > 0
                || has_managed_covers(&mut tx, &present).await?
            {
                return Err(invalid("完成凭据缺失但存在新版数据，拒绝重新导入旧库"));
            }
            StartupState::NeedsInventory
        }
    };
    check_schema(
        &mut tx,
        &present,
        matches!(
            state,
            StartupState::Ready | StartupState::AdoptLegacyReceipt | StartupState::RepairReceipt
        ),
    )
    .await?;
    let baseline = if matches!(state, StartupState::NeedsInventory | StartupState::Retry) {
        data_fingerprint(&mut tx, &present).await?
    } else {
        String::new()
    };
    let token = hash(
        serde_json::to_vec(&json!([
            version,
            legacy,
            r,
            core_count,
            modern,
            stage_count,
            baseline,
            pending
        ]))
        .map_err(err)?,
    );
    tx.commit().await.map_err(err)?;
    Ok(Inspection {
        state,
        token,
        pending_restore: pending,
        sqlite_records: core_count,
        sqlite_content_records: content_count,
        baseline,
    })
}
async fn ensure_journal(db: &mut SqliteConnection) -> Result<(), String> {
    for sql in ["CREATE TABLE IF NOT EXISTS desktop_migrations(id TEXT PRIMARY KEY,receipt TEXT NOT NULL)","CREATE TABLE IF NOT EXISTS desktop_migration_parts(run_id TEXT NOT NULL,namespace TEXT NOT NULL,count INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(run_id,namespace))"]{sqlx::query(sql).execute(&mut *db).await.map_err(err)?;}
    Ok(())
}
async fn save_receipt(db: &mut SqliteConnection, r: &Receipt) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO desktop_migrations(id,receipt) VALUES(?,?)")
        .bind(&r.id)
        .bind(serde_json::to_string(r).map_err(err)?)
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}
async fn complete(db: &mut SqliteConnection, r: &mut Receipt) -> Result<(), String> {
    r.status = "complete".into();
    r.completed_at = Some(now());
    r.error = None;
    save_receipt(db, r).await?;
    for (key, value) in [
        (VERSION_KEY, CURRENT_VERSION.to_string()),
        (LEGACY_KEY, "complete".into()),
    ] {
        sqlx::query("INSERT OR REPLACE INTO desktop_meta(key,value) VALUES(?,?)")
            .bind(key)
            .bind(value)
            .execute(&mut *db)
            .await
            .map_err(err)?;
    }
    Ok(())
}
pub async fn finalize_metadata_at(root: &Path, token: &str) -> Result<(), String> {
    let _lock = protocol_lock().lock().await;
    let inspection = inspect_at(root).await?;
    if inspection.token != token || inspection.pending_restore {
        return Err(invalid("检查后数据状态发生变化，请重新启动"));
    }
    if !matches!(
        inspection.state,
        StartupState::AdoptLegacyReceipt | StartupState::RepairReceipt
    ) {
        return Err(invalid("当前状态不允许补全迁移凭据"));
    }
    let mut db = desktop_storage::connect_existing_at(root).await?;
    ensure_journal(&mut db).await?;
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    let present = tables(&mut tx).await?;
    let mut r = receipt(&mut tx, &present).await?.unwrap_or(Receipt {
        id: spec().id,
        from_version: 0,
        to_version: CURRENT_VERSION,
        status: "complete".into(),
        origin: "adopted".into(),
        run_id: run_id(),
        baseline: String::new(),
        manifest: String::new(),
        backup_path: String::new(),
        started_at: now(),
        completed_at: Some(now()),
        error: None,
        notes: Vec::new(),
    });
    complete(&mut tx, &mut r).await?;
    tx.commit().await.map_err(err)
}

/// A legacy-mode full restore installs all data and the selection receipt in the same transaction.
pub async fn complete_restore(db: &mut SqliteConnection, token: &str) -> Result<(), String> {
    ensure_journal(db).await?;
    let mut restored = Receipt {
        id: spec().id,
        from_version: 0,
        to_version: CURRENT_VERSION,
        status: "complete".into(),
        origin: "restored".into(),
        run_id: token.to_string(),
        baseline: String::new(),
        manifest: String::new(),
        backup_path: String::new(),
        started_at: now(),
        completed_at: Some(now()),
        error: None,
        notes: Vec::new(),
    };
    complete(db, &mut restored).await
}
pub fn use_restored_storage() -> Result<(), String> {
    *RUNTIME_STORAGE.lock().map_err(err)? = Some(RuntimeStorage::Unified);
    Ok(())
}

fn protocol_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn records_digest(records: &[Record]) -> Result<String, String> {
    let mut sorted = BTreeMap::new();
    for record in records {
        if !record.key.is_string() && !record.key.is_number() {
            return Err(invalid("迁移记录标识无效"));
        }
        let key = serde_json::to_string(&record.key).map_err(err)?;
        serde_json::from_str::<Value>(&record.value).map_err(|_| invalid("迁移记录 JSON 损坏"))?;
        if sorted.insert(key, record.value.clone()).is_some() {
            return Err(invalid("迁移记录标识重复"));
        }
    }
    Ok(hash(serde_json::to_vec(&sorted).map_err(err)?))
}
async fn pending(db: &mut SqliteConnection, run_id: &str) -> Result<Receipt, String> {
    let present = tables(db).await?;
    let r = receipt(db, &present)
        .await?
        .ok_or_else(|| invalid("没有已准备的迁移任务"))?;
    if r.run_id != run_id || r.status != "running" {
        return Err(invalid("迁移会话已失效，请重新启动"));
    }
    if metadata(db, &present, VERSION_KEY)
        .await?
        .is_some_and(|v| v.parse::<i64>().ok() != Some(0))
        || metadata(db, &present, LEGACY_KEY).await?.is_some()
        || count(db, "desktop_records", &present).await? > 0
    {
        return Err(invalid("迁移过程中出现已启用的新版数据，停止提交"));
    }
    Ok(r)
}
fn contains_files(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    for entry in fs::read_dir(path).map_err(err)? {
        let entry = entry.map_err(err)?;
        let kind = entry.file_type().map_err(err)?;
        if kind.is_file() || kind.is_symlink() {
            return Ok(true);
        }
        if kind.is_dir() && contains_files(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn prepare_at(
    root: &Path,
    token: &str,
    manifest: SourceManifest,
) -> Result<Plan, String> {
    let _lock = protocol_lock().lock().await;
    validate_manifest(&manifest)?;
    let inspection = inspect_at(root).await?;
    if inspection.token != token || inspection.pending_restore {
        return Err(invalid("检查后数据状态发生变化，请重新检查"));
    }
    if !matches!(
        inspection.state,
        StartupState::NeedsInventory | StartupState::Retry
    ) {
        return Err(invalid("当前数据不允许重新迁移"));
    }
    let has_sources = manifest.sources.values().any(|source| source.count > 0);
    let mut db = if inspection.token == "new-database" {
        desktop_storage::connect_at(root).await?
    } else {
        desktop_storage::connect_existing_at(root).await?
    };
    let present = tables(&mut db).await?;
    let baseline = data_fingerprint(&mut db, &present).await?;
    if baseline != inspection.baseline {
        return Err(invalid("检查后 SQLite 数据发生变化，请重新检查"));
    }
    // 上次未完成的尝试从未碰过正式表（暂存会在下面清空），所以不要求这次的源清单或
    // SQLite 指纹与上次一致：清单里含全部 ew-* 设置键，用户在旧版本里改个主题就会不同，
    // 钉住它只会让重试永远失败。这次运行会重新做快照、重新暂存、重新校验。
    let previous = receipt(&mut db, &present).await?;
    let staged = count(&mut db, "desktop_migration_stage", &present).await?;
    if !has_sources && staged > 0 {
        return Err(invalid("存在未完成迁移的暂存数据，但原始旧数据不可用"));
    }
    if !has_sources
        && inspection.sqlite_records == 0
        && previous.is_none()
        && (contains_files(&root.join("assets"))? || contains_files(&root.join("recovery"))?)
    {
        return Err(invalid(
            "没有可读取的旧数据，但仍有附件或恢复副本，不能按全新安装处理",
        ));
    }
    let migrate = has_sources || inspection.sqlite_records > 0 || previous.is_some();
    let id = run_id();
    let mut backup = String::new();
    if migrate {
        fs::create_dir_all(root.join("recovery")).map_err(err)?;
        let path = root
            .join("recovery")
            .join(format!("before-migration-{id}.sqlite"));
        sqlx::query("VACUUM INTO ?")
            .bind(path.to_string_lossy().as_ref())
            .execute(&mut db)
            .await
            .map_err(err)?;
        backup = path.to_string_lossy().into();
    }
    ensure_journal(&mut db).await?;
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    let current_tables = tables(&mut tx).await?;
    if data_fingerprint(&mut tx, &current_tables).await? != baseline
        || count(&mut tx, "desktop_records", &current_tables).await? > 0
        || metadata(&mut tx, &current_tables, LEGACY_KEY)
            .await?
            .is_some()
    {
        return Err(invalid("准备期间出现新的数据或完成记录，未启动迁移"));
    }
    let mut r = Receipt {
        id: spec().id,
        from_version: 0,
        to_version: CURRENT_VERSION,
        status: "running".into(),
        origin: if migrate { "migrated" } else { "initialized" }.into(),
        run_id: id.clone(),
        baseline,
        manifest: serde_json::to_string(&manifest).map_err(err)?,
        backup_path: backup.clone(),
        started_at: now(),
        completed_at: None,
        error: None,
        notes: Vec::new(),
    };
    if migrate {
        // Only staging is reset. A consistent backup includes the previous attempt's staging.
        sqlx::query("DELETE FROM desktop_migration_stage")
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        sqlx::query("DELETE FROM desktop_migration_parts")
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        save_receipt(&mut tx, &r).await?;
    } else {
        complete(&mut tx, &mut r).await?;
    }
    tx.commit().await.map_err(err)?;
    Ok(Plan {
        action: if migrate { "migrate" } else { "initialized" }.into(),
        run_id: id,
        backup_path: backup,
    })
}
async fn validate_session(root: &Path, run_id: &str) -> Result<(), String> {
    let mut db = open_existing(root)
        .await?
        .ok_or_else(|| invalid("迁移会话不存在"))?;
    pending(&mut db, run_id).await?;
    Ok(())
}
pub async fn stage_at(root: &Path, run_id: &str, store: StoreDump) -> Result<(), String> {
    let _lock = protocol_lock().lock().await;
    validate_session(root, run_id).await?;
    let mut db = desktop_storage::connect_existing_at(root).await?;
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    let r = pending(&mut tx, run_id).await?;
    let manifest: SourceManifest = serde_json::from_str(&r.manifest).map_err(err)?;
    let source = manifest
        .sources
        .get(&store.namespace)
        .ok_or_else(|| invalid("迁移模块不在源清单中"))?;
    if source.count != store.records.len() as u64 {
        return Err(invalid("迁移记录数量与源清单不一致"));
    }
    let digest = records_digest(&store.records)?;
    for record in &store.records {
        desktop_storage::validate_value(root, &serde_json::from_str(&record.value).map_err(err)?)?;
    }
    sqlx::query("DELETE FROM desktop_migration_stage WHERE namespace=?")
        .bind(&store.namespace)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    for record in &store.records {
        sqlx::query("INSERT INTO desktop_migration_stage(namespace,key,value) VALUES(?,?,?)")
            .bind(&store.namespace)
            .bind(serde_json::to_string(&record.key).map_err(err)?)
            .bind(&record.value)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    let readback = desktop_storage::rows(&mut tx, &store.namespace, true).await?;
    if records_digest(&readback)? != digest {
        return Err(invalid("迁移暂存写入后校验失败"));
    }
    sqlx::query("INSERT OR REPLACE INTO desktop_migration_parts(run_id,namespace,count,digest) VALUES(?,?,?,?)").bind(run_id).bind(&store.namespace).bind(store.records.len() as i64).bind(digest).execute(&mut *tx).await.map_err(err)?;
    tx.commit().await.map_err(err)
}
pub async fn commit_at(
    root: &Path,
    run_id: &str,
    verified_source: SourceManifest,
) -> Result<(), String> {
    let _lock = protocol_lock().lock().await;
    validate_manifest(&verified_source)?;
    validate_session(root, run_id).await?;
    let mut db = desktop_storage::connect_existing_at(root).await?;
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    let mut r = pending(&mut tx, run_id).await?;
    let original: SourceManifest = serde_json::from_str(&r.manifest).map_err(err)?;
    if original != verified_source {
        return Err(invalid("读取后旧数据发生变化，未提交迁移"));
    }
    let present = tables(&mut tx).await?;
    if data_fingerprint(&mut tx, &present).await? != r.baseline {
        return Err(invalid("迁移过程中 SQLite 内容发生变化，未提交迁移"));
    }
    let parts =
        sqlx::query("SELECT namespace,count,digest FROM desktop_migration_parts WHERE run_id=?")
            .bind(run_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(err)?;
    if parts.len() != original.sources.len() {
        return Err(invalid("迁移模块尚未全部暂存，拒绝完成迁移"));
    }
    let mut expected = Vec::new();
    for namespace in namespaces() {
        let part = parts
            .iter()
            .find(|row| row.get::<&str, _>("namespace") == namespace)
            .ok_or_else(|| invalid("缺少迁移模块的校验记录"))?;
        let records = desktop_storage::rows(&mut tx, &namespace, true).await?;
        if records.len() as i64 != part.get::<i64, _>("count")
            || records.len() as u64 != original.sources[&namespace].count
            || records_digest(&records)? != part.get::<String, _>("digest")
        {
            return Err(invalid("暂存记录被修改，拒绝提交迁移"));
        }
        expected.push(StoreDump { namespace, records });
    }
    let total = expected
        .iter()
        .map(|store| store.records.len() as u64)
        .sum::<u64>();
    if count(&mut tx, "desktop_migration_stage", &present).await? != total {
        return Err(invalid("暂存库包含清单外的数据"));
    }
    r.notes = desktop_storage::apply_migration_records(root, &mut tx, &expected).await?;
    complete(&mut tx, &mut r).await?;
    tx.commit().await.map_err(err)
}
pub async fn fail_at(root: &Path, run_id: &str, message: &str) -> Result<(), String> {
    let _lock = protocol_lock().lock().await;
    let Some(mut check) = open_existing(root).await? else {
        return Ok(());
    };
    let existing = tables(&mut check).await?;
    let Some(current) = receipt(&mut check, &existing).await? else {
        return Ok(());
    };
    if current.run_id != run_id || current.status != "running" {
        return Ok(());
    }
    drop(check);
    let mut db = desktop_storage::connect_existing_at(root).await?;
    let present = tables(&mut db).await?;
    if let Some(mut r) = receipt(&mut db, &present).await? {
        // A lost IPC reply after COMMIT must never downgrade a completed migration.
        if r.run_id == run_id && r.status == "running" {
            r.status = "failed".into();
            r.error = Some(message.chars().take(2000).collect());
            save_receipt(&mut db, &r).await?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum RuntimeStorage {
    Unified,
    Legacy { core: CoreBackend },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CoreBackend {
    Sqlite,
    Indexeddb,
}
static RUNTIME_STORAGE: std::sync::Mutex<Option<RuntimeStorage>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn desktop_storage_session() -> Result<Option<RuntimeStorage>, String> {
    Ok(RUNTIME_STORAGE.lock().map_err(err)?.clone())
}
fn require_startup() -> Result<(), String> {
    if desktop_storage_session()?.is_some() {
        return Err("请保存作品并重新启动后再升级存储".into());
    }
    Ok(())
}
async fn validate_runtime_at(
    root: &Path,
    mode: &RuntimeStorage,
    token: &str,
) -> Result<(), String> {
    let current = inspect_at(root).await?;
    if current.token != token || current.pending_restore {
        return Err(invalid("数据状态发生变化，未启用存储"));
    }
    match mode {
        RuntimeStorage::Unified if current.state == StartupState::Ready => Ok(()),
        RuntimeStorage::Legacy { core }
            if matches!(
                current.state,
                StartupState::NeedsInventory | StartupState::Retry
            ) =>
        {
            if *core == CoreBackend::Indexeddb && current.sqlite_content_records > 0 {
                return Err(invalid("现有 SQLite 作品不能切换到旧 IndexedDB"));
            }
            Ok(())
        }
        _ => Err(invalid("当前状态不允许切换存储，原数据保持不变")),
    }
}
#[tauri::command]
pub async fn desktop_storage_activate(
    app: crate::DesktopAppHandle,
    mode: RuntimeStorage,
    token: String,
) -> Result<RuntimeStorage, String> {
    let _lock = protocol_lock().lock().await;
    if let Some(active) = desktop_storage_session()? {
        return if active == mode {
            Ok(active)
        } else {
            Err("本次运行不能切换存储，请先重新启动".into())
        };
    }
    validate_runtime_at(&desktop_storage::root(&app)?, &mode, &token).await?;
    *RUNTIME_STORAGE.lock().map_err(err)? = Some(mode.clone());
    Ok(mode)
}

#[tauri::command]
pub async fn desktop_storage_inspect(app: crate::DesktopAppHandle) -> Result<Inspection, String> {
    inspect_at(&desktop_storage::root(&app)?).await
}
#[tauri::command]
pub async fn desktop_storage_finalize(
    app: crate::DesktopAppHandle,
    token: String,
) -> Result<(), String> {
    require_startup()?;
    finalize_metadata_at(&desktop_storage::root(&app)?, &token).await
}
#[tauri::command]
pub async fn desktop_migration_prepare(
    app: crate::DesktopAppHandle,
    token: String,
    manifest: SourceManifest,
) -> Result<Plan, String> {
    require_startup()?;
    prepare_at(&desktop_storage::root(&app)?, &token, manifest).await
}
#[tauri::command]
pub async fn desktop_migration_stage(
    app: crate::DesktopAppHandle,
    run_id: String,
    store: StoreDump,
) -> Result<(), String> {
    require_startup()?;
    stage_at(&desktop_storage::root(&app)?, &run_id, store).await
}
#[tauri::command]
pub async fn desktop_migration_commit(
    app: crate::DesktopAppHandle,
    run_id: String,
    verified_source: SourceManifest,
) -> Result<(), String> {
    require_startup()?;
    commit_at(&desktop_storage::root(&app)?, &run_id, verified_source).await
}
#[tauri::command]
pub async fn desktop_migration_fail(
    app: crate::DesktopAppHandle,
    run_id: String,
    message: String,
) -> Result<(), String> {
    fail_at(&desktop_storage::root(&app)?, &run_id, &message).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ew-migration-protocol-{}", run_id()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn row(key: &str, value: &str) -> Record {
        Record {
            key: json!(key),
            value: json!({"text":value}).to_string(),
        }
    }
    fn manifest(stores: &[StoreDump]) -> SourceManifest {
        let mut sources = BTreeMap::new();
        for name in namespaces() {
            let records = stores
                .iter()
                .find(|s| s.namespace == name)
                .map(|s| s.records.clone())
                .unwrap_or_default();
            sources.insert(
                name,
                SourceDigest {
                    count: records.len() as u64,
                    digest: records_digest(&records).unwrap(),
                },
            );
        }
        SourceManifest {
            migration_id: spec().id,
            from_version: 0,
            target_version: CURRENT_VERSION,
            sources,
        }
    }
    fn source() -> Vec<StoreDump> {
        vec![StoreDump {
            namespace: "ew-local-workflow/kv".into(),
            records: vec![row("run:-1", "保留全部内容")],
        }]
    }
    async fn prepare(root: &Path, stores: &[StoreDump]) -> (Plan, SourceManifest) {
        let state = inspect_at(root).await.unwrap();
        let m = manifest(stores);
        let p = prepare_at(root, &state.token, m.clone()).await.unwrap();
        (p, m)
    }
    async fn stage_all(root: &Path, plan: &Plan, stores: &[StoreDump]) {
        for name in namespaces() {
            let records = stores
                .iter()
                .find(|s| s.namespace == name)
                .map(|s| s.records.clone())
                .unwrap_or_default();
            stage_at(
                root,
                &plan.run_id,
                StoreDump {
                    namespace: name,
                    records,
                },
            )
            .await
            .unwrap();
        }
    }
    async fn set_meta(root: &Path, key: &str, value: &str) {
        let mut db = desktop_storage::connect_at(root).await.unwrap();
        sqlx::query("INSERT OR REPLACE INTO desktop_meta(key,value) VALUES(?,?)")
            .bind(key)
            .bind(value)
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
    }

    // WAL 的已提交内容可能仍在 -wal 文件中，Drop 关闭连接又是异步的。
    // 比较主文件字节前先显式完成 checkpoint，避免把正常落盘误判为检查修改了数据。
    async fn checkpoint_fixture(root: &Path) {
        let mut db = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(root.join("ew-writing.db"))
                .create_if_missing(false),
        )
        .await
        .unwrap();
        let result = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(result.get::<i64, _>(0), 0);
        db.close().await.unwrap();
    }

    #[test]
    fn clean_install_initializes_without_backup_or_migration() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let inspected = inspect_at(&root.0).await.unwrap();
            assert_eq!(inspected.state, StartupState::NeedsInventory);
            assert!(!root.0.join("ew-writing.db").exists());
            let plan = prepare_at(&root.0, &inspected.token, manifest(&[]))
                .await
                .unwrap();
            assert_eq!(plan.action, "initialized");
            assert!(!root.0.join("recovery").exists());
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
            let bytes = fs::read(root.0.join("ew-writing.db")).unwrap();
            inspect_at(&root.0).await.unwrap();
            assert_eq!(bytes, fs::read(root.0.join("ew-writing.db")).unwrap());
        });
    }
    #[test]
    fn existing_sqlite_content_is_not_classified_as_clean_install() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            set_meta(&root.0, "unrelated", "value").await;
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO sync_settings(key,value) VALUES('localWritingSettings','{}')")
                .execute(&mut db)
                .await
                .unwrap();
            let (plan, m) = prepare(&root.0, &[]).await;
            assert_eq!(plan.action, "migrate");
            assert!(Path::new(&plan.backup_path).is_file());
            stage_all(&root.0, &plan, &[]).await;
            commit_at(&root.0, &plan.run_id, m).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='localWritingSettings'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "{}"
            );
        });
    }
    #[test]
    fn legacy_completion_receipt_is_adopted_without_reimport() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            set_meta(&root.0, LEGACY_KEY, "complete").await;
            desktop_storage::write_at(
                &root.0,
                "ew-local-workflow/kv",
                vec![row("run:-1", "升级后的新稿")],
                vec![],
                false,
                false,
            )
            .await
            .unwrap();
            let before = inspect_at(&root.0).await.unwrap();
            assert_eq!(before.state, StartupState::AdoptLegacyReceipt);
            finalize_metadata_at(&root.0, &before.token).await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
            assert!(!root.0.join("recovery").exists());
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            assert_eq!(
                desktop_storage::rows(&mut db, "ew-local-workflow/kv", false)
                    .await
                    .unwrap()[0]
                    .value,
                row("run:-1", "升级后的新稿").value
            );
        });
    }
    #[test]
    fn completed_journal_repairs_missing_flags_without_loading_legacy_sources() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (plan, m) = prepare(&root.0, &source()).await;
            stage_all(&root.0, &plan, &source()).await;
            commit_at(&root.0, &plan.run_id, m).await.unwrap();
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("DELETE FROM desktop_meta WHERE key IN ('storage-schema-version','browser-migration-v1')").execute(&mut db).await.unwrap();
            let state = inspect_at(&root.0).await.unwrap();
            assert_eq!(state.state, StartupState::RepairReceipt);
            finalize_metadata_at(&root.0, &state.token).await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
        });
    }
    #[test]
    fn modern_data_without_any_receipt_is_blocked_and_preserved() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            desktop_storage::write_at(
                &root.0,
                "app-settings",
                vec![row("ew-local-inspirations", "新数据")],
                vec![],
                false,
                false,
            )
            .await
            .unwrap();
            checkpoint_fixture(&root.0).await;
            let original = fs::read(root.0.join("ew-writing.db")).unwrap();
            assert!(inspect_at(&root.0)
                .await
                .unwrap_err()
                .contains("存在新版数据"));
            assert_eq!(original, fs::read(root.0.join("ew-writing.db")).unwrap());
        });
    }
    #[test]
    fn newer_versions_and_corrupt_databases_are_never_initialized() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            set_meta(&root.0, VERSION_KEY, "2").await;
            checkpoint_fixture(&root.0).await;
            let before = fs::read(root.0.join("ew-writing.db")).unwrap();
            assert!(inspect_at(&root.0).await.unwrap_err().contains("更新版本"));
            assert!(desktop_storage::connect_at(&root.0).await.is_err());
            assert_eq!(before, fs::read(root.0.join("ew-writing.db")).unwrap());
            let corrupt = Temp::new();
            fs::write(corrupt.0.join("ew-writing.db"), b"not a sqlite database").unwrap();
            assert!(inspect_at(&corrupt.0).await.is_err());
            assert_eq!(
                fs::read(corrupt.0.join("ew-writing.db")).unwrap(),
                b"not a sqlite database"
            );
        });
    }
    #[test]
    fn missing_database_with_remaining_assets_is_not_a_fresh_install() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            fs::create_dir(root.0.join("assets")).unwrap();
            assert!(inspect_at(&root.0)
                .await
                .unwrap_err()
                .contains("数据库缺失"));
            assert!(!root.0.join("ew-writing.db").exists());
        });
    }
    #[test]
    fn all_declared_parts_including_empty_ones_must_be_staged() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (plan, m) = prepare(&root.0, &source()).await;
            stage_at(&root.0, &plan.run_id, source().remove(0))
                .await
                .unwrap();
            assert!(commit_at(&root.0, &plan.run_id, m.clone())
                .await
                .unwrap_err()
                .contains("尚未全部暂存"));
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            assert!(
                desktop_storage::rows(&mut db, "ew-local-workflow/kv", false)
                    .await
                    .unwrap()
                    .is_empty()
            );
            stage_all(&root.0, &plan, &source()).await;
            commit_at(&root.0, &plan.run_id, m).await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
        });
    }
    #[test]
    fn retry_retains_previous_attempt_in_backup_and_rejects_stale_sessions() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (first, _) = prepare(&root.0, &source()).await;
            stage_all(&root.0, &first, &source()).await;
            fail_at(&root.0, &first.run_id, "模拟中断").await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Retry
            );
            let (next, m) = prepare(&root.0, &source()).await;
            assert_ne!(first.run_id, next.run_id);
            let mut backup = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(&next.backup_path)
                    .read_only(true),
            )
            .await
            .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM desktop_migration_stage")
                    .fetch_one(&mut backup)
                    .await
                    .unwrap(),
                1
            );
            assert!(stage_at(&root.0, &first.run_id, source().remove(0))
                .await
                .is_err());
            stage_all(&root.0, &next, &source()).await;
            commit_at(&root.0, &next.run_id, m).await.unwrap();
            fail_at(&root.0, &next.run_id, "模拟提交后回复丢失")
                .await
                .unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
        });
    }
    #[test]
    fn changed_sources_or_staged_payloads_cannot_commit() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (plan, m) = prepare(&root.0, &source()).await;
            stage_all(&root.0, &plan, &source()).await;
            let mut changed = m.clone();
            changed
                .sources
                .get_mut("ew-local-workflow/kv")
                .unwrap()
                .digest = hash("changed");
            assert!(commit_at(&root.0, &plan.run_id, changed)
                .await
                .unwrap_err()
                .contains("旧数据发生变化"));
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("UPDATE desktop_migration_stage SET value='{}' WHERE namespace='ew-local-workflow/kv'").execute(&mut db).await.unwrap();
            assert!(commit_at(&root.0, &plan.run_id, m)
                .await
                .unwrap_err()
                .contains("暂存记录被修改"));
            assert!(
                desktop_storage::rows(&mut db, "ew-local-workflow/kv", false)
                    .await
                    .unwrap()
                    .is_empty()
            );
        });
    }
    #[test]
    fn source_changes_after_failure_start_a_fresh_run_instead_of_trapping_retry() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (first, _) = prepare(&root.0, &source()).await;
            fail_at(&root.0, &first.run_id, "中断").await.unwrap();
            // 用户在旧版本里改了设置、加了数据：清单与上次不同，重试必须照常开始新一轮
            let changed = vec![StoreDump {
                namespace: "ew-local-workflow/kv".into(),
                records: vec![row("run:-1", "改过的内容"), row("run:-2", "新增")],
            }];
            let state = inspect_at(&root.0).await.unwrap();
            assert_eq!(state.state, StartupState::Retry);
            let m = manifest(&changed);
            let next = prepare_at(&root.0, &state.token, m.clone()).await.unwrap();
            assert_ne!(first.run_id, next.run_id);
            stage_all(&root.0, &next, &changed).await;
            commit_at(&root.0, &next.run_id, m).await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
        });
    }
    #[test]
    fn modified_sqlite_content_aborts_import_and_keeps_the_external_edit() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (plan, m) = prepare(&root.0, &source()).await;
            stage_all(&root.0, &plan, &source()).await;
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("INSERT INTO sync_settings(key,value) VALUES('external','保留外部修改')")
                .execute(&mut db)
                .await
                .unwrap();
            assert!(commit_at(&root.0, &plan.run_id, m)
                .await
                .unwrap_err()
                .contains("SQLite 内容发生变化"));
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM sync_settings WHERE key='external'"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                "保留外部修改"
            );
        });
    }
    #[test]
    fn invalid_inventory_and_unprepared_staging_do_not_create_a_database() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let state = inspect_at(&root.0).await.unwrap();
            let mut m = manifest(&[]);
            m.sources.remove("app-settings");
            assert!(prepare_at(&root.0, &state.token, m).await.is_err());
            assert!(stage_at(&root.0, "unknown", source().remove(0))
                .await
                .is_err());
            assert!(!root.0.join("ew-writing.db").exists());
        });
    }
    #[test]
    fn pending_receipt_with_modern_data_is_inconsistent_not_retryable() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let (_plan, _) = prepare(&root.0, &source()).await;
            desktop_storage::write_at(
                &root.0,
                "ew-local-workflow/kv",
                vec![row("run:-2", "新版稿件")],
                vec![],
                false,
                false,
            )
            .await
            .unwrap();
            assert!(inspect_at(&root.0).await.unwrap_err().contains("并存"));
        });
    }
    #[test]
    fn unrecognized_unversioned_schema_and_invalid_flags_are_blocked() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("CREATE TABLE unknown_future_books(id INTEGER,content TEXT)")
                .execute(&mut db)
                .await
                .unwrap();
            assert!(inspect_at(&root.0)
                .await
                .unwrap_err()
                .contains("未知数据表"));
            let bad = Temp::new();
            set_meta(&bad.0, LEGACY_KEY, "incomplete").await;
            assert!(inspect_at(&bad.0).await.unwrap_err().contains("标记无效"));
        });
    }
    #[test]
    fn pre_release_schema_with_extra_tables_is_migrated_and_preserved() {
        tauri::async_runtime::block_on(async {
            // 开源前的旧版本建的库：没有 desktop_* 表，多出 chapter_conflicts / sync_outbox，
            // 再加一张完全陌生的表。只要有可识别的旧数据，就必须走迁移而不是拒绝启动。
            let root = Temp::new();
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(root.0.join("ew-writing.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
            for sql in [
                "CREATE TABLE chapter_contents (storageKey TEXT PRIMARY KEY, userId TEXT NOT NULL, bookId TEXT NOT NULL, chapterId INTEGER NOT NULL, payload TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, conflict INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, lastBackedUpAt INTEGER NOT NULL DEFAULT 0, wordCount INTEGER NOT NULL DEFAULT 0, textWordCount INTEGER)",
                "CREATE TABLE chapter_conflicts (storageKey TEXT PRIMARY KEY, userId TEXT NOT NULL, bookId TEXT NOT NULL, chapterId INTEGER NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL)",
                "CREATE TABLE sync_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, nextRetryAt INTEGER)",
                "CREATE TABLE sync_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                "CREATE TABLE chapter_versions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, chapterId INTEGER NOT NULL, createdAt INTEGER NOT NULL)",
                "CREATE TABLE local_books (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, title TEXT NOT NULL, groupId TEXT, mergeStatus TEXT NOT NULL, deletedAt TEXT, updateTime TEXT NOT NULL)",
                "CREATE TABLE local_book_groups (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, deletedAt TEXT, sortNo INTEGER NOT NULL)",
                "CREATE TABLE local_volumes (id INTEGER PRIMARY KEY, bookId TEXT NOT NULL, payload TEXT NOT NULL, deletedAt TEXT, sortNo INTEGER NOT NULL)",
                "CREATE TABLE local_chapters (id INTEGER PRIMARY KEY, bookId TEXT NOT NULL, volumeId TEXT NOT NULL, payload TEXT NOT NULL, deletedAt TEXT, sortNo INTEGER NOT NULL)",
                "CREATE TABLE experimental_notes (id INTEGER PRIMARY KEY, body TEXT)",
                "INSERT INTO local_books VALUES (149,'{\"id\":149,\"title\":\"书\"}','书',NULL,'local',NULL,'2026-09-20')",
                "INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt) VALUES ('1:149:22083','1','149',22083,'{\"text\":\"正文\"}',1)",
                "INSERT INTO chapter_conflicts VALUES ('1:149:22083','1','149',22083,'{\"text\":\"冲突副本\"}',1)",
                "INSERT INTO sync_settings VALUES ('syncMode','auto')",
            ] {
                sqlx::query(sql).execute(&mut db).await.unwrap();
            }
            db.close().await.unwrap();
            let inspected = inspect_at(&root.0).await.unwrap();
            assert_eq!(inspected.state, StartupState::NeedsInventory);
            assert_eq!(inspected.sqlite_records, 3);
            assert_eq!(inspected.sqlite_content_records, 2);
            let (plan, m) = prepare(&root.0, &[]).await;
            assert_eq!(plan.action, "migrate");
            assert!(Path::new(&plan.backup_path).is_file());
            stage_all(&root.0, &plan, &[]).await;
            commit_at(&root.0, &plan.run_id, m).await.unwrap();
            assert_eq!(
                inspect_at(&root.0).await.unwrap().state,
                StartupState::Ready
            );
            let mut db = desktop_storage::connect_existing_at(&root.0).await.unwrap();
            let present = tables(&mut db).await.unwrap();
            for table in ["chapter_conflicts", "sync_outbox", "experimental_notes"] {
                assert!(present.contains(table), "{table} 应原样保留");
            }
            let conflict: String = sqlx::query_scalar("SELECT payload FROM chapter_conflicts")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert!(conflict.contains("冲突副本"));
            let content: String = sqlx::query_scalar(
                "SELECT payload FROM chapter_contents WHERE storageKey='1:149:22083'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert!(content.contains("正文"));
            db.close().await.unwrap();

            // 没有任何可识别旧数据、却带着这两张早期表的空库，也不能被当成陌生数据库拒绝
            let empty = Temp::new();
            let mut db = desktop_storage::connect_at(&empty.0).await.unwrap();
            for sql in [
                "CREATE TABLE chapter_conflicts (storageKey TEXT PRIMARY KEY, payload TEXT NOT NULL)",
                "CREATE TABLE sync_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
            ] {
                sqlx::query(sql).execute(&mut db).await.unwrap();
            }
            db.close().await.unwrap();
            assert_eq!(
                inspect_at(&empty.0).await.unwrap().state,
                StartupState::NeedsInventory
            );
        });
    }
    #[test]
    fn broken_primary_keys_or_record_payloads_are_not_accepted_as_legacy_data() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
            sqlx::query("DROP TABLE sync_settings")
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE sync_settings(key TEXT,value TEXT NOT NULL)")
                .execute(&mut db)
                .await
                .unwrap();
            assert!(inspect_at(&root.0)
                .await
                .unwrap_err()
                .contains("唯一标识约束"));
            // 现有 SQLite 里一条写坏的记录不能卡住启动检查；它原样保留，迁移照常完成
            let malformed = Temp::new();
            let mut db = desktop_storage::connect_at(&malformed.0).await.unwrap();
            sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt) VALUES('guest:-1:-2','guest','-1',-2,'null',1)").execute(&mut db).await.unwrap();
            let state = inspect_at(&malformed.0).await.unwrap();
            assert_eq!(state.state, StartupState::NeedsInventory);
            let (plan, m) = prepare(&malformed.0, &source()).await;
            stage_all(&malformed.0, &plan, &source()).await;
            commit_at(&malformed.0, &plan.run_id, m).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT payload FROM chapter_contents")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                "null"
            );
        });
    }
    #[test]
    fn orphan_assets_and_unfinished_legacy_staging_cannot_be_silently_initialized() {
        tauri::async_runtime::block_on(async {
            let root = Temp::new();
            desktop_storage::connect_at(&root.0).await.unwrap();
            fs::create_dir_all(root.0.join("assets/fonts")).unwrap();
            fs::write(root.0.join("assets/fonts/remaining.bin"), "原字体文件").unwrap();
            let state = inspect_at(&root.0).await.unwrap();
            assert!(prepare_at(&root.0, &state.token, manifest(&[]))
                .await
                .unwrap_err()
                .contains("不能按全新安装"));
            assert_eq!(
                fs::read_to_string(root.0.join("assets/fonts/remaining.bin")).unwrap(),
                "原字体文件"
            );
            let staged = Temp::new();
            desktop_storage::write_at(
                &staged.0,
                "ew-local-workflow/kv",
                vec![row("run:-1", "暂存中的旧稿")],
                vec![],
                true,
                true,
            )
            .await
            .unwrap();
            let state = inspect_at(&staged.0).await.unwrap();
            assert!(prepare_at(&staged.0, &state.token, manifest(&[]))
                .await
                .unwrap_err()
                .contains("原始旧数据不可用"));
            let mut db = desktop_storage::connect_at(&staged.0).await.unwrap();
            assert_eq!(
                desktop_storage::rows(&mut db, "ew-local-workflow/kv", true)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        });
    }
    // Run in a subprocess so termination happens without Rust destructors or SQLite close().
    #[test]
    fn crash_fixture_process() {
        let Ok(dir) = std::env::var("EW_STORAGE_CRASH_FIXTURE") else {
            return;
        };
        let phase = std::env::var("EW_STORAGE_CRASH_PHASE").unwrap();
        tauri::async_runtime::block_on(async {
            let root = Path::new(&dir);
            let stores = source();
            let (plan, manifest) = prepare(root, &stores).await;
            if phase == "staging" {
                stage_at(root, &plan.run_id, stores[0].clone())
                    .await
                    .unwrap();
            } else {
                stage_all(root, &plan, &stores).await;
                if phase == "committed" {
                    commit_at(root, &plan.run_id, manifest).await.unwrap();
                } else {
                    let mut db = desktop_storage::connect_at(root).await.unwrap();
                    let mut tx = desktop_storage::begin_write(&mut db).await.unwrap();
                    sqlx::query("UPDATE sync_settings SET value='uncommitted'")
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                    fs::write(root.join("fixture-ready"), "ready").unwrap();
                    std::thread::sleep(Duration::from_secs(30));
                    return;
                }
            }
            fs::write(root.join("fixture-ready"), "ready").unwrap();
            std::thread::sleep(Duration::from_secs(30));
        });
    }
    #[test]
    fn abrupt_process_exit_preserves_originals_and_selects_only_committed_data() {
        for phase in ["staging", "transaction", "committed"] {
            let root = Temp::new();
            tauri::async_runtime::block_on(async {
                let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
                sqlx::query(
                    "INSERT INTO sync_settings(key,value) VALUES('original','original text')",
                )
                .execute(&mut db)
                .await
                .unwrap();
                db.close().await.unwrap();
            });
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage_migration::tests::crash_fixture_process",
                    "--nocapture",
                ])
                .env("EW_STORAGE_CRASH_FIXTURE", &root.0)
                .env("EW_STORAGE_CRASH_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !root.0.join("fixture-ready").exists() && std::time::Instant::now() < deadline {
                if let Some(status) = child.try_wait().unwrap() {
                    panic!("fixture exited early: {status}");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let ready = root.0.join("fixture-ready").exists();
            child.kill().unwrap();
            child.wait().unwrap();
            assert!(ready, "child did not reach the requested failure point");
            tauri::async_runtime::block_on(async {
                let state = inspect_at(&root.0).await.unwrap();
                let mut db = desktop_storage::connect_at(&root.0).await.unwrap();
                assert_eq!(
                    sqlx::query_scalar::<_, String>(
                        "SELECT value FROM sync_settings WHERE key='original'"
                    )
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                    "original text"
                );
                if phase == "committed" {
                    assert_eq!(state.state, StartupState::Ready);
                    assert!(validate_runtime_at(
                        &root.0,
                        &RuntimeStorage::Legacy {
                            core: CoreBackend::Sqlite
                        },
                        &state.token
                    )
                    .await
                    .is_err());
                    assert_eq!(
                        desktop_storage::rows(&mut db, "ew-local-workflow/kv", false)
                            .await
                            .unwrap()[0]
                            .value,
                        row("run:-1", "保留全部内容").value
                    );
                } else {
                    assert_eq!(state.state, StartupState::Retry);
                    validate_runtime_at(
                        &root.0,
                        &RuntimeStorage::Legacy {
                            core: CoreBackend::Sqlite,
                        },
                        &state.token,
                    )
                    .await
                    .unwrap();
                    assert!(
                        desktop_storage::rows(&mut db, "ew-local-workflow/kv", false)
                            .await
                            .unwrap()
                            .is_empty()
                    );
                    // Continue writing before a fresh attempt; retry must retain that later content.
                    sqlx::query("UPDATE sync_settings SET value='continued after failure'")
                        .execute(&mut db)
                        .await
                        .unwrap();
                    let stores = source();
                    let (plan, manifest) = prepare(&root.0, &stores).await;
                    stage_all(&root.0, &plan, &stores).await;
                    commit_at(&root.0, &plan.run_id, manifest).await.unwrap();
                    assert_eq!(
                        sqlx::query_scalar::<_, String>(
                            "SELECT value FROM sync_settings WHERE key='original'"
                        )
                        .fetch_one(&mut db)
                        .await
                        .unwrap(),
                        "continued after failure"
                    );
                }
            });
        }
    }
}
