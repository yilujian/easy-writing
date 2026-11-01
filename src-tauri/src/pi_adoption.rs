//! 作者确认的章节采用：与 Pi 实例取消无关，所有正式数据在同一 SQLite 事务提交。
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::{path::Path, sync::OnceLock};

const DRAFTS: &str = "ew-agent-pi/drafts";
const RECEIPTS: &str = "ew-agent-pi/adoptions";
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ticket {
    pub draft_id: String,
    pub revision: u64,
    pub fingerprint: String,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn key(id: &str) -> String {
    json!(id).to_string()
}
fn number(v: &Value, field: &str) -> Result<u64, String> {
    match v.get(field) {
        None => Ok(0),
        Some(n) => n
            .as_u64()
            .filter(|n| *n <= MAX_SAFE)
            .ok_or_else(|| format!("草稿 {field} 无效")),
    }
}
fn text<'a>(v: &'a Value, field: &str) -> Result<&'a str, String> {
    v[field]
        .as_str()
        .ok_or_else(|| format!("草稿 {field} 无效"))
}
fn applied(v: &Value) -> bool {
    v["appliedAt"].as_i64().is_some_and(|at| at > 0)
}
pub(super) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn validate_content(content: &str) -> Result<(), String> {
    if content.trim_matches(whitespace).is_empty() || content.encode_utf16().count() > 150_000 {
        return Err("草稿正文不能为空或超过 15 万字".into());
    }
    Ok(())
}
fn validate_chapter(draft: &Value) -> Result<(), String> {
    if draft["kind"] != "chapter" && draft["kind"] != "new_chapter" {
        return Err("此入口只处理章节正式采用".into());
    }
    for field in ["id", "bookId", "title"] {
        if text(draft, field)?.trim_matches(whitespace).is_empty() {
            return Err(format!("草稿缺少 {field}"));
        }
    }
    validate_content(text(draft, "content")?)?;
    number(draft, "revision")?;
    if let Some(plan) = draft.get("plan") {
        let summary = plan["summary"].as_str().unwrap_or("");
        if summary.trim_matches(whitespace).is_empty() || summary.encode_utf16().count() > 2000 {
            return Err("章纲为空或超过两千字".into());
        }
    }
    if draft["kind"] == "new_chapter" {
        let volume = text(draft, "volumeId")?.parse::<i64>().map_err(err)?;
        if volume == 0
            || volume.unsigned_abs() > MAX_SAFE
            || volume.to_string() != text(draft, "volumeId")?
            || text(draft, "volumeTitle")?
                .trim_matches(whitespace)
                .is_empty()
            || draft["placement"] != "append"
            || (!applied(draft) && draft.get("chapterId").is_some())
        {
            return Err("新章节归属无效，请确认已有卷，位置仅支持追加卷末".into());
        }
        return Ok(());
    }
    let id = draft["chapterId"].as_i64().ok_or("章节编号无效")?;
    if id == 0 || id.unsigned_abs() > MAX_SAFE {
        return Err("章节编号无效".into());
    }
    number(draft, "baseVersion")?;
    text(draft, "baseText")?;
    text(draft, "baseTitle")?;
    Ok(())
}
fn fingerprint(draft: &Value) -> Result<String, String> {
    if matches!(
        draft["kind"].as_str(),
        Some("skill" | "short_story" | "text")
    ) {
        validate_content(text(draft, "content")?)?;
        let snapshot = json!({"id":draft["id"],"kind":draft["kind"],"revision":number(draft,"revision")?,
            "title":draft["title"],"content":draft["content"]});
        return Ok(format!(
            "{:x}",
            Sha256::digest(snapshot.to_string().as_bytes())
        ));
    }
    if draft["kind"] == "entity" || draft["kind"] == "outline" {
        validate_content(text(draft, "content")?)?;
        return Ok(format!(
            "{:x}",
            Sha256::digest(super::entities::snapshot(draft)?.to_string().as_bytes())
        ));
    }
    validate_chapter(draft)?;
    // 只包含被确认的意图与读取基线；采用标记不改变原操作身份。
    let mut snapshot = if draft["kind"] == "new_chapter" {
        // 创建后的 chapterId 是结果，不能改变原操作身份。
        json!({"id":draft["id"],"kind":draft["kind"],"bookId":draft["bookId"],
            "revision":number(draft,"revision")?,"title":draft["title"],"content":draft["content"],
            "volumeId":draft["volumeId"],"volumeTitle":draft["volumeTitle"],"placement":draft["placement"]})
    } else {
        json!({
            "id":draft["id"],"kind":draft["kind"],"bookId":draft["bookId"],"chapterId":draft["chapterId"],
            "revision":number(draft,"revision")?,"title":draft["title"],"content":draft["content"],
            "baseVersion":draft["baseVersion"],"baseText":draft["baseText"],"baseTitle":draft["baseTitle"],
            "baseVolumeId":draft.get("baseVolumeId").unwrap_or(&Value::Null)
        })
    };
    for key in ["selection", "appendAnchor", "plan"] {
        if let Some(value) = draft.get(key) {
            snapshot[key] = value.clone();
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(snapshot.to_string().as_bytes())
    ))
}
fn operation(ticket: &Ticket) -> Result<String, String> {
    if ticket.draft_id.is_empty()
        || ticket.revision > MAX_SAFE
        || ticket.fingerprint.len() != 64
        || !ticket.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("采用确认无效，请重新预览确认".into());
    }
    Ok(format!("chapter:{}:{}", ticket.draft_id, ticket.revision))
}
async fn load(db: &mut SqliteConnection, id: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(DRAFTS)
            .bind(key(id))
            .fetch_optional(db)
            .await
            .map_err(err)?;
    serde_json::from_str(&raw.ok_or("草稿不存在")?).map_err(err)
}
async fn receipt(db: &mut SqliteConnection, ticket: &Ticket) -> Result<Option<Value>, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(RECEIPTS)
            .bind(key(&operation(ticket)?))
            .fetch_optional(db)
            .await
            .map_err(err)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let saved: Value = serde_json::from_str(&raw).map_err(err)?;
    if saved["fingerprint"] != ticket.fingerprint {
        return Err("同一采用编号对应不同内容，未重复保存".into());
    }
    Ok(Some(saved["draft"].clone()))
}
pub async fn prepare(root: &Path, id: &str, expected_revision: u64) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let draft = load(&mut db, id).await?;
    let revision = number(&draft, "revision")?;
    if revision != expected_revision {
        return Err("草稿已更新，请重新预览确认".into());
    }
    let ticket = Ticket {
        draft_id: id.into(),
        revision,
        fingerprint: fingerprint(&draft)?,
    };
    Ok(json!({"draft":draft,"ticket":ticket}))
}
#[cfg(all(test, feature = "local-tests"))]
pub async fn edit(
    root: &Path,
    id: &str,
    expected_revision: u64,
    content: &str,
) -> Result<Value, String> {
    edit_from(root, id, expected_revision, content, true).await
}
pub async fn edit_from(
    root: &Path,
    id: &str,
    expected_revision: u64,
    content: &str,
    human: bool,
) -> Result<Value, String> {
    validate_content(content)?;
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let result = async {
        let mut draft = load(&mut tx, id).await?;
        // 采用与失焦保存交错时，相同内容只是回读；不能报错或重写采用状态。
        if draft["content"] == content {
            return Ok(draft);
        }
        if applied(&draft) {
            return Err("草稿已采用，不能再修改".to_string());
        }
        let revision = number(&draft, "revision")?;
        // 同内容重试可回读上次已提交的编辑，不产生多余修订。
        if revision != expected_revision || revision == MAX_SAFE {
            return Err("草稿已更新，未覆盖其他编辑，请重新读取".into());
        }
        crate::prose_examples::before_edit(&mut tx, &draft, human).await?;
        draft["content"] = json!(content);
        if !human {
            draft.as_object_mut().unwrap().remove("modelTextHash");
        }
        draft["revision"] = json!(revision + 1);
        if draft["kind"] == "entity" {
            super::entities::fields(&draft)?;
        }
        let result = sqlx::query("UPDATE desktop_records SET value=? WHERE namespace=? AND key=?")
            .bind(draft.to_string())
            .bind(DRAFTS)
            .bind(key(id))
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        if result.rows_affected() != 1 {
            return Err("草稿已不存在".into());
        }
        Ok(draft)
    }
    .await;
    match result {
        Ok(draft) => {
            tx.commit().await.map_err(err)?;
            Ok(draft)
        }
        Err(error) => {
            tx.rollback().await.map_err(err)?;
            Err(error)
        }
    }
}
/// 作者在前情核对卡上决定"这份候选不要了 / 改稿留着"：记一笔搁置时间。草稿照常留在右栏、仍可采用，
/// 只是写新章时不再被当作"上一章"。已采用的不能搁置。
pub async fn dismiss(root: &Path, id: &str) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let result = async {
        let mut draft = load(&mut tx, id).await?;
        if applied(&draft) {
            return Err("草稿已采用，不能搁置".to_string());
        }
        if draft["dismissedAt"].as_i64().is_some_and(|at| at > 0) {
            return Ok(draft);
        }
        draft["dismissedAt"] = json!(chrono::Utc::now().timestamp_millis());
        let result = sqlx::query("UPDATE desktop_records SET value=? WHERE namespace=? AND key=?")
            .bind(draft.to_string())
            .bind(DRAFTS)
            .bind(key(id))
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        if result.rows_affected() != 1 {
            return Err("草稿已不存在".into());
        }
        Ok(draft)
    }
    .await;
    match result {
        Ok(draft) => {
            tx.commit().await.map_err(err)?;
            Ok(draft)
        }
        Err(error) => {
            tx.rollback().await.map_err(err)?;
            Err(error)
        }
    }
}
// 对照前端 countWords/countTextWords 与 plainTextToTiptapJson；兼容性由双端样例验证。
fn render(content: &str) -> (Value, i64, i64) {
    static LETTERS: OnceLock<Regex> = OnceLock::new();
    let words = content
        .chars()
        .filter(|c| !whitespace(*c))
        .map(char::len_utf16)
        .sum::<usize>() as i64;
    let letters =
        LETTERS.get_or_init(|| Regex::new(r"[\p{L}\p{N}]").expect("valid Unicode categories"));
    let text_words = letters
        .find_iter(content)
        .map(|m| m.as_str().encode_utf16().count())
        .sum::<usize>() as i64;
    let normalized = content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\u{a0}', " ");
    let mut rows: Vec<Value> = normalized
        .split('\n')
        .map(|line| line.trim_matches([' ', '\t', '\u{3000}']))
        .filter(|line| !line.trim_matches(whitespace).is_empty())
        .map(|line| json!({"type":"paragraph","content":[{"type":"text","text":line}]}))
        .collect();
    if rows.is_empty() {
        rows.push(json!({"type":"paragraph"}));
    }
    (json!({"type":"doc","content":rows}), words, text_words)
}
// 在同一写事务中分配本地负数编号、计算卷末顺序并创建目录；正文与回执仍走下面的共用提交。
/// 候选里的章纲：目录摘要用 summary，拍子存 planMeta.beats；没有就留空。
fn plan_fields(draft: &Value) -> (String, Value) {
    let plan = &draft["plan"];
    let summary = plan["summary"].as_str().unwrap_or("").trim().to_owned();
    let beats: Vec<&str> = plan["beats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|b| !b.trim().is_empty())
        .collect();
    let meta = if beats.is_empty() {
        Value::Null
    } else {
        json!({"beats":beats,"source":"agent"})
    };
    (summary, meta)
}
async fn insert_new_catalog(
    db: &mut SqliteConnection,
    draft: &Value,
) -> Result<(i64, Value, String), String> {
    let bid = text(draft, "bookId")?;
    let vid = text(draft, "volumeId")?;
    let raw: Option<String> = sqlx::query_scalar("SELECT payload FROM local_volumes WHERE CAST(id AS TEXT)=? AND bookId=? AND deletedAt IS NULL")
        .bind(vid).bind(bid).fetch_optional(&mut *db).await.map_err(err)?;
    let volume: Value =
        serde_json::from_str(&raw.ok_or("目标卷不存在、不属于当前作品或已删除，未创建章节")?)
            .map_err(err)?;
    if !volume["deletedAt"].is_null() || volume["title"] != draft["volumeTitle"] {
        return Err("目标卷已删除或改名，请重新读取目录并确认归属，未创建章节".into());
    }
    let max_sort: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sortNo),0) FROM local_chapters WHERE bookId=? AND volumeId=? AND deletedAt IS NULL")
        .bind(bid).bind(vid).fetch_one(&mut *db).await.map_err(err)?;
    let sort = max_sort
        .max(0)
        .checked_add(1)
        .filter(|v| (*v as u64) <= MAX_SAFE)
        .ok_or("章节顺序超出范围")?;
    // 遵守平台的 JS 安全负数编号约定；使用 UUID 随机位避免与前端的毫秒计数器竞争。
    let mut cid = 0;
    for _ in 0..8 {
        let proposed = -((uuid::Uuid::new_v4().as_u128() % 4_503_599_627_370_495
            + 4_503_599_627_370_496) as i64);
        let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_chapters WHERE id=? UNION ALL SELECT 1 FROM chapter_contents WHERE chapterId=? UNION ALL SELECT 1 FROM chapter_versions WHERE chapterId=?)")
            .bind(proposed).bind(proposed).bind(proposed).fetch_one(&mut *db).await.map_err(err)?;
        if exists == 0 {
            cid = proposed;
            break;
        }
    }
    if cid == 0 {
        return Err("无法分配新章节编号，请重试".into());
    }
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    // 字段和默认值与平台 normalizeLocalChapter 一致；不调用会独立提交的前端创建入口。
    // 聊天模型拟的章纲随新章一起进目录（章纲默认采用，作者可改）。
    let (summary, plan_meta) = plan_fields(draft);
    let catalog = json!({"id":cid,"bookId":bid,"volumeId":vid,"title":draft["title"],"summary":summary,
        "wordCount":0,"textWordCount":0,"sortNo":sort,"status":0,"isPaid":0,"type":"chapter",
        "planMeta":plan_meta,"workflowStatus":null,"createTime":iso,"updateTime":iso,"deletedAt":null});
    sqlx::query("INSERT INTO local_chapters(id,bookId,volumeId,payload,deletedAt,sortNo) VALUES(?,?,?,?,NULL,?)")
        .bind(cid).bind(bid).bind(vid).bind(catalog.to_string()).bind(sort).execute(&mut *db).await.map_err(err)?;
    Ok((cid, catalog, vid.into()))
}
pub(super) async fn check_sources(db: &mut SqliteConnection, draft: &Value) -> Result<(), String> {
    if let Some(anchor) = draft["proseSource"]["historyAnchor"].as_object() {
        let h = crate::story_history::History::catalog(db, text(draft, "bookId")?).await?;
        let args = if draft["kind"] == "new_chapter" {
            json!({"volumeId":draft["volumeId"]})
        } else {
            json!({"chapterId":draft["chapterId"].to_string()})
        };
        let end = h.boundary(&args)?;
        if let Some(saved) = anchor.get("corrections") {
            let current =
                crate::story_memory::corrections(db, text(draft, "bookId")?, &h, end).await?;
            if saved != &crate::book_materials::version(&json!(current)) {
                return Err("作者更正已经改变，请核对后重新生成".into());
            }
        }
        if end == 0
            || anchor.get("id") != Some(&json!(h.chapters[end - 1].id))
            || anchor.get("revision") != Some(&json!(h.chapters[end - 1].stamp))
        {
            return Err("作为依据的前文已改变，请核对后重新生成".into());
        }
    }
    if let Some(anchor) = draft.get("appendAnchor") {
        let last:Option<String>=sqlx::query_scalar("SELECT CAST(id AS TEXT) FROM local_chapters WHERE bookId=? AND volumeId=? AND deletedAt IS NULL ORDER BY sortNo DESC,id DESC LIMIT 1")
            .bind(text(draft,"bookId")?).bind(text(draft,"volumeId")?).fetch_optional(&mut *db).await.map_err(err)?;
        if *anchor != json!(last) {
            return Err("目标卷最后一章已变化，不能把旧续稿接在新的位置".into());
        }
    }
    for source in draft["proseSource"]["chapters"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let bid = text(draft, "bookId")?;
        let cid = text(source, "chapterId")?;
        let owner = crate::writing_records::chapter_owner(db, bid, cid).await?;
        let version:Option<i64>=sqlx::query_scalar("SELECT COALESCE(json_extract(d.payload,'$.localVersion'),0) FROM local_chapters c LEFT JOIN chapter_contents d ON c.id=d.chapterId AND c.bookId=d.bookId AND d.userId=? WHERE c.id=? AND c.bookId=? AND c.deletedAt IS NULL")
            .bind(owner).bind(cid).bind(bid).fetch_optional(&mut *db).await.map_err(err)?;
        if version.is_none() || version != source["version"].as_i64() {
            return Err("作为依据的前文已改变，请核对后重新生成".into());
        }
    }
    Ok(())
}
async fn apply_in(
    db: &mut SqliteConnection,
    ticket: &Ticket,
    skills: &super::skills::Dirs,
) -> Result<Value, String> {
    if let Some(saved) = receipt(db, ticket).await? {
        return Ok(saved);
    }
    let mut draft = load(db, &ticket.draft_id).await?;
    if number(&draft, "revision")? != ticket.revision || fingerprint(&draft)? != ticket.fingerprint
    {
        return Err("草稿已更新，请重新预览确认；未保存未确认的内容".into());
    }
    // 兼容旧已采用稿：只返回历史状态，不伪造新事务回执，更不重写正文。
    if applied(&draft) {
        return Ok(draft);
    }
    if draft["kind"] == "entity" || draft["kind"] == "outline" {
        super::entities::apply(db, &mut draft).await?;
        return finish(db, ticket, draft).await;
    }
    // 技能候选：写进作者技能目录（文件在事务外，回执在事务内；重试同一凭据只回读回执）
    if draft["kind"] == "skill" {
        let saved = super::skills::adopt(skills, &draft)?;
        draft["appliedSkillId"] = saved["id"].clone();
        draft["appliedSkillName"] = saved["name"].clone();
        return finish(db, ticket, draft).await;
    }
    check_sources(db, &draft).await?;
    if draft["kind"] == "text" {
        return Err("先指定保存到的作品和章节".into());
    }
    let short_story = draft["kind"] == "short_story";
    if short_story {
        let mut creation = json!({"entity":"book","targetId":null,"content":json!({"title":text(&draft,"title")?}).to_string()});
        super::catalog::apply(db, &mut creation).await?;
        draft["appliedBookId"] = creation["appliedBookId"].clone();
        let (chapter_id, title): (i64, String) = sqlx::query_as("SELECT id,json_extract(payload,'$.title') FROM local_chapters WHERE bookId=? AND deletedAt IS NULL")
            .bind(text(&creation,"appliedBookId")?).fetch_one(&mut *db).await.map_err(err)?;
        draft["chapterId"] = json!(chapter_id);
        draft["baseText"] = json!("");
        draft["baseTitle"] = json!(title);
        draft["bookId"] = creation["appliedBookId"].clone();
    }
    let bid = text(&draft, "bookId")?.to_owned();
    let is_new = draft["kind"] == "new_chapter";
    let book: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL",
    )
    .bind(&bid)
    .fetch_optional(&mut *db)
    .await
    .map_err(err)?;
    let book: Value =
        serde_json::from_str(&book.ok_or("当前作品不存在或已删除，未保存")?).map_err(err)?;
    if !book["deletedAt"].is_null() {
        return Err("当前作品已删除，未保存".into());
    }
    let (cid, catalog, volume_id) = if is_new {
        insert_new_catalog(db, &draft).await?
    } else {
        let cid = draft["chapterId"].as_i64().ok_or("章节编号无效")?;
        let row = sqlx::query("SELECT c.payload,c.volumeId,v.payload AS volume FROM local_chapters c JOIN local_volumes v ON CAST(v.id AS TEXT)=c.volumeId AND v.bookId=c.bookId WHERE c.id=? AND c.bookId=? AND c.deletedAt IS NULL AND v.deletedAt IS NULL")
        .bind(cid).bind(&bid).fetch_optional(&mut *db).await.map_err(err)?.ok_or("目标章节或分卷不存在、已删除或已移出作品，未保存")?;
        let catalog: Value = serde_json::from_str(row.get("payload")).map_err(err)?;
        let volume: Value = serde_json::from_str(row.get("volume")).map_err(err)?;
        let volume_id: String = row.get("volumeId");
        if !catalog["deletedAt"].is_null() || !volume["deletedAt"].is_null() {
            return Err("目标章节或分卷已删除，未保存".into());
        }
        if draft
            .get("baseVolumeId")
            .is_some_and(|v| v != &Value::String(volume_id.clone()))
        {
            return Err("章节所属分卷已改变，请重新确认目标".into());
        }
        (cid, catalog, volume_id)
    };
    let owner = crate::writing_records::chapter_owner(db, &bid, &cid.to_string()).await?;
    let storage_key = format!("{owner}:{bid}:{cid}");
    let row = sqlx::query("SELECT payload,lastBackedUpAt FROM chapter_contents WHERE storageKey=?")
        .bind(&storage_key)
        .fetch_optional(&mut *db)
        .await
        .map_err(err)?;
    let existed = row.is_some();
    let backup = row
        .as_ref()
        .map(|row| row.get::<i64, _>("lastBackedUpAt"))
        .unwrap_or(0);
    let mut current: Value = match &row {
        Some(row) => serde_json::from_str(row.get::<&str, _>("payload")).map_err(err)?,
        None => json!({"storageKey":storage_key,"userId":owner,"bookId":bid,"chapterId":cid,
            "title":catalog["title"],"textContent":"","contentJson":null,"localVersion":0,"remoteVersion":0,
            "baseRemoteVersion":0,"baseTitle":"","baseTextContent":"","baseContentJson":null,"localOnly":true}),
    };
    let version = number(&current, "localVersion")?;
    if !is_new
        && (version != number(&draft, "baseVersion")?
            || version == MAX_SAFE
            || current["textContent"] != draft["baseText"]
            || catalog["title"] != draft["baseTitle"])
    {
        return Err("正文或章名已被修改，未覆盖作者内容。请重新读取章节并生成草稿。".into());
    }
    let op = operation(ticket)?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if existed {
        let history_id = format!(
            "{owner}:{bid}:{cid}:local:{stamp}:pi:{:x}",
            Sha256::digest(op.as_bytes())
        );
        let history = json!({"id":history_id,"userId":owner,"bookId":bid,"chapterId":cid,"source":"local",
            "title":catalog["title"],"textContent":current["textContent"],"contentJson":current["contentJson"],
            "remoteVersion":current["remoteVersion"],"remark":"Agent采用前快照","createdAt":stamp});
        sqlx::query("INSERT INTO chapter_versions(id,payload,chapterId,createdAt) VALUES(?,?,?,?)")
            .bind(&history_id)
            .bind(history.to_string())
            .bind(cid)
            .bind(stamp)
            .execute(&mut *db)
            .await
            .map_err(err)?;
    }
    let content = text(&draft, "content")?;
    let (final_text, doc, words, text_words) = if let Some(range) = draft.get("selection") {
        let (replaced, doc) = super::prose_range::replace(
            text(&current, "textContent")?,
            &current["contentJson"],
            range,
            content,
        )?;
        let (_, words, text_words) = render(&replaced);
        (replaced, doc, words, text_words)
    } else {
        let (doc, words, text_words) = render(content);
        (content.to_owned(), doc, words, text_words)
    };
    current["storageKey"] = json!(storage_key);
    current["userId"] = json!(owner);
    current["bookId"] = json!(bid);
    current["chapterId"] = json!(cid);
    for (field, value) in [
        ("remoteVersion", json!(0)),
        ("baseRemoteVersion", json!(0)),
        ("baseTitle", json!("")),
        ("baseTextContent", json!("")),
        ("baseContentJson", Value::Null),
    ] {
        if current.get(field).is_none() {
            current[field] = value;
        }
    }
    current["title"] = draft["title"].clone();
    current["textContent"] = json!(final_text);
    current["contentJson"] = doc;
    current["localVersion"] = json!(version + 1);
    current["dirty"] = json!(true);
    current["conflict"] = json!(false);
    current["workflowPreview"] = json!(false);
    current["localOnly"] = json!(true);
    current["updatedAt"] = json!(stamp);
    let backup = backup.max(current["lastBackedUpAt"].as_i64().unwrap_or(0));
    current["lastBackedUpAt"] = json!(backup);
    let changed = if existed {
        sqlx::query("UPDATE chapter_contents SET payload=?,dirty=1,conflict=0,updatedAt=?,lastBackedUpAt=?,wordCount=?,textWordCount=? WHERE storageKey=? AND COALESCE(json_extract(payload,'$.localVersion'),0)=?")
            .bind(current.to_string()).bind(stamp).bind(backup).bind(words).bind(text_words).bind(&storage_key).bind(version as i64)
            .execute(&mut *db).await.map_err(err)?.rows_affected()
    } else {
        sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,dirty,conflict,updatedAt,lastBackedUpAt,wordCount,textWordCount) VALUES(?,?,?,?,?,1,0,?,?,?,?)")
            .bind(&storage_key).bind(&owner).bind(&bid).bind(cid).bind(current.to_string()).bind(stamp).bind(backup).bind(words).bind(text_words)
            .execute(&mut *db).await.map_err(err)?.rows_affected()
    };
    if changed != 1 {
        return Err("正文版本冲突，未保存".into());
    }
    let changed = sqlx::query("UPDATE local_chapters SET payload=json_set(payload,'$.title',?,'$.wordCount',?,'$.textWordCount',?,'$.updateTime',?) WHERE id=? AND bookId=? AND volumeId=? AND deletedAt IS NULL AND json_extract(payload,'$.title')=?")
        .bind(text(&draft,"title")?).bind(words).bind(text_words).bind(&iso).bind(cid).bind(&bid).bind(&volume_id)
        .bind(text(&catalog,"title")?).execute(&mut *db).await.map_err(err)?.rows_affected();
    if changed != 1 {
        return Err("章名或章节归属已变化，未保存".into());
    }
    if !is_new {
        // 原章没有章纲而候选带了：补进目录；作者已写的章纲不动。
        let (summary, plan_meta) = plan_fields(&draft);
        if !summary.is_empty()
            && catalog["summary"]
                .as_str()
                .is_none_or(|s| s.trim_matches(whitespace).is_empty())
        {
            sqlx::query("UPDATE local_chapters SET payload=json_set(payload,'$.summary',?,'$.planMeta',CASE WHEN json_type(payload,'$.planMeta') IS NULL OR json_type(payload,'$.planMeta')='null' THEN json(?) ELSE json_extract(payload,'$.planMeta') END) WHERE id=? AND bookId=?")
                .bind(&summary).bind(plan_meta.to_string()).bind(cid).bind(&bid)
                .execute(&mut *db).await.map_err(err)?;
        }
    }
    let changed = sqlx::query(include_str!("../../src/storage/sql/update-book-stats.sql"))
        .bind(&bid)
        .bind(&iso)
        .execute(&mut *db)
        .await
        .map_err(err)?
        .rows_affected();
    if changed != 1 {
        return Err("作品已删除，未保存".into());
    }
    sqlx::query("DELETE FROM sync_settings WHERE key LIKE 'bookWordCounts:%'")
        .execute(&mut *db)
        .await
        .map_err(err)?;
    if is_new {
        draft["chapterId"] = json!(cid);
    }
    crate::prose_examples::adopted(db, &draft, &final_text, version + 1).await?;
    draft["appliedVersion"] = json!(version + 1);
    finish(db, ticket, draft).await
}
async fn finish(
    db: &mut SqliteConnection,
    ticket: &Ticket,
    mut draft: Value,
) -> Result<Value, String> {
    let op = operation(ticket)?;
    draft["appliedAt"] = json!(chrono::Utc::now().timestamp_millis());
    draft["appliedOperationId"] = json!(op);
    super::context::adopted(db, &draft).await?;
    let changed = sqlx::query("UPDATE desktop_records SET value=? WHERE namespace=? AND key=?")
        .bind(draft.to_string())
        .bind(DRAFTS)
        .bind(key(&ticket.draft_id))
        .execute(&mut *db)
        .await
        .map_err(err)?
        .rows_affected();
    if changed != 1 {
        return Err("草稿已不存在，未保存".into());
    }
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?)")
        .bind(RECEIPTS)
        .bind(key(&op))
        .bind(json!({"fingerprint":ticket.fingerprint,"draft":draft}).to_string())
        .execute(&mut *db)
        .await
        .map_err(err)?;
    Ok(draft)
}
pub async fn apply(root: &Path, ticket: &Ticket) -> Result<Value, String> {
    operation(ticket).map_err(|e| format!("PI_ADOPTION_REJECTED: {e}"))?;
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let skills = super::skill_dirs(root);
    match apply_in(&mut tx, ticket, &skills).await {
        Ok(draft) => match tx.commit().await {
            Ok(()) => Ok(draft),
            Err(_) => Err("PI_ADOPTION_UNKNOWN: 保存结果尚未确认，请查询或使用原确认重试".into()),
        },
        Err(error) => match tx.rollback().await {
            Ok(()) => Err(format!("PI_ADOPTION_REJECTED: {error}")),
            Err(_) => Err("PI_ADOPTION_UNKNOWN: 保存结果尚未确认，请查询或使用原确认重试".into()),
        },
    }
}
pub async fn status(root: &Path, ticket: &Ticket) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    match receipt(&mut db, ticket).await? {
        Some(draft) => Ok(json!({"status":"committed","draft":draft})),
        None => Ok(json!({"status":"unknown"})), // 没有回执不能证明另一连接未在执行。
    }
}
#[cfg(all(test, feature = "local-tests"))]
#[path = "pi_entity_tests.rs"]
mod entity_tests;
#[cfg(all(test, feature = "local-tests"))]
#[path = "pi_adoption_tests.rs"]
mod tests;

