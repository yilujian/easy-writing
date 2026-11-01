//! 蒸馏任务的宿主记录：范围方案、每章读到哪一段、模型标出的范例、归纳与核验结果、最后编成的技能。
//! 运行租约（runToken）和拆书一样：暂停、取消或应用重启后，迟到的结果不写入。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

const NS: &str = "ew-agent-pi/distillation";
const BOOK_NS: &str = "ew-local-breakdown/kv";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn stamp() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn key(id: &str) -> String {
    format!("task:{id}")
}
fn text(args: &Value, k: &str) -> String {
    args[k].as_str().unwrap_or_default().to_owned()
}
async fn read(db: &mut SqliteConnection, ns: &str, key: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(ns)
            .bind(json!(key).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    serde_json::from_str(&raw.ok_or("记录不存在")?).map_err(err)
}
async fn put(db: &mut SqliteConnection, key: &str, value: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value").bind(NS).bind(json!(key).to_string()).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
pub async fn tasks(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"task:%' ORDER BY json_extract(value,'$.createdAt') DESC")
        .bind(NS).fetch_all(db).await.map_err(err)?;
    rows.into_iter().map(|s| serde_json::from_str(&s).map_err(err)).collect()
}
fn active(t: &Value) -> bool {
    matches!(t["status"].as_str(), Some("running") | Some("pausing"))
}
/// 范围不到这个章数不留校准集。
const CALIBRATION_MIN_RANGE: usize = 10;
const CALIBRATION_DEFAULT: u64 = 2;
/// 范围方案：按章节编号读参考书目录和正文字数，给出粗估。
/// `calibration` 是留几章作校准集（默认 2，0 不留）：选中范围的末几章不进蒸馏，只用来核对卡；范围不到 10 章不留。
async fn prepare(db: &mut SqliteConnection, args: &Value) -> Result<Value, String> {
    let pid = args["projectId"].as_i64().ok_or("参考书编号无效")?;
    let project = read(db, BOOK_NS, &format!("project:{pid}")).await.map_err(|_| "参考书不存在")?;
    if project["visibility"] == "conversation" {
        return Err("参考书尚未保存".into());
    }
    let ids: Vec<i64> = args["chapterIds"]
        .as_array()
        .ok_or("缺少章节")?
        .iter()
        .filter_map(Value::as_i64)
        .collect();
    if ids.is_empty() {
        return Err("请选择章节".into());
    }
    let mut catalog: Vec<Value> = project["chapters"].as_array().cloned().unwrap_or_default();
    catalog.sort_by_key(|c| c["sortNo"].as_i64().unwrap_or(0));
    let mut selected = Vec::new();
    for c in &catalog {
        let cid = c["id"].as_i64().unwrap_or(0);
        if !ids.contains(&cid) {
            continue;
        }
        let content = read(db, BOOK_NS, &format!("content:{cid}")).await.map_err(|_| "章节正文缺失")?;
        let count: u64 = content["paragraphs"]
            .as_array()
            .map(|p| p.iter().map(|x| x.as_str().map_or(0, |s| s.chars().count() as u64)).sum())
            .unwrap_or(0);
        let source_hash = super::breakdown_tasks::fingerprint(&content);
        selected.push(json!({"sourceHash":source_hash,"id":cid,"title":c["title"],"sortNo":c["sortNo"],"wordCount":c["wordCount"],"chars":count,"done":false,"parts":0,"partsDone":0}));
    }
    if selected.len() != ids.len() {
        return Err("有章节不属于这本参考书".into());
    }
    let whole = selected.len() == catalog.len();
    let wanted = args["calibration"].as_u64().unwrap_or(CALIBRATION_DEFAULT).min(5) as usize;
    let held = if selected.len() >= CALIBRATION_MIN_RANGE { wanted.min(selected.len() - 1) } else { 0 };
    let calibration: Vec<Value> = selected.split_off(selected.len() - held);
    let chapters = selected;
    let chars: u64 = chapters.iter().map(|c| c["chars"].as_u64().unwrap_or(0)).sum();
    let first = chapters[0]["sortNo"].as_i64().unwrap_or(1);
    let last = chapters[chapters.len() - 1]["sortNo"].as_i64().unwrap_or(first);
    let scope = if whole && calibration.is_empty() {
        "全书".to_owned()
    } else if first == last {
        format!("第 {first} 章")
    } else {
        format!("第 {first}—{last} 章")
    };
    let title = project["title"].as_str().unwrap_or("参考书").to_owned();
    // 读一遍原文再归纳核验，用量按原文字数的 1.5 倍粗估；时间按每分钟两万字到五万字。
    // Include chapter analysis, synthesis, sample analysis, and optional held-out chapters.
    // These are estimates for the author, never a provider price or a billing receipt.
    let chapter_calls: u64 = chapters.iter().map(|c| c["chars"].as_u64().unwrap_or(0).div_ceil(12_000).max(1)).sum();
    let groups = (chapters.len() as u64).div_ceil(40);
    let book_calls = groups + u64::from(groups > 1);
    let sample_calls = chars.min(chapters.len() as u64 * 4_800).div_ceil(15_000).max(1);
    let requests = chapter_calls + book_calls + sample_calls + 2 + u64::from(!calibration.is_empty());
    let held_chars: u64 = calibration.iter().map(|c|c["chars"].as_u64().unwrap_or(0).min(8_000)).sum();
    let tokens = (chars + held_chars) * 2 + requests * 2_000;
    let minutes = json!([(requests * 15).div_ceil(60).max(1),(requests * 60).div_ceil(60).max(2)]);
    // 技能名里不留空白：Pi 的 /skill:名字 命令按第一个空格切名字
    let skill_name: String = format!("《{title}》写作方法{}", if scope == "全书" { String::new() } else { format!("（{scope}）") })
        .split_whitespace()
        .collect();
    Ok(json!({"projectId":pid,"title":title,"scope":scope,"chapters":chapters,"calibrationChapters":calibration,"estimatedTokens":tokens,"estimatedRequests":requests,"estimatedMinutes":minutes,
        "skillName":skill_name}))
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
                    t["updatedAt"] = json!(stamp());
                    put(&mut tx, &key(&text(&t, "id")), &t).await?;
                }
            }
            json!(tasks(&mut tx).await?)
        }
        "create" => {
            let plan = &args["plan"];
            let id = text(&args, "id");
            uuid::Uuid::parse_str(&id).map_err(|_| "任务编号无效")?;
            let model = text(&args, "modelCode");
            if model.is_empty() {
                return Err("请选择文本模型".into());
            }
            if let Some(old) = super::task_identity::existing(&mut tx, NS, &args).await? {
                if old["plan"] != *plan || old["modelCode"] != model || old["sessionId"] != args["sessionId"] {
                    return Err("任务编号已用于其他请求".into());
                }
                old
            } else {
                // 重新按同样的范围和校准集算一遍，和确认过的方案对得上才启动
                let calibration = plan["calibrationChapters"].as_array().cloned().unwrap_or_default();
                let mut chapter_ids: Vec<Value> = plan["chapters"].as_array().ok_or("缺少确认范围")?.iter().map(|c| c["id"].clone()).collect();
                chapter_ids.extend(calibration.iter().map(|c| c["id"].clone()));
                let fresh = prepare(&mut tx, &json!({"projectId":plan["projectId"],"chapterIds":chapter_ids,"calibration":calibration.len()})).await?;
                let mut expected = fresh.clone();
                expected["skillName"] = plan["skillName"].clone();
                if expected != *plan {
                    return Err("参考书内容在确认后已改变，请重新预览确认".into());
                }
                if tasks(&mut tx).await?.iter().any(|t| t["projectId"] == plan["projectId"] && active(t)) {
                    return Err("这本书已有蒸馏任务在运行".into());
                }
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
                t["phase"] = json!("read");
                t["runToken"] = json!(uuid::Uuid::new_v4().to_string());
                t["picks"] = json!([]);
                t["cards"] = json!({});
                t["digests"] = json!({});
                t["review"] = Value::Null;
                t["skillId"] = Value::Null;
                t["outcome"] = Value::Null;
                t["autoContinue"] = json!(args["autoContinue"] != false);
                t["continuedAt"] = Value::Null;
                t["continueSkipped"] = Value::Null;
                put(&mut tx, &key(&id), &t).await?;
                t
            }
        }
        "get" | "pause" | "paused" | "resume" | "cancel" | "fail" | "leaf" | "digest" | "review" | "complete"
        | "continue_state" => {
            let id = text(&args, "id");
            let mut t = read(&mut tx, NS, &key(&id)).await.map_err(|_| "蒸馏任务不存在")?;
            if op == "get" {
                t
            } else {
                if matches!(op.as_str(), "leaf" | "digest" | "review" | "complete" | "fail" | "paused")
                    && (!active(&t) || t["runToken"] != args["runToken"])
                {
                    return Err("任务已停止，本次迟到结果未写入".into());
                }
                match op.as_str() {
                    "pause" => {
                        if t["status"] == "running" {
                            t["status"] = json!("pausing");
                        }
                    }
                    "paused" => {
                        t["status"] = json!("paused");
                        t["runToken"] = Value::Null;
                    }
                    "resume" => {
                        if !matches!(t["status"].as_str(), Some("paused") | Some("failed")) {
                            return Err("任务不在可继续的状态".into());
                        }
                        if tasks(&mut tx).await?.iter().any(|x| x["projectId"] == t["projectId"] && active(x) && x["id"] != t["id"]) {
                            return Err("这本书已有蒸馏任务在运行".into());
                        }
                        t["status"] = json!("running");
                        t["error"] = Value::Null;
                        t["runToken"] = json!(uuid::Uuid::new_v4().to_string());
                    }
                    "cancel" => {
                        if t["status"] == "completed" {
                            return Err("任务已完成".into());
                        }
                        t["status"] = json!("cancelled");
                        t["runToken"] = Value::Null;
                    }
                    "fail" => {
                        t["status"] = json!("failed");
                        t["error"] = json!(text(&args, "error"));
                        t["runToken"] = Value::Null;
                    }
                    "leaf" => {
                        let cid = args["chapterId"].as_i64().ok_or("章节编号无效")?;
                        let part = args["part"].as_u64().ok_or("分段编号无效")?;
                        let parts = args["parts"].as_u64().ok_or("分段数无效")?.max(1);
                        let chapter = t["chapters"].as_array_mut().unwrap().iter_mut().find(|c| c["id"] == cid).ok_or("章节超出任务范围")?;
                        if chapter["partsDone"].as_u64().unwrap_or(0) != part {
                            return Err("分段顺序无效".into());
                        }
                        chapter["parts"] = json!(parts);
                        chapter["partsDone"] = json!(part + 1);
                        chapter["done"] = json!(part + 1 >= parts);
                        let incoming = args["picks"].as_array().cloned().unwrap_or_default();
                        let picks = t["picks"].as_array_mut().unwrap();
                        picks.retain(|p| !(p["chapterId"] == cid && p["part"] == part));
                        for mut pick in incoming {
                            pick["part"] = json!(part);
                            picks.push(pick);
                        }
                        // 章卡：长章分几段读时前端合并后整张送来，按章节编号覆盖
                        if args["card"].is_object() {
                            if !t["cards"].is_object() {
                                t["cards"] = json!({});
                            }
                            t["cards"][cid.to_string()] = args["card"].clone();
                        }
                        t["phase"] = json!("read");
                    }
                    "digest" => {
                        let step = text(&args, "key");
                        if step.is_empty() {
                            return Err("归纳步骤缺失".into());
                        }
                        t["digests"][step] = args["result"].clone();
                        t["phase"] = json!("digest");
                    }
                    "review" => {
                        t["review"] = args["result"].clone();
                        t["phase"] = json!("verify");
                    }
                    "complete" => {
                        if let Some(bundle) = args.get("bundle") {
                            if t["status"] != "running" {return Err("任务已暂停，本次没有安装技能".into());}
                            let project=t["projectId"].as_i64().ok_or("参考书编号无效")?;
                            let installed=super::skills::install_distilled(&super::skill_dirs(root),project,bundle)?;
                            t["skillId"]=installed["id"].clone();
                            t["skillName"]=installed["name"].clone();
                            t["outcome"]=args["outcome"].clone();
                            t["outcome"]["skillFile"]=installed["file"].clone();
                        } else {
                            // A runner already in memory before the update may have installed its Skill.
                            let skill = text(&args, "skillId");
                            if skill.is_empty() {return Err("技能编号缺失".into());}
                            t["skillId"]=json!(skill);
                            if let Some(name)=args["skillName"].as_str().filter(|s|!s.trim().is_empty()) {t["skillName"]=json!(name);}
                            t["outcome"]=args["outcome"].clone();
                        }
                        t["phase"] = json!("compile");
                        t["status"] = json!("completed");
                        t["runToken"] = Value::Null;
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
                    _ => unreachable!(),
                }
                t["updatedAt"] = json!(stamp());
                put(&mut tx, &key(&id), &t).await?;
                t
            }
        }
        _ => return Err("未知蒸馏操作".into()),
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
    async fn seed(db: &mut SqliteConnection, ns: &str, key: &str, value: &Value) {
        sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value").bind(ns).bind(json!(key).to_string()).bind(value.to_string()).execute(db).await.unwrap();
    }
    async fn fixture() -> Env {
        let e = Env(std::env::temp_dir().join(format!("pi-distill-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&e.0).await.unwrap();
        seed(&mut db, BOOK_NS, "project:-1", &json!({"id":-1,"title":"参考书","visibility":"workbench","chapters":[{"id":-2,"title":"第一章","sortNo":1,"wordCount":4},{"id":-3,"title":"第二章","sortNo":2,"wordCount":2}]})).await;
        seed(&mut db, BOOK_NS, "content:-2", &json!({"projectId":-1,"paragraphs":["甲乙","丙丁"]})).await;
        seed(&mut db, BOOK_NS, "content:-3", &json!({"projectId":-1,"paragraphs":["后文"]})).await;
        e
    }
    async fn call(e: &Env, op: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(op);
        dispatch(&e.0, args).await
    }
    async fn start(e: &Env, ids: Vec<i64>) -> Value {
        let plan = call(e, "prepare", json!({"projectId":-1,"chapterIds":ids})).await.unwrap();
        call(e, "create", json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan,"modelCode":"m","sessionId":"s1"})).await.unwrap()
    }
    fn lease(t: &Value) -> Value {
        json!({"id":t["id"],"runToken":t["runToken"]})
    }
    #[tokio::test]
    async fn changed_source_or_replayed_confirmation_never_starts_a_second_job() {
        let e = fixture().await;
        let preview = json!({"projectId":-1,"chapterIds":[-2]});
        let plan = call(&e, "prepare", preview.clone()).await.unwrap();
        let make = |plan: &Value| json!({"id":uuid::Uuid::new_v4().to_string(),"sessionId":"s","callId":"confirmed","modelCode":"m","plan":plan});
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        seed(
            &mut db,
            BOOK_NS,
            "content:-2",
            &json!({"projectId":-1,"paragraphs":["乙甲","丙丁"]}),
        )
        .await;
        assert!(call(&e, "create", make(&plan)).await.is_err());
        let fresh = call(&e, "prepare", preview).await.unwrap();
        let original = call(&e, "create", make(&fresh)).await.unwrap();
        let mut finish = lease(&original);
        finish["bundle"] = json!({"name":"测试文风","description":"测试","instructions":"参考原文","files":[
            {"path":"references/examples.json","content":json!({"source":{"projectId":-1}}).to_string()},
            {"path":"references/samples.md","content":"乙甲"}]});
        finish["outcome"] = json!({"samples":1});
        let saved = call(&e, "complete", finish.clone()).await.unwrap();
        assert_eq!(saved["status"], "completed");
        assert!(std::path::Path::new(saved["outcome"]["skillFile"].as_str().unwrap()).is_file());
        let replay = call(&e, "create", make(&fresh)).await.unwrap();
        assert_eq!(replay["id"], original["id"]);
        assert_eq!(replay["status"], "completed");
        assert!(call(&e, "complete", finish).await.is_err());
    }
    #[tokio::test]
    async fn prepare_reads_scope_and_full_flow_compiles_into_skill() {
        let e = fixture().await;
        let plan = call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-2,-3]})).await.unwrap();
        assert_eq!(plan["scope"], "全书");
        assert_eq!(plan["chapters"][0]["chars"], 4);
        assert_eq!(plan["skillName"], "《参考书》写作方法");
        assert_eq!(call(&e, "prepare", json!({"projectId":-1,"chapterIds":[-3]})).await.unwrap()["scope"], "第 2 章");
        let t = start(&e, vec![-2, -3]).await;
        assert_eq!(t["status"], "running");
        assert_eq!(t["autoContinue"], true);
        let mut a = lease(&t);
        a["chapterId"] = json!(-2);
        a["part"] = json!(0);
        a["parts"] = json!(2);
        a["picks"] = json!([{"id":"p1","kind":"开章","text":"甲乙"}]);
        let after = call(&e, "leaf", a.clone()).await.unwrap();
        assert_eq!(after["chapters"][0]["partsDone"], 1);
        assert_eq!(after["chapters"][0]["done"], false);
        assert!(call(&e, "leaf", a.clone()).await.is_err(), "分段顺序必须递增");
        a["part"] = json!(1);
        a["picks"] = json!([{"id":"p2","kind":"对白","text":"丙丁"}]);
        a["card"] = json!({"chapterId":-2,"summary":"合并后的章卡"});
        let after = call(&e, "leaf", a).await.unwrap();
        assert_eq!(after["chapters"][0]["done"], true);
        assert_eq!(after["picks"].as_array().unwrap().len(), 2);
        assert_eq!(after["cards"]["-2"]["summary"], "合并后的章卡", "章卡按章节编号落盘");
        let mut d = lease(&t);
        d["key"] = json!("root");
        d["result"] = json!({"notes":[{"text":"短句开场","evidence":["p1"]}],"narrative":["先抛事再交代"]});
        assert_eq!(call(&e, "digest", d).await.unwrap()["phase"], "digest");
        let mut r = lease(&t);
        r["result"] = json!({"items":[{"index":0,"verdict":"keep"}]});
        assert_eq!(call(&e, "review", r).await.unwrap()["phase"], "verify");
        let mut c = lease(&t);
        c["skillId"] = json!("参考书-文风档案");
        c["skillName"] = json!("《参考书》都市高武爽文写法");
        c["outcome"] = json!({"examples":2,"notes":1,"narrative":1,"skillFile":"/x/SKILL.md"});
        let done = call(&e, "complete", c).await.unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(done["skillName"], "《参考书》都市高武爽文写法", "编档定的技能名回写到任务");
        assert!(done["runToken"].is_null());
        assert!(call(&e, "cancel", json!({"id":t["id"]})).await.is_err());
    }
    #[tokio::test]
    async fn long_range_holds_out_last_chapters_as_calibration_set() {
        let e = Env(std::env::temp_dir().join(format!("pi-distill-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&e.0).await.unwrap();
        let chapters: Vec<Value> = (1..=12).map(|n| json!({"id":-(10 + n),"title":format!("第{n}章"),"sortNo":n,"wordCount":2})).collect();
        seed(&mut db, BOOK_NS, "project:-9", &json!({"id":-9,"title":"长书","visibility":"workbench","chapters":chapters})).await;
        for n in 1..=12 {
            seed(&mut db, BOOK_NS, &format!("content:{}", -(10 + n)), &json!({"projectId":-9,"paragraphs":["正文"]})).await;
        }
        let ids: Vec<i64> = (1..=12).map(|n| -(10 + n)).collect();
        let plan = call(&e, "prepare", json!({"projectId":-9,"chapterIds":ids})).await.unwrap();
        assert_eq!(plan["chapters"].as_array().unwrap().len(), 10);
        assert_eq!(plan["calibrationChapters"].as_array().unwrap().iter().map(|c| c["sortNo"].as_i64().unwrap()).collect::<Vec<_>>(), vec![11, 12]);
        assert_eq!(plan["scope"], "第 1—10 章", "范围按参与蒸馏的章算，校准集不算全书");
        assert_eq!(plan["skillName"], "《长书》写作方法（第1—10章）", "技能名里不留空白，否则 Pi 的 /skill: 命令切不出名字");
        assert!(plan["estimatedTokens"].as_u64().unwrap() > 30, "用量包含整理和校准请求");
        let none = call(&e, "prepare", json!({"projectId":-9,"chapterIds":ids,"calibration":0})).await.unwrap();
        assert_eq!(none["calibrationChapters"].as_array().unwrap().len(), 0);
        assert_eq!(none["scope"], "全书");
        let t = call(&e, "create", json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan,"modelCode":"m","sessionId":"s1"})).await.unwrap();
        assert_eq!(t["status"], "running");
        assert_eq!(t["calibrationChapters"].as_array().unwrap().len(), 2, "任务记录带着校准集");
        let mut a = json!({"id":t["id"],"runToken":t["runToken"],"chapterId":-22,"part":0,"parts":1,"picks":[]});
        assert!(call(&e, "leaf", a.clone()).await.is_err(), "校准集的章不在读取范围里");
        a["chapterId"] = json!(-11);
        call(&e, "leaf", a).await.unwrap();
    }
    #[tokio::test]
    async fn stale_results_are_rejected_after_pause_cancel_or_restart() {
        let e = fixture().await;
        let t = start(&e, vec![-2]).await;
        assert!(call(&e, "create", json!({"id":uuid::Uuid::new_v4().to_string(),"plan":t["plan"],"modelCode":"m","sessionId":"s1"})).await.unwrap_err().contains("已有蒸馏任务"));
        call(&e, "pause", json!({"id":t["id"]})).await.unwrap();
        call(&e, "paused", lease(&t)).await.unwrap();
        let mut a = lease(&t);
        a["chapterId"] = json!(-2);
        a["part"] = json!(0);
        a["parts"] = json!(1);
        a["picks"] = json!([]);
        assert!(call(&e, "leaf", a.clone()).await.is_err());
        let resumed = call(&e, "resume", json!({"id":t["id"]})).await.unwrap();
        assert_ne!(resumed["runToken"], t["runToken"]);
        a["runToken"] = resumed["runToken"].clone();
        call(&e, "leaf", a.clone()).await.unwrap();
        let recovered = call(&e, "recover", json!({})).await.unwrap();
        assert_eq!(recovered[0]["status"], "paused");
        assert!(call(&e, "leaf", a).await.is_err());
        let again = call(&e, "resume", json!({"id":t["id"]})).await.unwrap();
        call(&e, "cancel", json!({"id":t["id"]})).await.unwrap();
        let mut f = lease(&again);
        f["error"] = json!("迟到");
        assert!(call(&e, "fail", f).await.is_err());
        let state = call(&e, "continue_state", json!({"id":t["id"],"autoContinue":false,"continueSkipped":"对话当时正忙"})).await.unwrap();
        assert_eq!(state["autoContinue"], false);
        assert_eq!(state["continueSkipped"], "对话当时正忙");
    }
}
