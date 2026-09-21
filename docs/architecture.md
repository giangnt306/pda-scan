# Architecture

## Purpose

`pda-scan` is a mobile-first web application for warehouse goods receipt. An
operator opens a live camera, scans the barcodes on a part label or photographs
the label whole, and reviews, corrects, and confirms the resulting record before
it is persisted.

The application is currently a functional prototype. The user interface, the
barcode scanner, and the review workflow are complete; the image-recognition
service and the persistence backend are not yet implemented and are represented
by local stubs.

## Technology stack

| Component                   | Version | Role                                            |
| --------------------------- | ------- | ----------------------------------------------- |
| Vite                        | 5.4     | Development server and production bundler       |
| React                       | 18.3    | User interface library                          |
| `@vitejs/plugin-react`      | 4.7     | JSX transformation and Fast Refresh             |
| `@vitejs/plugin-basic-ssl`  | 1.2     | Self-signed certificate for the dev server      |
| `barcode-detector`          | 3.2     | WebAssembly ponyfill for the BarcodeDetector API |

Beyond React and the barcode ponyfill the project carries no runtime
dependencies. There is no router, no external state-management library, no
component library, and no CSS framework. TypeScript is not used. Styling is
hand-authored CSS.

This minimalism is a design decision rather than an omission. The application
consists of one screen, one form, one camera sheet, and no client-side
navigation; none of the libraries listed above would earn their maintenance cost
at the present scope.

The one dependency that was added, `barcode-detector`, exists because the
platform API it ponyfills is absent on desktop Chrome. It is dynamically
imported, so devices that provide the native API never download it.

## Source layout

```
index.html            Vite entry point; document shell, viewport, font loading
vite.config.js        HTTPS dev server, host binding, plugin registration
src/main.jsx          React root mount
src/App.jsx           Field schema, form components, application state
src/ScannerSheet.jsx  Full-screen camera sheet: live scan and label capture
src/lib/barcode.js    Barcode engine selection (native or ponyfill)
src/lib/camera.js     getUserMedia, torch, frame grab, haptics
src/lib/normalize.js  Date and code normalisation, label format patterns
src/index.css         Design tokens and all component styling
docs/                 This documentation
```

Line counts as of this document: `App.jsx` 431, `index.css` 688,
`ScannerSheet.jsx` 186, `camera.js` 74, `barcode.js` 60, `normalize.js` 57,
`main.jsx` 10.

## Module responsibilities

### `index.html`

Under Vite, `index.html` is the build entry point rather than a static asset.
Vite parses it, resolves the `<script type="module">` reference to
`src/main.jsx`, and builds the dependency graph from there.

The document head is configured for handheld use:

- `lang="vi"` drives keyboard selection, autocorrection, and assistive
  technology pronunciation.
- `maximum-scale=1` suppresses double-tap zoom, which would otherwise disturb
  the layout during rapid data entry. Note that current versions of iOS Safari
  ignore this directive.
- `viewport-fit=cover` permits the layout to extend into display cutouts and is
  paired with `env(safe-area-inset-*)` in the stylesheet.
- `theme-color` matches the application header colour.
- Barlow (body text) and IBM Plex Mono (identifiers) are loaded from Google
  Fonts with `preconnect` hints.

### `src/main.jsx`

Mounts the React tree using the React 18 `createRoot` API and wraps the
application in `StrictMode`. `StrictMode` is a development-only construct: it
double-invokes renders and effect cycles in order to surface impure side
effects, and is eliminated from production builds.

Note that the scanner's camera effect is written to tolerate this
double-invocation; see the teardown discussion under `ScannerSheet.jsx`.

### `src/App.jsx`

The form half of the application: the field schema, the components that render
it, and all shared state.

`Field` (line 81) renders one form control. It selects the control type from the
field descriptor, applies the provenance attribute used for styling, renders the
provenance badge and validation message, and — for descriptors marked
`scannable` — renders the scan button that opens the camera bound to that field.

`FieldList` (line 163) walks a field array and groups consecutive descriptors
marked `half` into a single horizontal row.

`App` (line 201) holds all application state and composes the screen: capture
panel, provenance legend, mandatory field group, optional field group, action
bar, transient toast, and the scanner sheet when open.

### `src/ScannerSheet.jsx`

A full-screen camera sheet, mounted only while `scanner` state is non-null. It
serves two purposes from one camera stream:

- **Barcode scanning.** A `setTimeout` loop (`DETECT_INTERVAL`, 120 ms, roughly
  eight passes per second) runs the barcode detector against the live video
  element. The interval is a deliberate compromise between responsiveness and
  battery drain on a handheld device.
- **Label capture.** The shutter button grabs one frame, downscales and
  compresses it, and hands it to the recognition path.

Three behaviours in this component are worth stating explicitly:

- **Duplicate suppression.** A barcode remains in the camera's view for many
  frames. `lastHitRef` records the last decoded value and its timestamp, and a
  repeat of the same value within `DEDUPE_MS` (1800 ms) is discarded. Without
  this, one physical barcode produces a burst of identical hits.
- **Teardown.** `aliveRef` is checked after every `await` and in the loop body,
  and the effect's cleanup stops the media tracks. This is what prevents the
  camera indicator remaining lit, and what makes `StrictMode`'s double mount
  harmless.
- **Targeted versus free scanning.** When opened from a field's scan button the
  sheet receives that `target` descriptor, writes the first hit into that field,
  and closes itself after a short delay so the operator sees what was captured.
  When opened from the main capture panel there is no target; the decoded value
  is displayed with a "use this code" button instead of being written
  automatically.

