# Development

## Prerequisites

Node.js with npm. No other tooling is required.

An Android phone or PDA running Chrome is required for meaningful testing; see
[Testing on a physical device](#testing-on-a-physical-device).

## Setup

```bash
npm install
```

## Commands

| Command           | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Starts the Vite development server with Fast Refresh  |
| `npm run build`   | Produces a production bundle in `dist/`               |
| `npm run preview` | Serves the built bundle for verification              |

## Network and HTTPS configuration

`vite.config.js` sets `server.host` to `true`, which binds the development
server to all interfaces rather than to `localhost` alone. This is what permits
a handset on the same network to reach the server. The port is fixed at `5173`.
The `dev` script also passes `--host`, which is redundant but harmless.

The configuration additionally registers `@vitejs/plugin-basic-ssl`, so the dev
server is served over HTTPS with a self-signed certificate. This is not
optional: `getUserMedia` is only available in a secure context, and a plain HTTP
LAN address is not one. Without it the scanner fails immediately with the
`SecurityError` branch of `ERROR_TEXT`.

The consequence is a certificate warning on first visit from each device.
Chrome shows "Your connection is not private"; **Advanced → Proceed** accepts
the certificate for that origin, and the origin is then treated as secure. This
is done once per device.

### Avoiding the warning

An alternative to accepting the certificate is to tell Chrome to treat the plain
HTTP origin as secure. On Chrome for Android, open

```
chrome://flags/#unsafely-treat-insecure-origin-as-secure
```

enter `http://192.168.1.xx:5173`, set the flag to **Enabled**, and restart
Chrome. Then remove `basicSsl()` from `vite.config.js` to return to HTTP.

This is a development convenience only. A real deployment has a real
certificate and needs neither the flag nor the plugin.

## Testing on a physical device

The application targets handheld use and should be exercised on a real device
rather than in a desktop browser's device emulation. Camera behaviour, barcode
decoding performance, torch availability, and haptic feedback all differ.

1. Connect the development machine and the handset to the same network.
2. Run `npm run dev`.
3. Open the address printed under `Network:` in the Vite output. Do not reuse an
   address recorded from an earlier session; DHCP may have reassigned it.
4. Accept the certificate warning as described above.
5. Grant the camera permission when Chrome prompts.

### Barcode engine

The engine is selected at runtime by `src/lib/barcode.js`:

| Platform                    | Engine                                | Notes                                          |
| --------------------------- | ------------------------------------- | ---------------------------------------------- |
| Chrome on Android (PDA, phone) | Native `BarcodeDetector`           | Backed by Google Play Services; no extra download |
| Chrome on Windows or Linux  | `barcode-detector` WebAssembly ponyfill | Loaded on demand; fetches its `.wasm` from a CDN |

While the ponyfill is in use, the hint under the viewfinder reads "đang dùng bộ
giải mã dự phòng". That line is the reliable indicator that testing is happening
on a laptop rather than on a target device. Decoding through the ponyfill is
noticeably slower, so scanning latency measured on a laptop says nothing about
the device.

The ponyfill downloads its WebAssembly payload from jsDelivr and therefore
requires internet access. Android devices using the native engine do not.

`WANTED_FORMATS` in `src/lib/barcode.js` currently enables QR, Code 128,
Code 39, EAN-13, EAN-8, UPC-A, UPC-E, ITF, and DataMatrix. Narrowing this array
to the symbologies actually in use in a given warehouse makes decoding both
faster and less prone to misreads, and is worth doing before any field trial.

### Camera failure modes

`ScannerSheet` maps `DOMException.name` to operator-facing text. When testing
the failure paths:

| Condition                     | Reproduce by                                             |
| ----------------------------- | -------------------------------------------------------- |
| `SecurityError`               | Opening the app over plain HTTP                          |
| `NotAllowedError`             | Denying the permission prompt, or revoking it in site settings |
| `NotFoundError`               | Running on a machine with no camera                      |
| `NotReadableError`            | Holding the camera open in another application           |
| `NotSupportedError`           | A browser without `mediaDevices`                         |

A denied permission is remembered per origin. Recovering requires the lock icon
in the address bar rather than a reload, which is why that instruction is in the
error text.

### Torch

The torch button appears only when the active video track reports the `torch`
capability. Desktop webcams do not, and some Android devices report the
capability but reject the constraint; in that case the button disappears after
the first press. Both paths are expected behaviour, not a bug.

## Verifying normalisation

`src/lib/normalize.js` is the one piece of logic with enough branching to be
worth checking directly rather than through the interface. Its exports are pure
functions, so a quick check needs no test framework:

```bash
node --input-type=module -e '
import { normalizeDate } from "./src/lib/normalize.js";
for (const s of ["18SEP2026", "2026/8/21", "15.09.2026", "15/9/2026", "20260821", "rubbish"])
  console.log(s.padEnd(12), "->", normalizeDate(s) || "(rejected)");
'
```

Expect the first five to yield ISO dates and the last to yield the empty string.
There is no automated test suite yet; see [roadmap.md](roadmap.md).
