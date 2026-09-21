# Architecture

## Purpose

`pda-scan` is a mobile-first web application for warehouse goods receipt. An
operator opens a live camera, photographs a part label, and reviews, corrects,
and confirms the resulting record before it is persisted.

The application is currently a functional prototype. The user interface, label
capture, and the review workflow are complete; the image-recognition service
and the persistence backend are not yet implemented and are represented
by local stubs.

## Technology stack

| Component                    | Version | Role                                       |
| ---------------------------- | ------- | ------------------------------------------ |
| Vite                         | 5.4     | Development server and production bundler  |
| React                        | 18.3    | User interface library                     |
| `@vitejs/plugin-react`     | 4.7     | JSX transformation and Fast Refresh        |
| `@vitejs/plugin-basic-ssl` | 1.2     | Self-signed certificate for the dev server |

Beyond React the project carries no runtime dependencies. There is no router,
no external state-management library, no component library, and no CSS framework.
TypeScript is not used. Styling is hand-authored CSS.

This minimalism is a design decision rather than an omission. The application
consists of one screen, one form, one camera sheet, and no client-side
navigation; none of the libraries listed above would earn their maintenance cost
at the present scope.

Barcode scanning is not implemented. Field values come from label capture and
recognition, or from manual entry.

## Source layout

```
index.html            Vite entry point; document shell, viewport, font loading
vite.config.js        HTTPS dev server, host binding, plugin registration
src/main.jsx          React root mount
src/App.jsx           Field schema, form components, application state
src/ScannerSheet.jsx  Full-screen camera sheet: live preview and label capture
src/lib/camera.js     getUserMedia, torch, ImageCapture photo, save/share, haptics
src/lib/normalize.js  Date and code normalisation, label format patterns
src/index.css         Design tokens and all component styling
docs/                 This documentation
```

Line counts as of this document: `App.jsx` 462, `index.css` 732,
`ScannerSheet.jsx` 147, `camera.js` 167, `normalize.js` 57, `main.jsx` 10.

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

Note that the camera sheet's effect is written to tolerate this
double-invocation; see the teardown discussion under `ScannerSheet.jsx`.

### `src/App.jsx`

The form half of the application: the field schema, the components that render
it, and all shared state.

`Field` (line 82) renders one form control. It selects the control type from the
field descriptor, applies the provenance attribute used for styling, and renders
the provenance badge and validation message.

`FieldList` (line 142) walks a field array and groups consecutive descriptors
marked `half` into a single horizontal row.

`App` (line 179) holds all application state and composes the screen: capture
panel, photo information panel, provenance legend, mandatory field group,
optional field group, action bar, transient toast, and the camera sheet when
open.

### `src/ScannerSheet.jsx`

A full-screen camera sheet, mounted only while `cameraOpen` state is true. It
shows the live camera as a viewfinder with a framing window and a shutter
button. The shutter takes a still photo through `ImageCapture.takePhoto()` and
hands it to `App`, which saves the original and sends a downscaled copy to the
recognition path, then the sheet closes. On a browser without `ImageCapture`
the shutter is hidden and the sheet can only be closed; see
[image-capture.md](image-capture.md).

**Teardown.** `aliveRef` is checked after every `await`, and the effect's
cleanup stops the media tracks. This is what prevents the camera indicator
remaining lit, and what makes `StrictMode`'s double mount harmless.

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

`takeFullPhoto` asks the sensor for a real still image at the maximum
resolution reported by `getPhotoCapabilities()`, retrying without size settings
if the device rejects them. `getPhotoInfo` reports that maximum for display.
`downscale` scales the long edge down to 1280 px and encodes JPEG at quality
0.82, roughly 150 KB, for the viewfinder and the recognition upload.
`buildFilename`, `saveToDevice`, and `shareFile` store the original on the
device. The capture pipeline is described in [image-capture.md](image-capture.md).

`torchCapable` and `setTorch` drive the device flash through
`MediaStreamTrack.applyConstraints`. Support is not universal, so both failure
paths are handled: the button is hidden when the capability is absent, and it is
hidden after the fact if applying the constraint throws.

`buzz` wraps `navigator.vibrate`, which is a no-op or absent on some platforms.

### `src/lib/normalize.js`

Converts raw text from the recognition service into the forms the schema
expects, and holds the regular expressions derived from the sample labels. See [data-model.md](data-model.md) for the rules
themselves.

### `src/index.css`

Defines design tokens on `:root` and styles every component, including the
camera sheet.

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
  header, the action bar, and the camera sheet's own controls on devices with display
  cutouts.
- `max-width: 520px` with automatic horizontal margins preserves the handheld
  layout when the application is opened on a desktop browser.
- A `prefers-reduced-motion` query disables transitions for users who request
  reduced motion.

## Rendering and data flow

```
live camera ─→ takePhoto ─→ recognition ─→ values + provenance
                               (stubbed)          metadata
                                                     ↓   ←── manual entry
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
through `useMemo` (line 191), which makes it impossible for validation results
to drift out of step with the data they describe.

Provenance is communicated to the stylesheet through a data attribute. `Field`
renders `data-src={src}`, and `index.css` matches on `[data-src="sure"]`,
`[data-src="doubt"]`, and `[data-invalid="true"]` to colour the vertical
indicator bar beside each control.

## Image capture

Capture uses `getUserMedia` with a live preview rather than the native file
input. The earlier prototype used `<input type="file" capture="environment">`,
which required no permission handling and worked over plain HTTP; it was
replaced because a live viewfinder lets the operator see that the label is
framed before the shutter is pressed.

The cost of that change is a secure-context requirement: `getUserMedia` is
unavailable over plain HTTP to a LAN address. The development server therefore
runs HTTPS with a self-signed certificate; see [development.md](development.md).

The live video feeds the preview only. Still photos are taken exclusively through the ImageCapture API; drawing a video frame to a
canvas is no longer used, because it is limited to the stream resolution
(typically 1920×1080) and to the stream's video processing. Details are in
[image-capture.md](image-capture.md).

## Known stubs

| Location                 | Current behaviour                     | Intended behaviour                              |
| ------------------------ | ------------------------------------- | ----------------------------------------------- |
| `FAKE_AI` (line 67)    | Hard-coded recognition result         | Response from the recognition service           |
| `recognize` (line 223) | Waits 900 ms, then applies`FAKE_AI` | Uploads`frame.blob` and consumes the response |
| `confirm` (line 291)   | Logs the payload to the console       | Submits the payload to the backend              |

Both stub sites carry source comments identifying the implementation step that
will replace them. `applyAiResult`, which normalises and merges the result, is
written against the real contract and is not expected to change when the service
is connected.
