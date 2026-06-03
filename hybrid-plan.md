# Hybrid rendering plan — gpui shell, native-feel content

Status: **decision pending** (this doc captures the fork + the experiments to resolve it).

## The problem

Pure gpui gives us a fast, GPU-drawn, cross-platform UI — but after building a
pixel-perfect superconductor clone we hit gpui's real ceilings, and they cluster
in two areas:

1. **Rich rendering primitives** (verified in `memory/gpui-capability-matrix`):
   no radial/conic gradients, no CSS filters (blur/brightness/etc.), no
   mix-blend-mode, no per-element backdrop-blur, no true alpha masks, content
   masks are rectangle-only (no rounded-clip of children). Fine for clean UI,
   limiting for expressive content.
2. **Interaction feel**: gpui's scroll has weak momentum (our bridge's was
   hand-rolled with none); text input/selection must be hand-built or pulled
   from `gpui-component` (a 10k-line engine), and even then it's not the native
   macOS text/scroll experience (IME, services, rubber-band, momentum).

Key realization: **the things gpui is worst at are the things the web is best
at.** That reframes the whole decision.

## Verified enabling facts

- gpui 0.2.2 **publicly exposes the native window**: `impl HasWindowHandle for
  Window` (gpui `src/window.rs:4845`). From Rust we can reach
  `NSWindow.contentView` and `addSubview:` native AppKit views. gpui itself does
  this (its `GPUIView` is an `NSView`; it inserts an `NSVisualEffectView` for
  vibrancy). **No gpui fork required.**
- `wry` (cross-platform webview: WKWebView / WebView2 / WebKitGTK) embeds as a
  child view via the same window handle. `gpui-component`'s `webview` feature
  already does exactly this — proven, if rough.
- **rn-macos prior art** at `~/github/react-native-macos`: `RCTScrollView`
  (real `NSScrollView` — momentum, rubber-band, native bars), native text
  inputs, and a Fabric `Mounting/ComponentViews/` layer (the precise thing this
  repo replaces with gpui). Borrow + adapt, don't invent.
- This repo's premise (`react-native-gpui.md`): Fabric's mounting layer is
  **per-component-type and swappable**. So "native for X, gpui for Y" is one
  branch in the mounting delegate, not a bolt-on.

The common constraint across every native/web overlay: **native child views
composite ABOVE the gpui Metal layer** (z-order is one-way), clipping is
rectangular, and the view frame must be synced to layout (natural in Fabric —
it happens on commit, not per-frame).

## The candidate architectures

### A. Native-scroll **proxy** + gpui content
A transparent `NSScrollView` overlay exists only to capture the trackpad gesture
and produce a native, momentum-driven `contentOffset`; we observe it and tell
gpui to render its content translated by that offset.
- ✅ Native scroll *feel* (rubber-band/momentum) with **gpui-rendered content**.
- ❌ Must forward non-scroll mouse events through to gpui below (fiddly).
- ❌ Still stuck with gpui's primitive gaps for the content itself.
- ❌ Text input/selection still hand-built (or gpui-component).
- Effort: medium-high. No fork.

### B. Native-scroll + **native** content (rn-macos style)
ScrollView and its children are all native AppKit views.
- ✅ Easiest native scroll; this is literally what rn-macos ships.
- ❌ The whole scrolled subtree must be native → lose gpui/RN flexibility there.
- ❌ Most per-component native work; least expressive.
- Effort: medium (lean on rn-macos view managers).

### C. **Native shell + webview content** ("shell is native, contents are web")
Chrome (sidebars, tabs, toolbar, window controls, command palette) = gpui /
RN→gpui. The main content area (chat, markdown, docs, diffs) = one `wry`
webview rendering HTML/CSS/JS.
- ✅ **Web's rendering primitives for free**: gradients, filters, backdrop-blur,
  masks, blend modes, `::selection`, animations — every gpui gap, solved.
- ✅ **WebKit/Chromium scroll is excellent** at large content (momentum,
  `content-visibility`, GPU-composited). Native-feeling by default.
