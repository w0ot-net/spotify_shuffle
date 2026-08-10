# Plan: Dark Glassmorphism Theme

## Summary

Give the page a deliberate visual identity: a dark glassmorphism theme --
translucent blurred panels, thin luminous borders, a monospace wordmark
banner, and a single Spotify-green accent -- served as one first-party
stylesheet. The Content Security Policy gains exactly `style-src 'self'`
and the service gains a `/styles.css` route beside `/app.js`. No browser
logic changes: the CSS styles the existing elements and their state
attributes, so `web/app.js` and `web/pure.js` are untouched.

## Problem

The page is unstyled browser default text on a white background. Every
state the app carefully renders -- connection, the source list, progress,
the countdown, cancellation -- reads as an undifferentiated column. The
CSP is the concrete blocker: `default-src 'none'` with no `style-src`
means a stylesheet cannot load at all, by the security model's deliberate
design. Styling therefore requires a CSP directive and an asset route,
not just a CSS file.

## Scope

In scope:

- Add `style-src 'self'` to `contentSecurityPolicy`; no other directive
  changes, and no third-party origin is introduced.
- Serve `web/styles.css` at `GET /styles.css` with `text/css`, embedded
  and secured exactly as the scripts are; generalize the existing
  `serveScript` helper to serve any asset with a given content type.
- Link the stylesheet from `web/index.html`, add a monospace ASCII banner,
  and wrap the existing controls in styling containers -- adding classes
  and structure only, never changing an element id, its `role`,
  `aria-live`, or the `hidden`/`aria-pressed`/`disabled` contract
  `web/app.js` drives.
- Write `web/styles.css`: a dark glass theme with CSS-variable tokens, the
  banner, the connection controls, the scrollable source list with a
  pressed-selection state, styled progress and status lines, and the
  buttons, keyboard focus rings, and a `prefers-reduced-motion` fallback
  for the blur and any transition.
- Update the served-page contract test, the security and service
  architecture pages, and the README.

Out of scope:

- Any change to `web/app.js` or `web/pure.js`. Selection, disabled,
  hidden, progress, and wait state are all already expressed as
  attributes the CSS can target; adding a class hook the JS must maintain
  is deliberately avoided.
- A light theme or `prefers-color-scheme` switching. The requested look is
  dark glass; a single committed dark palette is simpler and is what
  "similar styling" asks for.
- Web fonts, icons, images, or any `font-src`/`img-src` addition. The
  banner is text; type uses system stacks, so no new asset origin is
  needed.
- A theme toggle, multiple themes, or a settings surface.
- Copying any external site's stylesheet; the theme is authored here.

## Design

**The CSP change is one directive.** `style-src 'self'` permits the
first-party sheet and nothing inline -- no `style` attributes, no
`<style>` blocks -- preserving the no-inline posture the script rules
already hold. The served page must therefore carry no inline style, which
the existing "no inline script" discipline already models.

**One asset helper, one new route.** `serveScript(script)` becomes
`serveAsset(content, contentType)`; the two script routes pass
`text/javascript` and the new route passes `text/css; charset=utf-8`.
Same embed mechanism, same security headers, same exact-route matching --
`/styles.css/` is rejected like the script paths.

**Style the state that already exists.** The app communicates entirely
through element ids, `hidden`, `aria-pressed` on the selected row button,
and `disabled` during an active chain. The stylesheet targets exactly
those: `[hidden]` stays hidden, `button[aria-pressed="true"]` is the
selected panel, `button:disabled` is dimmed, `progress` is themed. This
is why no JavaScript changes -- the contract the CSS depends on is the one
the app already maintains, and `main_test.go`'s marker and ordering tests
keep it honest.

**The visual language.** Dark ground (near-black, faintly blue), panels
that are semi-transparent white over it with `backdrop-filter: blur()`,
1px borders at low-alpha white for the "lit glass" edge, and soft ambient
shadow. One accent -- Spotify green `#1DB954` -- carries the primary
action, the selected row, and the focus ring; status text is a muted
foreground. A monospace wordmark banner (`<pre>`) opens the page in the
reference's console idiom. Type is system stacks: a sans body and a
monospace banner, so no font asset is fetched. Tokens live in `:root`
custom properties so the palette is one edit, and `body` paints its own
background explicitly rather than borrowing the browser default.

**Accessibility is not sacrificed to the aesthetic.** Foreground/accent
pairs meet WCAG AA on the dark ground; every interactive control keeps a
visible `:focus-visible` ring distinct from hover; and
`prefers-reduced-motion: reduce` drops the blur and transitions to flat
translucency so the effect never causes motion discomfort. The `aria-live`
regions keep their exact roles, so screen-reader behavior is unchanged.

**Failure scope.** Styling is presentational. If `/styles.css` fails to
load the page renders unstyled but fully functional -- every control keeps
its behavior, since none depends on the sheet. The route test and a
deployed page load cover that the sheet is served and linked.

## Affected Components

- `main.go`: add `style-src 'self'` to `contentSecurityPolicy`; embed
  `web/styles.css`; generalize `serveScript` to `serveAsset` and add the
  `GET /styles.css` route.
- `main_test.go`: assert the `/styles.css` route, its `text/css` content
  type, and the security headers; add `/styles.css/` to the exact-route
  cases; assert the CSP permits `style-src 'self'`; extend the page-marker
  test with the stylesheet link and the banner.
- `web/index.html`: link `/styles.css`, add the banner and the styling
  containers, preserving every id and state attribute.
