# Architecture

## Purpose

`pda-scan` is a mobile-first web app for warehouse goods receipt. An operator:

1. Opens the live camera.
2. Captures a part label.
3. Reviews and corrects the extracted data.
4. Confirms the record before persistence.

The app is currently a functional prototype. The UI, label capture, and review flow are complete. Image recognition and persistence are still local stubs.

## Technology Stack

| Component                    | Version | Role                                      |
| ---------------------------- | ------: | ----------------------------------------- |
| Vite                         |     5.4 | Development server and production bundler |
| React                        |    18.3 | UI library                                |
| `@vitejs/plugin-react`     |     4.7 | JSX transformation and Fast Refresh       |
| `@vitejs/plugin-basic-ssl` |     1.2 | Self-signed HTTPS for development         |

The project intentionally has no router, state-management library, component library, CSS framework, or TypeScript. Styling is written in plain CSS.

This is appropriate for the current scope: one screen, one form, one camera sheet, and no client-side navigation.

Barcode scanning is not implemented. Values come from label recognition or manual entry.

## Source Layout

```text
index.html            Vite entry point, document shell, viewport, fonts
vite.config.js        HTTPS dev server and plugin configuration
src/main.jsx          React root
src/App.jsx           Field schema, form components, application state
src/ScannerSheet.jsx  Full-screen camera and label capture
src/lib/camera.js     Camera, torch, photo, save/share, haptics
src/lib/normalize.js  Date/code normalization and label patterns
src/index.css         Design tokens and component styling
docs/                 Documentation
```

Current file sizes: `App.jsx` 462 lines, `index.css` 732, `ScannerSheet.jsx` 147, `camera.js` 167, `normalize.js` 57, `main.jsx` 10.

## Module Responsibilities

### `index.html`

Vite uses `index.html` as the application entry point and resolves `src/main.jsx` from it.

The document is optimized for handheld use:

- `lang="vi"` supports Vietnamese keyboard behavior, autocorrection, and assistive technology.
- `maximum-scale=1` reduces accidental zoom during data entry. Current iOS Safari may ignore it.
- `viewport-fit=cover` supports display cutouts with `env(safe-area-inset-*)`.
- `theme-color` matches the app header.
- Barlow and IBM Plex Mono are loaded from Google Fonts with `preconnect`.

### `src/main.jsx`

Mounts the React app with React 18 `createRoot` and `StrictMode`.

`StrictMode` is development-only and may run renders/effects twice. The camera effect is designed to handle this safely.

### `src/App.jsx`

Contains the form schema, form components, and application state.

- `Field` renders a field, applies its provenance state, and shows validation feedback.
- `FieldList` groups consecutive fields marked `half` into one row.
- `App` manages the full screen: capture panel, photo information, provenance legend, required/optional fields, action bar, toast, and camera sheet.

### `src/ScannerSheet.jsx`

Provides the full-screen camera UI:

- Live camera preview with a framing window.
- Shutter button using `ImageCapture.takePhoto()`.
- Original photo saved by `App`.
- Downscaled image sent to the recognition flow.
- Sheet closes after capture.

If `ImageCapture` is unavailable, the shutter is hidden and the sheet can only be closed.

**Cleanup:** `aliveRef` is checked after each `await`, and cleanup stops all media tracks. This prevents the camera indicator from remaining active and makes `StrictMode`'s double mount safe.

Camera errors are mapped to Vietnamese operator messages through `ERROR_TEXT`. Insecure-context and permission errors include recovery instructions.

### `src/lib/camera.js`

Wraps the browser MediaDevices API.

- `startCamera` checks secure-context and API support before requesting the camera.
- `facingMode` uses `ideal` rather than `exact`, allowing development on devices with only a front camera.
- `takeFullPhoto` requests the sensor's maximum supported still-image resolution and retries without size settings if needed.
- `getPhotoInfo` exposes the maximum photo resolution.
- `downscale` reduces the long edge to 1280 px and encodes JPEG at quality `0.82` (about 150 KB).
- `buildFilename`, `saveToDevice`, and `shareFile` handle the original image.
- `torchCapable` and `setTorch` control the device torch through `MediaStreamTrack.applyConstraints`. Unsupported or failed torch operations hide the button.
- `buzz` wraps `navigator.vibrate`; it is a no-op where vibration is unavailable.

See `image-capture.md` for the capture pipeline.

### `src/lib/normalize.js`

Converts raw recognition text into the schema's expected formats and contains regular expressions derived from the sample labels.

See `data-model.md` for the detailed rules.

### `src/index.css`

Defines design tokens and styles all components, including the camera sheet.

Key environment-specific choices:

- `--tap: 52px` provides a larger touch target for gloved operators.
- `--bg: #e9ecf0` reduces glare compared with pure white.
- `min-height: 100dvh` handles the mobile browser address bar correctly.
- `overscroll-behavior-y: none` prevents pull-to-refresh and accidental loss of unsaved data.
- Safe-area insets protect fixed controls on devices with display cutouts.
- `max-width: 520px` keeps the handheld layout on desktop browsers.
- `prefers-reduced-motion` disables transitions when requested.

## Rendering and Data Flow

```text
Live camera
    ↓
Take photo
    ↓
Recognition (stub)
    ↓
Values + provenance
    ↓        ←── Manual entry
Review and correction
    ↓
Validation
    ↓
Confirmation
    ↓
Persistence (stub)
```

Application state lives in `App` with `useState` and is passed through props. There is no context, reducer, or external store.

Two state objects are central:

- `values`: current field values, keyed by field `key`.
- `metas`: provenance information, including source, acquisition method, recognition confidence, and whether the operator edited the value.

Validation is derived from `values` with `useMemo` rather than stored separately, keeping validation synchronized with the data.

Provenance is exposed through data attributes such as `data-src` and `data-invalid`, which `index.css` uses to style the field indicator.

## Image Capture

The app uses `getUserMedia` for a live preview instead of a native file input. The previous prototype used:

```html
<input type="file" capture="environment">
```

The live preview was chosen so operators can verify label framing before taking the photo.

Because `getUserMedia` requires a secure context, it does not work over plain HTTP when accessed through a LAN address. The development server therefore uses HTTPS with a self-signed certificate. See `development.md`.

The live video is used only for preview. Still images are captured with the `ImageCapture` API rather than by drawing the video to a canvas, which would limit the image to the stream resolution and processing.

See `image-capture.md` for details.

## Known Stubs

| Location                 | Current behavior                        | Intended behavior                             |
| ------------------------ | --------------------------------------- | --------------------------------------------- |
| `FAKE_AI` (line 67)    | Returns a hard-coded recognition result | Use the recognition service response          |
| `recognize` (line 223) | Waits 900 ms, then applies`FAKE_AI`   | Upload`frame.blob` and process the response |
| `confirm` (line 291)   | Logs the payload to the console         | Submit the payload to the backend             |

Each stub includes a source comment describing the implementation step that will replace it.

`applyAiResult` already normalizes and merges recognition results against the intended contract, so it should not need to change when the real service is connected.
