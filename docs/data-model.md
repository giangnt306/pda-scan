# Data Model

This document specifies the field schema, the normalisation rules, the
provenance model, and the validation rules implemented in `apps/webapp/src/App.jsx` and
`apps/webapp/src/lib/normalize.js`.

The schema describes automotive part labels as they are printed in the target
warehouse. Field names, formats, and the regular expressions below were derived
from physical sample labels, not from an upstream specification; when the
supplier set widens, they will need revisiting.

## Field descriptors

Form structure is data-driven. Each field is described by a plain object, and
the rendering components derive controls, layout, typography, and validation from those descriptors. Adding or removing a field requires editing
only the descriptor arrays; no JSX changes are necessary.

### Descriptor properties

| Property        | Type               | Meaning                                                             |
| --------------- | ------------------ | ------------------------------------------------------------------- |
| `key`         | string             | Unique identifier; also the key in`values` and `metas`          |
| `label`       | string             | Visible label text                                                  |
| `type`        | string             | `select`, `textarea`, `number`, `date`, or omitted for text |
| `options`     | string[]           | Permitted values; required when`type` is `select`               |
| `mono`        | boolean            | Renders the control in the monospace face                           |
| `half`        | boolean            | Field may share a horizontal row with the next`half` field        |
| `placeholder` | string             | Placeholder text                                                    |
| `validate`    | (string) => string | Returns an error message, or`""` when the value is acceptable     |

`validate` receives the trimmed value and is only consulted once the field is
non-empty, so emptiness and malformation never produce two messages at once.

### Mandatory fields

Declared in `REQUIRED_FIELDS` (line 19). All six must be populated, and must
satisfy their `validate` function, before a record may be confirmed.

| `key`          | Label             | Type   | Notes                                          |
| ---------------- | ----------------- | ------ | ---------------------------------------------- |
| `partNumber`   | Part Number       | text   | Monospace, checked against`PART_NUMBER_RE`   |
| `partName`     | Tên linh kiện   | text   | Free text, e.g.`WINDSCREEN_L2`               |
| `quantity`     | Số lượng       | number | Numeric keypad; must exceed zero               |
| `shipmentDate` | Ngày xuất hàng | date   | Normalised from label text by`normalizeDate` |
| `supplier`     | Nhà cung cấp    | select | Options from`SUPPLIERS` (line 13)            |
| `location`     | Vị trí lưu kho | text   | Monospace; the shelf position, e.g.`A-03-02` |

`location` is the one mandatory field that does not come from the label. It is
the operator's decision about where the goods are being put, and is entered by
hand.

### Optional fields

Declared in `OPTIONAL_FIELDS` (line 40). These are collapsed behind a toggle
until the operator expands them, or until recognition completes, at which point
`applyAiResult` expands the section automatically.

| `key`         | Label                | Type     | Notes                                             |
| --------------- | -------------------- | -------- | ------------------------------------------------- |
| `batch`       | Batch                | text     | Monospace, e.g.`260917_79F`                     |
| `saNumber`    | SA Number            | text     | Monospace, checked against`SA_NUMBER_RE`        |
| `variant`     | Phiên bản / Màu   | text     | Model and colour, e.g.`VF8 NP`, `Limo Green`  |
| `plantDock`   | Plant / Dock         | text     | Monospace, e.g.`3001/1001`                      |
| `grossWeight` | Gross weight (kg)    | number   | Printed on the label; not currently range-checked |
| `packaging`   | Tình trạng bao bì | select   | Four condition values                             |
| `note`        | Ghi chú             | textarea | Free text                                         |

`ALL_FIELDS` (line 62) concatenates both arrays and is used by `emptyValues`
(line 63) to construct the initial state, in which every field is an empty
string. No field is pre-filled: unlike the earlier schema there is no receipt
date defaulting to today, because `shipmentDate` is a property of the shipment
and belongs to the label rather than to the moment of entry.

## Normalisation

`apps/webapp/src/lib/normalize.js` converts raw label text into the forms the controls
expect. It runs on recognition results before the value reaches `values`.

### Dates

`normalizeDate` (line 22) accepts the formats observed on the sample labels and
returns an ISO `YYYY-MM-DD` string, or `""` when nothing matches:

| Input          | Origin                | Pattern                                    |
| -------------- | --------------------- | ------------------------------------------ |
| `18SEP2026`  | Printed VinFast label | day, three-letter month, year              |
| `2026/8/21`  | Chinese supplier      | year first,`.` `/` or `-` separators |
| `15.09.2026` | Rubber stamp          | day first,`.` `/` or `-` separators  |
| `15/9/2026`  | Handwritten           | day first,`.` `/` or `-` separators  |
| `20260821`   | Unseparated           | eight digits                               |

The `iso` helper (line 17) rejects out-of-range components, so an implausible
parse returns the empty string rather than an invalid date. The year is bounded
to 2000–2100.

If there is a label assumed for US-style ()month-first dates) such as `03/17/2026` would be misread, and would need a new branch rather than a guess.

### Codes

`normalizeCode` (line 47) upper-cases and strips whitespace. It deliberately
does not correct the `0`/`O` and `1`/`I` confusions common in OCR output: the function would not silently alter a value, instead the format patterns below reject the malformed value and the operator is shown an error.

### Format patterns

| Constant           | Pattern                       | Derived from                                               |
| ------------------ | ----------------------------- | ---------------------------------------------------------- |
| `PART_NUMBER_RE` | `^[A-Z]{3}\d{8}[A-Z]{2,6}$` | `BIN75151170ABBRA`, `BEX75149000AB`, `BEX32181030AB` |
| `SA_NUMBER_RE`   | `^\d{10}$`                  | `5300013959`, `5300013009`                             |

**Note**: Both are inferred from a small sample.

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

| Property       | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `src`        | `sure` or `doubt`; drives the indicator colour |
| `via`        | `ai` for a recognition proposal                  |
| `confidence` | 0 to 1, as reported by the service                 |
| `edited`     | Whether the operator has since modified the value  |

### States

| State      | Condition                                       | Presentation                                                      |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `manual` | No metadata entry                               | Grey indicator, no badge                                          |
| `sure`   | `via: "ai"`, `confidence >= SURE_THRESHOLD` | Green indicator, badge reading "AI" with a percentage             |
| `doubt`  | `via: "ai"`, `confidence < SURE_THRESHOLD`  | Amber indicator, badge reading "Kiểm tra lại" with a percentage |
| `edited` | Operator modified any of the above              | Grey indicator, badge reading "đã sửa"                         |

`SURE_THRESHOLD` is defined at line 77 and is currently `0.9`. 

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

| Scope     | Rule                                                    | Message                                                 |
| --------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Mandatory | Must be non-empty after trimming                        | `Chưa có dữ liệu`                                 |
| Mandatory | `quantity` must parse to a number greater than zero   | `Số lượng phải lớn hơn 0`                       |
| Either    | `partNumber` must match `PART_NUMBER_RE`            | `Sai định dạng — cần 3 chữ + 8 số + 2–6 chữ` |
| Either    | `saNumber`, when present, must match `SA_NUMBER_RE` | `SA Number phải đủ 10 chữ số`                    |

Optional fields are validated only when the operator has entered something.
An empty optional field is not an error; a malformed one is.

### Deferred error display

* **`handleChange` (L216):** Updates the field and sets `edited: true`. It keeps the original `confidence` and `via` values to preserve an audit trail of AI vs. human edits.

* **`doubtful` (L214):** Counts unedited, low-confidence fields and shows them in the action bar to highlight items needing operator review.

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

Each entry maps a field `key` to a proposed `value` and a 0–1 `confidence` score. Values arrive raw/unnormalized; `shipmentDate` in the stub intentionally uses a low-confidence handwritten date to test normalization and fallback paths.

The stub populates 7 of 13 fields, leaving the rest for manual input.

**Integration requirements for the real service:**

* **`select` fields:** Values must match `options` entries exactly, or the field renders unselected. A normalization step will likely be required.
* **Schema drift:** Unrecognized keys not in `ALL_FIELDS` are stored in `values` but ignored by components, failing silently rather than throwing an error.

## Submission payload

* The persistence endpoint expects

* ```js
  { values, metas, photo: photo?.blob }
  ```
* **Metadata Preservation:** Including `metas` tracks data provenance (AI confidence vs. operator edits), which is essential for measuring production accuracy.
* **Photo Attachment:** Sends a downscaled JPEG (~150 KB) for audit trails and verification. Sending the full-resolution original (`photo.original.blob`) instead remains an open decision.
