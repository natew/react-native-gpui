// Corner-clip + drop-shadow conformance fixture for the two native stage surfaces:
// a WebView (composited as an AppKit underlay below Metal) and the GhosttyTerminal
// (painted into the Metal scene). Both carry a borderRadius + a boxShadow, exactly
// the way the agentbus stage drives them. Rendered on a bright contrasting field so
// the rounded clip (the bright field shows through the corner, not a square surface)
// and the soft shadow falloff (a darker band just outside the card edge) are both
// measurable in pixels by check-card-corner-shadow-conformance.ts.
//
// The webview body is OPAQUE (#101428) so the corner clip is provable even when the
// WebContent XPC can't start (sandboxed shells): the host layer paints that opaque
// base, masksToBounds clips it to the radius, so the corner pixel is the bright field
// — not the body color — regardless of whether the page itself painted.
import { GhosttyTerminal, render, View, WebView } from "../src/index";

// a bright field so any square surface poking past the rounded corner is obvious,
// and the shadow reads as a darker falloff against it.
const FIELD = "#f2c84b";

const CARD_RADIUS = 24;
const CARD_SHADOW = "0 12px 32px -8px rgba(0,0,0,0.55), 0 2px 8px -2px rgba(0,0,0,0.4)";

const WEBVIEW_HTML = `<!doctype html><meta charset="utf8">
<body style="margin:0;height:520px;background:#101428;color:#cdd6ff;font-family:-apple-system,system-ui,sans-serif">
  <div style="height:520px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800">webview card</div>
</body>`;

function App() {
  return (
    <View
      style={{
        width: 900,
        height: 620,
        position: "relative",
        backgroundColor: FIELD,
      }}
    >
      <WebView
        accessibilityLabel="corner-shadow webview"
        source={{ html: WEBVIEW_HTML }}
        onLoad={() => console.log("CARD_WEBVIEW_PAGE_LOAD")}
        style={{
          position: "absolute",
          left: 60,
          top: 60,
          width: 360,
          height: 460,
          backgroundColor: "#101428",
          borderRadius: CARD_RADIUS,
          overflow: "hidden",
        }}
        boxShadow={CARD_SHADOW}
      />
      <GhosttyTerminal
        accessibilityLabel="corner-shadow terminal"
        sessionId="card-corner-fixture"
        frames={[
          {
            seq: 1,
            kind: "snapshot",
            cols: 40,
            rows: 18,
            data: btoa("rounded terminal card\r\n$ echo hello\r\nhello\r\n"),
          },
        ]}
        style={
          {
            position: "absolute",
            left: 480,
            top: 60,
            width: 360,
            height: 460,
            backgroundColor: "#050507",
            color: "#e4e4e7",
            fontFamily: "Menlo",
            fontSize: 13,
            lineHeight: 18,
            borderRadius: CARD_RADIUS,
            overflow: "hidden",
          } as never
        }
        boxShadow={CARD_SHADOW}
      />
    </View>
  );
}

render(<App />, { width: 900, height: 620 });
