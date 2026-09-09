//! The app's HTTP client for GPUI.
//!
//! GPUI's default is a `NullHttpClient`, and its image loader is the one thing
//! that asks for a client: `<Image source={{ uri: 'https://…' }} />` resolves to
//! `Resource::Uri` and goes through `cx.http_client()`. Without a real client
//! every remote image failed to load and painted nothing, so the whole `<Image>`
//! surface only ever worked for local file paths.
//!
//! ureq already carries the embedded JS host's `fetch` (see `hermes.rs`), so this
//! is the same blocking request moved onto a scratch thread and handed back
//! through a channel the GPUI executor can await.

use std::io::Read;
use std::thread;

use anyhow::anyhow;
use futures::future::BoxFuture;
use gpui::http_client::http::request::Parts;
use gpui::http_client::{
    AsyncBody, HttpClient, RedirectPolicy, Request, Response, StatusCode, Url, http,
};
use futures::AsyncReadExt;

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
            // one request per thread: ureq is blocking and an image load must not
            // stall the executor the window's frames run on.
            let (tx, rx) = flume::bounded(1);
            thread::Builder::new()
                .name("rngpui-http".into())
                .spawn(move || {
                    let _ = tx.send(send_blocking(parts, payload));
                })?;
            rx.recv_async().await?
        })
    }
}

fn send_blocking(parts: Parts, payload: Vec<u8>) -> anyhow::Result<Response<AsyncBody>> {
    // gpui asks for NoFollow when a caller wants to see the redirect itself, and
    // ureq decides redirects per agent rather than per request.
    let follow = !matches!(
        parts.extensions.get::<RedirectPolicy>(),
        Some(RedirectPolicy::NoFollow)
    );
    let agent = ureq::AgentBuilder::new()
        .redirects(if follow { 5 } else { 0 })
        .build();
    let mut request = agent.request(parts.method.as_str(), &parts.uri.to_string());
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
