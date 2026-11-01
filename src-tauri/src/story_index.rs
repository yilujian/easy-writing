//! 作品状态层的地基：变更事件（outbox）、正文切块与检索表、实体索引，以及索引器的
//! 领取 / 复核 / 提交协议。模型提取在后续任务接入；本模块不调用模型。
//!
//! 原编辑器通过 plugin-sql 直写 SQLite，Rust 收不到保存事件，所以变更事件全部由触发器
//! 写入 `agent_outbox`：正文（chapter）、目录软删除/排序/换卷（catalog）、资料文档（materials）。
//! 目录表由前端用 INSERT OR REPLACE 写入（删后插），因此同时挂 INSERT 与 UPDATE 触发器。
//!
//! 索引器领取一批事件时记录领取上限 id，只标记不超过该 id 的行；提交前重新计算章节指纹，
//! 与领取时不同就释放这批行留给下一轮，提取期间作者再保存的内容不会被吞掉。
use crate::writing_records::{err, now};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};

/// 最近 20 秒内仍在保存的章节不领取，避免编辑器 160ms 落盘一次时反复提取。
pub const QUIET_MS: i64 = 20_000;
/// 领取超过 10 分钟未提交视为索引器异常退出，下一轮重新领取。
pub const STALE_CLAIM_MS: i64 = 10 * 60_000;
/// 已处理事件保留 7 天供排查。
pub const RETENTION_MS: i64 = 7 * 86_400_000;
const FTS_META_KEY: &str = "fts5-available";

