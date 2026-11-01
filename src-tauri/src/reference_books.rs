//! 拆书 2.0：参考书按章产出与作者作品同一套章节卡，聚合成书级画像，供节奏对比、案例检索与仿书使用。
//!
//! 参考书原文与拆书报告在拆书库（`ew-local-breakdown/kv`）里；章节卡、事实、线索这些派生数据沿用状态层，
//! 作品编号用 `breakdown:{项目}` 前缀，与作者作品完全隔开。参考书的人物名在作者作品的草案、资料、
//! 对照方案里出现时由宿主拦下：参考书只能借方法与结构，不能借人物和事件。
//!
//! 导入、拆书和蒸馏的执行任务由 Pi 管理；此处只读写参考书与聚合统计。
use crate::story_state as canon;
use crate::writing_records::{err, get, list, str_field};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

pub const BREAKDOWN_NS: &str = "ew-local-breakdown/kv";
pub const PREFIX: &str = "breakdown:";

/// 常见称谓：出现在人物关系里也不当作参考书的专有人名，避免误拦作者自己的“师父”“长老”。
const COMMON_TITLES: &[&str] = &[
    "师父",
    "师傅",
    "师尊",
    "师兄",
    "师姐",
    "师弟",
    "师妹",
    "长老",
    "掌门",
    "宗主",
    "父亲",
    "母亲",
    "爸爸",
    "妈妈",
    "爷爷",
    "奶奶",
    "哥哥",
    "姐姐",
    "弟弟",
    "妹妹",
    "皇帝",
    "公主",
    "王爷",
    "少爷",
    "小姐",
    "老板",
    "主角",
    "反派",
    "众人",
    "路人",
    "管家",
    "侍卫",
    "老者",
    "少年",
    "少女",
    "男主",
    "女主",
    "系统",
    "黑衣人",
    "老人",
    "中年人",
    "青年",
    "女子",
    "男子",
    "少妇",
    "孩子",
    "小孩",
    "众弟子",
    "弟子",
    "掌柜",
    "伙计",
    "护卫",
    "将军",
    "大人",
    "陛下",
    "殿下",
    "夫人",
    "老爷",
    "先生",
    "医生",
    "老师",
    "同学",
    "队长",
    "敌人",
    "对手",
    "神秘人",
];

fn is_proper_name(name: &str) -> bool {
    name.chars().count() >= 2 && !COMMON_TITLES.contains(&name)
}

pub fn project_of(book_id: &str) -> Option<&str> {
    book_id.strip_prefix(PREFIX)
}

pub fn book_id(project_id: &str) -> String {
    format!("{PREFIX}{project_id}")
}

pub async fn project(db: &mut SqliteConnection, pid: &str) -> Result<Value, String> {
    get(db, BREAKDOWN_NS, &format!("project:{pid}"))
        .await?
        .ok_or_else(|| "拆书项目不存在".to_owned())
}

/// 参考书目录，按原书顺序；形状与作者作品目录一致（有 id、title）。
pub async fn catalog(db: &mut SqliteConnection, pid: &str) -> Result<Vec<Value>, String> {
    let mut chapters = project(db, pid).await?["chapters"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    chapters.sort_by_key(|c| c["sortNo"].as_i64().unwrap_or(0));
    Ok(chapters)
}

/// 作者作品或参考书的目录。
pub async fn any_catalog(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    match project_of(book_id) {
        Some(pid) => catalog(db, pid).await,
        None => crate::writing_records::catalog(db, book_id).await,
    }
}

/// 参考书一章：标题与正文（段落以换行连接）。
pub async fn chapter(db: &mut SqliteConnection, pid: &str, cid: &str) -> Result<Value, String> {
    let item = catalog(db, pid)
        .await?
        .into_iter()
        .find(|c| c["id"].to_string() == cid)
        .ok_or("参考书章节不存在")?;
    let content = get(db, BREAKDOWN_NS, &format!("content:{cid}"))
        .await?
        .ok_or("参考书章节正文不存在")?;
    let text = content["paragraphs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(json!({"id":item["id"],"title":item["title"],"sortNo":item["sortNo"],"textContent":text}))
}

/// 参考书章节的来源指纹：标题与正文。
pub fn version_of(chapter: &Value) -> String {
    crate::book_materials::version(&json!([chapter["title"], chapter["textContent"]]))
}

/// 章节卡里出现过的参考书人物：名字 → 出现的章数，按章数从多到少。
async fn card_names(db: &mut SqliteConnection, pid: &str) -> Result<Vec<(String, i64)>, String> {
    let rows = sqlx::query(
        "SELECT name,COUNT(DISTINCT chapterId) AS n FROM canon_entities WHERE bookId=? AND entityType='character' GROUP BY name ORDER BY n DESC,name",
    )
    .bind(book_id(pid))
    .fetch_all(&mut *db)
    .await
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get::<String, _>("name").trim().to_owned(),
                r.get::<i64, _>("n"),
            )
        })
        .filter(|(name, _)| is_proper_name(name))
        .collect())
}

