//! 启动失败时的恢复入口。只接受应用自己生成的迁移快照，恢复前保留当前数据库及 WAL。
use crate::{writing_host::WritingHost, desktop_storage, storage_migration, DesktopAppHandle};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{fs, io::Write, path::Path, sync::atomic::Ordering};
use tauri::Manager;
const DATABASE_FILES: [&str; 3] = ["ew-writing.db", "ew-writing.db-wal", "ew-writing.db-shm"];
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn sync_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    file.sync_all().map_err(err)
}

/// 未提交的恢复只回滚已移动的文件；已提交的恢复保留旧库作为恢复副本。
pub fn recover_at(root: &Path) -> Result<(), String> {
    let pending = root.join("pending-startup-recovery");
    if !pending.exists() {
        return Ok(());
    }
    let ready = pending.join("ready.json");
    if !ready.exists() {
        fs::remove_dir_all(&pending).map_err(err)?;
        return Ok(());
    }
    let original: Vec<String> =
        serde_json::from_slice(&fs::read(ready).map_err(err)?).map_err(err)?;
    if !original
        .iter()
        .all(|name| DATABASE_FILES.contains(&name.as_str()))
    {
        return Err("恢复日志无效".into());
    }
    if !pending.join("committed").exists() {
        for name in DATABASE_FILES {
            let saved = pending.join(name);
            let target = root.join(name);
            if saved.exists() {
                if target.exists() {
                    fs::remove_file(&target).map_err(err)?;
                }
                fs::rename(saved, target).map_err(err)?;
            } else if !original.iter().any(|n| n == name) && target.exists() {
                fs::remove_file(target).map_err(err)?;
            }
        }
        fs::remove_dir_all(pending).map_err(err)?;
    } else {
        let recovery = root.join("recovery");
        fs::create_dir_all(&recovery).map_err(err)?;
        fs::rename(
            pending,
            recovery.join(format!("replaced-{}", uuid::Uuid::new_v4())),
        )
        .map_err(err)?;
    }
    Ok(())
}

pub async fn restore_at(root: &Path, name: &str) -> Result<(), String> {
    if !name.starts_with("before-migration-")
        || !name.ends_with(".sqlite")
        || name.contains(['/', '\\', ':'])
        || name.contains("..")
    {
        return Err("请选择列表中的迁移前副本".into());
    }
    if root.join("pending-restore").exists() {
        return Err("上次完整备份恢复尚未收尾，请先重新尝试启动".into());
    }
    recover_at(root)?;
    let snapshot = root.join("recovery").join(name);
    let meta = fs::symlink_metadata(&snapshot).map_err(err)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("恢复副本不是普通文件".into());
    }
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&snapshot)
            .read_only(true)
            .create_if_missing(false),
    )
    .await
    .map_err(err)?;
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .map_err(err)?;
    let core: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='chapter_contents'",
    )
    .fetch_one(&mut db)
    .await
    .map_err(err)?;
    db.close().await.map_err(err)?;
    if check != "ok" || core != 1 {
        return Err("副本数据库未通过完整性检查，当前数据未变更".into());
    }
    let pending = root.join("pending-startup-recovery");
    fs::create_dir(&pending).map_err(err)?;
    let result = (|| {
        let incoming = pending.join("incoming.sqlite");
        fs::copy(&snapshot, &incoming).map_err(err)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&incoming)
            .map_err(err)?
            .sync_all()
            .map_err(err)?;
        let original: Vec<_> = DATABASE_FILES
            .iter()
            .filter(|n| root.join(n).exists())
            .map(|n| n.to_string())
            .collect();
        for name in &original {
            if fs::symlink_metadata(root.join(name))
                .map_err(err)?
                .file_type()
                .is_symlink()
            {
                return Err("数据库文件不能是符号链接".into());
            }
        }
        sync_write(
            &pending.join("ready.pending"),
            &serde_json::to_vec(&original).map_err(err)?,
        )?;
        fs::rename(pending.join("ready.pending"), pending.join("ready.json")).map_err(err)?;
        for name in original {
            fs::rename(root.join(&name), pending.join(&name)).map_err(err)?;
        }
        fs::rename(incoming, root.join("ew-writing.db")).map_err(err)?;
        sync_write(&pending.join("committed"), b"1")?;
        Ok::<_, String>(())
    })();
    recover_at(root)?;
    storage_migration::forget_health(root);
    result
}

#[tauri::command]
pub async fn desktop_storage_ready(app: DesktopAppHandle) -> Result<(), String> {
    if storage_migration::desktop_storage_session()? != Some(storage_migration::RuntimeStorage::Unified) {
        return Err("本地存储尚未正式启用，不能启动后台索引或清理".into());
    }
    let root = desktop_storage::root(&app)?;
    let state = serde_json::to_value(storage_migration::inspect_at(&root).await?).map_err(err)?;
    if state["state"] != "ready" {
        return Err("本地存储尚未完成准备".into());
    }
    if app.state::<WritingHost>().storage_ready.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    crate::writing_host::schedule_index(app, std::time::Duration::from_secs(30));
    // 迁移留下的暂存副本（可达几十 MB）在后台清一次，不拖慢启动
    std::thread::spawn(move || {
        match tauri::async_runtime::block_on(storage_migration::prune_stage_at(&root)) {
            Ok(Some(summary)) => eprintln!("[storage] 迁移暂存已清理：{summary}"),
            Ok(None) => {}
            Err(error) => eprintln!("[storage] 迁移暂存清理未完成：{error}"),
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn desktop_startup_recovery(
    app: DesktopAppHandle,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    let host = app.state::<WritingHost>();
    let _gate = host.gate.lock().await;
    if host.storage_ready.load(Ordering::SeqCst) || host.active() {
        return Err("请在启动失败页面使用此恢复入口；工作台内请使用完整备份恢复".into());
    }
    let root = desktop_storage::root(&app)?;
    let recovery = root.join("recovery");
    match action.as_str() {
        "list" => {
            let mut snapshots = Vec::new();
            if recovery.is_dir() {
                for entry in fs::read_dir(&recovery).map_err(err)? {
                    let entry = entry.map_err(err)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if entry.file_type().map_err(err)?.is_file()
                        && name.starts_with("before-migration-")
                        && name.ends_with(".sqlite")
                    {
                        snapshots.push(
                            json!({"name":name,"bytes":entry.metadata().map_err(err)?.len()}),
                        );
                    }
                }
            }
            snapshots.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
            Ok(json!({"directory":recovery,"snapshots":snapshots}))
        }
        "open" => {
            fs::create_dir_all(&recovery).map_err(err)?;
            let mut command = std::process::Command::new(if cfg!(target_os = "macos") {
                "open"
            } else if cfg!(windows) {
                "explorer"
            } else {
                "xdg-open"
            });
            command.arg(&recovery).spawn().map_err(err)?;
            Ok(json!(true))
        }
        "restore" => {
            restore_at(&root, name.as_deref().ok_or("请选择副本")?).await?;
            Ok(json!(true))
        }
        _ => Err("不支持的恢复操作".into()),
    }
}
