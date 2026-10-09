//! 七猫榜单接口带有旧式折行响应头；兼容仅限该公开 JSON 接口。
//! 请求作为窗口资源管理，关闭资源或窗口都会取消后台传输。
use crate::DesktopWebviewWindow;
use serde_json::Value;
use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, Resource, ResourceId, Url};
use tauri_plugin_http::reqwest;

const MAX_BODY_BYTES: usize = 2_000_000;

fn validate_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "七猫榜单地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.qimao.com")
        || url.port_or_known_default() != Some(443)
        || url.path() != "/qimaoapi/api/rank/book-list"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("仅支持七猫公开榜单接口".into());
    }
    Ok(url)
}

fn require_main(window: &DesktopWebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| crate::is_app_shell_url(&url)) {
        return Err("榜单请求只接受本地主窗口".into());
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .http1_only()
        .http1_allow_obsolete_multiline_headers_in_responses(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
        .build().map_err(request_error)
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "七猫请求超时（30 秒）".into();
    }
    let mut detail = error.to_string();
    let mut cause = error.source();
    while let Some(current) = cause {
        detail.push_str("；");
        detail.push_str(&current.to_string());
        cause = current.source();
    }
    format!("七猫请求失败：{detail}")
}

async fn fetch_with_client(client: &reqwest::Client, url: Url) -> Result<Value, String> {
    let mut response = client
        .get(url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Referer", "https://www.qimao.com/paihang/")
        .send()
        .await
        .map_err(request_error)?;
    if !response.status().is_success() {
        return Err(format!("七猫接口返回 HTTP {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("七猫单页响应超过大小限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "七猫接口未返回有效 JSON 数据".into())
}

pub(crate) async fn fetch_page(raw: &str) -> Result<Value, String> {
    let url = validate_url(raw)?;
    fetch_with_client(&client()?, url).await
}

struct RankRequest {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<Result<Value, String>>>>,
    abort: tokio::task::AbortHandle,
}

impl RankRequest {
    fn new(task: tauri::async_runtime::JoinHandle<Result<Value, String>>) -> Self {
        Self {
            abort: task.inner().abort_handle(),
            task: Mutex::new(Some(task)),
        }
    }

    async fn read(&self) -> Result<Value, String> {
        let task = self
            .task
            .lock()
            .map_err(|_| "榜单请求状态不可用")?
            .take()
            .ok_or("榜单请求已经读取")?;
        task.await.map_err(|_| "七猫请求已取消或中断".to_owned())?
    }
}

impl Resource for RankRequest {
    fn close(self: Arc<Self>) {
        self.abort.abort();
    }
}

impl Drop for RankRequest {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

#[tauri::command]
pub fn qimao_rank_request(window: DesktopWebviewWindow, url: String) -> Result<ResourceId, String> {
    require_main(&window)?;
    validate_url(&url)?;
    let task = tauri::async_runtime::spawn(async move { fetch_page(&url).await });
    Ok(window.resources_table().add(RankRequest::new(task)))
}

#[tauri::command]
pub async fn qimao_rank_response(
    window: DesktopWebviewWindow,
    rid: ResourceId,
) -> Result<Value, String> {
    require_main(&window)?;
    let request = window
        .resources_table()
        .get::<RankRequest>(rid)
        .map_err(|e| e.to_string())?;
    request.read().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn qimao_transport_accepts_only_the_public_rank_endpoint() {
        assert!(validate_url("https://www.qimao.com/qimaoapi/api/rank/book-list?page=1").is_ok());
        for url in [
            "http://www.qimao.com/qimaoapi/api/rank/book-list",
            "https://example.com/qimaoapi/api/rank/book-list",
            "https://www.qimao.com/login",
            "https://user:password@www.qimao.com/qimaoapi/api/rank/book-list",
            "https://www.qimao.com:444/qimaoapi/api/rank/book-list",
            "https://www.qimao.com/qimaoapi/api/rank/book-list#fragment",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn legacy_folded_response_headers_do_not_break_json_acquisition() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            let body = r#"{"data":{"table_data":[{"book_id":"1","title":"测试榜首"}]}}"#;
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nServer: test\r\n content-security-policy: default-src 'self'\r\n x-frame-options: SAMEORIGIN\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(reply.as_bytes()).unwrap();
        });
        let result = tauri::async_runtime::block_on(async {
            fetch_with_client(
                &client().unwrap(),
                Url::parse(&format!("http://{address}/")).unwrap(),
            )
            .await
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(result["data"]["table_data"][0]["title"], "测试榜首");
    }

    #[test]
    fn closing_the_window_resource_cancels_a_response_already_being_awaited() {
        tauri::async_runtime::block_on(async {
            let task = tauri::async_runtime::spawn(std::future::pending::<Result<Value, String>>());
            let request = Arc::new(RankRequest::new(task));
            let reader = request.clone();
            let waiting = tauri::async_runtime::spawn(async move { reader.read().await });
            tokio::task::yield_now().await;
            request.clone().close();
            let result = tokio::time::timeout(Duration::from_secs(2), waiting)
                .await
                .unwrap()
                .unwrap();
            assert!(result.unwrap_err().contains("取消"));
            assert!(request.read().await.unwrap_err().contains("已经读取"));
        });
    }

    #[test]
    #[ignore = "显式运行七猫真实接口验收，不作为离线单元测试"]
    fn live_qimao_male_ranks_return_data_using_the_production_transport() {
        tauri::async_runtime::block_on(async {
            for rank_type in [1, 2, 4] {
                let url = format!("https://www.qimao.com/qimaoapi/api/rank/book-list?is_girl=0&rank_type={rank_type}&date_type=1&date=&page=1");
                let data = fetch_page(&url).await.unwrap();
                let items = data["data"]["table_data"].as_array().unwrap();
                assert!(!items.is_empty());
                assert!(items
                    .iter()
                    .all(|item| item["book_id"].as_str().is_some_and(|id| !id.is_empty())));
                println!(
                    "七猫男频 rank_type={rank_type}: {} 条，榜首 {}",
                    items.len(),
                    items[0]["title"]
                );
                tokio::time::sleep(Duration::from_millis(1200)).await;
            }
        });
    }
}
