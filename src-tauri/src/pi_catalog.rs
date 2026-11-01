//! 目录候选采用；字段与平台 normalizeLocalBook/Volume/Chapter 保持一致。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(super) async fn allocate(db: &mut SqliteConnection) -> Result<i64, String> {
    for _ in 0..8 {
        let id = -((uuid::Uuid::new_v4().as_u128() % 4_503_599_627_370_495 + 4_503_599_627_370_496)
            as i64);
        let count:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_books WHERE id=? UNION ALL SELECT 1 FROM local_volumes WHERE id=? UNION ALL SELECT 1 FROM local_chapters WHERE id=? UNION ALL SELECT 1 FROM chapter_contents WHERE chapterId=? UNION ALL SELECT 1 FROM chapter_versions WHERE chapterId=?)")
            .bind(id).bind(id).bind(id).bind(id).bind(id).fetch_one(&mut *db).await.map_err(err)?;
        if count == 0 {
            return Ok(id);
        }
    }
    Err("无法分配目录编号".into())
}
pub async fn apply(db: &mut SqliteConnection, d: &mut Value) -> Result<(), String> {
    super::entities::validate_candidate(db, d).await?;
    let fields = super::entities::fields(d)?;
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if d["entity"] == "volume" && !d["targetId"].is_null() {
        // 改已有分卷的名称或卷纲（开书自带的"第一卷"要靠这里写进卷纲）。
        let bid = d["bookId"].as_str().ok_or("作品编号无效")?;
        let vid = d["targetId"].as_str().ok_or("分卷编号无效")?;
        let raw: Option<String> = sqlx::query_scalar("SELECT payload FROM local_volumes WHERE CAST(id AS TEXT)=? AND bookId=? AND deletedAt IS NULL")
            .bind(vid).bind(bid).fetch_optional(&mut *db).await.map_err(err)?;
        let mut volume: Value =
            serde_json::from_str(&raw.ok_or("分卷不存在、不属于当前作品或已删除")?).map_err(err)?;
        for (k, v) in fields.as_object().unwrap() {
            match k.as_str() {
                "title" => {
                    let title = v.as_str().unwrap_or("").trim();
                    if title.is_empty() {
                        return Err("分卷名称不能为空".into());
                    }
                    volume["title"] = json!(title);
                }
                "summary" => volume["summary"] = json!(v.as_str().unwrap_or("").trim()),
                _ => {}
            }
        }
        volume["updateTime"] = json!(iso);
        sqlx::query("UPDATE local_volumes SET payload=? WHERE CAST(id AS TEXT)=? AND bookId=? AND deletedAt IS NULL")
            .bind(volume.to_string()).bind(vid).bind(bid).execute(&mut *db).await.map_err(err)?;
        d["appliedEntityId"] = json!(vid);
        return Ok(());
    }
    let new_book = d["entity"] == "book";
    let bid = if new_book {
        allocate(db).await?.to_string()
    } else {
        d["bookId"].as_str().ok_or("作品编号无效")?.to_owned()
    };
    if new_book {
        let mut book = json!({"id":bid.parse::<i64>().map_err(err)?,"title":"","intro":"","globalInstruction":null,"coverUrl":"","category":"","tags":[],"platform":"","perspective":"","voice":"","audience":"","groupId":null,"status":0,"visibility":0,"wordCount":0,"textWordCount":0,"chapterCount":1,"authorId":"guest","createTime":iso,"updateTime":iso,"localOnly":true,"mergeStatus":"local","remoteBookId":null,"mergedAt":null,"deletedAt":null,"ownerUserId":"guest","lastChapterId":null});
        for (k, v) in fields.as_object().unwrap() {
            if k != "styleSkillId" {
                book[k] = v.clone();
            }
        }
        if let Some(style) = fields["styleSkillId"].as_str().filter(|s| !s.is_empty()) {
            sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES('app-settings',?,?)")
                .bind(json!(format!("ew-pi-default-style:{bid}")).to_string())
                .bind(json!(style).to_string())
                .execute(&mut *db)
                .await
                .map_err(err)?;
        }
        book["title"] = json!(book["title"].as_str().unwrap().trim());
        sqlx::query("INSERT INTO local_books(id,payload,title,groupId,mergeStatus,deletedAt,updateTime) VALUES(?,?,?,NULL,'local',NULL,?)")
            .bind(bid.parse::<i64>().map_err(err)?).bind(book.to_string()).bind(book["title"].as_str()).bind(&iso).execute(&mut *db).await.map_err(err)?;
    }
    let vid = allocate(db).await?;
    let max: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sortNo),0) FROM local_volumes WHERE bookId=? AND deletedAt IS NULL",
    )
    .bind(&bid)
    .fetch_one(&mut *db)
    .await
    .map_err(err)?;
    let sort = max
        .max(0)
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or("卷序号超出范围")?;
    let volume = json!({"id":vid,"bookId":bid,"title":if new_book {"第一卷"} else {fields["title"].as_str().unwrap().trim()},"summary":if new_book {""} else {fields["summary"].as_str().unwrap_or("")},"sortNo":sort,"type":"volume","planMeta":null,"createTime":iso,"updateTime":iso,"deletedAt":null});
    sqlx::query(
        "INSERT INTO local_volumes(id,bookId,payload,deletedAt,sortNo) VALUES(?,?,?,NULL,?)",
    )
    .bind(vid)
    .bind(&bid)
    .bind(volume.to_string())
    .bind(sort)
    .execute(&mut *db)
    .await
    .map_err(err)?;
    if new_book {
        let cid = allocate(db).await?;
        let chapter = json!({"id":cid,"bookId":bid,"volumeId":vid.to_string(),"title":"第1章","summary":"","wordCount":0,"textWordCount":0,"sortNo":1,"status":0,"isPaid":0,"type":"chapter","planMeta":null,"workflowStatus":null,"createTime":iso,"updateTime":iso,"deletedAt":null});
        sqlx::query("INSERT INTO local_chapters(id,bookId,volumeId,payload,deletedAt,sortNo) VALUES(?,?,?,?,NULL,1)").bind(cid).bind(&bid).bind(vid.to_string()).bind(chapter.to_string()).execute(&mut *db).await.map_err(err)?;
        d["appliedBookId"] = json!(bid);
        d["appliedEntityId"] = json!(bid);
    } else {
        d["appliedEntityId"] = json!(vid.to_string());
    }
    Ok(())
}
