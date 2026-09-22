# Development

## Prerequisites

* Node.js and npm
* An Android phone/PDA running Chrome for meaningful device testing

No other tooling is required.

## Setup

```bash
npm install
```

## Commands

| Command           | Description                            |
| ----------------- | -------------------------------------- |
| `npm run dev`     | Start the Vite development server      |
| `npm run build`   | Build the production bundle in `dist/` |
| `npm run preview` | Preview the production build           |

## Network and HTTPS

The Vite server is configured to:

* Listen on all network interfaces (`server.host: true`)
* Use port `5173`
* Serve HTTPS using `@vitejs/plugin-basic-ssl`

HTTPS is required because `getUserMedia` only works in a secure context. This allows an Android device on the same network to access the development server.

The first visit from each device will show a certificate warning:

**Your connection is not private → Advanced → Proceed**

This only needs to be accepted once per device.

### Using HTTP instead

For local development, Chrome can treat the HTTP origin as secure:

```text
chrome://flags/#unsafely-treat-insecure-origin-as-secure
```

Add the current LAN address, for example:

```text
http://192.168.1.xx:5173
```

Set the flag to **Enabled** and restart Chrome. Then remove `basicSsl()` from `vite.config.js`.

This is for development only. Production deployments should use a valid TLS certificate.

## Testing on a Physical Device

Test on a real Android device rather than desktop device emulation because camera resolution, latency, torch support, and haptics can differ.

1. Connect the computer and device to the same network.
2. Run:

   ```bash
   npm run dev
   ```
3. Open the address shown under `Network:` in the Vite output.
4. Always use the current address; DHCP may change the device IP.
5. Accept the certificate warning if using HTTPS.
6. Grant camera permission when prompted.

### Camera Errors

`ScannerSheet` maps `DOMException.name` to user-facing error messages.

| Error               | How to reproduce                      |
| ------------------- | ------------------------------------- |
| `SecurityError`     | Open the app over plain HTTP          |
| `NotAllowedError`   | Deny or revoke camera permission      |
| `NotFoundError`     | Use a device without a camera         |
| `NotReadableError`  | Use the camera in another application |
| `NotSupportedError` | Use a browser without `mediaDevices`  |

Camera permission is stored per origin. After denying permission, change it through the address-bar site settings rather than simply reloading the page.

## Label Capture

Photos use the **ImageCapture API**. Chrome for Android supports it; Firefox and Safari do not.

If `ImageCapture` is unavailable:

* The shutter is hidden.
* The subtitle shows:
  `Trình duyệt không hỗ trợ ImageCapture — không chụp được nhãn`
* Labels can still be entered manually.

When testing capture:

* The subtitle shows the sensor's maximum resolution, e.g. `ImageCapture · tối đa 4000×3000`.
* The photo panel shows the actual resolution, file size, and capture time.
* With **Tự lưu ảnh gốc vào máy** enabled, photos are downloaded as:
  `pda_<width>x<height>_<timestamp>.jpg`
* Chrome may ask once for permission to allow multiple downloads.
* **Lưu vào Thư viện ảnh** opens the Android share sheet. Browsers without file-sharing support show a toast instead.
* If `takePhoto()` fails, the error is shown above the shutter. The app does not silently fall back to a video frame.

## Torch

The torch button is shown only when the active video track reports `torch` support.

Some devices may report support but reject the torch constraint. In that case, the button disappears after the first attempt. Both behaviours are expected.

## Verifying Date Normalisation

`src/lib/normalize.js` contains the main branching logic and can be checked directly without a test framework:

```bash
node --input-type=module -e '
import { normalizeDate } from "./src/lib/normalize.js";
for (const s of ["18SEP2026", "2026/8/21", "15.09.2026", "15/9/2026", "20260821", "rubbish"])
  console.log(s.padEnd(12), "->", normalizeDate(s) || "(rejected)");
'
```

The first five inputs should produce ISO dates. `rubbish` should produce an empty string.

There is currently no automated test suite. See [roadmap.md](roadmap.md).
