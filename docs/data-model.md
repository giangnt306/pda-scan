# Data Model

This document specifies the field schema, the provenance model, and the
validation rules implemented in `src/App.jsx`.

## Field descriptors

Form structure is data-driven. Each field is described by a plain object, and
the rendering components derive controls, layout, and typography from those
descriptors. Adding or removing a field requires editing only the descriptor
arrays; no JSX changes are necessary.

### Descriptor properties

| Property        | Type     | Meaning                                                             |
| --------------- | -------- | ------------------------------------------------------------------- |
| `key`         | string   | Unique identifier; also the key in`values` and `metas`          |
| `label`       | string   | Visible label text                                                  |
| `type`        | string   | `select`, `textarea`, `number`, `date`, or omitted for text |
| `options`     | string[] | Permitted values; required when`type` is `select`               |
| `mono`        | boolean  | Renders the control in the monospace face                           |
| `half`        | boolean  | Field may share a horizontal row with the next`half` field        |
| `placeholder` | string   | Placeholder text                                                    |

### Mandatory fields

Declared in `REQUIRED_FIELDS` (line 17). All eight must be populated before a
record may be confirmed.

| `key`        | Label             | Type   | Notes                                |
| -------------- | ----------------- | ------ | ------------------------------------ |
| `lot`        | Mã lô           | text   | Monospace                            |
| `sku`        | SKU / Mã hàng   | text   | Monospace                            |
| `supplier`   | Nhà cung cấp    | select | Options from`SUPPLIERS` (line 8)   |
| `origin`     | Nước sản xuất | select | Options from`ORIGINS` (line 15)    |
| `qty`        | Số lượng       | number | Numeric keypad; must exceed zero     |
| `uom`        | Đơn vị         | select | Thùng, Kiện, Pallet, Bao, Cái, Kg |
| `location`   | Vị trí lưu kho | text   | Monospace                            |
| `receivedAt` | Ngày nhập       | date   | Defaults to the current date         |

### Optional fields

Declared in `OPTIONAL_FIELDS` (line 34). These are collapsed behind a toggle
until the operator expands them, or until recognition completes, at which point
`simulateAI` expands the section automatically.

| `key`       | Label                     | Type     | Notes                        |
| ------------- | ------------------------- | -------- | ---------------------------- |
| `mfgDate`   | Ngày sản xuất          | date     | Shares a row with`expDate` |
| `expDate`   | Hạn sử dụng            | date     | Must not precede`mfgDate`  |
| `po`        | Số đơn hàng (PO)      | text     | Monospace                    |
| `vehicle`   | Số container / biển số | text     | Monospace                    |
| `packaging` | Tình trạng bao bì      | select   | Four condition values        |
| `note`      | Ghi chú                  | textarea | Free text                    |

`ALL_FIELDS` (line 48) concatenates both arrays and is used by `emptyValues`
(line 51) to construct the initial state, in which every field is an empty
string except `receivedAt`, which is initialised to the current date in
`YYYY-MM-DD` form.

## Provenance model

The application distinguishes data the operator entered from data the
recognition service proposed, and further distinguishes high-confidence
proposals from those requiring review. 

### Structure

Two parallel state objects are keyed identically by field `key`:

```js
values = { lot: "LOT-240918-A7", qty: "48", ... }

metas  = { lot: { src: "sure",  confidence: 0.96, edited: false },
           qty: { src: "doubt", confidence: 0.71, edited: false }, ... }
```

A field absent from `metas` is treated as manually entered.

### States

| State      | Condition                            | Presentation                                                        |
| ---------- | ------------------------------------ | ------------------------------------------------------------------- |
| `manual` | No metadata entry                    | Grey indicator, no badge                                            |
| `sure`   | `confidence >= SURE_THRESHOLD`     | Green indicator, badge showing the confidence percentage            |
| `doubt`  | `confidence < SURE_THRESHOLD`      | Amber indicator, badge reading "Kiểm tra lại" with the percentage |
| `edited` | Operator modified a recognised value | Grey indicator, badge reading "đã sửa"                           |

`SURE_THRESHOLD` is defined at line 66 and is currently `0.9`. This constant is
the single tuning point governing how much recognised data the operator is
asked to verify. It should be calibrated against measured recognition accuracy
once the real service is integrated, not left at the prototype value by default.

### Edit tracking

`handleChange` (line 188) writes the new value and, if the field carries
metadata, sets `edited: true` on it. The original confidence figure is
retained. A recognised value that the operator has corrected therefore ceases
to display as machine-derived, and the audit trail distinguishing proposed data
from corrected data is preserved for the eventual submission payload.

The derived counter `doubtful` (line 186) reports how many recognised fields
remain below the threshold and unedited. It is surfaced in the action bar so
that the operator is informed of outstanding review items even when the form is
formally complete.

## Validation

`errors` is derived from `values` through `useMemo` (line 173) and is never
stored as state.

| Rule                                                                   | Message                                     |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| Every mandatory field must be non-empty after trimming                 | `Chưa có dữ liệu`                     |
| `qty` must parse to a number greater than zero                       | `Số lượng phải lớn hơn 0`           |
| `expDate`, when both dates are present, must not precede `mfgDate` | `Hạn sử dụng trước ngày sản xuất` |

The date comparison operates on the raw `YYYY-MM-DD` strings. This is correct
because ISO 8601 date strings sort lexicographically in chronological order,
and it avoids constructing `Date` objects and the associated timezone
ambiguity.

### Deferred error display

The `touched` flag gates error presentation. Errors are computed continuously
but passed to the field components only after the operator has attempted
confirmation, so an empty form is not marked as erroneous before any input has
been given. `confirm` (line 225) sets `touched`, aborts if any mandatory field
is missing, and otherwise emits the payload and resets the form.

## Recognition payload

`FAKE_AI` (line 55) stands in for the recognition service response and defines
the contract the real service is expected to satisfy:

```js
{
  lot:      { value: "LOT-240918-A7", confidence: 0.96 },
  sku:      { value: "SKU-88213-04",  confidence: 0.93 },
  supplier: { value: "...",           confidence: 0.88 },
  ...
}
```

Each entry maps a field `key` to a proposed `value` and a `confidence` in the
range 0 to 1. The stub supplies eight of the fourteen fields, leaving the
remainder for manual entry.

Two constraints apply when the real service is integrated. Values for `select`
fields must match an entry in the corresponding `options` array exactly, or the
control will render as unselected; a normalisation step between the service
response and the form state is likely to be required. Keys not present in
`ALL_FIELDS` are silently ignored by `simulateAI`, so schema drift between the
service and the form will fail quietly rather than raise an error.

## Submission payload

`confirm` currently logs the following structure, which is the intended request
body for the persistence endpoint:

```js
{ values, metas }
```

Transmitting `metas` alongside `values` preserves the provenance record: which
fields the service proposed, at what confidence, and which the operator
corrected. This information supports later measurement of recognition accuracy
in production and should not be discarded when the endpoint is implemented.