/// 提取下一章章节卡时给模型的人物表：项目记录里的人名在前，章节卡里出现过的按章数排在后面。
pub async fn known_names(
    db: &mut SqliteConnection,
    pid: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = match project(db, pid).await {
        Ok(p) => p["characterNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|n| is_proper_name(n))
            .map(str::to_owned)
            .collect(),
        Err(_) => Vec::new(),
    };
    for (name, _) in card_names(db, pid).await? {
        if names.len() >= limit {
            break;
        }
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.truncate(limit);
    Ok(names)
}

/// 已有有效章节卡的章节编号。只读状态字段，不解析整张卡。
pub async fn active_card_chapters(
    db: &mut SqliteConnection,
    book: &str,
) -> Result<BTreeSet<String>, String> {
    let prefix = crate::desktop_storage::key_prefix(&canon::card_key(book, ""));
    let rows: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT json_extract(value,'$.chapterId') FROM desktop_records WHERE namespace=? AND substr(key,1,length(?))=? AND json_extract(value,'$.status')='active'",
    )
    .bind(canon::CANON_NS)
    .bind(&prefix)
    .bind(&prefix)
    .fetch_all(&mut *db)
    .await
    .map_err(err)?;
    Ok(rows.into_iter().flatten().collect())
}

// ---------------------------------------------------------------------------
// 节奏曲线：作者作品与参考书用同一套章节卡统计
// ---------------------------------------------------------------------------

/// 每章一个点：爽点、章末钩子、新信息、事件数、线索开合。没有有效章节卡的章节标 indexed=false。
pub async fn curve(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    let cards = canon::list_cards(db, book_id).await?;
    let mut points = Vec::new();
    for (index, chapter) in any_catalog(db, book_id).await?.iter().enumerate() {
        let cid = chapter["id"].to_string();
        let no = index as i64 + 1;
        let Some(card) = cards
            .iter()
            .find(|c| c["chapterId"] == cid.as_str() && c["status"] == "active")
        else {
            points.push(json!({"no":no,"chapterId":cid,"title":chapter["title"],"indexed":false}));
            continue;
        };
        let c = &card["card"];
        let payoffs = c["payoffs"].as_array().cloned().unwrap_or_default();
        let hooks = c["hooks"].as_array().cloned().unwrap_or_default();
        let end_hook = hooks.iter().find(|h| h["position"] == "end");
        let threads = c["threads"].as_array().cloned().unwrap_or_default();
        points.push(json!({"no":no,"chapterId":cid,"title":chapter["title"],"indexed":true,"oneLine":c["oneLine"],
            "payoffCount":payoffs.len(),"payoffPeak":payoffs.iter().filter_map(|p| p["strength"].as_i64()).max().unwrap_or(0),
            "payoffTypes":payoffs.iter().filter_map(|p| p["type"].as_str()).collect::<Vec<_>>(),
            "endHook":end_hook.map(|h| json!({"type":h["type"],"strength":h["strength"]})),
            "hookTypes":hooks.iter().filter_map(|h| h["type"].as_str()).collect::<Vec<_>>(),
            "info":c["facts"].as_array().map_or(0, |a| a.len()),"events":c["events"].as_array().map_or(0, |a| a.len()),
            "planted":threads.iter().filter(|t| t["action"] == "plant").count(),
            "paid":threads.iter().filter(|t| t["action"] == "payoff").count(),
            "emotion":c["emotion"]}));
    }
    Ok(points)
}

fn count_types<'a>(items: impl Iterator<Item = &'a str>) -> Vec<Value> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for item in items {
        *counts.entry(item).or_insert(0) += 1;
    }
    let mut out: Vec<(&str, usize)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    out.into_iter()
        .map(|(t, n)| json!({"type":t,"count":n}))
        .collect()
}