/// 作者为独立文本选择存入位置。先冻结目标成为待采用章节候选，正式写入仍需原有采用凭据。
pub async fn target_text(root: &Path, args: &Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let mut draft = load(&mut tx, text(args, "id")?).await?;
    if draft["kind"] != "text" || applied(&draft) || draft["revision"] != args["revision"] {
        return Err("独立候选已变化，请重新打开".into());
    }
    let bid = text(args, "bookId")?;
    crate::writing_records::book(&mut tx, bid).await?;
    draft["bookId"] = json!(bid);
    match args["target"].as_str() {
        Some("append") => {
            let vid = text(args, "volumeId")?;
            let title:Option<String>=sqlx::query_scalar("SELECT json_extract(payload,'$.title') FROM local_volumes WHERE id=? AND bookId=? AND deletedAt IS NULL")
                .bind(vid).bind(bid).fetch_optional(&mut *tx).await.map_err(err)?;
            draft["kind"] = json!("new_chapter");
            draft["volumeId"] = json!(vid);
            draft["volumeTitle"] = json!(title.ok_or("所选分卷已不存在")?);
            draft["placement"] = json!("append");
            draft["title"] = json!(text(args, "title")?.trim());
        }
        Some("selection") => {
            let cid = text(args, "chapterId")?;
            let source = crate::writing_records::chapter(&mut tx, bid, cid).await?;
            if args["version"] != source["localVersion"] {
                return Err("选择范围期间正文已变化，请重新选择".into());
            }
            let volume: String = sqlx::query_scalar(
                "SELECT volumeId FROM local_chapters WHERE id=? AND bookId=? AND deletedAt IS NULL",
            )
            .bind(cid)
            .bind(bid)
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?;
            draft["baseVolumeId"] = json!(volume);
            let range = &args["selection"];
            super::prose_range::replace(
                text(&source, "textContent")?,
                &source["contentJson"],
                range,
                text(&draft, "content")?,
            )?;
            draft["kind"] = json!("chapter");
            draft["chapterId"] = source["chapterId"].clone();
            draft["baseText"] = source["textContent"].clone();
            draft["selection"] = range.clone();
            draft["baseTitle"] = source["title"].clone();
            draft["title"] = source["title"].clone();
            draft["baseVersion"] = source["localVersion"].clone();
        }
        _ => return Err("请选择追加新章或替换指定原文".into()),
    }
    validate_chapter(&draft)?;
    draft["revision"] = json!(number(&draft, "revision")? + 1);
    sqlx::query("UPDATE desktop_records SET value=? WHERE namespace=? AND key=?")
        .bind(draft.to_string())
        .bind(DRAFTS)
        .bind(key(text(&draft, "id")?))
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(draft)
}