- ✅ Mature **text selection + editing + IME** inside the content for free.
- ✅ Markdown / streaming markdown / embedded media = trivial (it's the DOM).
- ✅ Cross-platform: wry is WKWebView/WebView2/WebKitGTK; the shell is gpui.
- ⚠️ **Resize jank**: webview relayout on window resize can stutter on large
  DOM (noted from experience). Mitigate: debounce resize, `content-visibility`,
  virtualization. Likely only bites on huge content.
- ❌ Z-order: webview paints over gpui → anything that must appear *over* the
  content (autocomplete, context menus, tooltips inside the content) must live
  *in* the webview, not gpui. Boundary rule: **shell = gpui; anything in/over
  content = web.**
- ❌ Two worlds: you maintain a web frontend + a gpui shell, plus an IPC bridge
  (postMessage / wry IPC) for shell↔content state. More surface area — but the
  content is exactly where that surface pays off.
- ❌ "Electron for the content" weight: one webview process + JS runtime for the
  content. Far lighter than full Electron (shell stays native), but not free.
- Effort: medium. The shell↔content protocol is the real design work.

## How they compare

| | gpui primitives | scroll feel | text/IME/selection | resize | cross-platform | dev surface |
|---|---|---|---|---|---|---|
| Pure gpui (today) | weak | poor (improvable) | hand-built | great | native everywhere | one world |
| A. scroll-proxy + gpui | weak | **native** | hand-built | great | mac-only proxy | one world + JNI-ish glue |
| B. native scroll+content | n/a (native) | **native** | **native** | great | mac-only | per-component native |
| C. webview content | **web (best)** | **excellent** | **native (web)** | ⚠️ jank risk | wry everywhere | two worlds + IPC |

## The decision lens

- **Content-heavy app** (chat, markdown, docs, diffs, rich text) → **C wins
  decisively**: it erases the primitive gaps AND the scroll/selection problems
  in one move, and content is where web is strongest. Superconductor-shaped apps
  are content-heavy.
- **Chrome-heavy / bespoke-drawn app** (dense custom widgets, canvas-y UI) →
  pure gpui or A/B, because the value is in custom GPU drawing, not web content.
- The expensive risk in C is **resize jank**; the expensive risk in A is the
  **scroll-proxy event-forwarding** + still being stuck with gpui's primitives.

## Experiments to resolve the fork (do these before committing)

1. **C — webview content spike**: gpui shell (sidebars + chrome) + one wry
   webview for the center area rendering the 40×-content scroll page. Measure:
   (a) scroll feel/fps with large content, (b) **resize stutter** while dragging
   the window with heavy DOM, (c) shell↔content IPC latency for a click.
   *This is the one to run first — it's the most promising and the resize risk
   is the only real unknown.*
2. **A — scroll-proxy spike**: transparent `NSScrollView` over the gpui content;
   feed `contentOffset` to the bridge's scroll. Measure scroll feel vs. C, and
   how bad the event-forwarding gets.
3. **Phase-0 freebie (do regardless)**: replace the bridge's hand-rolled scroll
   with gpui's built-in `Interactivity` scroll (it has momentum). Sets the
   honest "pure-gpui" baseline to compare A and C against.

## Leaning / recommendation

For a content-heavy product, **C (native gpui shell + webview content)** is the
strongest bet: it's the only option that fixes *both* gpui ceilings (primitives
**and** interaction) at once, scrolls large content beautifully, and stays
cross-platform via wry. The deciding question is whether resize jank is
acceptable — so **run experiment 1 first** and judge resize directly.

If resize proves unacceptable for the target content sizes, fall back to **A**
(native-scroll-proxy + gpui) for native scroll feel while keeping content in
gpui, accepting the primitive gaps.

Cross-platform story either way: **gpui shell everywhere; content layer is the
swappable part** — webview (C) or gpui+proxy (A) — chosen per platform if
desired (e.g., web content on all, native scroll-proxy only on mac).

## Spike results (2026-06)

- **Variant gpui** (`cargo run --release --bin variant-gpui`): works. gpui's
  built-in momentum scroll on 40× content. This is the live pure-gpui baseline.
- **Variant C** (`cargo run --release --bin variant-webview`): **WORKS, and feels
  great** — gpui shell + a wry/WKWebView (lb-wry) rendering the 40× content as
  HTML, with **native WebKit momentum scroll** (fast + smooth, the clear winner
  on feel). It runs on our **crates.io gpui 0.2.2** (no git gpui needed). The
  WebView is a child of gpui's Metal NSView and composites fine.
- **Two red herrings that made it look broken for hours:** (1) cua / window-image
  capture **cannot see WKWebView's separate render surface** — every webview
  screenshot was blank to the agent even when the page was on screen; only a
  full-screen `screencapture` shows it. (2) the app was being launched from
  inside **sandbox-exec**, which blocked WKWebView's `WebContent` XPC from
  rendering — clearing the sandbox made it come alive instantly. Neither was a
  gpui or design problem.
- **Implementation notes that mattered:** use **lb-wry** (`wry` pkg `lb-wry`),
  and **load the HTML on the first render** (when the window is on screen), not
  during build / in `new()` — `with_html` at build time can no-op.

## Notes

- The hybrid belongs in the **real Fabric mounting layer** (`GpuiMountingDelegate`
  from the design doc), where per-component native/web/gpui mounting is a one-line
  branch — not the current bun-FFI/JSON prototype (which proved gpui can render RN
  trees and is good enough for the spikes above).
- See `memory/gpui-capability-matrix` (primitive gaps) and `memory/rn-bridge-parity`
  (what the bridge already does).
