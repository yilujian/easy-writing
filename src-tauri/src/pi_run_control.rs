//! 会话执行边界；不记录故事定位或由模型维护任务台账。
use crate::writing_records::{get, put};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Active,
    Paused,
    Ended,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldTask {
    pub kind: String,
    pub id: String,
    pub revision: u64,
    pub was_running: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankScope {
    platform: String,
    audience: String,
    category: String,
    rank_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingPolicy {
    pub intent: String,
    pub scopes: Vec<RankScope>,
    pub cache_only: bool,
    #[serde(default)]
    pub refresh_requested: bool,
}
impl RankingPolicy {
    pub fn validate(&self) -> Result<(), String> {
        let mut per_platform = std::collections::HashMap::new();
        if !["none", "specified", "delegated", "unresolved"].contains(&self.intent.as_str())
            || (self.intent == "none" && !self.scopes.is_empty())
            || (["specified", "delegated"].contains(&self.intent.as_str())
                && self.scopes.is_empty())
            || self.scopes.iter().any(|scope| {
                let count = per_platform.entry(&scope.platform).or_insert(0);
                *count += 1;
                *count > 16
                    || scope.platform == "*"
                    || [
                        &scope.platform,
                        &scope.audience,
                        &scope.category,
                        &scope.rank_type,
                    ]
                    .iter()
                    .any(|value| value.chars().count() > 120)
            })
        {
            return Err("榜单要求判定无效，未接受执行决定".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub state: State,
    pub revision: u64,
    pub held_tasks: Vec<HeldTask>,
    pub resume_agent: bool,
    pub paused_book_id: Option<String>,
    pub pending_input: Option<String>,
    pub rankings: Option<RankingPolicy>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub control: Control,
    pub released_tasks: Vec<HeldTask>,
    pub resume_agent: bool,
}
const TASKS: &[(&str, &str)] = &[
    ("breakdown", "ew-local-breakdown/kv"),
    ("distillation", "ew-agent-pi/distillation"),
    ("batch", "ew-agent-pi/batch"),
    ("cover", "ew-agent-pi/cover"),
];
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn from_meta(meta: &Value) -> Result<Control, String> {
    match meta.get("runControl") {
        Some(value) => serde_json::from_value(value.clone()).map_err(err),
        None => Ok(Control::default()),
    }
}
pub async fn read(db: &mut SqliteConnection, sid: &str) -> Result<Control, String> {
    from_meta(
        &get(db, super::sessions_meta::META_NS, sid)
            .await?
            .unwrap_or(Value::Null),
    )
}
pub async fn read_at(root: &Path, sid: &str) -> Result<Control, String> {
    read(
        &mut crate::desktop_storage::connect_existing_at(root).await?,
        sid,
    )
    .await
}
pub async fn complete_refresh(root: &Path, sid: &str, revision: u64) -> Result<Control, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let mut meta = get(&mut tx, super::sessions_meta::META_NS, sid)
        .await?
        .ok_or("会话记录不存在")?;
    let mut control = from_meta(&meta)?;
    if control.revision != revision
        || control.state != State::Active
        || control.pending_input.is_some()
    {
        return Err("作者要求已改变，未将旧刷新结果记为当前任务完成".into());
    }
    let policy = control.rankings.as_mut().ok_or("没有当前榜单要求")?;
    if !policy.refresh_requested {
        return Err("当前没有待处理的刷新要求".into());
    }
    policy.refresh_requested = false;
    control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
    meta["runControl"] = serde_json::to_value(&control).map_err(err)?;
    put(&mut tx, super::sessions_meta::META_NS, sid, &meta).await?;
    tx.commit().await.map_err(err)?;
    Ok(control)
}
pub async fn automatic_allowed(
    root: &Path,
    sid: &str,
    kind: &str,
    id: &str,
) -> Result<(Control, bool), String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let control = read(&mut db, sid).await?;
    let Some((_, namespace)) = TASKS.iter().find(|(k, _)| *k == kind) else {
        return Err("未知后台任务类型".into());
    };
    let task = get(&mut db, namespace, &format!("task:{id}")).await?;
    let context = super::context::read(&mut db, sid)
        .await?
        .unwrap_or(Value::Null);
    let owned =
        task.is_some_and(|value| value["sessionId"] == sid && task_matches_book(&value, &context));
    let allowed = owned && control.allows_automatic(kind, id);
    Ok((control, allowed))
}
fn task_matches_book(task: &Value, context: &Value) -> bool {
    task["bookId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .is_none_or(|id| context["bookId"] == id)
}
impl Control {
    pub fn allows_automatic(&self, kind: &str, id: &str) -> bool {
        self.state == State::Active
            && self.pending_input.is_none()
            && !self.held_tasks.iter().any(|t| t.kind == kind && t.id == id)
    }
}
async fn owned_tasks(db: &mut SqliteConnection, sid: &str) -> Result<Vec<(String, Value)>, String> {
    let mut tasks = Vec::new();
    for (kind, namespace) in TASKS {
        let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=?")
            .bind(namespace).bind(sid).fetch_all(&mut *db).await.map_err(err)?;
        for raw in rows {
            tasks.push(((*kind).to_owned(), serde_json::from_str(&raw).map_err(err)?));
        }
    }
    Ok(tasks)
}
pub async fn change(
    root: &Path,
    sid: &str,
    action: &str,
    resume_agent: bool,
    task: Option<(&str, &str)>,
) -> Result<Change, String> {
    change_inner(root, sid, action, resume_agent, task, None, None).await
}
pub async fn author_input(
    root: &Path,
    sid: &str,
    id: &str,
    decision: Option<&str>,
    rankings: Option<RankingPolicy>,
) -> Result<Change, String> {
    if decision.is_some() {
        rankings.as_ref().ok_or("缺少榜单要求判定")?.validate()?;
    }
    let action = match decision {
        None => "receive_input",
        Some("process") => "begin",
        Some("pause" | "clarify") => "pause",
        Some("end") => "end",
        _ => return Err("作者执行决定无效".into()),
    };
    change_inner(
        root,
        sid,
        action,
        decision == Some("pause"),
        None,
        Some(id),
        rankings,
    )
    .await
}
async fn change_inner(
    root: &Path,
    sid: &str,
    action: &str,
    resume_agent: bool,
    task: Option<(&str, &str)>,
    input_id: Option<&str>,
    rankings: Option<RankingPolicy>,
) -> Result<Change, String> {
    if sid.is_empty() {
        return Err("会话编号缺失".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let context = super::context::read(&mut tx, sid)
        .await?
        .ok_or("会话尚未建立")?;
    let book_id = context["bookId"].as_str().ok_or("会话作品配置缺失")?;
    let mut meta = get(&mut tx, super::sessions_meta::META_NS, sid)
        .await?
        .unwrap_or_else(|| json!({"id":sid}));
    let mut control = from_meta(&meta)?;
    if action != "receive_input" {
        if let Some(id) = input_id {
            if control.pending_input.as_deref() != Some(id) {
                return Err("作者要求已被更新或取消，本次决定未执行".into());
            }
        }
    }
    let was_pending = control.pending_input.is_some();
    let mut released = Vec::new();
    let mut resume = false;
    match action {
        "receive_input" => {
            control.pending_input = Some(input_id.ok_or("缺少作者输入编号")?.to_owned());
            control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
        }
        "pause" | "end" => {
            control.pending_input = None;
            let previous_revision = control.revision;
            let remaining_paused = action == "pause" && control.state == State::Paused;
            control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
            if action == "pause" && control.state == State::Ended {
                meta["runControl"] = serde_json::to_value(&control).map_err(err)?;
                put(&mut tx, super::sessions_meta::META_NS, sid, &meta).await?;
                tx.commit().await.map_err(err)?;
                return Ok(Change {
                    control,
                    released_tasks: Vec::new(),
                    resume_agent: false,
                });
            }
            if remaining_paused {
                for task in &mut control.held_tasks {
                    if task.revision == previous_revision {
                        task.revision = control.revision;
                    }
                }
            } else {
                control.resume_agent = action == "pause" && resume_agent;
                control.paused_book_id = (action == "pause").then(|| book_id.to_owned());
            }
            let state = if action == "pause" {
                State::Paused
            } else {
                State::Ended
            };
            control.state = state;
            for (kind, value) in owned_tasks(&mut tx, sid).await? {
                let running = matches!(
                    value["status"].as_str(),
                    Some("running" | "waiting" | "pausing")
                );
                let pending_summary = value["status"] == "completed"
                    && value["autoContinue"] == true
                    && value["continuedAt"].as_i64().unwrap_or(0) == 0;
                if !running && !pending_summary {
                    continue;
                }
                let id = value["id"].as_str().ok_or("任务编号缺失")?;
                if !control
                    .held_tasks
                    .iter()
                    .any(|t| t.kind == kind && t.id == id)
                {
                    control.held_tasks.push(HeldTask {
                        kind,
                        id: id.into(),
                        revision: control.revision,
                        was_running: running,
                    });
                }
            }
        }
        "resume" => {
            if was_pending {
                return Err("作者最新要求尚未判定，不能恢复旧工作".into());
            }
            control.pending_input = None;
            if control.state != State::Paused {
                return Err("只有已暂停的阶段可以继续；已结束的阶段请发送新要求".into());
            }
            if control.paused_book_id.as_deref() != Some(book_id) {
                return Err("绑定作品已改变，请先确认暂停时的目标作品再继续".into());
            }
            resume = control.resume_agent;
            let revision = control.revision;
            control.held_tasks.retain(|task| {
                if task.revision == revision {
                    released.push(task.clone());
                    false
                } else {
                    true
                }
            });
            control.state = State::Active;
            control.resume_agent = false;
            control.paused_book_id = None;
            control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
        }
        "begin" => {
            if let Some(policy) = rankings {
                control.rankings = Some(policy);
            }
            control.pending_input = None;
            if control.state == State::Active && !was_pending {
                return Ok(Change {
                    control,
                    released_tasks: Vec::new(),
                    resume_agent: false,
                });
            }
            control.state = State::Active;
            control.resume_agent = false;
            control.paused_book_id = None;
            control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
            // 新要求不恢复旧阶段的后台任务；旧任务只能显式继续。
        }
        "release_task" => {
            if was_pending {
                return Err("作者最新要求尚未判定，不能恢复旧任务".into());
            }
            let (kind, id) = task.ok_or("缺少要继续的任务")?;
            let tasks = owned_tasks(&mut tx, sid).await?;
            let (_, owned) = tasks
                .iter()
                .find(|(k, v)| k == kind && v["id"] == id)
                .ok_or("任务不属于当前会话")?;
            if !task_matches_book(owned, &context) {
                return Err("请先切回任务所属作品后继续，任务不会转移到其他作品".into());
            }
            control.held_tasks.retain(|task| {
                if task.kind == kind && task.id == id {
                    released.push(task.clone());
                    false
                } else {
                    true
                }
            });
            if control.state != State::Active {
                control.state = State::Active;
                control.resume_agent = false;
                control.paused_book_id = None;
                control.revision = control.revision.checked_add(1).ok_or("运行状态版本超限")?;
            }
        }
        _ => return Err("未知会话控制动作".into()),
    }
    meta["runControl"] = serde_json::to_value(&control).map_err(err)?;
    put(&mut tx, super::sessions_meta::META_NS, sid, &meta).await?;
    tx.commit().await.map_err(err)?;
    Ok(Change {
        control,
        released_tasks: released,
        resume_agent: resume,
    })
}

#[cfg(all(test, feature = "local-tests"))]
#[path = "pi_run_control_tests.rs"]
mod tests;
