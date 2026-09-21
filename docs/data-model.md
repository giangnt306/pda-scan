# Data Model

This document specifies the field schema, the normalisation rules, the
provenance model, and the validation rules implemented in `src/App.jsx` and
`src/lib/normalize.js`.

The schema describes automotive part labels as they are printed in the target
warehouse. Field names, formats, and the regular expressions below were derived
from physical sample labels, not from an upstream specification; when the
supplier set widens, they will need revisiting.

## Field descriptors

Form structure is data-driven. Each field is described by a plain object, and
the rendering components derive controls, layout, typography, and validation from those descriptors. Adding or removing a field requires editing
only the descriptor arrays; no JSX changes are necessary.

### Descriptor properties

| Property        | Type                   | Meaning                                                         |
| --------------- | ---------------------- | --------------------------------------------------------------- |
| `key`           | string                 | Unique identifier; also the key in `values` and `metas`         |
| `label`         | string                 | Visible label text                                              |
| `type`          | string                 | `select`, `textarea`, `number`, `date`, or omitted for text     |
| `options`       | string[]               | Permitted values; required when `type` is `select`              |
| `mono`          | boolean                | Renders the control in the monospace face                       |
| `half`          | boolean                | Field may share a horizontal row with the next `half` field     |
| `placeholder`   | string                 | Placeholder text                                                |
| `validate`      | (string) => string     | Returns an error message, or `""` when the value is acceptable  |

`validate` receives the trimmed value and is only consulted once the field is
non-empty, so emptiness and malformation never produce two messages at once.

### Mandatory fields

Declared in `REQUIRED_FIELDS` (line 19). All six must be populated, and must
satisfy their `validate` function, before a record may be confirmed.

| `key`          | Label            | Type   | Notes                                                     |
| -------------- | ---------------- | ------ | --------------------------------------------------------- |
| `partNumber`   | Part Number      | text   | Monospace, checked against `PART_NUMBER_RE`              |
| `partName`     | Tên linh kiện    | text   | Free text, e.g. `WINDSCREEN_L2`                           |
| `quantity`     | Số lượng         | number | Numeric keypad; must exceed zero                          |
| `shipmentDate` | Ngày xuất hàng   | date   | Normalised from label text by `normalizeDate`             |
| `supplier`     | Nhà cung cấp     | select | Options from `SUPPLIERS` (line 13)                        |
| `location`     | Vị trí lưu kho   | text   | Monospace; the shelf position, e.g. `A-03-02`            |

`location` is the one mandatory field that does not come from the label. It is
the operator's decision about where the goods are being put, and is entered by
hand.

### Optional fields

Declared in `OPTIONAL_FIELDS` (line 40). These are collapsed behind a toggle
until the operator expands them, or until recognition completes, at which point
`applyAiResult` expands the section automatically.

| `key`         | Label                | Type     | Notes                                               |
| ------------- | -------------------- | -------- | --------------------------------------------------- |
| `batch`       | Batch                | text     | Monospace, e.g. `260917_79F`                        |
| `saNumber`    | SA Number            | text     | Monospace, checked against `SA_NUMBER_RE`           |
| `variant`     | Phiên bản / Màu      | text     | Model and colour, e.g. `VF8 NP`, `Limo Green`       |
| `plantDock`   | Plant / Dock         | text     | Monospace, e.g. `3001/1001`                         |
| `grossWeight` | Gross weight (kg)    | number   | Printed on the label; not currently range-checked   |
| `packaging`   | Tình trạng bao bì    | select   | Four condition values                               |
| `note`        | Ghi chú              | textarea | Free text                                           |

`ALL_FIELDS` (line 62) concatenates both arrays and is used by `emptyValues`
(line 63) to construct the initial state, in which every field is an empty
string. No field is pre-filled: unlike the earlier schema there is no receipt
date defaulting to today, because `shipmentDate` is a property of the shipment
and belongs to the label rather than to the moment of entry.

## Normalisation

`src/lib/normalize.js` converts raw label text into the forms the controls
expect. It runs on recognition results before the value reaches `values`.

### Dates