/// 曲线的统计口径：只算已索引的章节。
pub fn summarize(points: &[Value]) -> Value {
    let indexed: Vec<&Value> = points.iter().filter(|p| p["indexed"] == true).collect();
    let n = indexed.len();
    let mut longest_gap = (0usize, 0i64, 0i64);
    let mut run = 0usize;
    let mut run_start = 0i64;
    let mut previous_no: Option<i64> = None;
    // 密度可以只统计已知章节；连续区间必须沿完整目录走，未知章节与编号断档都会打断区间。
    for p in points {
        let no = p["no"].as_i64();
        if previous_no.and_then(|n| n.checked_add(1)) != no {
            run = 0;
        }
        if p["indexed"] == true && no.is_some() && p["payoffCount"].as_u64() == Some(0) {
            let no = no.unwrap();
            if run == 0 {
                run_start = no;
            }
            run += 1;
            if run > longest_gap.0 {
                longest_gap = (run, run_start, no);
            }
        } else {
            run = 0;
        }
        previous_no = no;
    }
    let end_hooks: Vec<&str> = indexed
        .iter()
        .filter_map(|p| p["endHook"]["type"].as_str())
        .collect();
    let payoffs: usize = indexed
        .iter()
        .map(|p| p["payoffCount"].as_u64().unwrap_or(0) as usize)
        .sum();
    let info: usize = indexed
        .iter()
        .map(|p| p["info"].as_u64().unwrap_or(0) as usize)
        .sum();
    let ratio = |a: usize| {
        if n == 0 {
            0.0
        } else {
            (a as f64 / n as f64 * 100.0).round() / 100.0
        }
    };
    json!({"indexedChapters":n,"totalChapters":points.len(),"payoffsPerChapter":ratio(payoffs),"infoPerChapter":ratio(info),
        "endHookRate":ratio(end_hooks.len()),"longestPayoffGap":{"length":longest_gap.0,"from":longest_gap.1,"to":longest_gap.2},
        "endHookTypes":count_types(end_hooks.iter().copied()),
        "payoffTypes":count_types(indexed.iter().flat_map(|p| p["payoffTypes"].as_array().into_iter().flatten().filter_map(Value::as_str)))})
}

/// 书级画像：节奏曲线、类型分布、开篇模式、线索开合、文风数据、拆书报告里的阶段与技巧、已存的配方。
pub async fn profile(db: &mut SqliteConnection, pid: &str) -> Result<Value, String> {
    let p = project(db, pid).await?;
    let bid = book_id(pid);
    let points = curve(db, &bid).await?;
    let opening = points
        .iter()
        .filter(|pt| pt["indexed"] == true)
        .take(3)
        .map(|pt| json!({"no":pt["no"],"title":pt["title"],"oneLine":pt["oneLine"],"hookTypes":pt["hookTypes"],"payoffTypes":pt["payoffTypes"],"endHook":pt["endHook"]}))
        .collect::<Vec<_>>();
    let threads = canon::list_threads(db, &bid, None).await?;
    let order: BTreeMap<String, i64> = points
        .iter()
        .filter_map(|pt| Some((pt["chapterId"].as_str()?.to_owned(), pt["no"].as_i64()?)))
        .collect();
    let distances: Vec<i64> = threads
        .iter()
        .filter(|t| t["status"] == "paid")
        .filter_map(|t| {
            Some(
                order.get(t["paidChapter"].as_str()?)?
                    - order.get(t["plantedChapter"].as_str()?)?,
            )
        })
        .collect();
    // 文风统计与已索引范围一致，并单独声明其来源；统计不代表本轮模型阅读。
    let mut sample = String::new();
    let indexed: std::collections::BTreeSet<String> = points
        .iter()
        .filter(|p| p["indexed"] == true)
        .filter_map(|p| p["chapterId"].as_str().map(str::to_owned))
        .collect();
    for chapter in catalog(db, pid)
        .await?
        .iter()
        .filter(|c| indexed.contains(&c["id"].to_string()))
    {
        if let Ok(c) = self::chapter(db, pid, &chapter["id"].to_string()).await {
            sample.push_str(c["textContent"].as_str().unwrap_or(""));
            sample.push('\n');
        }
    }
    let report = p["report"].clone();
    Ok(
        json!({"projectId":pid,"title":p["title"],"summary":summarize(&points),"curve":points,"opening":opening,
        "threads":{"planted":threads.len(),"paid":threads.iter().filter(|t| t["status"] == "paid").count(),
            "averagePayoffDistance":if distances.is_empty() { Value::Null } else { json!(distances.iter().sum::<i64>() as f64 / distances.len() as f64) }},
        "style":crate::writing_style::metrics(&sample),
        "styleCoverage":{"basis":"raw_text_statistics","chapterIds":indexed,"chapters":indexed.len(),"note":"程序对这些章节原文计算的统计，不代表本轮模型读过原文，也不等于报告范围"},
        "stages":report["outlineRecovery"],"techniques":report["reusableTechniques"],"editorNotes":report["editorNotes"],

        "recipes":recipes(db, pid).await?,
        "note":"节奏、钩子与爽点来自已索引章节卡；文风统计的原文范围见 styleCoverage，程序统计不代表本轮模型阅读。画像不完整时如实说明。stages、techniques、editorNotes 来自最近一份拆书报告，未生成报告时为空。参考书的人物和事件只能借方法，不能进入作者作品"}),
    )
}

