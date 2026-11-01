//! 小说按正式目录顺序的历史视图。写作、补记和状态页读取同一份章节卡。
//! 只在需要引文时读正文，目录和版本用于判定作者改稿后哪些记录还能用。
use crate::story_state;
use crate::writing_records::{book, err, list};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub struct Chapter {
    pub id: String,
    pub no: usize,
    pub title: String,
    pub volume: String,
    pub version: i64,
    pub words: usize,
    pub stamp: String,
    pub plan: Value,
}

pub struct History {
    pub chapters: Vec<Chapter>,
    pub volumes: Vec<(String, String)>,
    pub cards: HashMap<String, Value>,
}

impl History {
    pub async fn load(db: &mut SqliteConnection, bid: &str) -> Result<Self, String> {
        let mut history = Self::catalog(db, bid).await?;
        history.cards = story_state::list_cards(db, bid)
            .await?
            .into_iter()
            .filter_map(|card| Some((card["chapterId"].as_str()?.to_owned(), card)))
            .collect();
        Ok(history)
    }

    pub async fn catalog(db: &mut SqliteConnection, bid: &str) -> Result<Self, String> {
        let owner = crate::writing_records::book_owner(&book(db, bid).await?);
        let volumes = sqlx::query_as::<_,(String,String)>("SELECT CAST(id AS TEXT),json_extract(payload,'$.title') FROM local_volumes WHERE bookId=? AND deletedAt IS NULL ORDER BY sortNo,id")
            .bind(bid).fetch_all(&mut *db).await.map_err(err)?;
        let rows = sqlx::query("SELECT c.id,c.volumeId,c.payload,d.userId,d.wordCount,COALESCE(json_extract(d.payload,'$.localVersion'),0) AS version,
            CASE WHEN d.wordCount=0 THEN length(trim(json_extract(d.payload,'$.textContent'))) ELSE d.wordCount END AS size
            FROM local_chapters c JOIN local_volumes v ON v.id=CAST(c.volumeId AS INTEGER) AND v.bookId=c.bookId AND v.deletedAt IS NULL
            LEFT JOIN chapter_contents d ON d.bookId=c.bookId AND d.chapterId=c.id AND d.userId IN ('guest',?)
            WHERE c.bookId=? AND c.deletedAt IS NULL ORDER BY v.sortNo,v.id,c.sortNo,c.id")
            .bind(owner).bind(bid).fetch_all(&mut *db).await.map_err(err)?;
        let mut chapters: Vec<Chapter> = Vec::with_capacity(rows.len());
        let mut prefix = Sha256::new();
        for row in rows {
            let id = row.get::<i64, _>("id").to_string();
            if chapters.last().is_some_and(|c| c.id == id) {
                return Err("同一章有两个账号的正文，请先核对归属".into());
            }
            let meta: Value = serde_json::from_str(row.get("payload")).map_err(err)?;
            let title = meta["title"].as_str().unwrap_or("").to_owned();
            let volume: String = row.get("volumeId");
            let version: i64 = row.get("version");
            let words = row.get::<Option<i64>, _>("size").unwrap_or(0).max(0) as usize;
            let account = row.get::<Option<String>, _>("userId");
            prefix.update(
                serde_json::to_vec(&(id.as_str(), &volume, &title, account, version))
                    .map_err(err)?,
            );
            chapters.push(Chapter {
                id,
                no: chapters.len() + 1,
                title,
                volume,
                version,
                words,
                stamp: format!("{:x}", prefix.clone().finalize()),
                plan: json!({"summary":meta["summary"],"outline":meta["planMeta"]}),
            });
        }
        Ok(Self {
            chapters,
            volumes,
            cards: HashMap::new(),
        })
    }
    pub fn verified(&self, chapter: &Chapter) -> Option<&Value> {
        self.cards
            .get(&chapter.id)
            .filter(|c| c["status"] == "active" && c["historyRevision"] == chapter.stamp)
    }
    pub fn pending(&self) -> Vec<&Chapter> {
        self.chapters
            .iter()
            .filter(|c| c.words > 0 && self.verified(c).is_none())
            .collect()
    }
    pub fn boundary(&self, args: &Value) -> Result<usize, String> {
        if let Some(cid) = args["chapterId"].as_str().filter(|s| !s.is_empty()) {
            return self
                .chapters
                .iter()
                .position(|c| c.id == cid)
                .ok_or_else(|| "目标章节不属于当前作品".into());
        }
        let vid = args["volumeId"].as_str().ok_or("缺少目标章节或分卷")?;
        let index = self
            .volumes
            .iter()
            .position(|(id, _)| id == vid)
            .ok_or("目标分卷不属于当前作品")?;
        let earlier: HashSet<_> = self.volumes[..=index]
            .iter()
            .map(|(id, _)| id.as_str())
            .collect();
        Ok(self
            .chapters
            .iter()
            .take_while(|c| earlier.contains(c.volume.as_str()))
            .count())
    }
}

fn proof(ch: &Chapter, item: &Value) -> Value {
    json!({"chapterId":ch.id,"chapterNo":ch.no,"version":ch.version,"quote":item["quote"]})
}

#[derive(Default)]
pub struct Snapshot {
    pub facts: BTreeMap<String, Value>,
    pub threads: BTreeMap<String, Value>,
    closed_threads: BTreeMap<String, Value>,
    pub people: BTreeMap<String, Value>,
    pub missing: Vec<usize>,
    pub author_corrections: Vec<Value>,
    pub entities: BTreeSet<String>,
    pub aliases: BTreeMap<String, BTreeSet<String>>,
}
impl Snapshot {
    pub fn person(&self, id: &str, chapter: &str) -> Value {
        let Some(p) = self.people.get(id) else {
            return json!({"characterId":id,"known":false,"asOfChapter":chapter});
        };
        let knows:Vec<_>=p["knows"].as_object().into_iter().flatten().map(|(fact,evidence)|json!({"factId":fact,"chapterId":evidence["chapterId"],"quote":evidence["quote"]})).collect();
        json!({"known":true,"asOfChapter":chapter,"characterId":id,"name":p["name"],"state":p["state"],"knows":knows,"doesNotKnow":p["doesNotKnow"],"lastSeen":p["lastSeen"]})
    }
    fn note_entities(&mut self, card: &Value) {
        for mention in card["entityMentions"].as_array().into_iter().flatten() {
            let (Some(name), Some(quote)) = (mention["name"].as_str(), mention["quote"].as_str())
            else {
                continue;
            };
            if !quote.contains(name) {
                continue;
            }
            let aliases = self.aliases.entry(name.to_owned()).or_default();
            aliases.insert(name.to_owned());
            aliases.extend(
                mention["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|n| quote.contains(n))
                    .map(str::to_owned),
            );
        }
        for event in card["events"].as_array().into_iter().flatten() {
            for entity in event["characters"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(std::iter::once(&event["location"]))
            {
                if let Some(name) = entity["name"].as_str() {
                    self.entities.insert(name.into());
                }
            }
        }
        for item in card["stateChanges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["field"] == "item")
        {
            if let Some(name) = item["after"].as_str() {
                self.entities.insert(name.into());
            }
        }
    }
    fn note_facts(&mut self, chapter: &Chapter, card: &Value, marks: &BTreeMap<String, String>) {
        for fact in card["facts"].as_array().into_iter().flatten() {
            if fact["factId"].as_str().is_some_and(|id| {
                marks
                    .get(&format!("fact:{id}"))
                    .is_some_and(|m| m == "rejected")
            }) {
                continue;
            }
            if let Some(old) = fact["supersedes"].as_str() {
                self.facts.remove(old);
            }
            if let Some(id) = fact["factId"].as_str() {
                self.facts.insert(
                    id.into(),
                    json!({"factId":id,"text":fact["text"],"source":proof(chapter,fact)}),
                );
            }
        }
    }
    fn note_threads(
        &mut self,
        ch: &Chapter,
        card: &Value,
        thread_ids: &HashMap<(String, String), String>,
    ) {
        let participants: BTreeSet<&str> = card["events"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|e| {
                e["characters"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(std::iter::once(&e["location"]))
            })
            .chain(card["entityMentions"].as_array().into_iter().flatten())
            .filter_map(|e| e["name"].as_str())
            .collect();
        for event in card["threads"].as_array().into_iter().flatten() {
            let title = event["text"].as_str().unwrap_or("");
            let id = event["threadId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| thread_ids.get(&(ch.id.clone(), title.into())).cloned());
            let Some(id) = id else { continue };
            match event["action"].as_str() {
                Some("plant") => {
                    self.threads.insert(
                id.clone(),
                json!({"threadId":id,"kind":event["kind"],"title":title,"origin":proof(ch,event),"relatedNames":participants}),
            );
                }
                Some("advance") => {
                    if let Some(thread) = self.threads.get_mut(&id) {
                        thread["latest"] = json!({"text":title,"source":proof(ch,event)});
                    }
                }
                Some("payoff") => {
                    if let Some(closed) = self.threads.remove(&id) {
                        self.closed_threads.insert(id, closed);
                    }
                }
                _ => {}
            }
        }
    }
    fn note_people(&mut self, ch: &Chapter, card: &Value, marks: &BTreeMap<String, String>) {
        for event in card["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["isMisdirection"] != true)
        {
            for actor in event["characters"].as_array().into_iter().flatten() {
                if let Some(name) = actor["name"].as_str() {
                    let key = actor["id"].as_str().unwrap_or(name);
                    let person = self.people.entry(key.into()).or_insert_with(
                        || json!({"characterId":key,"name":name,"changes":[],"knows":{}}),
                    );
                    person["lastSeen"] = json!({"chapterId":ch.id,"chapterNo":ch.no});
                }
            }
        }
        let misdirection: HashSet<_> = card["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["isMisdirection"] == true)
            .filter_map(|e| e["eventId"].as_str())
            .collect();
        for field in ["stateChanges", "knowledge"] {
            for item in card[field].as_array().into_iter().flatten() {
                if field == "stateChanges"
                    && item["eventId"]
                        .as_str()
                        .is_some_and(|id| misdirection.contains(id))
                {
                    continue;
                }
                let person = &item["character"];
                let Some(name) = person["name"].as_str() else {
                    continue;
                };
                let id = person["id"].as_str().unwrap_or(name);
                let entry = self.people.entry(id.into()).or_insert_with(
                    || json!({"characterId":id,"name":name,"changes":[],"knows":{}}),
                );
                if field == "knowledge" {
                    if let Some(fact) = item["factId"].as_str() {
                        let mut learned = proof(ch, item);
                        learned["factAtLearning"] = self
                            .facts
                            .get(fact)
                            .map(|v| v["text"].clone())
                            .unwrap_or_default();
                        entry["knows"][fact] = learned;
                    }
                } else if marks
                    .get(&story_state::state_change_key(&ch.id, item))
                    .is_none_or(|v| v != "rejected")
                {
                    let mut change = item.clone();
                    change["source"] = proof(ch, item);
                    entry["changes"].as_array_mut().unwrap().push(change);
                }
            }
        }
    }
    pub fn before(
        history: &History,
        boundary: usize,
        marks: &BTreeMap<String, String>,
        thread_ids: &HashMap<(String, String), String>,
    ) -> Self {
        let mut state = Self::default();
        for ch in &history.chapters[..boundary] {
            let Some(card) = history.verified(ch).map(|v| &v["card"]) else {
                if ch.words > 0 {
                    state.missing.push(ch.no)
                }
                continue;
            };
            state.note_entities(card);
            state.note_facts(ch, card, marks);
            state.note_threads(ch, card, thread_ids);
            state.note_people(ch, card, marks);
        }
        for person in state.people.values_mut() {
            let changes = person
                .as_object_mut()
                .unwrap()
                .remove("changes")
                .unwrap_or_default();
            let mut changes = changes.as_array().cloned().unwrap_or_default();
            changes.sort_by_key(|c| {
                c["storyOrder"]
                    .as_i64()
                    .unwrap_or(c["source"]["chapterNo"].as_i64().unwrap_or(0))
            });
            person["state"] = story_state::fold_latest(&changes, i64::MAX);
            if !changes.iter().any(|c| c["field"] == "alive") {
                person["state"]["alive"] = Value::Null;
            }
            person["lastChange"] = changes
                .last()
                .map(|v| v["source"].clone())
                .unwrap_or_default();
        }
        state
    }
}

pub async fn snapshot(
    db: &mut SqliteConnection,
    bid: &str,
    h: &History,
    end: usize,
) -> Result<Snapshot, String> {
    // 老章节卡有些只在派生伏笔表里保存了编号。只取编号映射，回收状态始终按此前的章节事件计算。
    let stored = list(db, story_state::CANON_NS, &format!("thread:{bid}:")).await?;
    let ids = stored
        .iter()
        .filter_map(|t| {
            Some((
                (
                    t["plantedChapter"].as_str()?.into(),
                    t["title"].as_str()?.into(),
                ),
                t["threadId"].as_str()?.into(),
            ))
        })
        .collect();
    let marks = story_state::load_marks(db, bid).await?;
    let mut state = Snapshot::before(h, end, &marks, &ids);
    for value in list(
        db,
        story_state::AUTHOR_NS,
        &format!("thread-override:{bid}:"),
    )
    .await?
    {
        if let Some(anchor) = value["afterChapterId"].as_str() {
            if !h.chapters[..end].iter().any(|c| c.id == anchor) {
                continue;
            }
        } else if h.chapters[end..].iter().any(|c| c.words > 0) {
            // 旧人工标记没有章节，不能拿最新决定倒推历史。
            continue;
        }
        if let Some(id) = value["threadId"].as_str() {
            if matches!(value["status"].as_str(), Some("paid" | "dropped")) {
                state.threads.remove(id);
            } else {
                if !state.threads.contains_key(id) {
                    if let Some(t) = state.closed_threads.remove(id) {
                        state.threads.insert(id.into(), t);
                    }
                }
                if let Some(t) = state.threads.get_mut(id) {
                    t["authorNote"] = value["note"].clone();
                }
            }
        }
    }
    state.author_corrections = crate::story_memory::corrections(db, bid, h, end).await?;
    for row in &state.author_corrections {
        let k = &row["knowledge"];
        let (Some(id), Some(fid), Some(known)) = (
            k["characterId"].as_str(),
            k["factId"].as_str(),
            k["known"].as_bool(),
        ) else {
            continue;
        };
        let Some(person) = state.people.get_mut(id) else {
            continue;
        };
        let anchor = h.chapters[..end]
            .iter()
            .find(|c| row["afterChapterId"] == c.id)
            .map(|c| c.no)
            .unwrap_or(0);
        if person["knows"][fid]["chapterNo"]
            .as_u64()
            .is_some_and(|n| n > anchor as u64)
        {
            continue;
        }
        let source = json!({"source":"author","chapterId":row["afterChapterId"],"chapterNo":anchor,"quote":row["text"]});
        if known {
            person["knows"][fid] = source;
            if let Some(unknown) = person["doesNotKnow"].as_object_mut() {
                unknown.remove(fid);
            }
        } else {
            if let Some(knows) = person["knows"].as_object_mut() {
                knows.remove(fid);
            }
            person["doesNotKnow"][fid] = source;
        }
    }
    Ok(state)
}

pub fn ranges(numbers: &[usize]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &n in numbers {
        if let Some(last) = ranges.last_mut() {
            if last.1 + 1 == n {
                last.1 = n;
                continue;
            }
        }
        ranges.push((n, n));
    }
    ranges
}
