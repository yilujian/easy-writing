//! Install a complete Skill on the same filesystem. A replacement preserves other author files.
use super::{err, Dirs, IMPORT_CAP};
use std::{
    fs, io,
    path::Path,
    sync::{Mutex, MutexGuard},
};

static ACCESS: Mutex<()> = Mutex::new(());
pub fn access(d: &Dirs) -> Result<MutexGuard<'static, ()>, String> {
    let guard = ACCESS.lock().map_err(|_| "技能目录访问已中断")?;
    let journal = d.author.with_file_name(".ew-skill-install");
    let staging = journal.join("staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(err)?;
    }
    let entries = match fs::read_dir(journal.join("previous")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(guard),
        Err(error) => return Err(err(error)),
    };
    for item in entries {
        let item = item.map_err(err)?;
        let file = item.file_name();
        let Some(id) = file.to_str() else {
            continue;
        };
        if id.is_empty() || id.starts_with('.') || !item.file_type().map_err(err)?.is_dir() {
            continue;
        }
        let target = d.author.join(id);
        if target.exists() {
            fs::remove_dir_all(item.path()).map_err(err)?;
        } else {
            fs::rename(item.path(), target).map_err(err)?;
        }
    }
    Ok(guard)
}
fn copy_existing(from: &Path, to: &Path, budget: &mut u64) -> Result<(), String> {
    for entry in fs::read_dir(from).map_err(err)? {
        let entry = entry.map_err(err)?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(err)?;
        if kind.is_dir() {
            fs::create_dir(&target).map_err(err)?;
            copy_existing(&entry.path(), &target, budget)?;
        } else if kind.is_file() {
            let bytes = entry.metadata().map_err(err)?.len();
            *budget = budget
                .checked_sub(bytes)
                .ok_or("原技能超过 20 MB，未替换")?;
            fs::copy(entry.path(), target).map_err(err)?;
        } else {
            return Err("技能中含特殊文件，无法安全替换".into());
        }
    }
    Ok(())
}
pub fn publish(d: &Dirs, id: &str, body: &str, files: Vec<(String, String)>) -> Result<(), String> {
    fs::create_dir_all(&d.author).map_err(err)?;
    let target = d.author.join(id);
    let journal = d.author.with_file_name(".ew-skill-install");
    let staged = journal.join("staging");
    let backups = journal.join("previous");
    fs::create_dir_all(&backups).map_err(err)?;
    let previous = backups.join(id);
    fs::create_dir(&staged).map_err(err)?;
    let result = (|| {
        if target.exists() {
            if !fs::symlink_metadata(&target).map_err(err)?.is_dir() {
                return Err("技能目录无效".into());
            }
            let mut budget = IMPORT_CAP;
            copy_existing(&target, &staged, &mut budget)?;
        }
        for (path, content) in files {
            let out = staged.join(path);
            fs::create_dir_all(out.parent().ok_or("技能文件路径无效")?).map_err(err)?;
            fs::write(out, content).map_err(err)?;
        }
        fs::write(staged.join("SKILL.md"), body).map_err(err)?;
        if target.exists() {
            fs::rename(&target, &previous).map_err(err)?;
        }
        if let Err(error) = fs::rename(&staged, &target) {
            if previous.exists() {
                fs::rename(&previous, &target).map_err(err)?;
            }
            return Err(err(error));
        }
        // Publication succeeded. A previous version left by interruption is removed on the next access.
        if previous.exists() {
            let _ = fs::remove_dir_all(previous);
        }
        Ok(())
    })();
    if staged.exists() {
        let _ = fs::remove_dir_all(staged);
    }
    result
}
