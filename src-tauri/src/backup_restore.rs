use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 1_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    path: String,
    content: String,
}

#[derive(Default, Serialize)]
pub struct BackupScan {
    files: Vec<BackupFile>,
    warnings: Vec<String>,
}

fn snapshot_key(path: &Path) -> Option<(String, u64)> {
    let stem = path.file_stem()?.to_str()?;
    let bytes = stem.as_bytes();
    if bytes.len() < 15
        || bytes[8] != b'-'
        || !bytes[..8]
            .iter()
            .chain(&bytes[9..15])
            .all(u8::is_ascii_digit)
    {
        return None;
    }
    let suffix = stem.get(15..)?;
    let version = if suffix.is_empty() {
        0
    } else {
        suffix
            .strip_prefix("-v")
            .or_else(|| suffix.strip_prefix("-cloud-v"))?
            .parse()
            .ok()?
    };
    Some((stem[..15].to_string(), version))
}

fn id(value: &Value) -> bool {
    value.as_i64().is_some() || value.as_str().is_some_and(|s| !s.is_empty())
}

fn is_backup_json(value: &Value) -> bool {
    if !id(&value["bookId"]) {
        return false;
    }
    if id(&value["chapterId"])
        && id(&value["volumeId"])
        && value["title"].is_string()
        && value["textContent"].is_string()
    {
        return true;
    }
    value["version"] == 1
        && value["reference"].as_object().is_some_and(|reference| {
            let keys = [
                "outlineNodes",
                "characters",
                "characterGroups",
                "characterRelations",
                "worldSettings",
                "worldSettingGroups",
                "timelineEvents",
                "storylines",
                "storylineRelations",
                "storylineNodes",
                "storylineNodeRelations",
                "plotBindings",
            ];
            keys.iter().any(|key| reference.contains_key(*key))
                && keys.iter().all(|key| {
                    reference.get(*key).is_none_or(|items| {
                        items.as_array().is_some_and(|items| {
                            items.iter().all(|item| item.is_object() && id(&item["id"]))
                        })
                    })
                })
        })
}

fn read_snapshot(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_FILE_BYTES {
        return Err("单个备份超过 32 MB".into());
    }
    String::from_utf8(data)
        .map(|s| s.trim_start_matches('\u{feff}').to_owned())
        .map_err(|_| "不是 UTF-8 备份文件".into())
}