/// 作者作品与参考书的节奏对比，附可直接说给作者听的诊断。
pub async fn compare(
    db: &mut SqliteConnection,
    book_id_value: &str,
    pid: &str,
) -> Result<Value, String> {
    let mine = curve(db, book_id_value).await?;
    let theirs = curve(db, &book_id(pid)).await?;
    let (a, b) = (summarize(&mine), summarize(&theirs));
    let mut findings = Vec::new();
    if a["indexedChapters"] == 0 {
        findings.push("你的作品还没有章节卡，请先保存正文并等待作品索引完成后再对比。".to_owned());
    }
    if b["indexedChapters"] == 0 {
        findings.push("参考书还没有章节卡，请先在本面板生成章节卡再对比。".to_owned());
    }
    if findings.is_empty() {
        let gap_a = &a["longestPayoffGap"];
        let gap_b = &b["longestPayoffGap"];
        if gap_a["length"].as_u64().unwrap_or(0) > gap_b["length"].as_u64().unwrap_or(0) + 1 {
            findings.push(format!(
                "第 {}–{} 章连续 {} 章没有爽点，对标书最长只空 {} 章。",
                gap_a["from"], gap_a["to"], gap_a["length"], gap_b["length"]
            ));
        }
        let density = |v: &Value| v["payoffsPerChapter"].as_f64().unwrap_or(0.0);
        if density(&a) + 0.3 < density(&b) {
            findings.push(format!(
                "爽点密度每章 {:.2} 个，对标书 {:.2} 个。",
                density(&a),
                density(&b)
            ));
        }
        let hook_rate = |v: &Value| v["endHookRate"].as_f64().unwrap_or(0.0);
        if hook_rate(&a) + 0.15 < hook_rate(&b) {
            findings.push(format!(
                "章末留钩子的章节占 {:.0}%，对标书 {:.0}%。",
                hook_rate(&a) * 100.0,
                hook_rate(&b) * 100.0
            ));
        }
        if let Some(top) = a["endHookTypes"].as_array().and_then(|t| t.first()) {
            let total: u64 = a["endHookTypes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["count"].as_u64().unwrap_or(0))
                .sum();
            let share = top["count"].as_u64().unwrap_or(0) as f64 / total.max(1) as f64;
            if total >= 5 && share >= 0.6 {
                findings.push(format!(
                    "章末钩子 {:.0}% 都是{}钩，类型单一。",
                    share * 100.0,
                    top["type"].as_str().unwrap_or("")
                ));
            }
        }
        let info = |v: &Value| v["infoPerChapter"].as_f64().unwrap_or(0.0);
        if info(&a) > info(&b) * 1.8 && info(&a) >= 3.0 {
            findings.push(format!(
                "每章新信息 {:.1} 条，对标书 {:.1} 条，可能在倾泻设定。",
                info(&a),
                info(&b)
            ));
        }
        if findings.is_empty() {
            findings.push("爽点密度、章末钩子与信息释放和对标书接近，没有明显差距。".to_owned());
        }
    }
    Ok(
        json!({"mine":{"summary":a,"curve":mine},"benchmark":{"projectId":pid,"title":project(db, pid).await?["title"],"summary":b,"curve":theirs},
        "findings":findings,"note":"基于章节卡统计；未索引的章节不计入，诊断是参考不是定论"}),
    )
}

// ---------------------------------------------------------------------------
// 拆书报告：章节卡按段归纳再合并成全书结论，保存为对话里的成果
// ---------------------------------------------------------------------------

fn clip(value: &Value, limit: usize) -> String {
    value.as_str().unwrap_or("").chars().take(limit).collect()
}

/// 一章章节卡的摘要：一句话、关键事件、钩子、爽点、伏笔开合、情绪。
fn chapter_digest(no: usize, title: &Value, card: &Value) -> Value {
    let list = |key: &str| card[key].as_array().cloned().unwrap_or_default();
    json!({"no":no,"title":title,"oneLine":card["oneLine"],
        "events":list("events").iter().take(6).map(|e| clip(&e["summary"], 60)).collect::<Vec<_>>(),
        "hooks":list("hooks").iter().map(|h| json!({"position":h["position"],"type":h["type"],"strength":h["strength"],"text":clip(&h["text"], 40)})).collect::<Vec<_>>(),
        "payoffs":list("payoffs").iter().map(|p| json!({"type":p["type"],"strength":p["strength"],"amplified":p["amplified"],"quote":clip(&p["quote"], 40)})).collect::<Vec<_>>(),
        "planted":list("threads").iter().filter(|t| t["action"] == "plant").map(|t| clip(&t["text"], 40)).collect::<Vec<_>>(),
        "paid":list("threads").iter().filter(|t| t["action"] == "payoff").map(|t| clip(&t["text"], 40)).collect::<Vec<_>>(),
        "emotion":format!("{} → {} → {}", clip(&card["emotion"]["open"], 20), clip(&card["emotion"]["peak"], 20), clip(&card["emotion"]["close"], 20))})
}

pub async fn recipes(db: &mut SqliteConnection, pid: &str) -> Result<Vec<Value>, String> {
    let mut items = list(db, canon::AUTHOR_NS, &format!("recipe:{}:", book_id(pid))).await?;
    items.retain(|r| !r["deletedAt"].is_number());
    items.sort_by_key(|r| r["createdAt"].as_i64().unwrap_or(0));
    Ok(items)
}

/// 拆书库里的全部项目，附章节卡覆盖情况。
/// 工作区每次加载都会列一遍，章节卡只按状态计数，不读整张卡。
pub async fn list_projects(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for p in list(db, BREAKDOWN_NS, "project:").await? {
        let pid = p["id"].to_string();
        let cards = active_card_chapters(db, &book_id(&pid)).await?.len();
        let chapters = p["chapters"].as_array().map_or(0, |a| a.len());
        out.push(json!({"projectId":pid,"title":p["title"],"chapters":chapters,"words":p["wordCount"],"cards":cards,
            "hasReport":p["report"].is_object(),"updateTime":p["updateTime"]}));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 导入参考书：输入框里拖进整本书，分章后一次写进拆书库
// ---------------------------------------------------------------------------

/// 单本参考书的章节上限与单章字数上限（前端分章时已把超长章拆成续章）。
pub const IMPORT_MAX_CHAPTERS: usize = 20_000;
pub const IMPORT_MAX_CHAPTER_CHARS: usize = 120_000;

pub fn project_id_arg(args: &Value) -> Result<String, String> {
    match &args["projectId"] {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err("缺少参考书编号 projectId".into()),
    }
}

/// 可直接阅读的拆书成果，不要求模型再跑一轮。按已拆章节分页，报告沿用原成果记录；to=0 表示到末章。
pub async fn results_in_range(
    db: &mut SqliteConnection,
    pid: &str,
    offset: usize,
    from: usize,
    to: usize,
) -> Result<Value, String> {
    let p = project(db, pid).await?;
    let bid = book_id(pid);
    let indexed = active_card_chapters(db, &bid).await?;
    let catalog = catalog(db, pid).await?;
    let from = from.max(1).min(catalog.len().max(1));
    let to = if to == 0 {
        catalog.len()
    } else {
        to.min(catalog.len()).max(from)
    };
    let covered: Vec<_> = catalog
        .iter()
        .enumerate()
        .filter(|(no, c)| no + 1 >= from && no + 1 <= to && indexed.contains(&c["id"].to_string()))
        .collect();
    let mut cards = Vec::new();
    for (no, c) in covered.iter().skip(offset).take(20) {
        if let Some(card) = canon::get_card(db, &bid, &c["id"].to_string()).await? {
            cards.push(chapter_digest(no + 1, &c["title"], &card["card"]));
        }
    }
    Ok(
        json!({"projectId":pid,"title":p["title"],"total":catalog.len(),"rangeFrom":from,"rangeTo":to,"rangeTotal":to.saturating_sub(from-1),"indexed":covered.len(),"offset":offset,"cards":cards,
        "projectReport":p["report"],
        "savedToWorkbench":p["visibility"]!="conversation", "needsRepair":p["parserVersion"]!=2,"repairNote":p["repairNote"],"notes":p["importNotes"],
        "searchReady":p["searchCursor"].as_u64().is_none_or(|n|n>=catalog.len() as u64)}),
    )
}