/// 变更事件表与触发器。每条都是单独一条语句，方便在纯 SQLite 环境里逐条验证。
pub const OUTBOX_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS agent_outbox(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,bookId TEXT NOT NULL,chapterId TEXT,createdAt INTEGER NOT NULL,claimedBy TEXT,claimedAt INTEGER,processedAt INTEGER)",
    "CREATE INDEX IF NOT EXISTS idx_agent_outbox_pending ON agent_outbox(processedAt,claimedBy,bookId,chapterId)",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_chapter_content_updated AFTER UPDATE OF payload ON chapter_contents WHEN json_extract(NEW.payload,'$.textContent') IS NOT json_extract(OLD.payload,'$.textContent') OR json_extract(NEW.payload,'$.title') IS NOT json_extract(OLD.payload,'$.title') BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('chapter',NEW.bookId,CAST(NEW.chapterId AS TEXT),CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_chapter_content_inserted AFTER INSERT ON chapter_contents BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('chapter',NEW.bookId,CAST(NEW.chapterId AS TEXT),CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_chapter_catalog_inserted AFTER INSERT ON local_chapters BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('catalog',NEW.bookId,CAST(NEW.id AS TEXT),CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_chapter_catalog_updated AFTER UPDATE ON local_chapters WHEN NEW.deletedAt IS NOT OLD.deletedAt OR NEW.sortNo IS NOT OLD.sortNo OR NEW.volumeId IS NOT OLD.volumeId BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('catalog',NEW.bookId,CAST(NEW.id AS TEXT),CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_chapter_catalog_deleted AFTER DELETE ON local_chapters BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('catalog',OLD.bookId,CAST(OLD.id AS TEXT),CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_volume_catalog_inserted AFTER INSERT ON local_volumes BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('catalog',NEW.bookId,NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_volume_catalog_updated AFTER UPDATE ON local_volumes WHEN NEW.deletedAt IS NOT OLD.deletedAt OR NEW.sortNo IS NOT OLD.sortNo BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('catalog',NEW.bookId,NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_materials_inserted AFTER INSERT ON desktop_records WHEN NEW.namespace='ew-local-reference/book-reference' BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('materials',CAST(json_extract(NEW.key,'$') AS TEXT),NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_materials_updated AFTER UPDATE OF value ON desktop_records WHEN NEW.namespace='ew-local-reference/book-reference' BEGIN INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('materials',CAST(json_extract(NEW.key,'$') AS TEXT),NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END",
];

/// 派生检索表：正文切块与实体索引。不备份，恢复后由索引器重建。
pub const CHUNK_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS chapter_chunks(id INTEGER PRIMARY KEY,bookId TEXT NOT NULL,chapterId TEXT NOT NULL,seq INTEGER NOT NULL,sourceRevision TEXT NOT NULL,sceneKind TEXT,provenance TEXT NOT NULL DEFAULT 'unknown',text TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_chapter_chunks_chapter ON chapter_chunks(bookId,chapterId,seq)",
    "CREATE TABLE IF NOT EXISTS canon_entities(bookId TEXT NOT NULL,entityType TEXT NOT NULL,entityId TEXT NOT NULL,name TEXT NOT NULL,chapterId TEXT NOT NULL,storyOrder INTEGER,PRIMARY KEY(bookId,entityType,entityId,name,chapterId))",
    "CREATE INDEX IF NOT EXISTS idx_canon_entities_name ON canon_entities(bookId,name)",
    // 记忆也进检索：一条记忆一行，按作品加作者层查；归档或删除的不在表里
    "CREATE TABLE IF NOT EXISTS memory_chunks(id INTEGER PRIMARY KEY,memoryId TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,bookId TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_memory_chunks_book ON memory_chunks(bookId,scope)",
];

/// FTS5 trigram 外部内容表；三字以上的子串检索走这里，两字短词走实体索引与 LIKE。
pub const FTS_DDL: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts5(text,content='chapter_chunks',content_rowid='id',tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS trg_chapter_chunks_ai AFTER INSERT ON chapter_chunks BEGIN INSERT INTO chapter_fts(rowid,text) VALUES(NEW.id,NEW.text); END",
    "CREATE TRIGGER IF NOT EXISTS trg_chapter_chunks_ad AFTER DELETE ON chapter_chunks BEGIN INSERT INTO chapter_fts(chapter_fts,rowid,text) VALUES('delete',OLD.id,OLD.text); END",
    "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text,content='memory_chunks',content_rowid='id',tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN INSERT INTO memory_fts(rowid,text) VALUES(NEW.id,NEW.text); END",
    "CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',OLD.id,OLD.text); END",
    "CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',OLD.id,OLD.text); INSERT INTO memory_fts(rowid,text) VALUES(NEW.id,NEW.text); END",
    "CREATE TRIGGER IF NOT EXISTS trg_chapter_chunks_au AFTER UPDATE ON chapter_chunks BEGIN INSERT INTO chapter_fts(chapter_fts,rowid,text) VALUES('delete',OLD.id,OLD.text); INSERT INTO chapter_fts(rowid,text) VALUES(NEW.id,NEW.text); END",
];

pub async fn fts5_available(db: &mut SqliteConnection) -> Result<bool, String> {
    let flag: i64 = sqlx::query_scalar("SELECT sqlite_compileoption_used('ENABLE_FTS5')")
        .fetch_one(&mut *db)
        .await
        .map_err(err)?;
    Ok(flag == 1)
}

const SCHEMA_META_KEY: &str = "agent-index-schema";
/// 改动任何 DDL 时递增；旧库按版本号补建。版本 2：记忆进索引（memory_chunks / memory_fts）。
const SCHEMA_VERSION: &str = "3";

/// 在核心表建好之后调用；全部 IF NOT EXISTS，旧库首次打开即建，不升存储版本。
/// 每次连接都会经过这里，所以用元数据里的版本号跳过已建好的库。
pub async fn ensure_schema(db: &mut SqliteConnection) -> Result<(), String> {
    let installed: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_meta WHERE key=?")
            .bind(SCHEMA_META_KEY)
            .fetch_optional(&mut *db)
            .await
            .map_err(err)?;
    if installed.as_deref() == Some(SCHEMA_VERSION) {
        return Ok(());
    }
    for sql in OUTBOX_DDL.iter().chain(CHUNK_DDL.iter()) {
        sqlx::query(sql).execute(&mut *db).await.map_err(err)?;
    }
    let fts = fts5_available(db).await?;
    if fts {
        for sql in FTS_DDL {
            sqlx::query(sql).execute(&mut *db).await.map_err(err)?;
        }
    }
    // 升到版本 2 的旧库：已有的记忆全部补进索引（新库没有记忆，等于空跑）
    if installed.as_deref() != Some(SCHEMA_VERSION) {
        rebuild_memory_index(db).await?;
    }
    for (key, value) in [
        (FTS_META_KEY, if fts { "1" } else { "0" }),
        (SCHEMA_META_KEY, SCHEMA_VERSION),
    ] {
        sqlx::query("INSERT INTO desktop_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(key)
            .bind(value)
            .execute(&mut *db)
            .await
            .map_err(err)?;
    }
    Ok(())
}

async fn fts5_enabled(db: &mut SqliteConnection) -> Result<bool, String> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM desktop_meta WHERE key=?")
        .bind(FTS_META_KEY)
        .fetch_optional(&mut *db)
        .await
        .map_err(err)?;
    Ok(value.as_deref() == Some("1"))
}

// ---------------------------------------------------------------------------
// 领取 / 复核 / 提交
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxGroup {
    /// chapter | catalog | materials
    pub kind: String,
    pub book_id: String,
    /// 只有 chapter 事件按章节分组；目录与资料事件按作品分组
    pub chapter_id: Option<String>,
    /// 领取上限：提交时只标记不超过它的行
    pub max_id: i64,
    pub count: i64,
}

fn priority(kind: &str) -> u8 {
    match kind {
        "materials" => 0,
        "catalog" => 1,
        _ => 2,
    }
}

/// 章节指纹与记忆来源指纹同口径（版本、标题、正文）；章节已不存在时返回 None。
pub async fn chapter_fingerprint(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<Option<String>, String> {
    if let Some(pid) = crate::reference_books::project_of(book_id) {
        return Ok(crate::reference_books::chapter(db, pid, chapter_id)
            .await
            .ok()
            .map(|c| crate::reference_books::version_of(&c)));
    }
    let present:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_chapters c JOIN local_books b ON CAST(b.id AS TEXT)=c.bookId WHERE c.bookId=? AND c.id=? AND c.deletedAt IS NULL AND b.deletedAt IS NULL)")
        .bind(book_id).bind(chapter_id).fetch_one(&mut *db).await.map_err(err)?;
    if !present {
        return Ok(None);
    }
    let c = crate::writing_records::chapter(db, book_id, chapter_id).await?;
    Ok(Some(crate::book_materials::version(&json!([
        c["localVersion"],
        c["title"],
        c["textContent"]
    ]))))
}

/// 索引通道。参考书（拆书库）一拆就是成百上千章，单独一条低优先级通道，
/// 作者自己作品的索引不排在它后面；两条通道各自领取，互不阻塞。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Author,
    Reference,
}

impl Lane {
    fn filter(lane: Option<Lane>) -> &'static str {
        match lane {
            None => " AND kind != 'distillation'",
            Some(Lane::Author) => " AND kind != 'distillation' AND bookId NOT LIKE 'breakdown:%'",
            Some(Lane::Reference) => " AND kind != 'distillation' AND bookId LIKE 'breakdown:%'",
        }
    }
}

pub async fn backlog_due_in(
    db: &mut SqliteConnection,
    stamp: i64,
    age_ms: i64,
    lane: Option<Lane>,
) -> Result<bool, String> {
    let sql = format!(
        "SELECT DISTINCT bookId FROM agent_outbox WHERE processedAt IS NULL AND claimedBy IS NULL AND createdAt<=?{}",
        Lane::filter(lane)
    );
    let books: Vec<String> = sqlx::query_scalar(&sql)
        .bind(stamp - age_ms)
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
    for book_id in books {
        if !index_paused(db, &book_id).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 按通道领取。参考书通道直接跳过已暂停的书：一本书暂停，其他参考书照常往下拆。
pub async fn claim_in(
    db: &mut SqliteConnection,
    run_id: &str,
    limit: usize,
    quiet_ms: i64,
    lane: Option<Lane>,
) -> Result<Vec<OutboxGroup>, String> {
    let stamp = now();
    sqlx::query("UPDATE agent_outbox SET claimedBy=NULL,claimedAt=NULL WHERE processedAt IS NULL AND claimedBy IS NOT NULL AND claimedAt<?")
        .bind(stamp - STALE_CLAIM_MS)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    let sql = format!(
        "SELECT id,kind,bookId,chapterId FROM agent_outbox WHERE processedAt IS NULL AND claimedBy IS NULL AND createdAt<=?{} ORDER BY id",
        Lane::filter(lane)
    );
    let rows = sqlx::query(&sql)
        .bind(stamp - quiet_ms)
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
    let mut paused: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    let mut groups: Vec<(OutboxGroup, Vec<i64>)> = Vec::new();
    for row in rows {
        let id: i64 = row.get("id");
        let kind: String = row.get("kind");
        let book_id: String = row.get("bookId");
        let chapter: Option<String> = row.get("chapterId");
        let chapter_id = if matches!(kind.as_str(), "chapter" | "distillation") {
            chapter
        } else {
            None
        };
        if lane.is_some() {
            let skip = match paused.get(&book_id) {
                Some(value) => *value,
                None => {
                    let value = index_paused(db, &book_id).await?;
                    paused.insert(book_id.clone(), value);
                    value
                }
            };
            if skip {
                continue;
            }
        }
        match groups
            .iter()
            .position(|(g, _)| g.kind == kind && g.book_id == book_id && g.chapter_id == chapter_id)
        {
            Some(index) => {
                let (group, ids) = &mut groups[index];
                group.max_id = id;
                group.count += 1;
                ids.push(id);
            }
            None => groups.push((
                OutboxGroup {
                    kind,
                    book_id,
                    chapter_id,
                    max_id: id,
                    count: 1,
                },
                vec![id],
            )),
        }
    }
    groups.sort_by_key(|(group, ids)| (priority(&group.kind), ids[0]));
    if lane == Some(Lane::Author) {
        // 同书必须按目录整理，后一章的提取要看到此前提交的伏笔编号。
        let mut order = std::collections::HashMap::new();
        for (g, _) in &groups {
            if !order.contains_key(&g.book_id) {
                let ids:Vec<(String,)>=sqlx::query_as("SELECT CAST(c.id AS TEXT) FROM local_chapters c JOIN local_volumes v ON v.id=CAST(c.volumeId AS INTEGER) AND v.bookId=c.bookId WHERE c.bookId=? AND c.deletedAt IS NULL AND v.deletedAt IS NULL ORDER BY v.sortNo,v.id,c.sortNo,c.id")
                    .bind(&g.book_id).fetch_all(&mut *db).await.map_err(err)?;
                order.insert(
                    g.book_id.clone(),
                    ids.into_iter()
                        .enumerate()
                        .map(|(i, (id,))| (id, i))
                        .collect::<std::collections::HashMap<_, _>>(),
                );
            }
        }
        groups.sort_by_key(|(g, ids)| {
            (
                priority(&g.kind),
                g.book_id.clone(),
                g.chapter_id
                    .as_ref()
                    .and_then(|id| order[&g.book_id].get(id).copied())
                    .unwrap_or(usize::MAX),
                ids[0],
            )
        });
        let mut selected = std::collections::HashSet::new();
        groups.retain(|(g, _)| g.kind != "chapter" || selected.insert(g.book_id.clone()));
    }
    groups.truncate(limit);
    let ids: Vec<i64> = groups
        .iter()
        .flat_map(|(_, ids)| ids.iter().copied())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query("UPDATE agent_outbox SET claimedBy=?,claimedAt=? WHERE id IN (SELECT value FROM json_each(?))")
        .bind(run_id)
        .bind(stamp)
        .bind(serde_json::to_string(&ids).map_err(err)?)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    Ok(groups.into_iter().map(|(group, _)| group).collect())
}

async fn mark(
    db: &mut SqliteConnection,
    run_id: &str,
    group: &OutboxGroup,
    processed_at: Option<i64>,
) -> Result<u64, String> {
    let set = if processed_at.is_some() {
        "processedAt=?"
    } else {
        "claimedBy=NULL,claimedAt=NULL,processedAt=?"
    };
    let sql = if matches!(group.kind.as_str(), "chapter" | "distillation") {
        format!("UPDATE agent_outbox SET {set} WHERE claimedBy=? AND processedAt IS NULL AND kind=? AND bookId=? AND chapterId IS ? AND id<=?")
    } else {
        format!("UPDATE agent_outbox SET {set} WHERE claimedBy=? AND processedAt IS NULL AND kind=? AND bookId=? AND id<=?")
    };
    let mut query = sqlx::query(&sql)
        .bind(processed_at)
        .bind(run_id)
        .bind(&group.kind)
        .bind(&group.book_id);
    if matches!(group.kind.as_str(), "chapter" | "distillation") {
        query = query.bind(group.chapter_id.clone());
    }
    Ok(query
        .bind(group.max_id)
        .execute(&mut *db)
        .await
        .map_err(err)?
        .rows_affected())
}

/// 提交一组事件。章节组比较领取时的指纹：一致则标记已处理，否则释放这批行并返回 false，
/// 提取期间作者再保存的内容留给下一轮。目录与资料组直接标记。
pub async fn complete(
    db: &mut SqliteConnection,
    run_id: &str,
    group: &OutboxGroup,
    claimed_fingerprint: Option<&str>,
) -> Result<bool, String> {
    let unchanged = match (group.kind.as_str(), &group.chapter_id) {
        ("chapter", Some(chapter_id)) => {
            chapter_fingerprint(db, &group.book_id, chapter_id)
                .await?
                .as_deref()
                == claimed_fingerprint
        }
        _ => true,
    };
    if unchanged {
        mark(db, run_id, group, Some(now())).await?;
    } else {
        mark(db, run_id, group, None).await?;
    }
    Ok(unchanged)
}

/// 索引器中止时释放本次运行的全部领取。
pub async fn release(db: &mut SqliteConnection, run_id: &str) -> Result<u64, String> {
    Ok(sqlx::query("UPDATE agent_outbox SET claimedBy=NULL,claimedAt=NULL WHERE claimedBy=? AND processedAt IS NULL")
        .bind(run_id)
        .execute(&mut *db)
        .await
        .map_err(err)?
        .rows_affected())
}

/// 某条通道里还没处理的事件数；参考书通道不计已暂停的书。
pub async fn pending_in(db: &mut SqliteConnection, lane: Lane) -> Result<i64, String> {
    let sql = format!(
        "SELECT bookId,COUNT(*) AS n FROM agent_outbox WHERE processedAt IS NULL{} GROUP BY bookId",
        Lane::filter(Some(lane))
    );
    let rows = sqlx::query(&sql).fetch_all(&mut *db).await.map_err(err)?;
    let mut total = 0;
    for row in rows {
        let book_id: String = row.get("bookId");
        if index_paused(db, &book_id).await? {
            continue;
        }
        total += row.get::<i64, _>("n");
    }
    Ok(total)
}

pub async fn pending(db: &mut SqliteConnection, book_id: Option<&str>) -> Result<i64, String> {
    let count: i64 = match book_id {
        Some(bid) => sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_outbox WHERE processedAt IS NULL AND bookId=?",
        )
        .bind(bid)
        .fetch_one(&mut *db)
        .await
        .map_err(err)?,
        None => sqlx::query_scalar("SELECT COUNT(*) FROM agent_outbox WHERE processedAt IS NULL")
            .fetch_one(&mut *db)
            .await
            .map_err(err)?,
    };
    Ok(count)
}

pub async fn prune(db: &mut SqliteConnection, retention_ms: i64) -> Result<u64, String> {
    Ok(
        sqlx::query("DELETE FROM agent_outbox WHERE processedAt IS NOT NULL AND processedAt<=?")
            .bind(now() - retention_ms)
            .execute(&mut *db)
            .await
            .map_err(err)?
            .rows_affected(),
    )
}

// ---------------------------------------------------------------------------
// 切块与检索
// ---------------------------------------------------------------------------

/// 按空行切段并合并到 300–500 字一块；单段超长时独立成块，不在句中切断。
pub fn split_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in text.split('\n').map(str::trim).filter(|p| !p.is_empty()) {
        let length = current.chars().count();
        if length > 0 && length + paragraph.chars().count() > 500 {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(paragraph);
        if current.chars().count() >= 300 {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 重建一章的切块；FTS 由触发器同步。`provenance` 取 unknown | author_confirmed | ai。
pub async fn index_chunks(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    revision: &str,
    text: &str,
    provenance: &str,
) -> Result<usize, String> {
    sqlx::query("DELETE FROM chapter_chunks WHERE bookId=? AND chapterId=?")
        .bind(book_id)
        .bind(chapter_id)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    let chunks = split_chunks(text);
    for (seq, chunk) in chunks.iter().enumerate() {
        sqlx::query("INSERT INTO chapter_chunks(bookId,chapterId,seq,sourceRevision,provenance,text) VALUES(?,?,?,?,?,?)")
            .bind(book_id)
            .bind(chapter_id)
            .bind(seq as i64)
            .bind(revision)
            .bind(provenance)
            .bind(chunk)
            .execute(&mut *db)
            .await
            .map_err(err)?;
    }
    Ok(chunks.len())
}

/// 切块里命中 AI 指纹片段的标为 `ai`：作者确认样本时这些块不会变成手写样本。
pub async fn mark_ai_chunks(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    marks: &[String],
) -> Result<u64, String> {
    if marks.is_empty() {
        return Ok(0);
    }
    let rows = sqlx::query("SELECT id,text FROM chapter_chunks WHERE bookId=? AND chapterId=?")
        .bind(book_id)
        .bind(chapter_id)
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
    let mut marked = 0;
    for row in rows {
        let text: String = row.get("text");
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if marks.iter().any(|m| compact.contains(m.as_str())) {
            sqlx::query("UPDATE chapter_chunks SET provenance='ai' WHERE id=?")
                .bind(row.get::<i64, _>("id"))
                .execute(&mut *db)
                .await
                .map_err(err)?;
            marked += 1;
        }
    }
    Ok(marked)
}

pub async fn drop_chapter_index(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM chapter_chunks WHERE bookId=? AND chapterId=?")
        .bind(book_id)
        .bind(chapter_id)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    sqlx::query("DELETE FROM canon_entities WHERE bookId=? AND chapterId=?")
        .bind(book_id)
        .bind(chapter_id)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    Ok(())
}

/// 三字以上且 FTS5 可用时走 trigram 子串匹配；否则走 LIKE。返回 {chapterId, seq, text}。
/// 本机正文检索：只查询关键词/全文索引，不调用模型或网络。
pub async fn search_chunks(
    db: &mut SqliteConnection,
    book_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let ids = fts_chunk_ids(db, book_id, query, limit, None).await?;
    let rows = chunk_rows(db, &ids).await?;
    Ok(ids
        .iter()
        .filter_map(|id| rows.get(id))
        .map(|row| {
            let mut hit = row.clone();
            hit["via"] = json!("fts");
            hit
        })
        .collect())
}

pub async fn bounded_chunks(
    db: &mut SqliteConnection,
    book_id: &str,
    query: &str,
    allowed: &[&str],
    limit: i64,
) -> Result<Vec<Value>, String> {
    if allowed.is_empty() {
        return Ok(Vec::new());
    }
    let ids = fts_chunk_ids(
        db,
        book_id,
        query,
        limit,
        Some(serde_json::to_string(allowed).map_err(err)?),
    )
    .await?;
    let rows = chunk_rows(db, &ids).await?;
    Ok(ids.iter().filter_map(|id| rows.get(id).cloned()).collect())
}

async fn fts_chunk_ids(
    db: &mut SqliteConnection,
    book_id: &str,
    query: &str,
    limit: i64,
    allowed: Option<String>,
) -> Result<Vec<i64>, String> {
    let use_fts = query.chars().count() >= 3 && fts5_enabled(db).await?;
    let rows = if use_fts {
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        sqlx::query("SELECT c.id AS id FROM chapter_fts JOIN chapter_chunks c ON c.id=chapter_fts.rowid WHERE chapter_fts MATCH ? AND c.bookId=? AND (? IS NULL OR c.chapterId IN (SELECT value FROM json_each(?))) ORDER BY bm25(chapter_fts) LIMIT ?")
            .bind(phrase)
            .bind(book_id)
            .bind(&allowed).bind(&allowed)
            .bind(limit)
            .fetch_all(&mut *db)
            .await
            .map_err(err)?
    } else {
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        sqlx::query("SELECT id FROM chapter_chunks WHERE bookId=? AND text LIKE ? ESCAPE '\\' AND (? IS NULL OR chapterId IN (SELECT value FROM json_each(?))) ORDER BY chapterId,seq LIMIT ?")
            .bind(book_id)
            .bind(pattern)
            .bind(&allowed).bind(&allowed)
            .bind(limit)
            .fetch_all(&mut *db)
            .await
            .map_err(err)?
    };
    Ok(rows.iter().map(|r| r.get::<i64, _>("id")).collect())
}

async fn chunk_rows(
    db: &mut SqliteConnection,
    ids: &[i64],
) -> Result<std::collections::BTreeMap<i64, Value>, String> {
    let mut out = std::collections::BTreeMap::new();
    for id in ids {
        if let Some(row) =
            sqlx::query("SELECT id,chapterId,seq,text FROM chapter_chunks WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *db)
                .await
                .map_err(err)?
        {
            out.insert(*id, json!({"chunkId":row.get::<i64,_>("id"),"chapterId":row.get::<String,_>("chapterId"),"seq":row.get::<i64,_>("seq"),"text":row.get::<String,_>("text")}));
        }
    }
    Ok(out)
}

/// 记忆是否该在索引里：归档、删除、系统记录（规则汇编）不进
fn memory_indexable(memory: &Value) -> bool {
    !memory["deletedAt"].is_number()
        && ["active", "pending", "rejected", "stale"]
            .contains(&memory["status"].as_str().unwrap_or(""))
        && memory["kind"] == "decision"
        && memory["content"]
            .as_str()
            .is_some_and(|c| !c.trim().is_empty())
}

/// 一条记忆写入后同步索引：该在就按最新内容写一行，不该在就删掉
pub async fn sync_memory_index(db: &mut SqliteConnection, memory: &Value) -> Result<(), String> {
    let id = memory["id"].as_str().unwrap_or("");
    if id.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM memory_chunks WHERE memoryId=?")
        .bind(id)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    if memory_indexable(memory) {
        sqlx::query(
            "INSERT INTO memory_chunks(memoryId,scope,bookId,status,kind,text) VALUES(?,?,?,?,?,?)",
        )
        .bind(id)
        .bind(memory["scope"].as_str().unwrap_or("book"))
        .bind(memory["bookId"].as_str().unwrap_or(""))
        .bind(memory["status"].as_str().unwrap_or(""))
        .bind(memory["kind"].as_str().unwrap_or(""))
        .bind(memory["content"].as_str().unwrap_or("").trim())
        .execute(&mut *db)
        .await
        .map_err(err)?;
    }
    Ok(())
}

/// 从记忆记录整体重建索引（升级、恢复备份后）
pub async fn rebuild_memory_index(db: &mut SqliteConnection) -> Result<usize, String> {
    sqlx::query("DELETE FROM memory_chunks")
        .execute(&mut *db)
        .await
        .map_err(err)?;
    let mut written = 0;
    for memory in crate::writing_records::list(db, crate::book_notes::NS, "memory:").await? {
        if memory_indexable(&memory) {
            sync_memory_index(db, &memory).await?;
            written += 1;
        }
    }
    Ok(written)
}

async fn memory_rows(
    db: &mut SqliteConnection,
    ids: &[i64],
) -> Result<std::collections::BTreeMap<i64, Value>, String> {
    let mut out = std::collections::BTreeMap::new();
    for id in ids {
        if let Some(row) =
            sqlx::query("SELECT id,memoryId,scope,status,kind,text FROM memory_chunks WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *db)
                .await
                .map_err(err)?
        {
            out.insert(*id, json!({"memoryId":row.get::<String,_>("memoryId"),"scope":row.get::<String,_>("scope"),"status":row.get::<String,_>("status"),
                "kind":row.get::<String,_>("kind"),"text":row.get::<String,_>("text")}));
        }
    }
    Ok(out)
}

/// 本书及作者层记忆的关键词检索。
pub async fn search_memories(
    db: &mut SqliteConnection,
    book_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let use_fts = query.chars().count() >= 3 && fts5_enabled(db).await?;
    let rows = if use_fts {
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        sqlx::query("SELECT m.id AS id FROM memory_fts JOIN memory_chunks m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? AND m.kind='decision' AND (m.bookId=? OR m.scope='author') LIMIT ?")
            .bind(phrase).bind(book_id).bind(limit).fetch_all(&mut *db).await.map_err(err)?
    } else {
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        sqlx::query("SELECT id FROM memory_chunks WHERE kind='decision' AND (bookId=? OR scope='author') AND text LIKE ? ESCAPE '\\' LIMIT ?")
            .bind(book_id).bind(pattern).bind(limit).fetch_all(&mut *db).await.map_err(err)?
    };
    let fts: Vec<i64> = rows.iter().map(|r| r.get::<i64, _>("id")).collect();
    let order: Vec<(i64, &str)> = fts.iter().map(|id| (*id, "fts")).collect();
    let found = memory_rows(db, &order.iter().map(|(id, _)| *id).collect::<Vec<_>>()).await?;
    Ok(order
        .iter()
        .filter_map(|(id, via)| {
            let mut hit = found.get(id)?.clone();
            hit["via"] = json!(via);
            Some(hit)
        })
        .collect())
}

/// 重写一章的实体索引；每条 {entityType, entityId, name, storyOrder}，name 含别名，一名一行。
pub async fn replace_entities(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    entries: &[Value],
) -> Result<usize, String> {
    sqlx::query("DELETE FROM canon_entities WHERE bookId=? AND chapterId=?")
        .bind(book_id)
        .bind(chapter_id)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    let mut written = 0;
    for entry in entries {
        let (Some(kind), Some(id), Some(name)) = (
            entry["entityType"].as_str(),
            entry["entityId"].as_str(),
            entry["name"].as_str(),
        ) else {
            continue;
        };
        if name.trim().is_empty() {
            continue;
        }
        sqlx::query("INSERT OR REPLACE INTO canon_entities(bookId,entityType,entityId,name,chapterId,storyOrder) VALUES(?,?,?,?,?,?)")
            .bind(book_id)
            .bind(kind)
            .bind(id)
            .bind(name.trim())
            .bind(chapter_id)
            .bind(entry["storyOrder"].as_i64())
            .execute(&mut *db)
            .await
            .map_err(err)?;
        written += 1;
    }
    Ok(written)
}

/// 按名称或别名精确查实体出现过的章节；两字短词靠这里而不是 trigram。
pub async fn search_entities(
    db: &mut SqliteConnection,
    book_id: &str,
    name: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let rows = sqlx::query("SELECT entityType,entityId,name,chapterId,storyOrder FROM canon_entities WHERE bookId=? AND name=? ORDER BY storyOrder,chapterId LIMIT ?")
        .bind(book_id)
        .bind(name.trim())
        .bind(limit)
        .fetch_all(&mut *db)
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({"entityType":row.get::<String,_>("entityType"),"entityId":row.get::<String,_>("entityId"),"name":row.get::<String,_>("name"),
                   "chapterId":row.get::<String,_>("chapterId"),"storyOrder":row.get::<Option<i64>,_>("storyOrder")})
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 批次：准备（含无需模型的事件）、模型提取后的收尾
// ---------------------------------------------------------------------------

/// 一次索引批次。`jobs` 交给 worker 做结构化提取；`pending` 是等待模型结果的章节组。
#[derive(Debug, Default)]
pub struct Batch {
    pub jobs: Vec<Value>,
    pub pending: Vec<(OutboxGroup, Option<String>)>,
    pub books: std::collections::BTreeSet<String>,
    pub skipped_paused: usize,
}

/// 单次交给模型的章节上限。

const TEXT_LIMIT: usize = 40_000;
const MAX_FAILURES: i64 = 3;

fn control_key(book_id: &str) -> String {
    format!("index-control:{book_id}")
}

pub async fn index_paused(db: &mut SqliteConnection, book_id: &str) -> Result<bool, String> {
    Ok(
        crate::writing_records::get(db, crate::story_state::AUTHOR_NS, &control_key(book_id))
            .await?
            .is_some_and(|v| v["paused"] == true),
    )
}

/// 作者在记忆页手动建立索引：触发器装上之前写好的章节从未产生事件，需要补一条正文事件。
/// `only_missing` 只补没有有效章节卡的章节；否则全书重新提取（换了索引模型或想整体刷新时）。
/// 事件时间提前一个安静期，索引器立即可以领取；照常走领取、复核、提交协议。
pub async fn enqueue_book(
    db: &mut SqliteConnection,
    book_id: &str,
    only_missing: bool,
) -> Result<i64, String> {
    let catalog = crate::reference_books::any_catalog(db, book_id).await?;
    let created_at = now() - QUIET_MS;
    let mut queued = 0;
    for chapter in catalog {
        let chapter_id = chapter["id"].to_string();
        if only_missing
            && crate::story_state::get_card(db, book_id, &chapter_id)
                .await?
                .is_some_and(|card| card["status"] == "active")
        {
            continue;
        }
        sqlx::query(
            "INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('chapter',?,?,?)",
        )
        .bind(book_id)
        .bind(&chapter_id)
        .bind(created_at)
        .execute(&mut *db)
        .await
        .map_err(err)?;
        queued += 1;
    }
    Ok(queued)
}

/// 拆书任务按区间入队：只补没有有效章节卡、也没有在排队的章节。返回新入队的章数。
pub async fn enqueue_chapters(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_ids: &[String],
) -> Result<i64, String> {
    let queued_already: std::collections::BTreeSet<String> = sqlx::query_scalar(
        "SELECT DISTINCT chapterId FROM agent_outbox WHERE bookId=? AND kind='chapter' AND processedAt IS NULL AND chapterId IS NOT NULL",
    )
    .bind(book_id)
    .fetch_all(&mut *db)
    .await
    .map_err(err)?
    .into_iter()
    .collect();
    let indexed = crate::reference_books::active_card_chapters(db, book_id).await?;
    let created_at = now() - QUIET_MS;
    let mut queued = 0;
    for chapter_id in chapter_ids {
        if indexed.contains(chapter_id) || queued_already.contains(chapter_id) {
            continue;
        }
        sqlx::query(
            "INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) VALUES('chapter',?,?,?)",
        )
        .bind(book_id)
        .bind(chapter_id)
        .bind(created_at)
        .execute(&mut *db)
        .await
        .map_err(err)?;
        queued += 1;
    }
    Ok(queued)
}

/// 连续失败、已不再重试的章节。

/// 释放一组已领取的事件，留给下一轮。
pub async fn release_group(
    db: &mut SqliteConnection,
    run_id: &str,
    group: &OutboxGroup,
) -> Result<u64, String> {
    mark(db, run_id, group, None).await
}

async fn build_job(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    chapter: &Value,
    fingerprint: &str,
    text: &str,
) -> Result<Value, String> {
    use crate::story_state as canon;
    let catalog = crate::reference_books::any_catalog(db, book_id).await?;
    let position = catalog
        .iter()
        .position(|c| c["id"].to_string() == chapter_id)
        .unwrap_or(0);
    let previous = if position > 0 {
        canon::get_card(db, book_id, &catalog[position - 1]["id"].to_string())
            .await?
            .map(|c| c["card"]["oneLine"].clone())
    } else {
        None
    };
    let reference = crate::reference_books::project_of(book_id).is_some();
    let (characters, entities) = match crate::reference_books::project_of(book_id) {
        // 参考书没有人物表：前面章节卡里出现过的人名直接当编号，人物状态照样能按人折叠
        Some(pid) => {
            let names = crate::reference_books::known_names(db, pid, REFERENCE_NAME_LIMIT)
                .await?
                .into_iter()
                .map(|n| json!({"id":n,"name":n,"aliases":[]}))
                .collect::<Vec<_>>();
            (names, Vec::new())
        }
        None => {
            let materials = crate::book_materials::materials(db, book_id).await?;
            let characters = materials["characters"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| json!({"id":c["id"].to_string(),"name":c["name"],"aliases":c["aliases"],"role":c["role"],"voice":c["voice"]}))
                .collect::<Vec<_>>();
            let entities = materials["worldSettings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|w| json!({"id":w["id"].to_string(),"name":w["name"],"type":w["type"]}))
                .collect::<Vec<_>>();
            (characters, entities)
        }
    };
    let (previous, threads, facts, history_revision, selected_model, pending_chapters) =
        if reference {
            let records = canon::list_threads(db, book_id, Some("open")).await?;
            let threads = records
                .iter()
                .skip(records.len().saturating_sub(REFERENCE_THREAD_LIMIT))
                .map(|t| json!({"threadId":t["threadId"],"kind":t["kind"],"title":t["title"]}))
                .collect::<Vec<_>>();
            (previous, threads, Vec::new(), None, None, 0)
        } else {
            let h = crate::story_history::History::load(db, book_id).await?;
            let end = h.boundary(&json!({"chapterId":chapter_id}))?;
            let state = crate::story_history::snapshot(db, book_id, &h, end).await?;
            let previous = h.chapters[..end]
                .iter()
                .rev()
                .filter(|c| c.words > 0)
                .next()
                .and_then(|c| h.verified(c))
                .map(|c| c["card"]["oneLine"].clone());
            let threads = state
                .threads
                .values()
                .map(|t| json!({"threadId":t["threadId"],"title":t["title"]}))
                .collect();
            let facts = state
                .facts
                .values()
                .map(|f| json!({"factId":f["factId"],"text":f["text"]}))
                .collect();
            let control = crate::writing_records::get(db, canon::AUTHOR_NS, &control_key(book_id))
                .await?
                .unwrap_or_default();
            (
                previous,
                threads,
                facts,
                Some(h.chapters[end].stamp.clone()),
                control["approved"]
                    .get(chapter_id)
                    .and_then(|_| control["modelCode"].as_str())
                    .map(str::to_owned),
                h.pending().len(),
            )
        };
    let truncated = text.chars().count() > TEXT_LIMIT;
    let body: String = if truncated {
        text.chars().take(TEXT_LIMIT).collect()
    } else {
        text.to_owned()
    };
    Ok(
        json!({"bookId":book_id,"chapterId":chapter_id,"narrativeOrder":position as i64 + 1,"sourceRevision":fingerprint,"historyRevision":history_revision,"modelCode":selected_model,"pendingChapters":pending_chapters,
        "title":chapter["title"],"text":body,"truncated":truncated,"previousOneLine":previous,
        "characters":characters,"entities":entities,"openThreads":threads,"facts":facts,
        "mode":if reference { "reference" } else { "author" }}),
    )
}

/// 参考书章节卡带给模型的人名与线索上限。
const REFERENCE_NAME_LIMIT: usize = 120;
const REFERENCE_THREAD_LIMIT: usize = 40;

pub async fn prepare_batch_in(
    db: &mut SqliteConnection,
    run_id: &str,
    limit: usize,
    quiet_ms: i64,
    lane: Option<Lane>,
) -> Result<Batch, String> {
    use crate::story_state as canon;
    let mut batch = Batch::default();
    for group in claim_in(db, run_id, limit, quiet_ms, lane).await? {
        let book_id = group.book_id.clone();
        if index_paused(db, &book_id).await? {
            release_group(db, run_id, &group).await?;
            batch.skipped_paused += 1;
            continue;
        }
        if group.kind != "chapter" {
            complete(db, run_id, &group, None).await?;
            batch.books.insert(book_id);
            continue;
        }
        let chapter_id = group.chapter_id.clone().unwrap_or_default();
        let Some(fingerprint) = chapter_fingerprint(db, &book_id, &chapter_id).await? else {
            canon::remove_card(db, &book_id, &chapter_id).await?;
            complete(db, run_id, &group, None).await?;
            batch.books.insert(book_id);
            continue;
        };
        let chapter = match crate::reference_books::project_of(&book_id) {
            Some(pid) => crate::reference_books::chapter(db, pid, &chapter_id).await?,
            None => crate::writing_records::chapter(db, &book_id, &chapter_id).await?,
        };
        let text = chapter["textContent"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned();
        if text.is_empty() {
            canon::remove_card(db, &book_id, &chapter_id).await?;
            complete(db, run_id, &group, Some(&fingerprint)).await?;
            batch.books.insert(book_id);
            continue;
        }
        let provenance = if canon::confirmed_samples(db, &book_id)
            .await?
            .iter()
            .any(|c| c == &chapter_id)
        {
            "author_confirmed"
        } else {
            "unknown"
        };
        index_chunks(db, &book_id, &chapter_id, &fingerprint, &text, provenance).await?;
        let marks = canon::ai_span_marks(db, &book_id, &chapter_id).await?;
        mark_ai_chunks(db, &book_id, &chapter_id, &marks).await?;
        let job = build_job(db, &book_id, &chapter_id, &chapter, &fingerprint, &text).await?;
        if lane == Some(Lane::Author) {
            let key = control_key(&book_id);
            let mut control = crate::writing_records::get(db, canon::AUTHOR_NS, &key)
                .await?
                .unwrap_or_else(|| json!({}));
            let existing = canon::get_card(db, &book_id, &chapter_id).await?;
            if existing.as_ref().is_some_and(|c| {
                c["status"] == "active"
                    && c["sourceRevision"] == fingerprint
                    && c["historyRevision"] == job["historyRevision"]
            }) {
                complete(db, run_id, &group, Some(&fingerprint)).await?;
                continue;
            }
            if let Some(expected) = control["approved"].get(&chapter_id) {
                if expected != &job["historyRevision"] {
                    control["paused"] = json!(true);
                    crate::writing_records::put(db, canon::AUTHOR_NS, &key, &control).await?;
                    release_group(db, run_id, &group).await?;
                    batch.skipped_paused += 1;
                    continue;
                }
            } else if job["pendingChapters"].as_u64().unwrap_or(0) > 1 {
                if control["approved"]
                    .as_object()
                    .is_none_or(|ids| ids.is_empty())
                {
                    control["paused"] = json!(true);
                    control["needsConfirmation"] = json!(true);
                    crate::writing_records::put(db, canon::AUTHOR_NS, &key, &control).await?;
                    release_group(db, run_id, &group).await?;
                    batch.skipped_paused += 1;
                } else {
                    // 仍有作者同意的章节在排队，未授权的事件只做本地索引；章节仍会列入补记预览。
                    complete(db, run_id, &group, Some(&fingerprint)).await?;
                }
                batch.books.insert(book_id);
                continue;
            } else if existing.is_some_and(|c| {
                c["sourceRevision"] == fingerprint && c["historyRevision"] != job["historyRevision"]
            }) {
                complete(db, run_id, &group, Some(&fingerprint)).await?;
                batch.books.insert(book_id);
                continue;
            }
        }
        batch.jobs.push(job);
        batch.pending.push((group, Some(fingerprint)));
        batch.books.insert(book_id);
    }
    Ok(batch)
}

async fn bump_failure(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    message: &str,
) -> Result<i64, String> {
    use crate::story_state as canon;
    let key = canon::index_key(book_id);
    let mut progress = crate::writing_records::get(db, canon::CANON_NS, &key)
        .await?
        .unwrap_or_else(|| json!({"id":key,"bookId":book_id}));
    if !progress["failed"].is_object() {
        progress["failed"] = json!({});
    }
    let count = progress["failed"][chapter_id]["count"]
        .as_i64()
        .unwrap_or(0)
        + 1;
    progress["failed"][chapter_id] = json!({"count":count,"message":message,"at":now()});
    crate::writing_records::put(db, canon::CANON_NS, &key, &progress).await?;
    Ok(count)
}

/// `interrupted`：作者暂停或取消、应用退出时停掉了进程。没写成的章节直接释放，不算失败次数。
pub async fn finish_batch_with(
    db: &mut SqliteConnection,
    run_id: &str,
    batch: &Batch,
    saved: &std::collections::BTreeSet<(String, String)>,
    failures: &[Value],
    interrupted: bool,
) -> Result<Value, String> {
    use crate::story_state as canon;
    let mut completed = 0;
    let mut retried = 0;
    let mut given_up = 0;
    for (group, fingerprint) in &batch.pending {
        let chapter_id = group.chapter_id.clone().unwrap_or_default();
        if saved.contains(&(group.book_id.clone(), chapter_id.clone())) {
            if complete(db, run_id, group, fingerprint.as_deref()).await? {
                let ctl = control_key(&group.book_id);
                if let Some(mut control) =
                    crate::writing_records::get(db, canon::AUTHOR_NS, &ctl).await?
                {
                    if let Some(approved) = control["approved"].as_object_mut() {
                        if approved
                            .remove(group.chapter_id.as_deref().unwrap_or(""))
                            .is_some()
                        {
                            crate::writing_records::put(db, canon::AUTHOR_NS, &ctl, &control)
                                .await?;
                        }
                    }
                }
                completed += 1;
            } else {
                retried += 1;
            }
            continue;
        }
        if interrupted || index_paused(db, &group.book_id).await? {
            release_group(db, run_id, group).await?;
            retried += 1;
            continue;
        }
        let message = failures
            .iter()
            .find(|f| f["bookId"] == group.book_id && f["chapterId"] == chapter_id)
            .and_then(|f| f["message"].as_str())
            .unwrap_or("索引未完成");
        let count = bump_failure(db, &group.book_id, &chapter_id, message).await?;
        if count >= MAX_FAILURES {
            mark(db, run_id, group, Some(now())).await?;
            given_up += 1;
        } else {
            release_group(db, run_id, group).await?;
            retried += 1;
        }
    }
    let mut folded = Vec::new();
    for book_id in &batch.books {
        // 人物状态折叠服务于作者续写的连续性检查；参考书只做写法分析，每轮全量折叠上千张卡不划算
        if crate::reference_books::project_of(book_id).is_none() {
            canon::fold_states(db, book_id).await?;
        }
        canon::update_index_progress(db, book_id, &json!({"lastRunAt":now(),"lastRunId":run_id}))
            .await?;
        folded.push(json!(book_id));
    }
    prune(db, RETENTION_MS).await?;
    Ok(json!({"completed":completed,"retried":retried,"givenUp":given_up,"books":folded}))
}
