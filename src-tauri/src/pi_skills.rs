//! Agent(Pi版本) 的技能。内置技能随应用分发（agent-pi/skills），作者技能放在应用数据目录
//! pi-agent/skills/<id>/SKILL.md，格式沿用 Pi 原生（开头 name/description，正文是给模型的说明）。
//! Pi 启动时按启用列表逐个传 --skill；作者改过的内置技能用同名覆盖文件，"恢复默认"就是删掉覆盖。
//! 脚本只跑技能目录 scripts/ 下的 JavaScript，由跑 Pi 的那个 Node 执行，设超时、可取消。
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[path = "pi_skill_install.rs"]
mod install;

const OUTPUT_CAP: usize = 64 * 1024;
const IMPORT_CAP: u64 = 20 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub struct Dirs {
    pub builtin: PathBuf,
    pub author: PathBuf,
    pub state: PathBuf,
}
pub fn dirs(builtin: &Path, pi_root: &Path) -> Dirs {
    Dirs {
        builtin: builtin.to_path_buf(),
        author: pi_root.join("skills"),
        state: pi_root.join("skills.json"),
    }
}
struct Head {
    name: String,
    display_name: String,
    description: String,
    manual: bool,
}
/// 只认开头 `---` 块里的 name、description、disable-model-invocation；其余行原样留在正文。
fn parse(text: &str) -> (Head, String) {
    let text = text.replace("\r\n", "\n");
    let mut head = Head {
        name: String::new(),
        display_name: String::new(),
        description: String::new(),
        manual: false,
    };
    let Some(rest) = text.strip_prefix("---\n") else {
        return (head, text.trim().to_owned());
    };
    let Some(end) = rest.find("\n---") else {
        return (head, text.trim().to_owned());
    };
    let mut metadata = false;
    for line in rest[..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote(value.trim());
        if line.starts_with(' ') || line.starts_with('\t') {
            if metadata && key.trim() == "display-name" {
                head.display_name = value;
            }
            continue;
        }
        metadata = key.trim() == "metadata";
        match key.trim() {
            "name" => head.name = value,
            "description" => head.description = value,
            "disable-model-invocation" => head.manual = value == "true",
            _ => {}
        }
    }
    let body = rest[end + 4..].trim_start_matches('-').trim().to_owned();
    (head, body)
}
/// 去掉成对的引号并还原 \" 和 \\；没有引号的原样返回。
fn unquote(value: &str) -> String {
    if value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''))) {
        let inner = &value[1..value.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some(next) => out.push(next),
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        value.to_owned()
    }
}
fn render(name: &str, description: &str, manual: bool, body: &str) -> String {
    render_named(name, "", description, manual, body)
}
fn render_named(name: &str, display_name: &str, description: &str, manual: bool, body: &str) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let mut text = format!(
        "---\nname: {}\ndescription: {}\n",
        name.trim(),
        quote(description.trim())
    );
    if manual {
        text.push_str("disable-model-invocation: true\n");
    }
    if !display_name.trim().is_empty() {
        text.push_str(&format!("metadata:\n  display-name: {}\n", quote(display_name.trim())));
    }
    text.push_str("---\n\n");
    text.push_str(body.trim());
    text.push('\n');
    text
}
/// 目录名：保留中英文、数字、连字符和下划线，其余换成连字符；太长截断；空则用 skill。
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.trim().chars() {
        if c.is_alphanumeric() || c == '_' {
            out.extend(c.to_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out: String = out.trim_matches('-').chars().take(64).collect();
    if out.is_empty() {
        "skill".into()
    } else {
        out
    }
}
fn disabled(d: &Dirs) -> Vec<String> {
    fs::read(&d.state)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|v| v["disabled"].as_array().cloned())
        .map(|list| list.into_iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}
fn write_disabled(d: &Dirs, list: &[String]) -> Result<(), String> {
    if let Some(parent) = d.state.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&d.state, json!({"disabled":list}).to_string()).map_err(err)
}
fn scripts_of(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir.join("scripts"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|n| n.ends_with(".js") || n.ends_with(".mjs") || n.ends_with(".cjs"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}
fn subdirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().join("SKILL.md").is_file())
                .filter_map(|e| e.file_name().to_str().map(|n| (n.to_owned(), e.path())))
                .filter(|(n, _)| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}
/// 技能名里不能有空白：Pi 的 /skill:名字 命令按第一个空格切名字，带空格的名字永远对不上、技能不会展开。
pub fn compact_name(name: &str) -> String {
    name.split_whitespace().collect()
}
fn entry(id: &str, dir: &Path, file: &Path, source: &str, overridden: bool, enabled: bool) -> Result<Value, String> {
    let text = fs::read_to_string(file).map_err(err)?;
    let (mut head, body) = parse(&text);
    // 作者目录里旧文件的名字带空格（早期蒸馏默认名"（第 1—28 章）"）：顺手改掉，否则这个技能永远用不上
    if (source == "custom" || overridden) && head.name.chars().any(char::is_whitespace) {
        head.name = compact_name(&head.name);
        fs::write(file, render_named(&head.name, &head.display_name, &head.description, head.manual, &body)).map_err(err)?;
    }
    let updated = fs::metadata(file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let inherited_display = if overridden && head.display_name.is_empty() {
        fs::read_to_string(dir.join("SKILL.md")).ok().map(|text| parse(&text).0.display_name).unwrap_or_default()
    } else { String::new() };
    let display_name = if !head.display_name.is_empty() { &head.display_name }
        else if !inherited_display.is_empty() { &inherited_display }
        else if !head.name.is_empty() { &head.name } else { id };
    Ok(json!({
        "id": id,
        "name": if head.name.is_empty() { id.to_owned() } else { head.name.clone() },
        "displayName": display_name,
        "description": head.description,
        "manual": head.manual,
        "instructions": body,
        "source": source,
        "overridden": overridden,
        "enabled": enabled,
        "dir": dir,
        "file": file,
        "scripts": scripts_of(dir),
        "updatedAt": updated,
    }))
}
/// 内置在前、作者的在后；作者改过的内置技能读覆盖文件，脚本仍在内置目录。
pub fn list(d: &Dirs) -> Result<Vec<Value>, String> {
    let _access=install::access(d)?;
    list_unlocked(d)
}
fn list_unlocked(d: &Dirs) -> Result<Vec<Value>, String> {
    let off = disabled(d);
    let mut out = Vec::new();
    let builtin = subdirs(&d.builtin);
    for (id, dir) in &builtin {
        let override_file = d.author.join(id).join("SKILL.md");
        let overridden = override_file.is_file();
        let file = if overridden { override_file } else { dir.join("SKILL.md") };
        out.push(entry(id, dir, &file, "builtin", overridden, !off.contains(id))?);
    }
    for (id, dir) in subdirs(&d.author) {
        if builtin.iter().any(|(b, _)| b == &id) {
            continue;
        }
        out.push(entry(&id, &dir, &dir.join("SKILL.md"), "custom", false, !off.contains(&id))?);
    }
    Ok(out)
}
/// Pi 启动时逐个传 --skill 的文件；停用的不传。
pub fn enabled_paths(d: &Dirs) -> Vec<PathBuf> {
    list(d)
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s["enabled"] == true)
        .filter_map(|s| s["file"].as_str().map(PathBuf::from))
        .collect()
}
pub fn allowed_roots(d: &Dirs) -> Vec<PathBuf> {
    vec![d.builtin.clone(), d.author.clone()]
}
fn text(args: &Value, key: &str) -> String {
    args[key].as_str().unwrap_or_default().trim().to_owned()
}
fn find<'a>(items: &'a [Value], id: &str) -> Option<&'a Value> {
    items.iter().find(|s| s["id"] == id)
}
fn check_head(name: &str, description: &str, instructions: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > 60 {
        return Err("技能名称不能为空，不超过 60 字".into());
    }
    if description.is_empty() || description.chars().count() > 300 {
        return Err("请用一句话说明这个技能什么时候用，不超过 300 字".into());
    }
    if instructions.is_empty() || instructions.len() > 200_000 {
        return Err("技能说明不能为空，不超过 20 万字符".into());
    }
    Ok(())
}
/// 采用"技能候选"（作者在右栏确认后）：按候选内容写成作者技能目录里的一个技能。
/// replaceId 指向作者自己的技能时原地更新；文件只允许 references/、assets/、scripts/，脚本只认 JavaScript。
pub fn adopt(d: &Dirs, draft: &Value) -> Result<Value, String> {
    let fields: Value = serde_json::from_str(draft["content"].as_str().ok_or("技能候选内容无效")?)
        .map_err(|_| "技能候选内容无效".to_string())?;
    let _access = install::access(d)?;
    install_bundle(d, &fields)
}
pub(super) fn install_distilled(d: &Dirs, project: i64, bundle: &Value) -> Result<Value, String> {
    let _access = install::access(d)?;
    let items = list_unlocked(d)?;
    let base = compact_name(&text(bundle, "name"));
    if base.is_empty() {
        return Err("缺少蒸馏技能名称".into());
    }
    for number in 1..=items.len() + 1 {
        let suffix = if number == 1 {
            String::new()
        } else {
            format!("（{number}）")
        };
        let name = base
            .chars()
            .take(60 - suffix.chars().count())
            .collect::<String>()
            + &suffix;
        let mut fields = bundle.clone();
        fields["name"] = json!(name);
        fields["replaceId"] = Value::Null;
        if let Some(item) = items.iter().find(|i| {
            i["name"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(&name))
        }) {
            if item["source"] != "custom" {
                continue;
            }
            let dir = Path::new(item["dir"].as_str().ok_or("技能目录无效")?);
            let source = fs::read_to_string(dir.join("references/examples.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            if source
                .as_ref()
                .and_then(|v| v["source"]["projectId"].as_i64())
                != Some(project)
            {
                continue;
            }
            fields["replaceId"] = item["id"].clone();
        }
        return install_bundle(d, &fields);
    }
    Err("未能分配技能名称".into())
}
fn bundle_files(fields: &Value) -> Result<Vec<(String, String)>, String> {
    let mut budget = IMPORT_CAP;
    let mut writes = Vec::new();
    for file in fields["files"].as_array().into_iter().flatten() {
        let path = file["path"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .replace('\\', "/");
        let content = file["content"].as_str().ok_or("技能文件内容必须是文本")?;
        let script = path.starts_with("scripts/");
        let ok = (path.starts_with("references/") || path.starts_with("assets/") || script)
            && !path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            && (!script
                || path.ends_with(".js")
                || path.ends_with(".mjs")
                || path.ends_with(".cjs"));
        if !ok {
            return Err(format!("不允许写入 {path}"));
        }
        let size = content.len() as u64;
        if size > 2 * 1024 * 1024 || size > budget {
            return Err(format!("{path} 太大"));
        }
        budget -= size;
        writes.push((path, content.to_owned()));
    }
    Ok(writes)
}
pub(super) fn candidate_fields(d: &Dirs, args: &Value) -> Result<Value, String> {
    let name = compact_name(&text(args, "name"));
    let description = text(args, "description");
    let instructions = text(args, "instructions");
    check_head(&name, &description, &instructions)?;
    let files = bundle_files(args)?
        .into_iter()
        .map(|(path, content)| json!({"path":path,"content":content}))
        .collect::<Vec<_>>();
    let target = text(args, "replaceId");
    let replace = if target.is_empty() {
        Value::Null
    } else {
        let skills = list(d)?;
        let item = skills
            .iter()
            .find(|s| s["id"] == target || s["name"] == target)
            .ok_or("要替换的技能不存在")?;
        if item["source"] != "custom" {
            return Err("只能替换作者自己的技能".into());
        }
        item["id"].clone()
    };
    Ok(
        json!({"name":name,"description":description,"instructions":instructions,"files":files,"replaceId":replace}),
    )
}
fn install_bundle(d: &Dirs, fields: &Value) -> Result<Value, String> {
    let name = compact_name(&text(fields, "name"));
    let description = text(fields, "description");
    let instructions = fields["instructions"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    check_head(&name, &description, &instructions)?;
    let items = list_unlocked(d)?;
    let replace = text(fields, "replaceId");
    let id = if replace.is_empty() {
        let base = slug(&name);
        let mut candidate = base.clone();
        let mut n = 2;
        while find(&items, &candidate).is_some() || d.author.join(&candidate).exists() {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        candidate
    } else {
        let item = find(&items, &replace).ok_or("要替换的技能不存在")?;
        if item["source"] != "custom" {
            return Err("只能替换作者自己的技能；内置技能请在技能页编辑".into());
        }
        replace.clone()
    };
    if items.iter().any(|s| {
        s["id"] != id
            && s["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(&name))
    }) {
        return Err("已有同名技能".into());
    }
    let writes = bundle_files(fields)?;
    install::publish(
        d,
        &id,
        &render(&name, &description, false, &instructions),
        writes,
    )?;
    let items = list_unlocked(d)?;
    Ok(find(&items, &id)
        .cloned()
        .unwrap_or(json!({"id": id, "name": name})))
}
fn copy_dir(from: &Path, to: &Path, budget: &mut u64) -> Result<(), String> {
    fs::create_dir_all(to).map_err(err)?;
    for item in fs::read_dir(from).map_err(err)?.flatten() {
        let name = item.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let path = item.path();
        if path.is_dir() {
            copy_dir(&path, &to.join(&name), budget)?;
        } else if path.is_file() {
            let size = fs::metadata(&path).map_err(err)?.len();
            if size > *budget {
                return Err("技能文件夹超过 20 MB".into());
            }
            *budget -= size;
            fs::copy(&path, to.join(&name)).map_err(err)?;
        }
    }
    Ok(())
}
pub fn dispatch(d: &Dirs, args: Value) -> Result<Value, String> {
    let _access = install::access(d)?;
    match args["op"].as_str().unwrap_or_default() {
        "list" => Ok(json!(list_unlocked(d)?)),
        "save" => {
            let name = compact_name(&text(&args, "name"));
            let description = text(&args, "description");
            let instructions = text(&args, "instructions");
            check_head(&name, &description, &instructions)?;
            let manual = args["manual"] == true;
            let items = list_unlocked(d)?;
            let id = text(&args, "id");
            let (id, dir) = if id.is_empty() {
                let base = slug(&name);
                let mut candidate = base.clone();
                let mut n = 2;
                while find(&items, &candidate).is_some() || d.author.join(&candidate).exists() {
                    candidate = format!("{base}-{n}");
                    n += 1;
                }
                (candidate.clone(), d.author.join(&candidate))
            } else {
                find(&items, &id).ok_or("技能不存在")?;
                (id.clone(), d.author.join(&id))
            };
            if items
                .iter()
                .any(|s| s["id"] != id && s["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&name)))
            {
                return Err("已有同名技能".into());
            }
            let display_name = if args.get("displayName").is_some() {
                let label = text(&args, "displayName");
                if label.is_empty() || label.chars().count() > 60 {
                    return Err("技能显示名称不能为空，不超过 60 字".into());
                }
                label
            } else {
                find(&items, &id).and_then(|s| s["displayName"].as_str()).unwrap_or(&name).to_owned()
            };
            fs::create_dir_all(&dir).map_err(err)?;
            fs::write(dir.join("SKILL.md"), render_named(&name, &display_name, &description, manual, &instructions)).map_err(err)?;
            let items = list_unlocked(d)?;
            Ok(find(&items, &id).cloned().unwrap_or(Value::Null))
        }
        // 往作者技能目录写参考文件：只允许 references/ 和 assets/ 下的相对路径，文本内容，每个不超过 2 MB。
        "save_files" => {
            let id = text(&args, "id");
            let items = list_unlocked(d)?;
            let item = find(&items, &id).ok_or("技能不存在")?;
            if item["source"] != "custom" {
                return Err("只能给作者自己的技能写文件".into());
            }
            let dir = d.author.join(&id);
            let files = args["files"].as_array().ok_or("没有要写的文件")?;
            for file in files {
                let path = file["path"].as_str().unwrap_or_default().trim().replace('\\', "/");
                let content = file["content"].as_str().ok_or("文件内容必须是文本")?;
                let ok = (path.starts_with("references/") || path.starts_with("assets/"))
                    && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..");
                if !ok {
                    return Err(format!("不允许写入 {path}"));
                }
                if content.len() > 2 * 1024 * 1024 {
                    return Err(format!("{path} 超过 2 MB"));
                }
                let target = dir.join(&path);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                fs::write(target, content).map_err(err)?;
            }
            let items = list_unlocked(d)?;
            Ok(find(&items, &id).cloned().unwrap_or(Value::Null))
        }
        "read_files" => {
            // 读技能目录里的参考文件（references/ 下）：写作时平台按功能类型挑范例要用；只读文本，不越出目录。
            let id = text(&args, "id");
            let items = list_unlocked(d)?;
            let item = find(&items, &id).ok_or("技能不存在")?;
            let dir = PathBuf::from(item["dir"].as_str().unwrap_or_default());
            let paths = args["paths"].as_array().ok_or("没有要读的文件")?;
            let mut out = Vec::new();
            for path in paths {
                let path = path.as_str().unwrap_or_default().trim().replace('\\', "/");
                let ok = path.starts_with("references/") && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..");
                if !ok {
                    return Err(format!("不允许读取 {path}"));
                }
                let content = fs::read_to_string(dir.join(&path)).ok();
                out.push(json!({"path": path, "content": content}));
            }
            Ok(json!(out))
        }
        "delete" => {
            let id = text(&args, "id");
            let items = list_unlocked(d)?;
            let item = find(&items, &id).ok_or("技能不存在")?;
            let target = d.author.join(&id);
            if item["source"] == "builtin" {
                // 内置技能只能恢复默认：删掉覆盖文件
                if item["overridden"] == true {
                    fs::remove_dir_all(&target).map_err(err)?;
                }
            } else {
                fs::remove_dir_all(&target).map_err(err)?;
            }
            let mut off = disabled(d);
            off.retain(|x| x != &id);
            write_disabled(d, &off)?;
            Ok(json!(list_unlocked(d)?))
        }
        "enable" => {
            let id = text(&args, "id");
            find(&list_unlocked(d)?, &id).ok_or("技能不存在")?;
            let mut off = disabled(d);
            off.retain(|x| x != &id);
            if args["enabled"] == false {
                off.push(id);
            }
            write_disabled(d, &off)?;
            Ok(json!(list_unlocked(d)?))
        }
        "import" => {
            let path = PathBuf::from(text(&args, "path"));
            let (file, from) = if path.is_dir() {
                (path.join("SKILL.md"), path.clone())
            } else {
                (path.clone(), path.parent().map(Path::to_path_buf).ok_or("路径无效")?)
            };
            if !file.is_file() || file.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
                return Err("请选择 SKILL.md 文件或包含它的文件夹".into());
            }
            let (head, body) = parse(&fs::read_to_string(&file).map_err(err)?);
            let name = compact_name(&if head.name.is_empty() {
                from.file_name().and_then(|n| n.to_str()).unwrap_or("skill").to_owned()
            } else {
                head.name.clone()
            });
            if body.is_empty() {
                return Err("这个 SKILL.md 没有说明正文".into());
            }
            let id = slug(&name);
            let items = list_unlocked(d)?;
            if find(&items, &id).is_some() || d.author.join(&id).exists() {
                return Err(format!("已有技能「{name}」，请先删除再导入"));
            }
            let target = d.author.join(&id);
            let mut budget = IMPORT_CAP;
            if path.is_dir() {
                copy_dir(&from, &target, &mut budget)?;
            } else {
                fs::create_dir_all(&target).map_err(err)?;
                fs::copy(&file, target.join("SKILL.md")).map_err(err)?;
            }
            if head.name.is_empty() || head.description.is_empty() {
                fs::write(
                    target.join("SKILL.md"),
                    render_named(&name, &head.display_name, if head.description.is_empty() { "导入的技能" } else { &head.description }, head.manual, &body),
                )
                .map_err(err)?;
            }
            let items = list_unlocked(d)?;
            Ok(find(&items, &id).cloned().unwrap_or(Value::Null))
        }
        _ => Err("未知技能操作".into()),
    }
}

type Running = Mutex<HashMap<String, Arc<Mutex<Option<Child>>>>>;
fn running() -> &'static Running {
    static RUNNING: OnceLock<Running> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}
fn drain(mut reader: impl Read + Send + 'static) -> thread::JoinHandle<(String, bool)> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        let mut truncated = false;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            if out.len() < OUTPUT_CAP {
                let take = n.min(OUTPUT_CAP - out.len());
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            } else {
                truncated = true;
            }
        }
        (String::from_utf8_lossy(&out).into_owned(), truncated)
    })
}
/// 跑技能目录 scripts/ 下的一个 JavaScript 文件；阻塞直到结束、超时或被取消。
pub fn run_script(d: &Dirs, node: &Path, args: &Value, timeout: Duration) -> Result<Value, String> {
    let run_id = text(args, "id");
    let skill = text(args, "skill");
    let script = text(args, "script");
    if run_id.is_empty() {
        return Err("运行编号缺失".into());
    }
    let items = list(d)?;
    let item = find(&items, &skill).ok_or("技能不存在")?;
    if item["enabled"] != true {
        return Err("这个技能已停用".into());
    }
    let dir = PathBuf::from(item["dir"].as_str().unwrap_or_default());
    if !scripts_of(&dir).iter().any(|s| s == &script) {
        return Err("脚本不在这个技能的 scripts 目录里，或不是 JavaScript".into());
    }
    let root = dir.canonicalize().map_err(err)?;
    let path = root.join("scripts").join(&script).canonicalize().map_err(err)?;
    if !path.starts_with(&root) {
        return Err("脚本路径越界".into());
    }
    let extra: Vec<String> = args["args"]
        .as_array()
        .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    if extra.len() > 32 || extra.iter().any(|a| a.len() > 4096) {
        return Err("脚本参数过多或过长".into());
    }
    let mut cmd = Command::new(node);
    cmd.arg(dunce::simplified(&path))
        .args(&extra)
        .current_dir(&root)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("EW_SKILL_DIR", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::background_process::hide_console(&mut cmd);
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(err)?;
    let out = drain(child.stdout.take().ok_or("脚本输出不可用")?);
    let errs = drain(child.stderr.take().ok_or("脚本输出不可用")?);
    let slot = Arc::new(Mutex::new(Some(child)));
    running().lock().unwrap().insert(run_id.clone(), slot.clone());
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        let mut guard = slot.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            cancelled = true;
            break None;
        };
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                running().lock().unwrap().remove(&run_id);
                return Err(err(e));
            }
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        drop(guard);
        thread::sleep(Duration::from_millis(50));
    };
    running().lock().unwrap().remove(&run_id);
    let (stdout, out_cut) = out.join().unwrap_or_default();
    let (stderr, err_cut) = errs.join().unwrap_or_default();
    Ok(json!({
        "skill": skill,
        "script": script,
        "exitCode": status.and_then(|s| s.code()),
        "stdout": stdout,
        "stderr": stderr,
        "truncated": out_cut || err_cut,
        "timedOut": timed_out,
        "cancelled": cancelled,
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}
/// 取消正在跑的脚本：杀掉进程，run_script 随后以 cancelled 返回。
pub fn cancel_script(run_id: &str) -> bool {
    let slot = running().lock().unwrap().get(run_id).cloned();
    let Some(slot) = slot else {
        return false;
    };
    let mut guard = slot.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    true
}

#[cfg(all(test, feature = "local-tests"))]
mod tests {
    use super::*;
    struct Env(PathBuf, Dirs);
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Env {
        let root = std::env::temp_dir().join(format!("pi-skills-{}", uuid::Uuid::new_v4()));
        let builtin = root.join("builtin");
        fs::create_dir_all(builtin.join("novel-writing")).unwrap();
        fs::write(
            builtin.join("novel-writing/SKILL.md"),
            "---\nname: novel-writing\ndescription: 内置写作\n---\n\n内置说明\n",
        )
        .unwrap();
        let d = dirs(&builtin, &root.join("pi-agent"));
        Env(root, d)
    }
    fn op(d: &Dirs, name: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(name);
        dispatch(d, args)
    }
    fn node() -> Option<PathBuf> {
        std::env::var("EW_TEST_NODE").ok().map(PathBuf::from).or_else(|| {
            let out = Command::new("sh").args(["-c", "command -v node"]).output().ok()?;
            let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            (!path.is_empty()).then(|| PathBuf::from(path))
        })
    }
    #[test]
    fn frontmatter_round_trip_and_slug() {
        let (head, body) = parse(&render("写法 A", "用于 \"对白\"", true, "正文\n第二行"));
        assert_eq!(head.name, "写法 A");
        assert_eq!(head.description, "用于 \"对白\"");
        assert!(head.manual);
        assert_eq!(body, "正文\n第二行");
        let (plain, text) = parse("没有头部的说明");
        assert!(plain.name.is_empty());
        assert_eq!(text, "没有头部的说明");
        assert_eq!(slug("  对白 写法/Dialogue!! "), "对白-写法-dialogue");
        assert_eq!(slug("!!!"), "skill");
    }
    #[test]
    fn display_name_preserves_runtime_identity_and_author_overrides() {
        let e = fixture();
        let d = &e.1;
        let path = d.builtin.join("book-creation/SKILL.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, render_named("book-creation", "建书策划", "按需建书", false, "正文")).unwrap();
        let items = list(d).unwrap();
        let skill = find(&items, "book-creation").unwrap();
        assert_eq!(skill["name"], "book-creation");
        assert_eq!(skill["displayName"], "建书策划");
        assert!(enabled_paths(d).contains(&path));
        let saved = op(d, "save", json!({"id":"book-creation","name":"book-creation","description":"我的方法","instructions":"作者补充"})).unwrap();
        assert_eq!(saved["displayName"], "建书策划");
        assert_eq!(saved["name"], "book-creation");
        let raw = fs::read_to_string(d.author.join("book-creation/SKILL.md")).unwrap();
        assert_eq!(parse(&raw).0.display_name, "建书策划");
        // 旧覆盖文件没有显示名时继承内置中文名，正文保持原样。
        fs::write(d.author.join("book-creation/SKILL.md"), render("book-creation", "旧覆盖", false, "旧正文")).unwrap();
        let items = list(d).unwrap();
        assert_eq!(find(&items, "book-creation").unwrap()["displayName"], "建书策划");
        assert_eq!(find(&items, "book-creation").unwrap()["instructions"], "旧正文");
        op(d, "enable", json!({"id":"book-creation","enabled":false})).unwrap();
        assert!(!enabled_paths(d).iter().any(|p| p.to_string_lossy().contains("book-creation")));
    }
    #[test]
    fn skill_names_never_keep_whitespace_and_old_files_are_fixed_on_list() {
        let e = fixture();
        let d = &e.1;
        // 保存、采用、导入都去掉名字里的空白：Pi 的 /skill:名字 命令按第一个空格切名字
        let saved = op(d, "save", json!({"name":"《斩神》写法（第 1—28 章）","description":"x","instructions":"y"})).unwrap();
        assert_eq!(saved["name"], "《斩神》写法（第1—28章）");
        let draft = json!({"content": json!({"name":"对白 打磨","description":"d","instructions":"i","files":[]}).to_string()});
        assert_eq!(adopt(d, &draft).unwrap()["name"], "对白打磨");
        // 作者目录里早期蒸出的技能名带空格：列目录时改掉文件里的名字
        fs::create_dir_all(d.author.join("old")).unwrap();
        fs::write(d.author.join("old/SKILL.md"), "---\nname: 《旧书》写法（第 1—30 章）\ndescription: \"旧\"\n---\n\n正文\n").unwrap();
        let items = list(d).unwrap();
        let old = items.iter().find(|s| s["id"] == "old").unwrap();
        assert_eq!(old["name"], "《旧书》写法（第1—30章）");
        assert_eq!(old["instructions"], "正文");
        let (head, _) = parse(&fs::read_to_string(d.author.join("old/SKILL.md")).unwrap());
        assert_eq!(head.name, "《旧书》写法（第1—30章）", "文件本身也改了，Pi 启动加载到的就是无空格的名字");
    }
    #[test]
    fn save_delete_enable_and_builtin_override() {
        let e = fixture();
        let d = &e.1;
        let items = list(d).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["source"], "builtin");
        let saved = op(d, "save", json!({"name":"对白打磨","description":"作者要改对白时用","instructions":"先读章节再改对白"})).unwrap();
        assert_eq!(saved["id"], "对白打磨");
        assert_eq!(saved["source"], "custom");
        assert!(d.author.join("对白打磨/SKILL.md").is_file());
        assert!(op(d, "save", json!({"name":"对白打磨","description":"x","instructions":"y"})).unwrap_err().contains("同名"));
        let again = op(d, "save", json!({"id":"对白打磨","name":"对白打磨","description":"改过的说明","instructions":"新正文","manual":true})).unwrap();
        assert_eq!(again["description"], "改过的说明");
        assert_eq!(again["manual"], true);
        assert_eq!(enabled_paths(d).len(), 2);
        let off = op(d, "enable", json!({"id":"对白打磨","enabled":false})).unwrap();
        assert_eq!(off.as_array().unwrap().iter().find(|s| s["id"] == "对白打磨").unwrap()["enabled"], false);
        assert_eq!(enabled_paths(d).len(), 1);
        // 内置技能：保存写成覆盖文件，删除即恢复默认
        let edited = op(d, "save", json!({"id":"novel-writing","name":"novel-writing","description":"我改过的内置","instructions":"我的说明"})).unwrap();
        assert_eq!(edited["source"], "builtin");
        assert_eq!(edited["overridden"], true);
        assert_eq!(edited["instructions"], "我的说明");
        assert!(enabled_paths(d)[0].starts_with(&d.author));
        let restored = op(d, "delete", json!({"id":"novel-writing"})).unwrap();
        let builtin = restored.as_array().unwrap().iter().find(|s| s["id"] == "novel-writing").unwrap().clone();
        assert_eq!(builtin["overridden"], false);
        assert_eq!(builtin["instructions"], "内置说明");
        assert!(d.builtin.join("novel-writing/SKILL.md").is_file());
        let left = op(d, "delete", json!({"id":"对白打磨"})).unwrap();
        assert_eq!(left.as_array().unwrap().len(), 1);
        assert!(!d.author.join("对白打磨").exists());
        assert!(op(d, "delete", json!({"id":"没有"})).is_err());
    }
    #[test]
    fn adopt_skill_candidate_creates_and_replaces_author_skill() {
        let e = fixture();
        let d = &e.1;
        let draft = json!({"content": json!({"name":"章尾钩子","description":"收尾时用","instructions":"最后一段停在冲突上","files":[{"path":"references/notes.md","content":"备注"},{"path":"scripts/count.js","content":"console.log(1)"}]}).to_string()});
        let saved = adopt(d, &draft).unwrap();
        assert_eq!(saved["id"], "章尾钩子");
        assert_eq!(saved["source"], "custom");
        assert!(d.author.join("章尾钩子/references/notes.md").is_file());
        assert_eq!(saved["scripts"], json!(["count.js"]));
        assert!(adopt(d, &draft).unwrap_err().contains("同名"), "不带 replaceId 的同名候选不覆盖");
        let again = json!({"content": json!({"name":"章尾钩子","description":"改过","instructions":"新正文","replaceId":"章尾钩子"}).to_string()});
        assert_eq!(adopt(d, &again).unwrap()["description"], "改过");
        assert!(adopt(d, &json!({"content": json!({"name":"x","description":"y","instructions":"z","files":[{"path":"../evil","content":""}]}).to_string()})).is_err());
        assert!(adopt(d, &json!({"content": json!({"name":"x","description":"y","instructions":"z","files":[{"path":"scripts/run.py","content":""}]}).to_string()})).is_err());
        assert!(adopt(d, &json!({"content": json!({"name":"内置","description":"y","instructions":"z","replaceId":"novel-writing"}).to_string()})).unwrap_err().contains("作者自己"));
    }
    #[test]
    fn replacement_with_conflicting_paths_preserves_the_entire_previous_skill() {
        let env = fixture();
        let d = &env.1;
        let first = adopt(d,&json!({"content":json!({"name":"原技能","description":"测试","instructions":"原说明","files":[{"path":"references/a","content":"原文"}]}).to_string()})).unwrap();
        let id = first["id"].as_str().unwrap();
        let result = adopt(
            d,
            &json!({"content":json!({"name":"原技能","description":"测试","instructions":"新说明","replaceId":id,"files":[{"path":"references/a/sub","content":"不能写入"}]}).to_string()}),
        );
        assert!(result.is_err());
        let stored = list(d).unwrap();
        assert_eq!(find(&stored, id).unwrap()["instructions"], "原说明");
        assert_eq!(
            fs::read_to_string(d.author.join(id).join("references/a")).unwrap(),
            "原文"
        );
    }
    #[test]
    fn save_files_only_writes_reference_and_asset_paths_of_custom_skills() {
        let e = fixture();
        let d = &e.1;
        let saved = op(d, "save", json!({"name":"文风","description":"文风档案","instructions":"按范例写"})).unwrap();
        let id = saved["id"].as_str().unwrap().to_owned();
        op(d, "save_files", json!({"id":id,"files":[{"path":"references/examples.json","content":"{\"examples\":[]}"}]})).unwrap();
        assert_eq!(fs::read_to_string(d.author.join(&id).join("references/examples.json")).unwrap(), "{\"examples\":[]}");
        assert!(op(d, "save_files", json!({"id":id,"files":[{"path":"../x.json","content":""}]})).is_err());
        assert!(op(d, "save_files", json!({"id":id,"files":[{"path":"scripts/a.js","content":""}]})).is_err());
        assert!(op(d, "save_files", json!({"id":"novel-writing","files":[{"path":"references/a.json","content":""}]})).is_err());
    }
    #[test]
    fn import_copies_folder_and_rejects_duplicates() {
        let e = fixture();
        let d = &e.1;
        let src = e.0.join("incoming/pdf-tools");
        fs::create_dir_all(src.join("scripts")).unwrap();
        fs::write(src.join("SKILL.md"), "---\nname: pdf-tools\ndescription: 读 PDF\n---\n按说明用脚本\n").unwrap();
        fs::write(src.join("scripts/extract.js"), "console.log(1)").unwrap();
        fs::write(src.join("scripts/helper.py"), "print(1)").unwrap();
        let imported = op(d, "import", json!({"path":src})).unwrap();
        assert_eq!(imported["id"], "pdf-tools");
        assert_eq!(imported["scripts"], json!(["extract.js"]));
        assert!(op(d, "import", json!({"path":src})).unwrap_err().contains("已有技能"));
        let bare = e.0.join("incoming/bare/SKILL.md");
        fs::create_dir_all(bare.parent().unwrap()).unwrap();
        fs::write(&bare, "只有正文，没有头部").unwrap();
        let fixed = op(d, "import", json!({"path":bare})).unwrap();
        assert_eq!(fixed["name"], "bare");
        assert_eq!(fixed["description"], "导入的技能");
        assert!(op(d, "import", json!({"path":e.0.join("incoming/none")})).is_err());
    }
    #[test]
    fn scripts_run_inside_skill_dir_with_timeout_and_cancel() {
        let Some(node) = node() else { return };
        let e = fixture();
        let d = &e.1;
        let dir = d.author.join("tools");
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: tools\ndescription: 工具\n---\n用脚本\n").unwrap();
        fs::write(dir.join("scripts/hello.js"), "console.log('hi', process.argv.slice(2).join(','), process.cwd() === process.env.EW_SKILL_DIR); console.error('warn'); process.exit(3)").unwrap();
        fs::write(dir.join("scripts/slow.js"), "setTimeout(() => {}, 20000)").unwrap();
        fs::write(dir.join("scripts/evil.py"), "print(1)").unwrap();
        let result = run_script(d, &node, &json!({"id":"r1","skill":"tools","script":"hello.js","args":["a","b"]}), Duration::from_secs(20)).unwrap();
        assert_eq!(result["exitCode"], 3);
        assert!(result["stdout"].as_str().unwrap().contains("hi a,b true"), "{result}");
        assert_eq!(result["stderr"].as_str().unwrap().trim(), "warn");
        assert_eq!(result["timedOut"], false);
        assert!(run_script(d, &node, &json!({"id":"r2","skill":"tools","script":"evil.py"}), Duration::from_secs(5)).is_err());
        assert!(run_script(d, &node, &json!({"id":"r3","skill":"tools","script":"../SKILL.md"}), Duration::from_secs(5)).is_err());
        let slow = run_script(d, &node, &json!({"id":"r4","skill":"tools","script":"slow.js"}), Duration::from_millis(400)).unwrap();
        assert_eq!(slow["timedOut"], true);
        assert!(running().lock().unwrap().is_empty());
        let handle = thread::spawn(|| {
            thread::sleep(Duration::from_millis(300));
            while !cancel_script("r5") {
                thread::sleep(Duration::from_millis(20));
            }
        });
        let cancelled = run_script(d, &node, &json!({"id":"r5","skill":"tools","script":"slow.js"}), Duration::from_secs(20)).unwrap();
        handle.join().unwrap();
        assert_eq!(cancelled["cancelled"], true);
        op(d, "enable", json!({"id":"tools","enabled":false})).unwrap();
        assert!(run_script(d, &node, &json!({"id":"r6","skill":"tools","script":"hello.js"}), Duration::from_secs(5)).unwrap_err().contains("停用"));
    }
}
