# Roadmap

## Current State

The prototype covers the complete operator workflow. Recognition and persistence are currently local stubs, so no data leaves the browser.

### Implemented

* Mobile-first layout with safe-area support and glove-friendly controls
* Data-driven form with 6 required and 7 optional fields
* Camera sheet using `getUserMedia`, including torch and haptic feedback
* Full-resolution label capture via `ImageCapture.takePhoto()`
* Downscaled JPEG for preview and recognition
* Original photo download and Android share-sheet support
* Date and code normalisation based on sample labels
* Provenance tracking for recognised vs. manual values
* Confidence downgrade when normalisation fails
* Per-field validation with deferred error display
* Session counter and confirmation toast

### Not Implemented

* Barcode scanning
* Recognition API and image upload
* Persistence backend
* Authentication/operator identity
* Offline queueing and retry
* Automated tests
* `ImageCapture` support outside compatible browsers

Manual entry remains available when `ImageCapture` is unsupported.

## Outstanding Work

### 1. Recognition Integration

Replace the local `recognize` implementation in `src/App.jsx` with an upload of `frame.blob` and handling of the service response.

The response contract is represented by `FAKE_AI` and documented in [data-model.md](data-model.md). `applyAiResult` already follows this contract.

Before integration, address:

* **Select fields:** AI values must exactly match an entry in `options`. Production values such as `supplier` may differ. Use fuzzy matching and fall back to `src: "doubt"` when no match is reliable.
* **Unknown keys:** Keys not in `ALL_FIELDS` are silently ignored. At minimum, log or warn about schema mismatches.
* **Failures:** A rejected request currently leaves `reading` active. Add an error state and retry action.
* **Cancellation:** Prevent overlapping requests by aborting the previous request or ensuring only the latest response is applied.
* **Confidence threshold:** `SURE_THRESHOLD = 0.9` is provisional. Calibrate it using measured model accuracy and keep it as a single configurable constant.

### 2. Persistence

Replace the `console.log` in `confirm` with a persistence request.

Submit:

* `values`
* `metas`
* Captured photo

Keeping provenance with the record allows later accuracy analysis and label verification.

Once persistence is remote:

* Reset the form only after a successful request.
* Preserve all entered data when submission fails.

### 3. Reliability and Offline Support

Warehouse connectivity may be unreliable. Submissions should therefore be queued locally and retried rather than lost.

The UI should clearly show the queue state.

Currently:

* Capture works offline.
* Normalisation works offline.
* Recognition requires the network.
* Persistence requires the network.

A queue should allow operators to continue with manual entry during outages.

The session counter must also be revisited because it currently counts local confirmations, not successfully persisted records.

## Schema and Validation

`PART_NUMBER_RE` and `SA_NUMBER_RE` are based on a small set of sample labels. Validate them against a larger sample before field testing to avoid rejecting legitimate values.

`normalizeDate` also assumes day-first ordering for ambiguous separated dates. This assumption should be verified against real data.

`App.jsx` references a `samples/` directory that is not currently in the repository. Either commit the samples or update the documentation to point to their actual location.

## Known Rough Edges

### Optional-field validation

`confirm` blocks submission when **any** error exists, including errors in optional fields. However, the confirm button only reflects errors in required fields.

For example, an invalid `saNumber` can leave the button enabled while pressing it appears to do nothing if the optional section is collapsed.

Fix by either:

* Including all validation errors in the button state, or
* Scrolling to the invalid field when confirmation fails.

### Capture latency

Maximum-resolution `takePhoto()` may be noticeably slower than capturing a video frame.

Measure this on the target PDA. If necessary, request a smaller `imageWidth` rather than restoring video-frame capture.

### Original image upload

Recognition currently receives only the downscaled image. Decide whether the backend also needs the full-resolution original before implementing persistence.

## Testing

There is currently no automated test suite.

The first tests should cover:

* `normalizeDate`
* `PART_NUMBER_RE`
* `SA_NUMBER_RE`

These are pure logic based on assumptions from a small sample and are therefore easy to test and relatively likely to expose hidden problems.

Until a test runner is introduced, the one-line check documented in [development.md](development.md) can be used.

## Deferred Decisions

These technologies were considered but intentionally postponed:

| Item                     | Reason                                                   |
| ------------------------ | -------------------------------------------------------- |
| TypeScript               | The current failure modes are not type-related           |
| Component library        | One screen with highly specific UI requirements          |
| State management library | State is local to one component                          |
| Routing                  | The app has one screen; the camera is conditional UI     |
| Test framework           | Only a small pure module currently needs automated tests |
| iOS support              | Target devices are Android PDAs                          |

Revisit these only when a concrete requirement justifies them.

## Structure

`App.jsx` currently contains the field schema, form components, and application state in about 462 lines.

Camera and normalisation logic have already been extracted into `ScannerSheet.jsx` and `src/lib/`.

The next likely extraction is:

* Field schema
* Recognition contract

These change independently and will eventually need to be shared with backend integration or other consumers.

Do not split them prematurely. Extract them when a second consumer appears.
