//! The app's HTTP client for GPUI.
//!
//! GPUI's default is a `NullHttpClient`, and its image loader is the one thing
//! that asks for a client: `<Image source={{ uri: 'https://…' }} />` resolves to
//! `Resource::Uri` and goes through `cx.http_client()`. Without a real client
//! every remote image failed to load and painted nothing, so the whole `<Image>`
//! surface only ever worked for local file paths.
//!
//! ureq already carries the embedded JS host's `fetch` (see `hermes.rs`), so this
//! is the same blocking request moved onto a pool thread and handed back through
//! a channel the GPUI executor can await.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::thread;

use anyhow::anyhow;
use futures::AsyncReadExt;
use futures::future::BoxFuture;
use gpui::http_client::http::request::Parts;
use gpui::http_client::{
    AsyncBody, HttpClient, RedirectPolicy, Request, Response, StatusCode, Url, http,
};

/// ureq is blocking, so the pool size IS the concurrency limit. One thread per
/// request would let a grid of `<Image>`s spawn a thread each; browsers settle
/// around six connections per host, and an image load is the only caller.
const HTTP_WORKERS: usize = 6;

/// `RedirectPolicy::FollowAll` has no ureq equivalent, which caps redirects per
/// agent. This stands in for "as many as anyone sanely means by all".
const FOLLOW_ALL_LIMIT: u32 = 32;

type Job = Box<dyn FnOnce() + Send + 'static>;

pub struct UreqHttpClient;

impl HttpClient for UreqHttpClient {
    fn type_name(&self) -> &'static str {
        "UreqHttpClient"
    }

    fn user_agent(&self) -> Option<&http::HeaderValue> {
        None
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(
        &self,
        request: Request<AsyncBody>,
    ) -> BoxFuture<'static, anyhow::Result<Response<AsyncBody>>> {
        Box::pin(async move {
            let (parts, mut body) = request.into_parts();
            let mut payload = Vec::new();
            body.read_to_end(&mut payload).await?;
            // the blocking call must not stall the executor the window's frames
            // run on. dropping this future just drops the receiver, and the job's
            // send then fails into the `let _`.
            let (tx, rx) = flume::bounded(1);
            workers()
                .send(Box::new(move || {
                    let _ = tx.send(send_blocking(parts, payload));
                }))
                .map_err(|_| anyhow!("http worker pool is gone"))?;
            rx.recv_async().await?
        })
    }
}

fn workers() -> &'static flume::Sender<Job> {
    static WORKERS: OnceLock<flume::Sender<Job>> = OnceLock::new();
    WORKERS.get_or_init(|| {
        let (tx, rx) = flume::unbounded::<Job>();
        for index in 0..HTTP_WORKERS {
            let rx = rx.clone();
            thread::Builder::new()
                .name(format!("rngpui-http-{index}"))
                .spawn(move || {
                    while let Ok(job) = rx.recv() {
                        job();
                    }
                })
                .expect("spawn rngpui-http worker");
        }
        tx
    })
}

/// ureq decides redirects per agent rather than per request, so each distinct
/// limit gets its own agent. They are cached because an `Agent` is what holds
/// the connection pool, and building one per request threw that away.
fn agent(redirects: u32) -> ureq::Agent {
    static AGENTS: OnceLock<Mutex<HashMap<u32, ureq::Agent>>> = OnceLock::new();
    let agents = AGENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut agents = agents.lock().unwrap_or_else(|error| error.into_inner());
    agents
        .entry(redirects)
        .or_insert_with(|| ureq::AgentBuilder::new().redirects(redirects).build())
        .clone()
}

fn send_blocking(parts: Parts, payload: Vec<u8>) -> anyhow::Result<Response<AsyncBody>> {
    let redirects = match parts.extensions.get::<RedirectPolicy>() {
        Some(RedirectPolicy::FollowLimit(limit)) => *limit,
        Some(RedirectPolicy::FollowAll) => FOLLOW_ALL_LIMIT,
        // NoFollow is the declared default, for a caller that wants to see the
        // redirect itself. The image loader asks for FollowAll explicitly.
        None | Some(RedirectPolicy::NoFollow) => 0,
    };
    let mut request = agent(redirects).request(parts.method.as_str(), &parts.uri.to_string());
    for (name, value) in parts.headers.iter() {
        if let Ok(value) = value.to_str() {
            request = request.set(name.as_str(), value);
        }
    }
    let response = match if payload.is_empty() {
        request.call()
    } else {
        request.send_bytes(&payload)
    } {
        Ok(response) => response,
        // a non-2xx is a Response the caller inspects (gpui's image loader turns
        // it into BadStatus with the body), not a transport failure.
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(anyhow!(error)),
    };

    let mut builder = Response::builder().status(StatusCode::from_u16(response.status())?);
    for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
            builder = builder.header(name, value);
        }
    }
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes)?;
    Ok(builder.body(AsyncBody::from(bytes))?)
}