- `web/styles.css` (new): the dark glass theme.
- `doc/architecture/security/SECURITY_MODEL.md`: the CSP now permits a
  first-party stylesheet; still no inline style and no third-party asset
  origin.
- `doc/architecture/service/SERVICE_MODEL.md`: add the `/styles.css` route
  to the table.
- `README.md`: the Browser security section names the stylesheet source;
  a line notes the page is themed.

No change is expected in `web/app.js`, `web/pure.js`, the telemetry code,
`connect-src`, the OAuth scopes, or any host configuration.

## Implementation Sequence

1. Add the CSP directive, generalize the asset helper, embed and route the
   stylesheet, and update `main_test.go`.
2. Restructure `web/index.html` with the link, banner, and containers,
   changing no id or state attribute.
3. Write `web/styles.css`.
4. Update the two architecture pages and the README.
5. Validate, commit, push, and deploy per the standing directive through
   the private runbook.

## Validation

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --test web/pure_test.js web/app_test.js
git diff --check
```

The Go tests must prove `/styles.css` is served with `text/css` and the
security headers, is an exact route, and that the served CSP contains
`style-src 'self'`. The browser suites must pass unmodified -- proof that
the DOM restructure preserved every id and state contract the harness
drives. A grep confirming the served page and stylesheet contain no inline
`style=` attribute keeps the no-inline-style posture load-bearing.

Manual browser validation, local server, no Spotify account required:
load the page and confirm the theme renders, both scripts and the sheet
load with no CSP violation in the console, keyboard focus rings are
visible, and the layout holds at a phone width.

Deployment validation: confirm `/styles.css` returns 200 with `text/css`
on the deployed origin, the page links it, and the CSP header carries
`style-src 'self'`.

## Success Criteria

- The page renders as a dark glassmorphism theme -- blurred translucent
  panels, a monospace banner, a single green accent -- at phone and
  desktop widths.
- The selected source row, disabled controls during a chain, the progress
  bar, and the countdown are each visually distinct, driven entirely by
  the existing state attributes with no JavaScript change.
- The CSP permits only the first-party stylesheet; no inline style and no
  third-party asset origin exists.
- `/styles.css` is served with `text/css` and the security headers, is an
  exact route, and is linked by the page.
- Keyboard focus is always visible and `prefers-reduced-motion` drops the
  blur and transitions.
- The Go and browser suites pass, the browser suite unmodified.
- The security and service pages and the README describe the stylesheet
  and the theme.

## Execution Notes

Executed 2026-08-10. Implementation commit `68400ac`.

Implemented as planned: `style-src 'self'` added to
`contentSecurityPolicy`; `serveScript` generalized to `serveAsset(content,
contentType)` and `web/styles.css` embedded and routed at `GET /styles.css`
with `text/css`; `web/index.html` restructured with the stylesheet link, a
monospace riffle-shuffle banner (`aria-hidden`), a new tagline, and glass
panel containers -- every id, `role`, `aria-live`, and `hidden` attribute
preserved so no browser logic changed. `web/styles.css` is a dark theme
with CSS-variable tokens: near-black ground with a faint green refraction
glow, translucent `backdrop-filter` panels with luminous 1px edges, one
Spotify-green accent on the connect action / selected row / focus ring,
system-sans body with monospace wordmark and controls, source rows styled
as a dealt stack with an `aria-pressed` selection state, themed progress
and scrollbar, always-visible `:focus-visible` rings, and a
`prefers-reduced-motion` fallback that drops the blur and transitions.

Deviations: none in scope. Two things worth noting: no JavaScript file was
touched, exactly as the boundary intended -- the sheet drives entirely off
existing state attributes; and a live browser screenshot could not be
captured (browser tooling unavailable this session), so the render was
verified structurally (balanced braces, every state selector resolving to
a real element, the `[hidden] { display: none !important }` override, and
served CSP/content-type over a local server) rather than visually. A
human glance at the deployed page is the remaining visual confirmation.

Bounded additions to the plan's test list, both matching existing
conventions: `main_test.go` also asserts the served page carries no inline
`style=`/`<style>` (mirroring the no-inline-script check) and pins
`style-src 'self'` in the CSP constant.

Validation, all passing: `gofmt -l` clean, `go test ./...` (new
`/styles.css` route, content-type, exact-route, CSP, and marker
assertions), `go vet ./...`, `node --test web/pure_test.js
web/app_test.js` (119 pass, 0 fail, unmodified -- proof the DOM
restructure preserved every contract), `git diff --check`, and an ASCII
check of the new files. Local server confirmed `/styles.css` returns 200
`text/css` and the served CSP carries `style-src 'self'`.

Deployment, completed 2026-08-10 under the standing deployment direction
through the private runbook: release
`13269d6494aeb7609319e570f8968c63d5f142dd` (binary SHA-256
`a67d95538260c03e3483...`, embedded revision matching,
`vcs.modified=false`); host Go and browser suites passed; previous release
`266af0f...` retained; after the atomic switch the service is active as
`trueshuffle` with zero restarts and zero warning journal entries.

The new release was fully validated over loopback: `/styles.css` returns
200 `text/css`, the served page links the sheet, the CSP header carries
`style-src 'self'`, and a loopback-resolved HTTPS request through Apache
returned 200 -- so the public-facing stack serves the theme end to end.
One caveat, an infrastructure condition rather than a deployment fault:
at deploy time the host could not resolve `shuffle.p.a-9.co` (`a-9.co`
and other names resolved normally), so the public-URL health check could
not run from the host. The service is healthy and was not rolled back;
public DNS for the subdomain should be confirmed separately.