// 每个章节目录只读取最新可用快照；同时间戳优先 JSON，损坏时尝试配套 TXT 或旧版本。
fn scan_directory(root: &Path) -> Result<BackupScan, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "备份目录不存在或无法访问")?;
    if !root.is_dir() {
        return Err("请选择备份文件夹".into());
    }
    let mut result = BackupScan::default();
    let mut directories = vec![(root, 0)];
    let mut count = 0;
    let mut total_bytes = 0;
    while let Some((directory, depth)) = directories.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                result
                    .warnings
                    .push(format!("无法读取目录：{}", directory.display()));
                continue;
            }
        };
        let mut snapshots: BTreeMap<(String, u64), Vec<PathBuf>> = BTreeMap::new();
        for entry in entries {
            count += 1;
            if count > MAX_ENTRIES {
                return Err("目录文件过多，请选择单本作品的备份目录".into());
            }
            let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if depth < 8 {
                    directories.push((path, depth + 1));
                } else {
                    result
                        .warnings
                        .push(format!("目录层级过深，未扫描：{}", path.display()));
                }
            } else if kind.is_file()
                && matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("json" | "txt")
                )
            {
                if let Some(key) = snapshot_key(&path) {
                    snapshots.entry(key).or_default().push(path);
                }
            }
        }
        'versions: for (_, mut paths) in snapshots.into_iter().rev() {
            paths.sort(); // .json 优先于配套 .txt
            for path in paths {
                let content = match read_snapshot(&path) {
                    Ok(content) => content,
                    Err(e) => {
                        result
                            .warnings
                            .push(format!("跳过 {}：{}", path.display(), e));
                        continue;
                    }
                };
                if path.extension().is_some_and(|s| s == "json")
                    && !serde_json::from_str::<Value>(&content).is_ok_and(|v| is_backup_json(&v))
                {
                    result
                        .warnings
                        .push(format!("跳过损坏或不匹配的备份：{}", path.display()));
                    continue;
                }
                total_bytes += content.len();
                if total_bytes > MAX_TOTAL_BYTES {
                    return Err("备份内容超过 256 MB，请分批选择单本作品恢复".into());
                }
                result.files.push(BackupFile {
                    path: path.to_string_lossy().to_string(),
                    content,
                });
                break 'versions;
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn scan_backup_directory(directory: String) -> Result<BackupScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_directory(Path::new(&directory)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_latest_and_falls_back_without_changing_files() {
        let root = std::env::temp_dir().join(format!(
            "ew-restore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let chapter = root.join("测试_-1/第一卷_-2/第1章_-3");
        std::fs::create_dir_all(&chapter).unwrap();
        std::fs::write(chapter.join("20260914-010000-v1.json"), r#"{"bookId":"-1","volumeId":"-2","chapterId":-3,"title":"第1章","textContent":"旧正文"}"#).unwrap();
        std::fs::write(chapter.join("20260914-020000-v2.json"), "{broken").unwrap();
        std::fs::write(chapter.join("20260914-020000-v2.txt"), "新正文").unwrap();
        std::fs::write(chapter.join("unrelated.txt"), "不属于备份").unwrap();
        let result = scan_directory(&root).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].content, "新正文");
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(std::fs::read_dir(&chapter).unwrap().count(), 4);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn prefers_json_and_handles_numeric_versions() {
        assert!(
            snapshot_key(Path::new("20260914-010000-v10.json"))
                > snapshot_key(Path::new("20260914-010000-v2.json"))
        );
        assert!(snapshot_key(Path::new("普通文件.json")).is_none());
        assert!(is_backup_json(
            &serde_json::json!({"version":1,"bookId":"-1","reference":{"characters":[]}})
        ));
        assert!(!is_backup_json(
            &serde_json::json!({"version":1,"bookId":"-1","reference":{"characters":[null]}})
        ));
    }

    #[test]
    fn reads_current_writer_and_reference_snapshots() {
        let root = std::env::temp_dir().join(format!(
            "ew-writer-restore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root_text = root.to_string_lossy().to_string();
        crate::write_chapter_backup(crate::ChapterBackupPayload {
            order_no: Some(1),
            volume_order_no: Some(1),
            backup_dir: Some(root_text.clone()),
            book_id: "-1".into(),
            book_title: "真实备份格式".into(),
            volume_id: Some("-2".into()),
            volume_title: Some("第一卷".into()),
            chapter_id: -3,
            chapter_title: "第1章".into(),
            text_content: "最新正文".into(),
            content_json: serde_json::json!({"type":"doc","content":[]}),
            local_version: 10,
            remote_version: 0,
            updated_at: 1,
            backup_at: 1,
            file_stem: "20260914-120000-v10".into(),
        })
        .unwrap();
        crate::write_reference_backup(&crate::ReferenceBackupPayload {
            backup_dir: Some(root_text), book_id: "-1".into(), book_title: "真实备份格式".into(), file_stem: "20260914-120001".into(),
            content: serde_json::json!({"version":1,"bookId":"-1","reference":{"characters":[{"id":-4,"name":"角色"}]}}).to_string(),
        }).unwrap();
        let result = scan_directory(&root).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.warnings.is_empty());
        assert!(result.files.iter().all(|file| file.path.ends_with(".json")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_cycles_and_outside_files() {
        let root = std::env::temp_dir().join(format!(
            "ew-restore-links-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("20260914-120000-v1.txt")).unwrap();
        assert!(scan_directory(&root).unwrap().files.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
