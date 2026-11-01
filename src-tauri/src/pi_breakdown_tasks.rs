//! Shared workbench/Pi breakdown tasks. Source checks, leases and result/status writes
//! are committed in one SQLite transaction. No model or UI state lives here.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::path::Path;
const NS: &str = "ew-local-breakdown/kv";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn stamp() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}
fn key(id: &str) -> String {
    format!("task:{id}")
}
fn part_key(id: &str, cid: i64) -> String {
    format!("taskpart:{id}:{cid}")
}
async fn get(db: &mut SqliteConnection, k: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(json!(k).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()?
        .ok_or_else(|| "拆书数据已删除或不存在".into())
}
async fn put(db: &mut SqliteConnection, k: &str, v: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
        .bind(NS).bind(json!(k).to_string()).bind(v.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
async fn tasks(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"task:%' ORDER BY json_extract(value,'$.createdAt') DESC")
        .bind(NS).fetch_all(db).await.map_err(err)?;
    rows.into_iter()
        .map(|v| serde_json::from_str(&v).map_err(err))
        .collect()
}
fn body(content: &Value) -> Result<String, String> {
    let a = content["paragraphs"].as_array().ok_or("章节原文无效")?;
    let p: Option<Vec<&str>> = a.iter().map(Value::as_str).collect();
    Ok(p.ok_or("章节原文无效")?.join("\n"))
}
pub(super) fn fingerprint(content: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(content["paragraphs"].to_string().as_bytes())
    )
}
fn active(t: &Value) -> bool {
    matches!(t["status"].as_str(), Some("running" | "pausing"))
}
fn recalc(p: &mut Value) {
    let a = p["chapters"].as_array().unwrap();
    let done = a.iter().filter(|c| c["status"] == "done").count();
    p["progress"] = json!(if a.is_empty() {
        0
    } else {
        done * 100 / a.len()
    });
    let a = p["chapters"].as_array().unwrap();
    p["status"] = json!(if a.iter().any(|c| c["status"] == "processing") {
        "processing"
    } else if done == a.len() {
        "done"
    } else if a.iter().any(|c| c["status"] == "failed") {
        "failed"
    } else {
        "wait"
    });
    p["updateTime"] = json!(chrono::Utc::now().to_rfc3339());
}
async fn prepare(db: &mut SqliteConnection, args: &Value) -> Result<Value, String> {
    let pid = args["projectId"].as_i64().ok_or("项目编号无效")?;
    let p = get(db, &format!("project:{pid}")).await?;
    if p["visibility"] == "conversation" {
        return Err("请先将参考书保存到工作台".into());
    }
    let ids = args["chapterIds"].as_array().ok_or("请选择章节范围")?;
    if ids.is_empty() {
        return Err("请选择章节范围".into());
    }
    let mut chapters = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for id in ids {
        let cid = id.as_i64().ok_or("章节编号无效")?;
        if !seen.insert(cid) {
            return Err("章节不能重复".into());
        }
        let c = p["chapters"]
            .as_array()
            .ok_or("目录无效")?
            .iter()
            .find(|c| c["id"] == cid)
            .ok_or("章节不属于此项目")?;
        let content = get(db, &format!("content:{cid}")).await?;
        if content["projectId"] != pid {
            return Err("章节归属已改变".into());
        }
        let source = fingerprint(&content);
        let chars = body(&content)?.chars().count();
        if chars == 0 {
            return Err(format!("{}没有正文", text(c, "title")));
        }
        let reusable = args["reanalyze"] != true
            && c["status"] == "done"
            && content["analysis"].is_object()
            && content["coverage"]["sourceRevision"] == source
            && content["coverage"]["complete"] == true;
        chapters.push(json!({"id":cid,"title":c["title"],"sortNo":c["sortNo"],"wordCount":c["wordCount"],"chars":chars,"sourceRevision":source,"reusable":reusable}));
    }
    chapters.sort_by_key(|c| c["sortNo"].as_i64().unwrap_or(0));
    let chars: u64 = chapters
        .iter()
        .filter(|c| c["reusable"] != true)
        .map(|c| c["chars"].as_u64().unwrap_or(0))
        .sum();
    let calls: u64 = chapters
        .iter()
        .filter(|c| c["reusable"] != true)
        .map(|c| c["chars"].as_u64().unwrap_or(0).div_ceil(12000))
        .sum();
    let count = p["chapters"].as_array().unwrap().len();
    let first = chapters.first().unwrap()["sortNo"].as_i64().unwrap_or(1);
    let last = chapters.last().unwrap()["sortNo"].as_i64().unwrap_or(1);
    let scope = if count == chapters.len() {
        "全书".to_owned()
    } else if last - first + 1 == chapters.len() as i64 {
        format!("第 {first}—{last} 章")
    } else {
        format!("所选 {} 章", chapters.len())
    };
    Ok(
        json!({"projectId":pid,"title":p["title"],"chapters":chapters,"scope":scope,"wholeBook":count==ids.len(),"reanalyze":args["reanalyze"]==true,"estimatedTokens":chars+calls*4000+ids.len() as u64*1500,"estimatedMinutes":[(calls*20).div_ceil(60)+1,(calls*90).div_ceil(60)+3]}),
    )
}
async fn validate_sources(
    db: &mut SqliteConnection,
    t: &Value,
    chapter_id: Option<i64>,
) -> Result<Value, String> {
    let p = get(db, &format!("project:{}", t["projectId"])).await?;
    if p["title"] != t["title"] {
        return Err("书名已改变，请重新确认任务".into());
    }
    if t["wholeBook"] == true
        && p["chapters"].as_array().map(Vec::len) != t["chapters"].as_array().map(Vec::len)
    {
        return Err("全书目录已改变，请重新确认范围".into());
    }
    for c in t["chapters"].as_array().ok_or("任务章节无效")? {
        if chapter_id.is_some_and(|id| c["id"] != id) {
            continue;
        }
        let current = p["chapters"]
            .as_array()
            .ok_or("目录无效")?
            .iter()
            .find(|v| v["id"] == c["id"])
            .ok_or("任务章节已删除")?;
        let content = get(db, &format!("content:{}", c["id"])).await?;
        if current["title"] != c["title"]
            || current["sortNo"] != c["sortNo"]
            || content["projectId"] != t["projectId"]
            || fingerprint(&content) != c["sourceRevision"]
        {
            return Err("原文或目录已改变，已保留旧结果，请重新确认范围".into());
        }
    }
    Ok(p)
}
async fn mark_project(db: &mut SqliteConnection, t: &Value, running: bool) -> Result<(), String> {
    let pk = format!("project:{}", t["projectId"]);
    let Ok(mut p) = get(db, &pk).await else {
        return Ok(());
    };
    for c in p["chapters"].as_array_mut().ok_or("目录无效")? {
        if t["chapters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == c["id"] && v["done"] != true)
        {
            if running {
                c["status"] = json!("processing");
                c["breakdownTaskId"] = t["id"].clone();
            } else if c["status"] == "processing" && c["breakdownTaskId"] == t["id"] {
                c["status"] = json!("wait");
                c.as_object_mut().unwrap().remove("breakdownTaskId");
            }
        }
    }
    recalc(&mut p);
    put(db, &pk, &p).await
}
async fn check_free(db: &mut SqliteConnection, pid: &Value, except: &str) -> Result<(), String> {
    if tasks(db)
        .await?
        .iter()
        .any(|t| t["projectId"] == *pid && active(t) && t["id"] != except)
    {
        return Err("这本书已有拆书任务在运行，请暂停或等待该任务完成；原任务未被替换".into());
    }
    let p = get(db, &format!("project:{pid}")).await?;
    if p["chapters"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c["status"] == "processing"))
    {
        return Err("工作台正在分析这本书，请先等待完成".into());
    }
    Ok(())
}
pub async fn dispatch(root: &Path, args: Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let op = text(&args, "op");
    let output = match op.as_str() {
        "prepare" => prepare(&mut tx, &args).await?,
        "list" => json!(tasks(&mut tx).await?),
        "recover" => {
            for mut t in tasks(&mut tx).await? {
                if active(&t) {
                    t["status"] = json!("paused");
                    t["error"] = json!("上次执行已中断，已保存进度，点击继续后恢复");
                    t["runToken"] = Value::Null;
                    mark_project(&mut tx, &t, false).await?;
                    put(&mut tx, &key(&text(&t, "id")), &t).await?;
                }
            }
            json!(tasks(&mut tx).await?)
        }
        "create" => {
            let plan = &args["plan"];
            if let Some(old) = super::task_identity::existing(&mut tx, NS, &args).await? {
                if old["plan"] != *plan
                    || old["modelCode"] != args["modelCode"]
                    || old["sessionId"] != args["sessionId"]
                {
                    return Err("任务编号已用于其他请求".into());
                }
                tx.commit().await.map_err(err)?;
                return Ok(old);
            }
            let fresh=prepare(&mut tx,&json!({"projectId":plan["projectId"],"chapterIds":plan["chapters"].as_array().ok_or("缺少确认范围")?.iter().map(|c|c["id"].clone()).collect::<Vec<_>>(),"reanalyze":plan["reanalyze"]})).await?;
            if fresh != *plan {
                return Err("拆书内容在确认后已改变，请重新预览确认".into());
            }
            let model = text(&args, "modelCode");
            if model.is_empty() {
                return Err("请选择文本模型".into());
            }
            let id = text(&args, "id");
            uuid::Uuid::parse_str(&id).map_err(|_| "任务编号无效")?;
            if let Ok(old) = get(&mut tx, &key(&id)).await {
                if old["plan"] != *plan
                    || old["modelCode"] != model
                    || old["sessionId"] != args["sessionId"]
                {
                    return Err("任务编号已用于其他请求".into());
                }
                old
            } else {
                check_free(&mut tx, &plan["projectId"], "").await?;
                let mut t = plan.clone();
                t["plan"] = plan.clone();
                t["id"] = json!(id);
                t["modelCode"] = json!(model);
                t["sessionId"] = args["sessionId"].clone();
                t["callId"] = args["callId"].clone();
                t["anchor"] = args["anchor"].clone();
                t["createdAt"] = json!(stamp());
                t["updatedAt"] = json!(stamp());
                t["status"] = json!("running");
                t["phase"] = json!("chapters");
                t["runToken"] = json!(uuid::Uuid::new_v4().to_string());
                t["report"] = Value::Null;
                t["reportSteps"] = json!({});
                // 拆完默认让 Agent 接着说结论；作者可在任务卡上关掉。
                t["autoContinue"] = json!(args["autoContinue"] != false);
                t["continuedAt"] = Value::Null;
                t["continueSkipped"] = Value::Null;
                for c in t["chapters"].as_array_mut().unwrap() {
                    c["done"] = c["reusable"].clone();
                    c["offset"] = json!(if c["done"] == true {
                        c["chars"].as_u64().unwrap_or(0)
                    } else {
                        0
                    });
                    c["partsDone"] = json!(0);
                    let result = if c["done"] == true {
                        get(&mut tx, &format!("content:{}", c["id"])).await?["analysis"].clone()
                    } else {
                        Value::Null
                    };
                    put(
                        &mut tx,
                        &part_key(&id, c["id"].as_i64().unwrap()),
                        &json!({"parts":[],"result":result}),
                    )
                    .await?;
                }
                mark_project(&mut tx, &t, true).await?;
                put(&mut tx, &key(&id), &t).await?;
                t
            }
        }
        "get" | "chapter" | "claim" | "pause" | "paused" | "cancel" | "resume" | "fail"
        | "part" | "complete_chapter" | "report_step" | "complete" | "continue_state" => {
            let id = text(&args, "id");
            let mut t = get(&mut tx, &key(&id)).await?;
            if op == "get" {
                t
            } else if op == "chapter" {
                let cid = args["chapterId"].as_i64().ok_or("章节编号无效")?;
                if !t["chapters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["id"] == cid)
                {
                    return Err("章节超出任务范围".into());
                }
                let content = get(&mut tx, &format!("content:{cid}")).await?;
                let target = t["chapters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == cid)
                    .unwrap();
                let source_changed = content["projectId"] != t["projectId"]
                    || fingerprint(&content) != target["sourceRevision"];
                json!({"content": content,"saved":get(&mut tx,&part_key(&id,cid)).await?, "sourceChanged": source_changed})
            } else {
                if matches!(
                    op.as_str(),
                    "part" | "complete_chapter" | "report_step" | "complete" | "fail" | "paused"
                ) && (!active(&t) || t["runToken"] != args["runToken"])
                {
                    return Err("任务已停止，本次迟到结果未写入".into());
                }
                match op.as_str() {
                    "claim" => {
                        let sid = args["sessionId"]
                            .as_str()
                            .filter(|s| !s.is_empty() && *s != "workbench")
                            .ok_or("目标会话无效")?;
                        if t["sessionId"] != "workbench" && t["sessionId"] != sid {
                            return Err("任务已属于其他会话，不能移走".into());
                        }
                        t["sessionId"] = json!(sid);
                    }
                    "pause" => {
                        if t["status"] == "running" {
                            t["status"] = json!("pausing")
                        }
                    }
                    "continue_state" => {
                        if let Some(value) = args.get("autoContinue") {
                            t["autoContinue"] = json!(*value == true);
                        }
                        if let Some(value) = args.get("continuedAt") {
                            t["continuedAt"] = value.clone();
                        }
                        if let Some(value) = args.get("continueSkipped") {
                            t["continueSkipped"] = value.clone();
                        }
                    }
                    "paused" | "cancel" | "fail" => {
                        if op == "cancel" && t["status"] == "completed" {
                            return Err("任务已完成".into());
                        }
                        t["status"] = json!(if op == "cancel" {
                            "cancelled"
                        } else if op == "fail" {
                            "failed"
                        } else {
                            "paused"
                        });
                        t["runToken"] = Value::Null;
                        t["error"] = args["error"].clone();
                        mark_project(&mut tx, &t, false).await?;
                    }
                    "resume" => {
                        if !matches!(t["status"].as_str(), Some("paused" | "failed")) {
                            return Err("只有已暂停或失败的任务可以继续".into());
                        }
                        validate_sources(&mut tx, &t, None).await?;
                        check_free(&mut tx, &t["projectId"], &id).await?;
                        t["status"] = json!("running");
                        t["error"] = Value::Null;
                        t["runToken"] = json!(uuid::Uuid::new_v4().to_string());
                        mark_project(&mut tx, &t, true).await?;
                    }
                    "part" | "complete_chapter" => {
                        let cid = args["chapterId"].as_i64().ok_or("章节编号无效")?;
                        let mut p = validate_sources(&mut tx, &t, Some(cid)).await?;
                        let c = t["chapters"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|c| c["id"] == cid)
                            .ok_or("章节超出确认范围")?;
                        if c["done"] == true {
                            return Err("本章已经完成".into());
                        }
                        let mut saved = get(&mut tx, &part_key(&id, cid)).await?;
                        if op == "part" {
                            let part = &args["part"];
                            let start = part["start"].as_u64().ok_or("分段范围无效")?;
                            let end = part["end"].as_u64().ok_or("分段范围无效")?;
                            if start != c["offset"].as_u64().unwrap_or(0)
                                || end <= start
                                || end > c["chars"].as_u64().unwrap_or(0)
                                || !part["analysis"].is_object()
                            {
                                return Err("分段覆盖不连续或结果无效".into());
                            }
                            saved["parts"].as_array_mut().unwrap().push(part.clone());
                            c["offset"] = json!(end);
                            c["partsDone"] = json!(saved["parts"].as_array().unwrap().len());
                        } else {
                            if c["offset"] != c["chars"] || !args["analysis"].is_object() {
                                return Err("原文尚未完整覆盖，不能标记完成".into());
                            }
                            let ck = format!("content:{cid}");
                            let mut content = get(&mut tx, &ck).await?;
                            if args["paragraphInsightIds"].as_array().map(Vec::len)
                                != content["paragraphs"].as_array().map(Vec::len)
                            {
                                return Err("原文段落映射无效".into());
                            }
                            content["analysis"] = args["analysis"].clone();
                            content["paragraphInsightIds"] = args["paragraphInsightIds"].clone();
                            content["coverage"] = json!({"sourceRevision":c["sourceRevision"],"complete":true,"chars":c["chars"],"taskId":id});
                            saved["result"] = args["analysis"].clone();
                            c["done"] = json!(true);
                            for pc in p["chapters"].as_array_mut().unwrap() {
                                if pc["id"] == cid {
                                    pc["status"] = json!("done");
                                    pc.as_object_mut().unwrap().remove("errorMessage");
                                    pc.as_object_mut().unwrap().remove("breakdownTaskId");
                                }
                            }
                            let mut names =
                                p["characterNames"].as_array().cloned().unwrap_or_default();
                            for rel in args["analysis"]["relations"]
                                .as_array()
                                .into_iter()
                                .flatten()
                            {
                                for field in ["from", "to"] {
                                    if rel[field].as_str().is_some_and(|s| !s.is_empty())
                                        && !names.contains(&rel[field])
                                    {
                                        names.push(rel[field].clone());
                                    }
                                }
                            }
                            p["characterCount"] = json!(names.len());
                            p["characterNames"] = json!(names);
                            recalc(&mut p);
                            put(&mut tx, &ck, &content).await?;
                            put(&mut tx, &format!("project:{}", t["projectId"]), &p).await?;
                        }
                        put(&mut tx, &part_key(&id, cid), &saved).await?;
                    }
                    "report_step" | "complete" => {
                        let mut p = validate_sources(&mut tx, &t, None).await?;
                        if !t["chapters"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|c| c["done"] == true)
                        {
                            return Err("尚有章节未完成，不能生成范围报告".into());
                        }
                        t["phase"] = json!("report");
                        if op == "report_step" {
                            let step = text(&args, "step");
                            if step.is_empty() || !args["report"].is_object() {
                                return Err("报告节点无效".into());
                            }
                            t["reportSteps"][step] = args["report"].clone();
                        } else {
                            if !args["report"].is_object() {
                                return Err("报告无效".into());
                            }
                            t["report"] = args["report"].clone();
                            t["report"]["scope"] = t["scope"].clone();
                            t["report"]["chapterIds"] = json!(t["chapters"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|c| c["id"].clone())
                                .collect::<Vec<_>>());
                            t["status"] = json!("completed");
                            t["runToken"] = Value::Null;
                            if t["wholeBook"] == true
                                && p["chapters"].as_array().unwrap().len()
                                    == t["chapters"].as_array().unwrap().len()
                            {
                                p["report"] = t["report"].clone();
                                put(&mut tx, &format!("project:{}", t["projectId"]), &p).await?;
                            }
                        }
                    }
                    _ => unreachable!(),
                }
                if t["chapters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|c| c["done"] == true)
                {
                    t["phase"] = json!("report");
                }
                t["updatedAt"] = json!(stamp());
                put(&mut tx, &key(&id), &t).await?;
                t
            }
        }
        _ => return Err("未知拆书操作".into()),
    };
    tx.commit().await.map_err(err)?;
    Ok(output)
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
    async fn fixture() -> Env {
        let e = Env(std::env::temp_dir().join(format!("pi-task-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&e.0).await.unwrap();
        put(&mut db,"project:-1",&json!({"id":-1,"title":"参考书","characterNames":[],"chapters":[{"id":-2,"title":"第一章","sortNo":1,"wordCount":4,"status":"wait"},{"id":-3,"title":"第二章","sortNo":2,"wordCount":2,"status":"wait"}],"report":null})).await.unwrap();
        put(
            &mut db,
            "content:-2",
            &json!({"projectId":-1,"paragraphs":["甲乙","丙丁"],"analysis":null}),
        )
        .await
        .unwrap();
        put(
            &mut db,
            "content:-3",
            &json!({"projectId":-1,"paragraphs":["后文"],"analysis":null}),
        )
        .await
        .unwrap();
        e
    }
    async fn call(e: &Env, op: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(op);
        dispatch(&e.0, args).await
    }
    async fn start(e: &Env, ids: Vec<i64>) -> Value {
        let plan = call(e, "prepare", json!({"projectId":-1,"chapterIds":ids}))
            .await
            .unwrap();
        call(e,"create",json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan,"modelCode":"test","sessionId":"s1"})).await.unwrap()
    }
    fn args(t: &Value) -> Value {
        json!({"id":t["id"],"runToken":t["runToken"]})
    }
    async fn part(e: &Env, t: &Value, start: usize, end: usize) -> Result<Value, String> {
        let mut a = args(t);
        a["chapterId"] = json!(-2);
        a["part"] = json!({"start":start,"end":end,"analysis":{"summary":"分段分析"}});
        call(e, "part", a).await
    }
    async fn chapter_done(e: &Env, t: &Value) -> Result<Value, String> {
        let mut a = args(t);
        a["chapterId"] = json!(-2);
        a["analysis"] = json!({"summary":"完整分析","outline":[],"rhythm":[],"setting":[]});
        a["paragraphInsightIds"] = json!([null, null]);
        call(e, "complete_chapter", a).await
    }
    #[tokio::test]
    async fn tasks_do_not_replace_each_other_and_cancel_keeps_checkpoints() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        let plan = call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-3]}))
            .await
            .unwrap();
        assert!(call(&e,"create",json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan,"modelCode":"test","sessionId":"s2"})).await.unwrap_err().contains("原任务未被替换"));
        part(&e, &t, 0, 2).await.unwrap();
        call(&e, "cancel", args(&t)).await.unwrap();
        assert!(part(&e, &t, 2, 5).await.is_err());
        let data = call(&e, "chapter", json!({"id":t["id"],"chapterId":-2}))
            .await
            .unwrap();
        assert_eq!(data["saved"]["parts"].as_array().unwrap().len(), 1);
        let next = start(&e, vec![-3]).await;
        assert_ne!(next["id"], t["id"]);
    }
    #[tokio::test]
    async fn pause_resume_changes_lease_and_recovery_never_autostarts() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        call(&e, "pause", args(&t)).await.unwrap();
        part(&e, &t, 0, 2).await.unwrap();
        call(&e, "paused", args(&t)).await.unwrap();
        assert!(part(&e, &t, 2, 5).await.is_err());
        let resumed = call(&e, "resume", args(&t)).await.unwrap();
        assert_eq!(resumed["chapters"][0]["offset"], 2);
        assert_ne!(resumed["runToken"], t["runToken"]);
        assert!(part(&e, &t, 2, 5).await.is_err());
        part(&e, &resumed, 2, 5).await.unwrap();
        let recovered = call(&e, "recover", json!({})).await.unwrap();
        assert_eq!(recovered[0]["status"], "paused");
        assert!(part(&e, &resumed, 2, 5).await.is_err());
    }
    #[tokio::test]
    async fn full_coverage_required_and_range_report_does_not_become_whole_book() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        assert!(chapter_done(&e, &t).await.is_err());
        assert!(part(&e, &t, 1, 5).await.is_err());
        part(&e, &t, 0, 5).await.unwrap();
        chapter_done(&e, &t).await.unwrap();
        let mut a = args(&t);
        a["report"] = json!({"editorNotes":"第一章总结"});
        let done = call(&e, "complete", a).await.unwrap();
        assert_eq!(done["status"], "completed");
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        assert!(get(&mut db, "project:-1").await.unwrap()["report"].is_null());
        let plan = call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-2,-3]}))
            .await
            .unwrap();
        assert_eq!(plan["chapters"][0]["reusable"], true);
        assert_eq!(plan["chapters"][1]["reusable"], false);
    }
    #[tokio::test]
    async fn source_changes_invalidate_confirmation_resume_and_late_results() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        part(&e, &t, 0, 2).await.unwrap();
        call(&e, "paused", args(&t)).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        put(
            &mut db,
            "content:-2",
            &json!({"projectId":-1,"paragraphs":["已经修改"]}),
        )
        .await
        .unwrap();
        assert!(call(&e, "resume", args(&t))
            .await
            .unwrap_err()
            .contains("原文"));
        assert!(call(&e,"create",json!({"id":uuid::Uuid::new_v4().to_string(),"plan":t["plan"],"modelCode":"test","sessionId":"s2"})).await.unwrap_err().contains("确认后已改变"));
    }
    #[tokio::test]
    async fn analysis_and_completion_roll_back_together_on_disk_error() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        part(&e, &t, 0, 5).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER fail_content BEFORE UPDATE ON desktop_records WHEN NEW.key='\"content:-2\"' BEGIN SELECT RAISE(ABORT,'fail'); END").execute(&mut db).await.unwrap();
        assert!(chapter_done(&e, &t).await.is_err());
        assert_eq!(
            get(&mut db, &key(&text(&t, "id"))).await.unwrap()["chapters"][0]["done"],
            false
        );
        assert!(get(&mut db, "content:-2").await.unwrap()["analysis"].is_null());
    }
    #[tokio::test]
    async fn deletion_never_resurrects_project_and_legacy_done_is_not_full_coverage() {
        let e = fixture().await;
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        let mut p = get(&mut db, "project:-1").await.unwrap();
        p["chapters"][0]["status"] = json!("done");
        put(&mut db, "project:-1", &p).await.unwrap();
        let plan = call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-2]}))
            .await
            .unwrap();
        assert_eq!(plan["chapters"][0]["reusable"], false);
        let t = start(&e, vec![-2]).await;
        sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(json!("project:-1").to_string())
            .execute(&mut db)
            .await
            .unwrap();
        assert!(part(&e, &t, 0, 5).await.is_err());
        call(&e, "cancel", args(&t)).await.unwrap();
        assert!(get(&mut db, "project:-1").await.is_err());
    }
    #[tokio::test]
    async fn cancelled_paused_task_does_not_reset_another_task_chapters() {
        let e = fixture().await;
        let a = start(&e, vec![-2]).await;
        call(&e, "paused", args(&a)).await.unwrap();
        let b = start(&e, vec![-2]).await;
        call(&e, "cancel", args(&a)).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        let p = get(&mut db, "project:-1").await.unwrap();
        assert_eq!(p["chapters"][0]["status"], "processing");
        assert_eq!(p["chapters"][0]["breakdownTaskId"], b["id"]);
        part(&e, &b, 0, 5).await.unwrap();
        chapter_done(&e, &b).await.unwrap();
    }
    #[tokio::test]
    async fn retries_return_original_task_and_changed_sources_are_labeled_on_read() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        part(&e, &t, 0, 5).await.unwrap();
        chapter_done(&e, &t).await.unwrap();
        let repeated = call(
            &e,
            "create",
            json!({"id":t["id"],"plan":t["plan"],"modelCode":"test","sessionId":"s1"}),
        )
        .await
        .unwrap();
        assert_eq!(repeated["chapters"][0]["done"], true);
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        put(
            &mut db,
            "content:-2",
            &json!({"projectId":-1,"paragraphs":["新正文"]}),
        )
        .await
        .unwrap();
        let read = call(&e, "chapter", json!({"id":t["id"],"chapterId":-2}))
            .await
            .unwrap();
        assert_eq!(read["sourceChanged"], true);
        assert_eq!(read["saved"]["result"]["summary"], "完整分析");
    }
    #[tokio::test]
    async fn workbench_tasks_can_join_chat_without_losing_checkpoints_or_stealing_other_chats() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        part(&e, &t, 0, 2).await.unwrap();
        call(&e, "paused", args(&t)).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        let mut old = get(&mut db, &key(&text(&t, "id"))).await.unwrap();
        old["sessionId"] = json!("workbench");
        put(&mut db, &key(&text(&t, "id")), &old).await.unwrap();
        let moved = call(&e, "claim", json!({"id":t["id"],"sessionId":"chat"}))
            .await
            .unwrap();
        assert_eq!(moved["sessionId"], "chat");
        assert_eq!(moved["chapters"][0]["offset"], 2);
        assert_eq!(moved["status"], "paused");
        assert!(
            call(&e, "claim", json!({"id":t["id"],"sessionId":"another"}))
                .await
                .is_err()
        );
        let resumed = call(&e, "resume", args(&t)).await.unwrap();
        part(&e, &resumed, 2, 5).await.unwrap();
        chapter_done(&e, &resumed).await.unwrap();
    }
    #[tokio::test]
    async fn continue_state_defaults_on_and_updates_without_lease() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        assert_eq!(t["autoContinue"], true);
        assert!(t["continuedAt"].is_null());
        assert!(t["continueSkipped"].is_null());
        let off = call(&e, "continue_state", json!({"id":t["id"],"autoContinue":false}))
            .await
            .unwrap();
        assert_eq!(off["autoContinue"], false);
        call(&e, "cancel", args(&t)).await.unwrap();
        let skipped = call(&e, "continue_state", json!({"id":t["id"],"continueSkipped":"对话当时正忙"}))
            .await
            .unwrap();
        assert_eq!(skipped["continueSkipped"], "对话当时正忙");
        assert_eq!(skipped["autoContinue"], false);
        let done = call(&e, "continue_state", json!({"id":t["id"],"continuedAt":123,"continueSkipped":null}))
            .await
            .unwrap();
        assert_eq!(done["continuedAt"], 123);
        assert!(done["continueSkipped"].is_null());
        let plan = call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-3]}))
            .await
            .unwrap();
        let quiet = call(&e,"create",json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan,"modelCode":"test","sessionId":"s1","autoContinue":false})).await.unwrap();
        assert_eq!(quiet["autoContinue"], false);
    }
}
