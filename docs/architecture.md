# Architecture

## Purpose

`pda-scan` is a mobile-first web application for warehouse goods receipt. An
operator photographs a product label, an image-recognition service extracts the
label fields, and the operator reviews, corrects, and confirms the resulting
record before it is persisted.

The application is currently a functional prototype. The user interface and the
review workflow are complete; the recognition service and the persistence
backend are not yet implemented and are represented by local stubs.

## Technology stack

| Component                | Version | Role                                      |
| ------------------------ | ------- | ----------------------------------------- |
| Vite                     | 8.3     | Development server and production bundler |
| React                    | 18.3    | User interface library                    |
| `@vitejs/plugin-react` | 4.3     | JSX transformation and Fast Refresh       |

The project deliberately carries no further runtime dependencies. There is no
router, no external state-management library, no component library, and no CSS
framework. TypeScript is not used. Styling is hand-authored CSS.

This minimalism is a design decision rather than an omission. The application
consists of a single screen, a single form, and no client-side navigation;
none of the libraries listed above would earn their maintenance cost at the
present scope.

## Source layout

```
index.html          Vite entry point; document shell, viewport, font loading
vite.config.js      Dev-server host binding and plugin registration
src/main.jsx        React root mount
src/App.jsx         Entire application: field schema, components, state
src/index.css       Design tokens and all component styling
docs/               This documentation
```

Line counts as of this document: `App.jsx` 363, `index.css` 471, `main.jsx` 10.

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
double-invokes renders and effect cycles in order to surface impure
side effects, and is eliminated from production builds.

### `src/App.jsx`

The whole application. It contains three components and the field schema that
drives them.

`Field` (line 70) renders one form control. It selects the control type from
the field descriptor, applies the provenance attribute used for styling, and
renders the confidence badge and validation message.

`FieldList` (line 129) walks a field array and groups consecutive descriptors
marked `half` into a single horizontal row. 

`App` (line 164) holds all application state and composes the screen: capture
panel, provenance legend, mandatory field group, optional field group, action
bar, and transient confirmation toast.

### `src/index.css`

Defines design tokens on `:root` and styles every component. The token set
distinguishes surface colours, the primary action colour, and three data
provenance colours.

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
  header and action bar on devices with display cutouts.
- `max-width: 520px` with automatic horizontal margins preserves the handheld
  layout when the application is opened on a desktop browser.
- A `prefers-reduced-motion` query disables transitions for users who request
  reduced motion.

## Rendering and data flow

```
photograph  →  recognition (stubbed)  →  values + provenance metadata
                                             ↓
                                    operator review and correction
                                             ↓
                                   validation  →  confirmation  →  persistence (stubbed)
```

Application state is held in `App` using `useState` and passed downward through
props. There is no context, no reducer, and no external store. Two state
objects form the core of the design:

- `values` — the current content of each field, keyed by field `key`.
- `metas` — the provenance of that content: its origin, the recognition
  confidence, and whether the operator has since edited it.

Validation state is not stored. The `errors` object is derived from `values`
through `useMemo` (line 173), which makes it impossible for validation results
to drift out of step with the data they describe.

Provenance is communicated to the stylesheet through a data attribute. `Field` renders
`data-src={src}`, `index.css` matches on `[data-src="sure"]`,
`[data-src="doubt"]`, and `[data-invalid="true"]` to colour the vertical
indicator bar beside each control. 

## Image capture

Capture uses the native file input rather than the MediaDevices API:

```jsx
<input type="file" accept="image/*" capture="environment" />
```

The browser opens the system camera application and returns a `File`, which is
converted to a preview URL with `URL.createObjectURL`.

This approach was chosen over `getUserMedia` for two reasons. It requires
substantially less code, and it functions over plain HTTP, whereas
`getUserMedia` requires a secure context and would prevent camera use during
LAN-based development. The trade-off is the absence of a live viewfinder and of
programmatic focus control; the on-screen frame is a static CSS overlay.

## Known stubs

| Location                  | Current behaviour               | Intended behaviour                                  |
| ------------------------- | ------------------------------- | --------------------------------------------------- |
| `FAKE_AI` (line 55)     | Hard-coded recognition result   | Response from the recognition service               |
| `simulateAI` (line 193) | Copies`FAKE_AI` into state    | Uploads the image and consumes the service response |
| `confirm` (line 225)    | Logs the payload to the console | Submits the payload to the backend                  |

Both stub sites carry source comments identifying the implementation step that
will replace them.