`normalizeDate` (line 22) accepts the formats observed on the sample labels and
returns an ISO `YYYY-MM-DD` string, or `""` when nothing matches:

| Input          | Origin                          | Pattern                    |
| -------------- | ------------------------------- | -------------------------- |
| `18SEP2026`    | Printed VinFast label           | day, three-letter month, year |
| `2026/8/21`    | Chinese supplier                | year first, `.` `/` or `-` separators |
| `15.09.2026`   | Rubber stamp                    | day first, `.` `/` or `-` separators |
| `15/9/2026`    | Handwritten                     | day first, `.` `/` or `-` separators |
| `20260821`     | Unseparated                     | eight digits               |

The `iso` helper (line 17) rejects out-of-range components, so an implausible
parse returns the empty string rather than an invalid date. The year is bounded
to 2000–2100.

Ambiguity is resolved structurally, not by heuristics: a four-digit group in the
first position means year-first, a four-digit group in the last position means
day-first. There is no case in the observed data where a date could be read both
ways, but note that a day-first reading is assumed for `03/04/2026`-style
input — a supplier printing US-style month-first dates would be misread, and
would need a new branch rather than a guess.

The conversion is deliberately performed here rather than being requested of the
recognition model. A model asked to return ISO dates will usually comply and
will occasionally invent; a regular expression either matches or does not.

### Codes

`normalizeCode` (line 47) upper-cases and strips whitespace. It deliberately
does not correct the `0`/`O` and `1`/`I` confusions common in OCR output: that
correction would silently alter a value the operator believes was read
correctly. Instead the format patterns below reject the malformed value and the
operator is shown an error.

### Format patterns

| Constant           | Pattern                     | Derived from                                            |
| ------------------ | --------------------------- | ------------------------------------------------------- |
| `PART_NUMBER_RE`   | `^[A-Z]{3}\d{8}[A-Z]{2,6}$` | `BIN75151170ABBRA`, `BEX75149000AB`, `BEX32181030AB`     |
| `SA_NUMBER_RE`     | `^\d{10}$`                  | `5300013959`, `5300013009`                               |

Both are inferred from a small sample. They are strict enough to catch a
misread character and loose enough to admit the observed variation; if a
legitimate part number is ever rejected, the pattern is what should change, not
the check.

## Provenance model

The application distinguishes data the operator entered from data proposed by
the recognition service, and further distinguishes high-confidence proposals from those requiring review.

### Structure

Two parallel state objects are keyed identically by field `key`:

```js
values = { partNumber: "BEX32181030AB", quantity: "80", ... }

metas  = { partNumber: { src: "sure",  via: "ai", confidence: 0.94, edited: false },
           shipmentDate: { src: "doubt", via: "ai", confidence: 0.62, edited: false }, ... }
```

A field absent from `metas` is treated as manually entered.

| Property     | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `src`        | `sure` or `doubt`; drives the indicator colour                       |
| `via`        | `ai` for a recognition proposal                                      |
| `confidence` | 0 to 1, as reported by the service                                   |
| `edited`     | Whether the operator has since modified the value                    |

### States

| State    | Condition                                   | Presentation                                          |
| -------- | ------------------------------------------- | ----------------------------------------------------- |
| `manual` | No metadata entry                           | Grey indicator, no badge                              |
| `sure`   | `via: "ai"`, `confidence >= SURE_THRESHOLD` | Green indicator, badge reading "AI" with a percentage |
| `doubt`  | `via: "ai"`, `confidence < SURE_THRESHOLD`  | Amber indicator, badge reading "Kiểm tra lại" with a percentage |
| `edited` | Operator modified any of the above          | Grey indicator, badge reading "đã sửa"                |

`SURE_THRESHOLD` is defined at line 77 and is currently `0.9`. This constant is
the single tuning point governing how much recognised data the operator is asked
to verify. It should be calibrated against measured recognition accuracy once
the real service is integrated, not left at the prototype value by default.

### Confidence downgrade on failed normalisation

