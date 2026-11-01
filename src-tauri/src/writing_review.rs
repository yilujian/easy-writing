//! 确定性核对：不调模型，不判文风。
//!
//! 只做三类事：
//! 1. 结构与数据完整性：空稿、字数不到下限一半、整段重复、作者自定义敏感词是阻断（保存前要作者豁免）；
//!    字数偏低偏高、相邻段开头相同只提示。
//! 2. 状态层疑点：来自状态账本，附两处原文，由作者裁决。
//! 文风一律不在这里判：没有 AI 味词表，没有对白占比、句长之类的关卡。指纹只量出来给人看（styleDrift），
//! 不进提示词，不拦保存，也不交给评审当线索——数字和词表给模型，只会让它换一套话来满足数字。
//! 各 code 的级别由平台画像的 gate 决定；画像没写的 code 用这里的默认级别。
use crate::story_state as canon;
use crate::writing_records::get;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

const REPEAT_MIN_PARAGRAPH_CHARS: usize = 16;

fn default_level(code: &str) -> &'static str {
    match code {
        "structure.empty"
        | "structure.words_min"
        | "structure.repeat"
        | "structure.sensitive"
        | "overlap.reference" => "block",
        c if c.starts_with("state.") => "suspect",
        _ => "notice",
    }
}

fn level_for(profile: &Value, code: &str) -> String {
    for level in ["block", "suspect", "notice"] {
        if profile["gate"][level]
            .as_array()
            .is_some_and(|codes| codes.iter().any(|c| c == code))
        {
            return level.to_owned();
        }
    }
    default_level(code).to_owned()
}

