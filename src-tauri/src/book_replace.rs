//! 全书替换：比较正文版本、保留原文历史、更新正文和目录统计，在一个事务内提交。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{collections::HashSet, path::Path, sync::OnceLock};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    chapter_id: i64,
    expected_version: i64,
    expected_text: String,
    #[serde(default)]
    expected_json: Value,
    expected_title: String,
    text_content: String,
    content_json: Value,
    count: usize,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    operation_id: String,
    book_id: String,
    query: String,
    replacement: String,
    edits: Vec<Edit>,
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn counts(text: &str) -> (i64, i64) {
    static LETTERS: OnceLock<regex::Regex> = OnceLock::new();
    let whitespace = |c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    let all = text
        .chars()
        .filter(|c| !whitespace(*c))
        .map(char::len_utf16)
        .sum::<usize>() as i64;
    let letters =
        LETTERS.get_or_init(|| regex::Regex::new(r"[\p{L}\p{N}]").expect("valid categories"));
    (
        all,
        letters
            .find_iter(text)
            .map(|m| m.as_str().encode_utf16().count())
            .sum::<usize>() as i64,
    )
}

pub async fn apply_at(root: &Path, batch: &Batch) -> Result<Value, String> {
    if uuid::Uuid::parse_str(&batch.operation_id).is_err()
        || batch.query.is_empty()
        || batch.query == batch.replacement
        || batch.edits.is_empty()
    {
        return Err("全书替换请求无效".into());
    }
    let ids: HashSet<_> = batch.edits.iter().map(|edit| edit.chapter_id).collect();
    if ids.len() != batch.edits.len()
        || batch.edits.iter().any(|e| {
            e.chapter_id == 0
                || e.expected_version < 1
                || e.count == 0
                || e.content_json["type"] != "doc"
        })
    {
        return Err("替换章节或正文结构无效".into());
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(batch).map_err(err)?)
    );
    let key = json!(batch.operation_id).to_string();
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let receipt: Option<String> = sqlx::query_scalar(
        "SELECT value FROM desktop_records WHERE namespace='ew-book-replace/receipts' AND key=?",
    )
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(err)?;
    if let Some(raw) = receipt {
        let saved: Value = serde_json::from_str(&raw).map_err(err)?;
        if saved["fingerprint"] != fingerprint {
            return Err("替换确认已变化，请重新搜索".into());
        }
        return Ok(saved["result"].clone());
    }
    let stamp = chrono::Utc::now().timestamp_millis();
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut total = 0;
    for edit in &batch.edits {
        let row = sqlx::query("SELECT d.storageKey,d.payload,c.payload AS catalog FROM chapter_contents d JOIN local_chapters c ON c.id=d.chapterId AND c.bookId=d.bookId JOIN local_books b ON CAST(b.id AS TEXT)=c.bookId JOIN local_volumes v ON CAST(v.id AS TEXT)=c.volumeId AND v.bookId=c.bookId WHERE d.userId='guest' AND d.bookId=? AND d.chapterId=? AND c.deletedAt IS NULL AND b.deletedAt IS NULL AND v.deletedAt IS NULL")
            .bind(&batch.book_id).bind(edit.chapter_id).fetch_optional(&mut *tx).await.map_err(err)?
            .ok_or("作品或章节已删除，请重新搜索；本次未写入")?;
        let storage_key: String = row.try_get("storageKey").map_err(err)?;
        let mut current: Value =
            serde_json::from_str(row.try_get::<&str, _>("payload").map_err(err)?).map_err(err)?;
        let catalog: Value =
            serde_json::from_str(row.try_get::<&str, _>("catalog").map_err(err)?).map_err(err)?;
        if current["localVersion"].as_i64() != Some(edit.expected_version)
            || current["textContent"] != edit.expected_text
            || current["contentJson"] != edit.expected_json
            || current["title"] != edit.expected_title
        {
            return Err("章节已被其他操作更新，请重新搜索后再替换；本次未写入".into());
        }
        if current["conflict"] == true
            || current["workflowPreview"] == true
            || catalog["workflowStatus"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            return Err("匹配章节处于生成、待确认或冲突状态；本次未写入".into());
        }
        let history_id = format!("{storage_key}:local:replace:{}", batch.operation_id);
        let history = json!({"id":history_id,"userId":"guest","bookId":batch.book_id,"chapterId":edit.chapter_id,"source":"local",
            "title":current["title"],"textContent":current["textContent"],"contentJson":current["contentJson"],"remoteVersion":current["remoteVersion"],"remark":"全书替换前","createdAt":stamp});
        sqlx::query("INSERT INTO chapter_versions(id,payload,chapterId,createdAt) VALUES(?,?,?,?)")
            .bind(&history_id)
            .bind(history.to_string())
            .bind(edit.chapter_id)
            .bind(stamp)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        current["textContent"] = json!(edit.text_content);
        current["contentJson"] = edit.content_json.clone();
        current["localVersion"] = json!(edit.expected_version + 1);
        current["updatedAt"] = json!(stamp);
        current["dirty"] = json!(true);
        let (words, text_words) = counts(&edit.text_content);
        sqlx::query("UPDATE chapter_contents SET payload=?,dirty=1,updatedAt=?,wordCount=?,textWordCount=? WHERE storageKey=?")
            .bind(current.to_string()).bind(stamp).bind(words).bind(text_words).bind(&storage_key).execute(&mut *tx).await.map_err(err)?;
        sqlx::query("UPDATE local_chapters SET payload=json_set(payload,'$.wordCount',?,'$.textWordCount',?,'$.updateTime',?) WHERE id=? AND bookId=?")
            .bind(words).bind(text_words).bind(&iso).bind(edit.chapter_id).bind(&batch.book_id).execute(&mut *tx).await.map_err(err)?;
        total += edit.count;
    }
    sqlx::query(include_str!("../../src/storage/sql/update-book-stats.sql"))
        .bind(&batch.book_id)
        .bind(&iso)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    let result = json!({"chapterIds":batch.edits.iter().map(|e| e.chapter_id).collect::<Vec<_>>(),"count":total});
    sqlx::query(
        "INSERT INTO desktop_records(namespace,key,value) VALUES('ew-book-replace/receipts',?,?)",
    )
    .bind(key)
    .bind(json!({"fingerprint":fingerprint,"result":result,"createdAt":stamp}).to_string())
    .execute(&mut *tx)
    .await
    .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(result)
}

