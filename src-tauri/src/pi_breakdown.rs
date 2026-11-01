//! 平台拆书结果提交：复用 Pi 实例取消屏障，分析内容与章节完成状态一起落盘。
use super::control::{Instance, ToolCall};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::{path::Path, sync::Arc};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
async fn read(db: &mut SqliteConnection, key: &str) -> Result<Value, String> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value FROM desktop_records WHERE namespace='ew-local-breakdown/kv' AND key=?",
    )
    .bind(json!(key).to_string())
    .fetch_optional(db)
    .await
    .map_err(err)?;
    serde_json::from_str(&raw.ok_or("拆书项目或章节已删除")?).map_err(err)
}
pub async fn commit(
    root: &Path,
    instance: Arc<Instance>,
    call: Arc<ToolCall>,
    result: Value,
) -> Result<Value, String> {
    let _writing = instance.writing(&call)?;
    let pid = call.args["projectId"].as_str().ok_or("项目编号缺失")?;
    let cid = result["chapterId"].as_i64().ok_or("章节编号无效")?;
    if call.tool != "run_breakdown"
        || !call.args["chapterIds"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(cid.to_string())))
        || !result["analysis"].is_object()
        || !result["paragraphInsightIds"].is_array()
    {
        return Err("拆书结果不属于已确认范围".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    instance.check(&call)?;
    let pkey = format!("project:{pid}");
    let ckey = format!("content:{cid}");
    let mut project = read(&mut tx, &pkey).await?;
    let mut content = read(&mut tx, &ckey).await?;
    if content["projectId"]
        .as_i64()
        .map(|v| v.to_string())
        .as_deref()
        != Some(pid)
        || content["paragraphs"] != result["expectedParagraphs"]
    {
        return Err("拆书原文或归属已改变，未覆盖".into());
    }
    let confirmed = call.args["confirmedTarget"]["chapters"]
        .as_array()
        .and_then(|a| a.iter().find(|c| c["id"] == cid))
        .ok_or("缺少作者确认的章节目标")?;
    if project["title"] != call.args["confirmedTarget"]["title"] {
        return Err("拆书项目在确认后已改变".into());
    }
    let chapter = project["chapters"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|c| c["id"] == cid))
        .ok_or("拆书章节已从项目删除")?;
    if chapter["title"] != confirmed["title"] || chapter["wordCount"] != confirmed["wordCount"] {
        return Err("章节在确认后已改变".into());
    }
    if chapter["status"] != "processing" {
        return Err("拆书章节状态已改变，未覆盖".into());
    }
    chapter["status"] = json!("done");
    chapter.as_object_mut().unwrap().remove("errorMessage");
    // Legacy single-call results do not certify full source coverage.
    content.as_object_mut().unwrap().remove("coverage");
    content["analysis"] = result["analysis"].clone();
    content["paragraphInsightIds"] = result["paragraphInsightIds"].clone();
    let mut names = project["characterNames"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for rel in result["analysis"]["relations"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for key in ["from", "to"] {
            if rel[key].as_str().is_some_and(|s| !s.is_empty()) && !names.contains(&rel[key]) {
                names.push(rel[key].clone());
            }
        }
    }
    project["characterCount"] = json!(names.len());
    project["characterNames"] = json!(names);
    let chapters = project["chapters"].as_array().ok_or("拆书目录无效")?;
    let len = chapters.len();
    let done = chapters.iter().filter(|c| c["status"] == "done").count();
    let processing = chapters.iter().any(|c| c["status"] == "processing");
    let failed = chapters.iter().any(|c| c["status"] == "failed");
    project["chapterCount"] = json!(len);
    project["progress"] = json!(if len > 0 {
        (done as f64 / len as f64 * 100.).round() as i64
    } else {
        0
    });
    project["status"] = json!(if processing {
        "processing"
    } else if len > 0 && done == len {
        "done"
    } else if failed {
        "failed"
    } else {
        "wait"
    });
    project["updateTime"] =
        json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    for (key, value) in [(pkey, project), (ckey, content)] {
        sqlx::query(
            "UPDATE desktop_records SET value=? WHERE namespace='ew-local-breakdown/kv' AND key=?",
        )
        .bind(value.to_string())
        .bind(json!(key).to_string())
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    }
    let _commit = instance.commit.lock().await;
    instance.check(&call)?;
    tx.commit().await.map_err(err)?;
    Ok(json!({"chapterId":cid,"status":"done"}))
}

#[cfg(all(test, feature = "local-tests"))]
mod tests {
    use super::*;
    struct Env(std::path::PathBuf);
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    async fn fixture() -> (Env, Arc<Instance>, Arc<ToolCall>, Value) {
        let f = Env(std::env::temp_dir().join(format!("pi-breakdown-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&f.0).await.unwrap();
        for (key, value) in [
            (
                "project:-1",
                json!({"id":-1,"title":"项目","characterNames":[],"custom":"keep","chapters":[{"id":-2,"title":"章","wordCount":2,"status":"processing"},{"id":-3,"title":"次章","status":"wait"}]}),
            ),
            (
                "content:-2",
                json!({"projectId":-1,"chapterId":-2,"paragraphs":["原文"],"analysis":null,"paragraphInsightIds":[null]}),
            ),
        ] {
            sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES('ew-local-breakdown/kv',?,?)").bind(json!(key).to_string()).bind(value.to_string()).execute(&mut db).await.unwrap();
        }
        let instance = Arc::new(Instance::new("instance".into()));
        let call = Arc::new(ToolCall::new(
            "req".into(),
            "run_breakdown".into(),
            json!({"projectId":"-1","chapterIds":["-2"],"confirmedTarget":{"title":"项目","chapters":[{"id":-2,"title":"章","wordCount":2}]}}),
            "call".into(),
            Value::Null,
        ));
        let result = json!({"chapterId":-2,"expectedParagraphs":["原文"],"analysis":{"summary":"分析","relations":[{"from":"甲","to":"乙"}]},"paragraphInsightIds":[1]});
        (f, instance, call, result)
    }
    #[tokio::test]
    async fn result_and_progress_commit_atomically_preserving_unrelated_data() {
        let (f, i, c, r) = fixture().await;
        commit(&f.0, i, c, r).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&f.0)
            .await
            .unwrap();
        let p = read(&mut db, "project:-1").await.unwrap();
        assert_eq!(p["progress"], 50);
        assert_eq!(p["custom"], "keep");
        assert_eq!(p["characterCount"], 2);
        assert_eq!(p["chapters"][1]["status"], "wait");
        assert_eq!(
            read(&mut db, "content:-2").await.unwrap()["analysis"]["summary"],
            "分析"
        );
    }
    #[tokio::test]
    async fn persistence_failure_rolls_back_analysis_and_status_together() {
        let (f, i, c, r) = fixture().await;
        let mut db = crate::desktop_storage::connect_existing_at(&f.0)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER fail_content BEFORE UPDATE ON desktop_records WHEN NEW.key='\"content:-2\"' BEGIN SELECT RAISE(ABORT,'fail'); END").execute(&mut db).await.unwrap();
        assert!(commit(&f.0, i, c, r).await.is_err());
        assert_eq!(
            read(&mut db, "project:-1").await.unwrap()["chapters"][0]["status"],
            "processing"
        );
        assert!(read(&mut db, "content:-2").await.unwrap()["analysis"].is_null());
    }
    #[tokio::test]
    async fn stop_during_database_wait_prevents_late_analysis() {
        let (f, i, c, r) = fixture().await;
        let mut db = crate::desktop_storage::connect_existing_at(&f.0)
            .await
            .unwrap();
        let lock = crate::desktop_storage::begin_write(&mut db).await.unwrap();
        let root = f.0.clone();
        let instance = i.clone();
        let pending = tokio::spawn(async move { commit(&root, instance, c, r).await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        i.revoke();
        lock.rollback().await.unwrap();
        assert!(pending.await.unwrap().is_err());
        assert!(read(&mut db, "content:-2").await.unwrap()["analysis"].is_null());
    }
    #[tokio::test]
    async fn removed_changed_or_out_of_scope_targets_never_receive_analysis() {
        for mutation in ["DELETE FROM desktop_records WHERE key='\"project:-1\"'","UPDATE desktop_records SET value=json_set(value,'$.chapters',json('[]')) WHERE key='\"project:-1\"'","UPDATE desktop_records SET value=json_set(value,'$.paragraphs',json('[\"新原文\"]')) WHERE key='\"content:-2\"'","UPDATE desktop_records SET value=json_set(value,'$.title','已改名') WHERE key='\"project:-1\"'"] {
   let(f,i,c,r)=fixture().await;let mut db=crate::desktop_storage::connect_existing_at(&f.0).await.unwrap();sqlx::query(mutation).execute(&mut db).await.unwrap();assert!(commit(&f.0,i,c,r).await.is_err());assert!(read(&mut db,"content:-2").await.unwrap()["analysis"].is_null());
  }
        let (f, i, c, mut r) = fixture().await;
        r["chapterId"] = json!(-3);
        assert!(commit(&f.0, i, c, r)
            .await
            .unwrap_err()
            .contains("已确认范围"));
    }
}