In `applyAiResult` (line 230): when normalisation returns the empty string — an
unrecognised date format, for instance — the field is stored with `src: "doubt"`
and `confidence: 0` regardless of what the service reported. The model may have
been entirely confident about a string that the application could not interpret,
and that combination is precisely when a human should look.

### Edit tracking

`handleChange` (line 216) writes the new value and, if the field carries
metadata, sets `edited: true` on it. The original `confidence` and `via` are
retained. A recognised value that the operator has corrected therefore ceases to
display as machine-derived, while the audit trail distinguishing proposed data
from corrected data is preserved for the eventual submission payload.

The derived counter `doubtful` (line 214) reports how many recognised fields
remain below the threshold and unedited. It is surfaced in the action bar so
that the operator is informed of outstanding review items even when the form is
formally complete.

## Validation

`errors` is derived from `values` through `useMemo` (line 191) and is never
stored as state.

| Scope     | Rule                                                        | Message                                            |
| --------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Mandatory | Must be non-empty after trimming                            | `Chưa có dữ liệu`                                  |
| Mandatory | `quantity` must parse to a number greater than zero         | `Số lượng phải lớn hơn 0`                          |
| Either    | `partNumber` must match `PART_NUMBER_RE`                    | `Sai định dạng — cần 3 chữ + 8 số + 2–6 chữ`       |
| Either    | `saNumber`, when present, must match `SA_NUMBER_RE`         | `SA Number phải đủ 10 chữ số`                      |

Optional fields are validated only when the operator has entered something.
An empty optional field is not an error; a malformed one is.

### Deferred error display

The `touched` flag gates error presentation. Errors are computed continuously
but passed to the field components only after the operator has attempted
confirmation, so an empty form is not marked as erroneous before any input has
been given.

`confirm` (line 291) sets `touched` and then aborts if either any mandatory
field is unsatisfied or any error at all is present — including an error on an
optional field. The confirm button's `disabled` state, by contrast, reflects
only the mandatory count. An optional field in error therefore leaves the button
enabled but the submission blocked, with the error visible on the offending
field. This is a known rough edge; see [roadmap.md](roadmap.md).

## Recognition payload

`FAKE_AI` (line 67) stands in for the recognition service response and defines
the contract the real service is expected to satisfy:

```js
{
  partNumber:   { value: "BEX32181030AB",            confidence: 0.94 },
  partName:     { value: "BATTERY_PACK_REAR_FENDER", confidence: 0.96 },
  quantity:     { value: "80",                       confidence: 0.91 },
  shipmentDate: { value: "15/9/2026",                confidence: 0.62 },
  ...
}
```

Each entry maps a field `key` to a proposed `value` and a `confidence` in the
range 0 to 1. Values arrive as they appear on the label, not pre-normalised —
`shipmentDate` in the stub is deliberately a handwritten-style date with a low
confidence, so that the normalisation and downgrade paths are exercised by the
prototype rather than only by the real service.

The stub supplies seven of the thirteen fields, leaving the remainder for manual
entry.

Two constraints apply when the real service is integrated. Values for `select`
fields must match an entry in the corresponding `options` array exactly, or the
control renders as unselected; `supplier` in the stub matches by construction,
but a real response will not, so a normalisation step for select fields is
likely to be required. Keys not present in `ALL_FIELDS` are written into
`values` by `applyAiResult` and then ignored by every component, so schema drift
between the service and the form fails quietly rather than raising an error.

## Submission payload

`confirm` currently logs the following structure, which is the intended request
body for the persistence endpoint:

```js
{ values, metas, photo: photo?.blob }
```

Transmitting `metas` alongside `values` preserves the provenance record: which
fields the service proposed and at what confidence, and which the operator
corrected. This information supports later measurement of
recognition accuracy in production and should not be discarded when the endpoint
is implemented.

The captured photo is included so that a disputed record can be checked against
the label it came from. `photo.blob` is the downscaled JPEG (1280 px long edge,
quality 0.82, roughly 150 KB) that is also sent for recognition. The
full-resolution original taken by `ImageCapture.takePhoto()` is held in
`photo.original.blob`; whether the backend should receive the original instead
is an open question, see [image-capture.md](image-capture.md).