#[tauri::command]
pub async fn replace_book_chapters(
    window: crate::DesktopWebviewWindow,
    app: crate::DesktopAppHandle,
    batch: Batch,
) -> Result<Value, String> {
    if window.label() != crate::MAIN_WINDOW_LABEL
        || !window
            .url()
            .map(|url| crate::is_app_shell_url(&url))
            .unwrap_or(false)
    {
        return Err("此窗口不能修改全书正文".into());
    }
    apply_at(&crate::desktop_storage::root(&app)?, &batch).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    struct Fixture {
        root: PathBuf,
        batch: Batch,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    async fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("ew-book-replace-{}", uuid::Uuid::new_v4()));
        let mut db = crate::desktop_storage::connect_at(&root).await.unwrap();
        sqlx::query("INSERT INTO local_books(id,payload,title,mergeStatus,updateTime) VALUES(-1,?,'测试作品','local','')")
            .bind(json!({"id":-1,"title":"测试作品","wordCount":8,"chapterCount":2}).to_string()).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO local_volumes(id,bookId,payload,sortNo) VALUES(-2,'-1','{}',1)")
            .execute(&mut db)
            .await
            .unwrap();
        let mut edits = vec![];
        for id in [-11, -12] {
            let content = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"林渡来了"}]}]});
            let next = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"沈舟来了"}]}]});
            let draft = json!({"storageKey":format!("guest:-1:{id}"),"userId":"guest","bookId":"-1","chapterId":id,"title":"章节","localVersion":1,"remoteVersion":0,"textContent":"林渡来了","contentJson":content,"lastBackedUpAt":123,"updatedAt":1});
            sqlx::query("INSERT INTO local_chapters(id,bookId,volumeId,payload,sortNo) VALUES(?,'-1','-2',?,1)")
                .bind(id).bind(json!({"id":id,"bookId":"-1","title":"章节","wordCount":4}).to_string()).execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO chapter_contents(storageKey,userId,bookId,chapterId,payload,updatedAt,lastBackedUpAt,wordCount,textWordCount) VALUES(?,'guest','-1',?,?,1,123,4,4)")
                .bind(format!("guest:-1:{id}")).bind(id).bind(draft.to_string()).execute(&mut db).await.unwrap();
            edits.push(Edit {
                chapter_id: id,
                expected_version: 1,
                expected_text: "林渡来了".into(),
                expected_json: content,
                expected_title: "章节".into(),
                text_content: "沈舟来了".into(),
                content_json: next,
                count: 1,
            });
        }
        Fixture {
            root,
            batch: Batch {
                operation_id: uuid::Uuid::new_v4().to_string(),
                book_id: "-1".into(),
                query: "林渡".into(),
                replacement: "沈舟".into(),
                edits,
            },
        }
    }
    async fn snapshot(root: &Path) -> (Vec<String>, Vec<String>) {
        let mut db = crate::desktop_storage::connect_existing_at(root)
            .await
            .unwrap();
        (
            sqlx::query_scalar("SELECT payload FROM chapter_contents ORDER BY chapterId")
                .fetch_all(&mut db)
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT payload FROM chapter_versions ORDER BY chapterId")
                .fetch_all(&mut db)
                .await
                .unwrap(),
        )
    }
    #[tokio::test]
    async fn replacement_keeps_history_backup_marker_and_is_idempotent() {
        let f = fixture().await;
        assert_eq!(apply_at(&f.root, &f.batch).await.unwrap()["count"], 2);
        apply_at(&f.root, &f.batch).await.unwrap();
        let (chapters, history) = snapshot(&f.root).await;
        assert_eq!(history.len(), 2);
        for raw in chapters {
            let v: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(v["localVersion"], 2);
            assert_eq!(v["textContent"], "沈舟来了");
            assert_eq!(v["lastBackedUpAt"], 123);
        }
        for raw in history {
            let v: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(v["textContent"], "林渡来了");
            assert_eq!(v["remark"], "全书替换前");
        }
    }
    #[tokio::test]
    async fn second_chapter_conflict_rolls_back_first_chapter_and_history() {
        let f = fixture().await;
        let mut db = crate::desktop_storage::connect_existing_at(&f.root)
            .await
            .unwrap();
        sqlx::query("UPDATE chapter_contents SET payload=json_set(payload,'$.localVersion',2,'$.textContent','作者新稿') WHERE chapterId=-12").execute(&mut db).await.unwrap();
        let before = snapshot(&f.root).await;
        assert!(apply_at(&f.root, &f.batch)
            .await
            .unwrap_err()
            .contains("章节已被其他操作更新"));
        assert_eq!(snapshot(&f.root).await, before);
    }
    #[tokio::test]
    async fn write_failure_rolls_back_the_entire_operation() {
        let f = fixture().await;
        let mut db = crate::desktop_storage::connect_existing_at(&f.root)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER fail_replace BEFORE UPDATE ON chapter_contents WHEN NEW.chapterId=-12 BEGIN SELECT RAISE(ABORT,'injected failure'); END").execute(&mut db).await.unwrap();
        let before = snapshot(&f.root).await;
        assert!(apply_at(&f.root, &f.batch).await.is_err());
        assert_eq!(snapshot(&f.root).await, before);
        sqlx::query("DROP TRIGGER fail_replace")
            .execute(&mut db)
            .await
            .unwrap();
        assert_eq!(apply_at(&f.root, &f.batch).await.unwrap()["count"], 2);
    }
    #[tokio::test]
    async fn deleted_or_generated_chapters_are_not_modified() {
        for change in ["UPDATE local_chapters SET deletedAt='deleted' WHERE id=-12", "UPDATE local_chapters SET payload=json_set(payload,'$.workflowStatus','incomplete') WHERE id=-12", "UPDATE local_books SET deletedAt='deleted' WHERE id=-1"] {
            let f=fixture().await;let mut db=crate::desktop_storage::connect_existing_at(&f.root).await.unwrap();
            sqlx::query(change).execute(&mut db).await.unwrap();let before=snapshot(&f.root).await;
            assert!(apply_at(&f.root,&f.batch).await.is_err());assert_eq!(snapshot(&f.root).await,before);
        }
    }
    #[tokio::test]
    async fn stale_replacement_identity_cannot_be_reused_for_different_content() {
        let mut f = fixture().await;
        apply_at(&f.root, &f.batch).await.unwrap();
        f.batch.replacement = "别的名字".into();
        assert!(apply_at(&f.root, &f.batch)
            .await
            .unwrap_err()
            .contains("确认已变化"));
        assert_eq!(snapshot(&f.root).await.1.len(), 2);
    }
    #[test]
    fn counts_follow_utf16_and_text_only_modes() {
        assert_eq!(counts("😀，林 A\u{feff}"), (5, 2));
    }
}
