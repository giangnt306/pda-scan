# Development

## Prerequisites

Node.js with npm. No other tooling is required.

## Setup

```bash
npm install
```

## Commands

| Command             | Effect                                               |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`     | Starts the Vite development server with Fast Refresh |
| `npm run build`   | Produces a production bundle in`dist/`             |
| `npm run preview` | Serves the built bundle for verification             |

## Network configuration

`vite.config.js` sets `server.host` to `true`, which binds the development
server to all interfaces rather than to `localhost` alone. This is what permits
a handset on the same network to reach the server. The port is fixed at `5173`.

The `dev` script also passes `--host`. This is redundant, since the
configuration file already establishes the same binding, but it is harmless.

## Testing on a physical device

The application targets handheld use and should be exercised on a real device
rather than in a desktop browser's device emulation.

1. Connect the development machine and the handset to the same network.
2. Run `npm run dev`.
3. Open the address printed under `Network:` in the Vite output. Do not reuse an
   address recorded from an earlier session; DHCP may have reassigned it.

### Camera behaviour

Image capture uses a native file input with the `capture` attribute rather than
`getUserMedia`. It therefore functions over plain HTTP and requires no secure
context during LAN development. Should the implementation later move to
`getUserMedia`, a secure context becomes mandatory and device testing will
require either a tunnel providing HTTPS or a locally trusted certificate.
