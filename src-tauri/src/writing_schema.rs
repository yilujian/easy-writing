//! 状态层文档的 JSON Schema（章节卡、质量报告）。校验和给模型看的提示词用同一份。
use serde_json::{json, Value};
use std::{collections::HashMap, sync::OnceLock};

struct Contracts {
    /// 作品状态层文档（章节卡、质量报告）的校验器。
    documents: HashMap<String, jsonschema::Validator>,
    /// 同一份 Schema 的原文，提取章节卡时给模型看。
    schemas: HashMap<String, Value>,
}
static CONTRACTS: OnceLock<Result<Contracts, String>> = OnceLock::new();
fn contracts() -> Result<&'static Contracts, String> {
    CONTRACTS
        .get_or_init(|| {
            let definitions: Value = serde_json::from_str(include_str!("contracts/documents.json"))
                .map_err(|e| e.to_string())?;
            let compile =
                |section: &str| -> Result<HashMap<String, jsonschema::Validator>, String> {
                    definitions[section]
                        .as_object()
                        .ok_or("工具契约格式错误")?
                        .iter()
                        .map(|(name, schema)| {
                            Ok((
                                name.clone(),
                                jsonschema::validator_for(schema).map_err(|e| e.to_string())?,
                            ))
                        })
                        .collect()
                };
            Ok(Contracts {
                documents: compile("documents")?,
                schemas: definitions["documents"]
                    .as_object()
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default(),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// JSON 的整数允许写成 1.0；在边界统一为整数，业务层不再各自猜测类型。
pub fn canonical_arguments(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_arguments).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), canonical_arguments(v)))
                .collect(),
        ),
        Value::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap();
            if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
                json!(f as i64)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

/// 契约里声明的文档类型名（chapterCard、qualityReport 等）。
#[cfg(test)]
pub fn document_kinds() -> Result<Vec<String>, String> {
    let mut kinds = contracts()?.documents.keys().cloned().collect::<Vec<_>>();
    kinds.sort();
    Ok(kinds)
}

/// 用与模型侧相同的 Schema 校验文档；调用方先经过 `canonical_arguments`，1.0 这类整数按整数处理。
/// 返回带字段路径的问题列表，空表示通过。
pub fn document_issues(kind: &str, value: &Value) -> Result<Vec<Value>, String> {
    let validator = contracts()?
        .documents
        .get(kind)
        .ok_or_else(|| format!("未知文档类型：{kind}"))?;
    Ok(validator
        .iter_errors(value)
        .take(8)
        .map(|e| {
            json!({"field":e.instance_path.to_string(),"message":e.to_string().chars().take(240).collect::<String>()})
        })
        .collect())
}

/// 文档类型的 JSON Schema 原文（给模型看的那份，与校验用的是同一份）。
pub fn document_schema(kind: &str) -> Result<Value, String> {
    contracts()?
        .schemas
        .get(kind)
        .cloned()
        .ok_or_else(|| format!("未知文档类型：{kind}"))
}

pub fn validate_document(kind: &str, value: &Value) -> Result<(), String> {
    let issues = document_issues(kind, value)?;
    if issues.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{kind} 不符合契约：{}",
        issues
            .iter()
            .map(|i| format!(
                "{} {}",
                i["field"].as_str().unwrap_or("$"),
                i["message"].as_str().unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join("；")
    ))
}
