# Non-media handle roundtrip findings

## Answer

Node encode/decode is intended to handle non-media handle-backed stdlib values today, and the current bridge was close enough that the test should cover the behavior directly.

The existing pieces already in place:

- Decode of `class_value` uses the generated typemap, so `baml.fs.File` and `baml.http.Response` decode to generated class instances.
- Those instances carry their engine-owned handle field (`_handle` for `File`, `_body` for `Response`) as a `BamlHandle`.
- Encode of generated class instances with embedded `BamlHandle`s sends a FQN-tagged `class_value`, which lets the engine reconstruct the expected stdlib class shape instead of receiving an untyped map.

The bug was in the nested `BamlHandle` encode path. `bridge_ctypes::inbound_to_external` drains handle-table entries when it decodes an inbound handle. Node was sending the JS-owned handle key itself, so the first call using a `File`/`Response` consumed that key and a second call with the same JS object failed with `Invalid handle key`.

## Fix

Changed Node's generic `BamlHandle` encode branch to clone the handle table entry with `putHandleIntoTable(...)` before putting the key on the wire. This mirrors the intended helper semantics: the engine can drain the cloned inbound key while the JS-owned handle remains valid for later calls.

Updated `roundtrip_handles.test.ts` to exercise the generated stdlib APIs directly:

- `baml.media.Image.fromBase64(...)`
- `await baml.http.fetch_async(url)` followed by `resp.text()`
- `baml.fs.open(path, "r")` followed by repeated `f.read(...)`, `f.seek_from(...)`, `f.text()`, and `f.close()`

This avoids the Python-only wrapper workaround (`open_file_read`, `file_read`, etc.) and proves the Node surface roundtrips non-media handles through ordinary generated methods.

## Verification

Focused verification passed:

```bash
cd /Users/sam/baml3/baml_language
cargo nextest run -p sdk_test_nodejs_typescript type_shapes::tsc
cd sdk_tests/crates/nodejs_typescript/type_shapes/generated
node node_modules/jest/bin/jest.js roundtrip_handles.test.ts --runInBand
```

Result: `roundtrip_handles.test.ts` passed with 4 tests.