fn paragraphs(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

fn std_dev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

pub fn fingerprint(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
        .chars()
        .take(16)
        .collect()
}

/// 纯文本指标：结构计数 + 文风指纹。不依赖数据库，不判好坏。
pub fn metrics(text: &str) -> Value {
    let paras = paragraphs(text);
    let words = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{feff}')
        .count();
    let lengths: Vec<f64> = paras.iter().map(|p| p.chars().count() as f64).collect();
    let avg = if lengths.is_empty() {
        0.0
    } else {
        lengths.iter().sum::<f64>() / lengths.len() as f64
    };
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut repeated = 0;
    for p in paras.iter().copied() {
        if p.chars().count() < REPEAT_MIN_PARAGRAPH_CHARS {
            continue;
        }
        let count = seen.entry(p).or_insert(0);
        *count += 1;
        if *count == 2 {
            repeated += 1;
        }
    }
    let fp = crate::writing_style::style_fingerprint(text);
    let sentence_std =
        fp["sentenceCv"].as_f64().unwrap_or(0.0) * fp["sentenceMean"].as_f64().unwrap_or(0.0);
    json!({"words":words,"paragraphs":paras.len(),"repeatedParagraphs":repeated,"estimatedTokens":crate::writing_context::estimate_tokens(text),
        "avgParagraphLen":(avg*10.0).round()/10.0,"paragraphLenStd":(std_dev(&lengths)*10.0).round()/10.0,
        "dialogueRatio":fp["dialogueRatio"],"sentenceLenStd":(sentence_std*10.0).round()/10.0,"fingerprint":fp})
}

fn issue(
    profile: &Value,
    code: &str,
    dimension: &str,
    message: String,
    paragraphs: Vec<usize>,
    quotes: Vec<String>,
    fix: Option<&str>,
) -> Value {
    let mut value = json!({"id":format!("{code}:{}",paragraphs.first().copied().unwrap_or(0)),"source":"rule","code":code,"dimension":dimension,
        "level":level_for(profile,code),"message":message,"paragraphs":paragraphs,"quotes":quotes.into_iter().map(|q| q.chars().take(200).collect::<String>()).collect::<Vec<_>>()});
    if let Some(fix) = fix {
        value["fix"] = json!(fix);
    }
    if code.starts_with("style.") {
        value["observation"] = json!(true);
    }
    value
}

/// 结构检查。`sensitive` 是作者自定义敏感词（作者显式维护的字段，不是平台词表）。
/// 字数按程序实测：有作者要求或起草目标时以它为准（“约 N 字”，轻微偏差不报），没有时才用画像区间；
/// 只有不到目标一半才算阻断（多半是生成中断或漏写），其余只是提示，不触发改稿。
pub fn rule_issues(
    text: &str,
    profile: &Value,
    sensitive: &[String],
    target_words: Option<usize>,
) -> (Value, Vec<Value>) {
    let m = metrics(text);
    let paras = paragraphs(text);
    let mut issues = Vec::new();
    let words = m["words"].as_u64().unwrap_or(0) as usize;
    if words == 0 {
        issues.push(issue(
            profile,
            "structure.empty",
            "结构",
            "正文为空".into(),
            vec![],
            vec![],
            None,
        ));
        return (m, issues);
    }
    let min = profile["chapterWords"][0].as_u64().unwrap_or(2000) as usize;
    let max = profile["chapterWords"][1].as_u64().unwrap_or(4000) as usize;
    let (low, high, basis) = match target_words.filter(|t| *t > 0) {
        Some(target) => (
            target * 8 / 10,
            target * 15 / 10,
            format!("目标约 {target} 字"),
        ),
        None => (min, max * 17 / 10, format!("画像区间 {min}–{max} 字")),
    };
    // 阻断线取画像下限与目标里较小的那个的一半：作者要的短章不被画像卡住，默认目标也不比画像更严
    let floor = target_words.filter(|t| *t > 0).map_or(min, |t| t.min(min)) / 2;
    if words < floor {
        issues.push(issue(
            profile,
            "structure.words_min",
            "结构",
            format!("实测 {words} 字，不到可接受篇幅（{basis}）的一半"),
            vec![],
            vec![],
            Some("核对是否生成中断或漏写了必要情节；不用描写凑字"),
        ));
    } else if words < low {
        issues.push(issue(
            profile,
            "structure.words_low",
            "结构",
            format!("实测 {words} 字，低于{basis}"),
            vec![],
            vec![],
            None,
        ));
    } else if words > high {
        issues.push(issue(
            profile,
            "structure.words_high",
            "结构",
            format!("实测 {words} 字，明显超过{basis}"),
            vec![],
            vec![],
            Some("核对是否有重复冗长的段落；篇幅过长可拆成两章"),
        ));
    }
    // 整段重复
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut repeated: Vec<(usize, &str)> = Vec::new();
    for (i, p) in paras.iter().copied().enumerate() {
        if p.chars().count() < REPEAT_MIN_PARAGRAPH_CHARS {
            continue;
        }
        if let Some(first) = seen.get(p) {
            repeated.push((*first, p));
        } else {
            seen.insert(p, i);
        }
    }
    if !repeated.is_empty() {
        issues.push(issue(
            profile,
            "structure.repeat",
            "重复",
            format!("发现 {} 处整段重复", repeated.len()),
            repeated.iter().map(|(i, _)| *i).collect(),
            repeated
                .iter()
                .take(3)
                .map(|(_, p)| (*p).to_owned())
                .collect(),
            Some("删去重复段或重写"),
        ));
    }
    // 相邻段开头相同：程序能看见的重复，只提示
    let mut same_head = Vec::new();
    for i in 1..paras.len() {
        let a: String = paras[i - 1].chars().take(6).collect();
        let b: String = paras[i].chars().take(6).collect();
        if a.chars().count() == 6 && a == b {
            same_head.push(i);
        }
    }
    if !same_head.is_empty() {
        issues.push(issue(
            profile,
            "style.repeat_head",
            "重复",
            format!("{} 处相邻段落开头相同", same_head.len()),
            same_head,
            vec![],
            None,
        ));
    }
    // 敏感词（作者自定义层）
    let hits: Vec<&String> = sensitive
        .iter()
        .filter(|w| !w.is_empty() && text.contains(w.as_str()))
        .collect();
    if !hits.is_empty() {
        issues.push(issue(
            profile,
            "structure.sensitive",
            "合规",
            format!(
                "命中自定义敏感词：{}",
                hits.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
            vec![],
            vec![],
            None,
        ));
    }
    (m, issues)
}

async fn custom_sensitive(db: &mut SqliteConnection) -> Result<Vec<String>, String> {
    let Some(raw) = get(db, "app-settings", "ew-local-sensitive-words").await? else {
        return Ok(Vec::new());
    };
    let lexicon: Value = if let Some(s) = raw.as_str() {
        serde_json::from_str(s).unwrap_or(Value::Null)
    } else {
        raw.clone()
    };
    Ok(lexicon["custom"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["word"].as_str().map(str::to_owned))
        .collect())
}

pub struct CheckRequest<'a> {
    pub book_id: &'a str,
    pub text: &'a str,
    pub chapter_id: Option<&'a str>,
    pub artifact_id: &'a str,
    pub reviewed_revision: i64,
    pub profile_id: Option<&'a str>,
    /// 作者要求或起草时定下的篇幅；没有时按画像区间核对
    pub target_words: Option<usize>,
}

/// 指纹基线：绑定的文风档案优先，其次作者自己确认过的样本（样本不足时没有基线）。
async fn fingerprint_baseline(
    db: &mut SqliteConnection,
    book_id: &str,
) -> Result<Option<(String, Value)>, String> {
    if book_id.is_empty() {
        return Ok(None);
    }
    let Some(style) = get(db, canon::CANON_NS, &format!("style:{book_id}")).await? else {
        return Ok(None);
    };
    if style["insufficient"] == true || !style["metrics"]["fingerprint"].is_object() {
        return Ok(None);
    }
    Ok(Some((
        "作者确认的样本".to_owned(),
        style["metrics"]["fingerprint"].clone(),
    )))
}

/// 完整的确定性报告：结构问题、该章状态疑点及作者样本统计；`critic` 留给评审填充。
pub async fn check(db: &mut SqliteConnection, req: &CheckRequest<'_>) -> Result<Value, String> {
    let profile_id = match req.profile_id.filter(|p| !p.is_empty()) {
        Some(p) => p.to_owned(),
        None => canon::book_profile_id(db, req.book_id).await?,
    };
    let profile = canon::platform_profile(db, &profile_id).await?;
    let sensitive = custom_sensitive(db).await?;
    let (metrics, mut issues) = rule_issues(req.text, &profile, &sensitive, req.target_words);
    if let Some(chapter_id) = req.chapter_id {
        for suspect in canon::list_suspects(db, req.book_id).await? {
            if suspect["chapterId"] != chapter_id {
                continue;
            }
            let quotes = suspect["quotes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|q| q.as_str().map(str::to_owned))
                .collect::<Vec<_>>();
            let code = suspect["code"].as_str().unwrap_or("state.conflict");
            issues.push(json!({"id":suspect["issueKey"],"source":"rule","code":code,"dimension":"连续性","level":level_for(&profile,code),
                "message":suspect["message"],"paragraphs":[],"quotes":quotes,"fix":"确认是回忆、伪装或合理剧情则驳回；否则修改本章或前文"}));
        }
    }
    let drift = fingerprint_baseline(db, req.book_id)
        .await?
        .map(|(label, baseline)| {
            crate::writing_style::drift(&metrics["fingerprint"], &baseline, &label)
        });
    finish_report(req, &profile_id, issues, metrics, drift)
}

fn finish_report(
    req: &CheckRequest<'_>,
    profile_id: &str,
    issues: Vec<Value>,
    metrics: Value,
    drift: Option<Value>,
) -> Result<Value, String> {
    let mut report = json!({"version":1,"artifactId":req.artifact_id,"reviewedRevision":req.reviewed_revision,"reviewedFingerprint":fingerprint(req.text),
        "rulesetId":"none","chapterId":req.chapter_id,"profileId":profile_id,
        "issues":issues,"metrics":metrics,"critic":{"status":"not_run"}});
    if let Some(drift) = drift {
        report["styleDrift"] = drift;
    }
    let mut report = crate::writing_schema::canonical_arguments(&report);
    if report["chapterId"].is_null() {
        report.as_object_mut().unwrap().remove("chapterId");
    }
    crate::writing_schema::validate_document("qualityReport", &report)?;
    let blocked = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["level"] == "block");
    report["blocked"] = json!(blocked);
    Ok(report)
}
