//! 提示词文档的文件范围；备份、恢复和回滚使用同一份清单。
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if root.exists() {
        visit(root, root, &mut out)?;
    }
    Ok(out)
}

fn visit(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("提示词或技能目录不能包含符号链接".into());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "__pycache__" {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!(
                "提示词或技能目录含符号链接：{}",
                relative.display()
            ));
        }
        if kind.is_dir() {
            visit(root, &path, out)?;
        } else if kind.is_file() {
            let document = path
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("md") || v.eq_ignore_ascii_case("txt"));
            if document {
                out.push(path);
            }
        } else {
            return Err(format!("不支持的提示词文件：{}", relative.display()));
        }
    }
    out.sort();
    Ok(())
}

/// 不跟随已有的目录链接写到用户选择范围之外。
pub fn checked_target(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("恢复目标目录不能是符号链接".into());
    }
    let mut target = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("无效的提示词相对路径".into());
        }
        target.push(component);
        if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("恢复目标包含符号链接".into());
        }
    }
    Ok(target)
}
