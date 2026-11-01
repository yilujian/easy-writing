//! 局部采用在正式保存事务内重算。选段外沿用原节点、段落属性和行内标记。
use serde_json::{json, Value};

fn text_node(s: &str) -> Value {
    json!({"type":"text","text":s})
}
fn paragraph(s: &str) -> Value {
    if s.is_empty() {
        json!({"type":"paragraph"})
    } else {
        json!({"type":"paragraph","content":[text_node(s)]})
    }
}
fn inline_text(node: &Value) -> Option<&str> {
    if node["type"] == "hardBreak" {
        Some("\n")
    } else {
        node["text"].as_str()
    }
}
fn block_text(node: &Value) -> String {
    if let Some(text) = inline_text(node) {
        return text.to_owned();
    }
    let children = node["content"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let inline = matches!(
        node["type"].as_str(),
        Some("paragraph" | "heading" | "codeBlock")
    );
    children
        .iter()
        .map(block_text)
        .collect::<Vec<_>>()
        .join(if inline { "" } else { "\n" })
}
fn slice(row: &Value, from: usize, to: usize) -> Result<Vec<Value>, String> {
    let mut offset = 0;
    let mut parts = Vec::new();
    for node in row["content"].as_array().into_iter().flatten() {
        let s = inline_text(node).ok_or("选段含无法安全定位的内联元素")?;
        let a = from.saturating_sub(offset).min(s.len());
        let b = to.saturating_sub(offset).min(s.len());
        if a < b {
            let mut part = node.clone();
            if part["type"] != "hardBreak" {
                part["text"] = json!(s.get(a..b).ok_or("选段边界无效")?);
            }
            parts.push(part);
        }
        offset += s.len();
    }
    Ok(parts)
}
pub fn replace(
    base: &str,
    stored: &Value,
    range: &Value,
    replacement: &str,
) -> Result<(String, Value), String> {
    let original = range["text"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("缺少选段原文")?;
    let index = range["occurrence"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("选段位置无效")? as usize;
    let (start, _) = base
        .match_indices(original)
        .nth(index - 1)
        .ok_or("选段原文已变化，请重新定位")?;
    let end = start + original.len();
    let mut doc = if stored.is_null() {
        json!({"type":"doc","content":base.split('\n').map(paragraph).collect::<Vec<_>>()})
    } else if let Some(raw) = stored.as_str() {
        if raw == base {
            json!({"type":"doc","content":base.split('\n').map(paragraph).collect::<Vec<_>>()})
        } else {
            serde_json::from_str(raw)
                .map_err(|_| "历史排版无法安全定位选段，请先在编辑器保存该章")?
        }
    } else {
        stored.clone()
    };
    let rows = doc["content"]
        .as_array_mut()
        .ok_or("章节格式不支持安全定位，原文未修改")?;
    let lines: Vec<String> = rows.iter().map(block_text).collect();
    if lines.join("\n") != base {
        return Err("章节排版与纯文本位置不一致，原文未修改".into());
    }
    let mut offset = 0;
    let mut a = None;
    let mut b = None;
    for (i, line) in lines.iter().enumerate() {
        if a.is_none() && start >= offset && start <= offset + line.len() {
            a = Some((i, start - offset));
        }
        if end >= offset && end <= offset + line.len() {
            b = Some((i, end - offset));
            break;
        }
        offset += line.len() + 1;
    }
    let (first, left) = a.ok_or("选段起点无效")?;
    let (last, right) = b.ok_or("选段终点无效")?;
    if first == last
        && rows[first]["content"]
            .as_array()
            .is_some_and(|children| children.iter().any(|n| n["content"].is_array()))
    {
        let local = lines[first][..left].match_indices(original).count() + 1;
        let (_, changed) = replace(
            &lines[first],
            &rows[first],
            &json!({"text":original,"occurrence":local}),
            replacement,
        )?;
        rows[first] = changed;
        return Ok((
            format!("{}{replacement}{}", &base[..start], &base[end..]),
            doc,
        ));
    }
    let prefix = slice(&rows[first], 0, left)?;
    let suffix = slice(&rows[last], right, usize::MAX)?;
    let lines: Vec<_> = replacement.split('\n').collect();
    let mut changed = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let mut row = if i == 0 {
            rows[first].clone()
        } else if i + 1 == lines.len() {
            rows[last].clone()
        } else {
            paragraph("")
        };
        let mut parts = if i == 0 { prefix.clone() } else { vec![] };
        if !line.is_empty() {
            parts.push(text_node(line));
        }
        if i + 1 == lines.len() {
            parts.extend(suffix.clone());
        }
        if parts.is_empty() {
            row.as_object_mut().ok_or("段落无效")?.remove("content");
        } else {
            row["content"] = json!(parts);
        }
        changed.push(row);
    }
    rows.splice(first..=last, changed);
    Ok((
        format!("{}{replacement}{}", &base[..start], &base[end..]),
        doc,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserve_outside_across_paragraphs() {
        let doc = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"align":"left"},"content":[{"type":"text","text":"前","marks":[{"type":"bold"}]},{"type":"text","text":"原"}]},{"type":"paragraph","content":[{"type":"text","text":"文后","marks":[{"type":"italic"}]}]},paragraph("末")]});
        let (text, new) = replace(
            "前原\n文后\n末",
            &doc,
            &json!({"text":"原\n文","occurrence":1}),
            "新\n句",
        )
        .unwrap();
        assert_eq!(text, "前新\n句后\n末");
        assert_eq!(
            new["content"][0]["content"][0],
            doc["content"][0]["content"][0]
        );
        assert_eq!(new["content"][0]["attrs"], doc["content"][0]["attrs"]);
        assert_eq!(
            new["content"][1]["content"][1]["marks"],
            doc["content"][1]["content"][0]["marks"]
        );
        assert_eq!(new["content"][2], doc["content"][2]);
    }
}