Camera failures are mapped to operator-facing Vietnamese text through
`ERROR_TEXT`, keyed by `DOMException.name`. The insecure-context and
permission-denied cases carry recovery instructions rather than a bare error,
since both are recoverable by the operator.

### `src/lib/camera.js`

Wraps the MediaDevices API. `startCamera` checks `isSecureContext` and API
availability before requesting the stream, so the failure modes surface as named
exceptions rather than as an unexplained rejection. The video constraints use
`ideal` rather than `exact` for `facingMode`, which keeps the application usable
on a development laptop that has only a front-facing camera.

`grabFrame` draws the current video frame to a canvas, scales the long edge down
to 1280 px, and encodes JPEG at quality 0.82. A raw 1920 px frame is roughly
1.5 MB; the compressed frame is roughly 150 KB. On warehouse WiFi that
difference determines whether recognition feels immediate.

`torchCapable` and `setTorch` drive the device flash through
`MediaStreamTrack.applyConstraints`. Support is not universal, so both failure
paths are handled: the button is hidden when the capability is absent, and it is
hidden after the fact if applying the constraint throws.

`buzz` wraps `navigator.vibrate`, which is a no-op or absent on some platforms.

### `src/lib/barcode.js`

Selects the decoding engine and caches the selection in a module-level promise,
so the choice is made once per page load.

The native `BarcodeDetector` is preferred where present: on Chrome for Android
it is backed by the Google Play Services ML stack, costs no additional download,
and is markedly faster. It is absent on Chrome for Windows and Linux, where the
module falls back to a dynamically imported WebAssembly ponyfill.

Because the import is dynamic, Android devices never download the WebAssembly
payload. The ponyfill fetches its `.wasm` file from a CDN and therefore requires
internet access on development machines; devices using the native engine do not.

`WANTED_FORMATS` is intersected with the formats the chosen engine reports as
supported. Narrowing this array to the symbologies a given warehouse actually
uses improves both speed and accuracy, and is the intended tuning point.

### `src/lib/normalize.js`

Converts raw text — from a barcode, or eventually from the recognition service —
into the forms the schema expects, and holds the regular expressions derived
from the sample labels. See [data-model.md](data-model.md) for the rules
themselves.

### `src/index.css`

Defines design tokens on `:root` and styles every component, including the
scanner sheet.

Several choices target the operating environment explicitly:

- `--tap: 52px` exceeds the conventional 44px minimum, because operators may be
  wearing gloves.
- `--bg: #e9ecf0` is a cool grey rather than pure white, to reduce glare under
  warehouse lighting.
- `min-height: 100dvh` accounts for the collapsing mobile address bar, which
  `100vh` handles incorrectly.
- `overscroll-behavior-y: none` disables pull-to-refresh, preventing accidental
  loss of unsaved form data.
- `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` inset the fixed
  header, the action bar, and the scanner's own controls on devices with display
  cutouts.
- `max-width: 520px` with automatic horizontal margins preserves the handheld
  layout when the application is opened on a desktop browser.
- A `prefers-reduced-motion` query disables transitions for users who request
  reduced motion.

## Rendering and data flow

```
                     ┌─ barcode decode ─────────────┐
live camera  ────────┤                              ├─→ values + provenance
                     └─ frame capture → recognition ┘         metadata
                                        (stubbed)                 ↓
                                                    operator review and correction
                                                                  ↓
                                        validation → confirmation → persistence
                                                                     (stubbed)
```

Application state is held in `App` using `useState` and passed downward through
props. There is no context, no reducer, and no external store. Two state objects
form the core of the design:

- `values` — the current content of each field, keyed by field `key`.
- `metas` — the provenance of that content: its origin, how it was obtained, the
  recognition confidence, and whether the operator has since edited it.

Validation state is not stored. The `errors` object is derived from `values`
through `useMemo` (line 212), which makes it impossible for validation results
to drift out of step with the data they describe.

Provenance is communicated to the stylesheet through a data attribute. `Field`
renders `data-src={src}`, and `index.css` matches on `[data-src="sure"]`,
`[data-src="doubt"]`, and `[data-invalid="true"]` to colour the vertical
indicator bar beside each control.

The two input paths are not equal in authority. `applyAiResult` skips any field
whose metadata records `via: "scan"`, so a barcode that has already been decoded
is never overwritten by a later recognition pass. A decoded barcode is exact
where recognition is probabilistic, and the operator should not have to defend a
scanned value against the model.

## Image capture

Capture uses `getUserMedia` with a live preview rather than the native file
input. The earlier prototype used `<input type="file" capture="environment">`,
which required no permission handling and worked over plain HTTP; it was
replaced because barcode scanning needs a continuous frame source, and because a
live viewfinder lets the operator see that the label is framed before the shutter
is pressed.

The cost of that change is a secure-context requirement: `getUserMedia` is
unavailable over plain HTTP to a LAN address. The development server therefore
runs HTTPS with a self-signed certificate; see [development.md](development.md).

## Known stubs

| Location                   | Current behaviour                            | Intended behaviour                                   |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `FAKE_AI` (line 66)        | Hard-coded recognition result                | Response from the recognition service                |
| `recognize` (line 253)     | Waits 900 ms, then applies `FAKE_AI`         | Uploads `frame.blob` and consumes the response       |
| `confirm` (line 302)       | Logs the payload to the console              | Submits the payload to the backend                   |

Both stub sites carry source comments identifying the implementation step that
will replace them. `applyAiResult`, which normalises and merges the result, is
written against the real contract and is not expected to change when the service
is connected.
