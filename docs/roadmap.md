# Roadmap

## Current state

The prototype implements the complete operator workflow with recognition and
persistence stubbed locally. An operator may open the camera, photograph the
label for recognition, review proposed values with confidence indication, correct any field, and confirm a validated
record. Nothing leaves the browser.

Implemented:

- Mobile-oriented layout with safe-area handling and glove-sized targets
- Data-driven form schema covering six mandatory and seven optional fields,
  derived from physical sample labels
- Live camera sheet over `getUserMedia`, with torch control and haptic feedback
- Label capture through `ImageCapture.takePhoto()` at full sensor resolution,
  with a downscaled JPEG for display and recognition
- Saving the original photo to the device (download or Android share sheet)
- Normalisation of the date and code formats observed on the sample labels
- Provenance model distinguishing recognised and manual data, with confidence
  downgrade on failed normalisation
- Per-field format validation with deferred error presentation
- Session counter and confirmation toast

Not implemented:

- Barcode scanning
- Recognition service and image upload
- Persistence backend
- Authentication and operator identity
- Offline capability and submission queueing
- Automated tests
- Label capture on browsers without the ImageCapture API (manual entry still works)

## Outstanding work

### Recognition integration

Replace the body of `recognize` (`src/App.jsx`, line 223) with an upload of
`frame.blob` (the downscaled photo) and consumption of the service response. The response contract is
defined by the shape of `FAKE_AI` (line 67) and is documented in
[data-model.md](data-model.md). `applyAiResult` is written against the real
contract and should not need to change.

The following must be addressed during integration:

- **Select-field normalisation.** Proposed values for `select` fields must match
  an entry in the corresponding `options` array exactly, otherwise the control
  renders as unselected. `supplier` matches by construction in the stub and will
  not in production. A fuzzy match against `options`, falling back to
  `src: "doubt"`, is the likely shape of the fix.
- **Unknown keys.** Keys absent from `ALL_FIELDS` are written into `values` and
  then ignored by every component, so schema drift between service and form
  fails silently. At minimum this should warn.
- **Failure state.** `recognize` has no failure path: a rejected upload would
  leave `reading` true and the interface stuck. Both a failure state and a retry
  affordance are required before this is usable off a desk.
- **Cancellation.** A second capture while the first is in flight is not
  guarded. The later response should win, or the earlier request should be
  aborted.
- **Threshold calibration.** `SURE_THRESHOLD` is set to `0.9` as a prototype
  value. It should be set from measured accuracy of the deployed model, and it
  should remain a single adjustable constant.

### Persistence

Replace the `console.log` in `confirm` (line 291) with a request to the
persistence endpoint. Submit `metas` and the captured photo alongside `values`,
so that provenance is retained for later accuracy measurement and a disputed
record can be checked against its label.

The form resets immediately on confirmation. Once submission is remote, reset
must be deferred until the request succeeds, and a failed submission must
preserve the entered data.

### Reliability

Warehouse connectivity is frequently poor. Submissions should be queued locally
and retried rather than lost, and the operator should be informed of the queue
state. This has implications for the confirmation flow and for the session
counter, which currently counts local confirmations rather than persisted
records.

Capture and normalisation both work offline; recognition and persistence do
not. A queued-submission design would let an operator continue working through
an outage using manual entry alone, which is worth
preserving as a constraint on whatever queueing mechanism is chosen.

### Schema and format patterns

`PART_NUMBER_RE` and `SA_NUMBER_RE` are inferred from a handful of sample
labels. Before a field trial they should be checked against a wider sample,
because a pattern that rejects a legitimate part number blocks a receipt
outright. The same applies to `normalizeDate`, which assumes day-first ordering
for ambiguous separated dates.

Note also that the comment at the head of `App.jsx` refers to a `samples/`
directory that is not in the repository. Either the sample labels should be
committed, or the reference should be corrected to say where they live.

### Known rough edges

- **Optional-field errors block silently.** `confirm` aborts when any error is
  present, including on an optional field, but the confirm button's `disabled`
  state reflects only mandatory fields. An invalid `saNumber` therefore leaves
  the button enabled and the press apparently inert, with the error visible only
  if the optional section is expanded. Either the button state should account
  for all errors, or confirmation should scroll to the offending field.
- **Capture latency.** `takePhoto()` at maximum sensor resolution can take
  noticeably longer than a preview frame, and the shutter shows "giữ yên máy"
  meanwhile. Measure it on the target PDA; if it is too slow, request a lower
  `imageWidth` rather than reintroducing video-frame capture.
- **Original upload.** Only the downscaled copy is used today. Decide whether
  the backend needs the full-resolution original before building persistence.

### Testing

There are no automated tests. The first candidates are `normalizeDate` and the
format patterns: they are pure, they encode assumptions drawn from a small
sample, and they are the components most likely to be wrong in a way the
interface will not reveal. [development.md](development.md) shows a one-line
check that can serve until a test runner is justified.

## Deferred decisions

The following were considered and deliberately postponed. Each should be
revisited only when a concrete requirement justifies it.

| Item                     | Reason for deferral                                                          |
| ------------------------ | ---------------------------------------------------------------------------- |
| TypeScript               | Few modules; type errors are not the present failure mode                    |
| Component library        | One screen, one form; styling requirements are specific to the environment   |
| State management library | State is local to a single component                                         |
| Routing                  | The application has one screen; the camera sheet is conditional rendering, not a route |
| Test framework           | One pure module currently warrants testing; `node -e` covers it              |
| iOS support              | The target hardware is Android PDAs                                          |

## Structural note

`App.jsx` holds the field schema, the form components, and all state, at 462
lines. The camera and normalisation concerns have already been
extracted into `src/lib/` and `ScannerSheet.jsx`, which is where the bulk of the
growth went.

The next division, when one becomes necessary, is to extract the field schema
and the recognition contract into their own module. Those are the parts that
change most often and that a backend integration needs to reference
independently of the interface. That split has not been made yet because nothing
outside `App.jsx` consumes the schema today; do it when the second consumer
appears, not on principle.
