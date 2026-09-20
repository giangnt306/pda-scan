# Roadmap

## Current state

The prototype implements the complete operator workflow with recognition and
persistence stubbed locally. A user may photograph a label, trigger simulated
recognition, review proposed values with confidence indication, correct any
field, and confirm a validated record. Nothing leaves the browser.

Implemented:

- Mobile-oriented layout with safe-area handling and glove-sized targets
- Data-driven form schema covering eight mandatory and six optional fields
- Native camera capture with preview
- Provenance and confidence model with per-field indication and edit tracking
- Derived validation with deferred error presentation
- Session counter and confirmation toast

Not implemented:

- Recognition service and image upload
- Persistence backend
- Authentication and operator identity
- Offline capability and submission queueing
- Barcode decoding
- Automated tests

## Outstanding work

### Recognition integration

Replace `simulateAI` (`src/App.jsx`, line 193) with an upload of the captured
image and consumption of the service response. The response contract is defined
by the shape of `FAKE_AI` (line 55) and is documented in
[data-model.md](data-model.md).

The following must be addressed during integration:

- **Value normalisation.** Proposed values for `select` fields must match an
  entry in the corresponding `options` array exactly, otherwise the control
  renders as unselected.
- **Unknown keys.** Keys absent from `ALL_FIELDS` are currently discarded
  without warning, so schema drift between service and form will fail silently.
- **Request lifecycle.** The interface has no pending or failure state. Both
  must be added, since recognition will not be instantaneous and will sometimes
  fail.
- **Threshold calibration.** `SURE_THRESHOLD` is set to `0.9` as a prototype
  value. It should be set from measured accuracy of the deployed model, and it
  should remain a single adjustable constant.

### Persistence

Replace the `console.log` in `confirm` (line 225) with a request to the
persistence endpoint. Submit `metas` alongside `values` so that provenance is
retained for later accuracy measurement.

The form resets immediately on confirmation. Once submission is remote, reset
must be deferred until the request succeeds, and a failed submission must
preserve the entered data.

### Reliability

Warehouse connectivity is frequently poor. Submissions should be queued locally
and retried rather than lost, and the operator should be informed of the queue
state. This has implications for the confirmation flow and for the session
counter, which currently counts local confirmations rather than persisted
records.

### Barcode decoding

Several mandatory fields — `lot`, `sku`, and `location` — are barcode-bearing
in practice. Direct decoding would be faster and more reliable than image
recognition for those fields. The `BarcodeDetector` API is available on Android
Chrome but not on iOS Safari, so a decision on platform support is required
before this work is scheduled.

## Deferred decisions

The following were considered and deliberately postponed. Each should be
revisited only when a concrete requirement justifies it.

| Item                     | Reason for deferral                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------- |
| TypeScript               | Single component file; type errors are not the present failure mode                    |
| Component library        | One screen, one form; styling requirements are specific to the environment             |
| State management library | State is local to a single component                                                   |
| Routing                  | The application has one screen                                                         |
| Splitting`App.jsx`     | 363 lines remains readable; split when the file resists modification, not on principle |

## Structural note

`App.jsx` currently contains the field schema, three components, and all state.
This is appropriate at the present size. The natural division, when one becomes
necessary, is to extract the field schema and the recognition contract into a
separate module, since those are the parts that will change most often and that
a backend integration will need to reference independently of the interface.
