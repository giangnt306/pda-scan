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
LAN address is not one. Without it the camera sheet fails immediately with the
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
rather than in a desktop browser's device emulation. Camera behaviour, still-photo
resolution and latency, torch availability, and haptic feedback all differ.

1. Connect the development machine and the handset to the same network.
2. Run `npm run dev`.
3. Open the address printed under `Network:` in the Vite output. Do not reuse an
   address recorded from an earlier session; DHCP may have reassigned it.
4. Accept the certificate warning as described above.
5. Grant the camera permission when Chrome prompts.

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

### Label capture

Photos are taken only through the ImageCapture API. Chrome for Android supports
it; Firefox and Safari do not. Where it is missing, the sheet subtitle reads
"Trình duyệt không hỗ trợ ImageCapture — không chụp được nhãn" and the shutter
is hidden; fields can still be filled in by hand.

When checking capture on a device:

- The sheet subtitle shows the maximum photo size the sensor offers, for example
  `ImageCapture · tối đa 4000×3000`. The photo panel below the viewfinder shows
  the size, file size, and capture time actually obtained.
- With "Tự lưu ảnh gốc vào máy" ticked, each photo is downloaded as
  `pda_<width>x<height>_<timestamp>.jpg`. From the second download Chrome may ask
  once to allow multiple downloads.
- "Lưu vào Thư viện ảnh" opens the Android share sheet; desktop browsers without
  file sharing show a toast instead.

A rejected `takePhoto()` is shown as an error above the shutter; there is no
silent fallback to a video frame.

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
