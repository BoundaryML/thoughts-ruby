---
date: 2026-06-05
repository: baml
source_paths:
  - baml_language/sdks/python/src/baml_core/__init__.py
  - baml_language/sdks/python/src/baml_core/proto.py
  - baml_language/sdks/python/src/baml_core/typemap.py
  - baml_language/sdks/python/src/baml_core/_stream.py
  - baml_language/crates/bridge_ctypes/types/baml_core/cffi/v1/baml_outbound.proto
  - baml_language/crates/bridge_ctypes/src/value_encode.rs
  - baml_language/crates/bridge_cffi/src/lib.rs
  - baml_language/sdk_tests/fixtures/type_shapes/baml_src
  - baml_language/sdk_tests/crates/python_pydantic2/type_shapes/generated
  - baml_language/sdk_tests/crates/python_pydantic2/type_shapes/customizable/roundtrip_tests/test_generics.py
  - baml_language/sdk_tests/crates/python_pydantic2/type_shapes/customizable/test_complex_models.py
---

# Python Outbound Return Decoding

This file records how `baml_core` decodes values returned from the BAML engine
back into generated Python SDK objects. It complements
`00a-prior-art-python-type-mappings.md`,
`00a-prior-art-python-examples.md`, and
`00a-prior-art-python-inbound-encoding.md`.

The important implementation fact is that `baml_core` is implemented in
`baml_language/sdks/python`. Generated SDK packages call functions through
`baml_core.define_function(...)`; the generated package itself does not
implement outbound result decoding or error-envelope handling.

## Return Path Overview

After a generated callable sends encoded args to the PyO3/Rust runtime:

1. Rust executes the BAML function.
2. Rust converts the resulting `BexExternalValue` to `BamlOutboundValue` with
   `bridge_ctypes::value_encode::external_to_outbound(...)`.
3. The top-level value, thrown error, or panic is wrapped in a
   `BamlOutboundResult` envelope.
4. Python receives the serialized envelope bytes.
5. `decode_call_result(result_bytes)` decodes the envelope to a Python value
   or raises a Python exception.

Sync and async generated functions share the same outbound decoder.

## Outbound Result Envelope

Top-level function returns use `baml_outbound.proto`:

```proto
message BamlOutboundResult {
  oneof result {
    BamlOutboundValue ok = 1;
    BamlOutboundError error = 2;
    BamlOutboundPanic panic = 3;
  }
}

message BamlOutboundError {
  BamlOutboundValue value = 1;
  repeated string trace = 2;
}

message BamlOutboundPanic {
  BamlOutboundValue value = 1;
  repeated string trace = 2;
  bool is_exit_panic = 3;
  int64 exit_code = 4;
}
```

`decode_call_result(data)` parses that envelope:

| Envelope arm | Python behavior |
| --- | --- |
| `ok` | Decodes `ok` with `decode_value(...)` and returns it. |
| absent oneof | Decodes the default `ok` value, which becomes `None`. |
| `error` | Decodes `error.value` and raises `BamlError(value, baml_trace=..., class_name=...)`. |
| `panic` with `is_exit_panic` | Flushes telemetry and calls `os._exit(exit_code)`. This is not a catchable `SystemExit`. |
| other `panic` | Decodes `panic.value` and raises `BamlPanic(value, baml_trace=..., class_name=...)`. |

There is a same-host exception rehydration path for
`baml.errors.HostCallable`: if the decoded error value has a private `_handle`
that still resolves to an original native Python exception in the host-value
registry, `decode_call_result` re-raises that original exception object instead
of wrapping it in `BamlError`.

## Outbound Proto Shape

Python decodes `BamlOutboundValue` messages:

```proto
message BamlOutboundValue {
  oneof value {
    BamlValueNull null_value = 2;
    string string_value = 3;
    int64 int_value = 4;
    double float_value = 5;
    bool bool_value = 6;
    BamlValueClass class_value = 7;
    BamlValueEnum enum_value = 8;
    BamlTyLiteral literal_value = 9;
    BamlValueList list_value = 11;
    BamlValueMap map_value = 12;
    BamlValueUnionVariant union_variant_value = 13;
    BamlOutboundHandle handle_value = 16;
    BamlValueMedia media_value = 17;
    BamlValuePromptAst prompt_ast_value = 18;
    bytes uint8array_value = 19;
    string bigint_value = 20;
  }
}
```

Unlike inbound arguments, outbound values are type-rich: class and enum values
carry BAML FQNs, handles carry discriminator tags, lists/maps carry type
metadata, and generic class names can carry concrete `generic_args`.

## Python Value Decoding Rules

`decode_value(holder, type_map)` decodes a `BamlOutboundValue`.

| Outbound proto field | Python value |
| --- | --- |
| absent oneof / `null_value` | `None` |
| `string_value` | `str` |
| `int_value` | `int` |
| `bigint_value` | `int`, parsed from strict hex with a pre-allocation length cap |
| `float_value` | `float` |
| `bool_value` | `bool` |
| `uint8array_value` | `bytes` |
| `literal_value` | Inner Python literal (`str`, `int`, `bool`, or bigint-as-`int`); literal wrapper is discarded. |
| `list_value.items[]` | Python `list` with recursively decoded items. |
| `map_value.entries[]` | Python `dict[str, Any]` with recursively decoded values. |
| `class_value` | Generated Pydantic model, stdlib media wrapper, or fallback field dict. |
| `enum_value` | Generated enum member. |
| `union_variant_value` | Recursively decoded inner value; union metadata is discarded. |
| `handle_value` | Media wrapper, tagged-handle wrapper, or bare `BamlPyHandle`, depending on `handle_type`. |
| `media_value` / `prompt_ast_value` | Raises `BamlError`; the Python FFI path expects these to arrive through `handle_value`. |

The caller's Python return annotation does not drive runtime decoding.
Decoding is driven by the outbound wire payload plus the installed
`BamlTypeMap`.

## Decoder Implementation Details

The current `decode_value` implementation is a direct oneof dispatcher. The
important property is that it does not receive an expected return type. It only
receives the outbound value plus the typemap:

```python
def decode_value(holder, type_map: BamlTypeMap) -> Any:
    which = holder.WhichOneof("value")
    if which is None or which == "null_value":
        return None
    if which == "string_value":
        return holder.string_value
    if which == "int_value":
        return holder.int_value
    if which == "bigint_value":
        return _parse_hex_bigint(holder.bigint_value)
    if which == "float_value":
        return holder.float_value
    if which == "bool_value":
        return holder.bool_value
    if which == "uint8array_value":
        return holder.uint8array_value
    if which == "literal_value":
        return _decode_literal(holder.literal_value)
    if which == "list_value":
        return [decode_value(item, type_map) for item in holder.list_value.items]
    if which == "map_value":
        return {
            entry.key: decode_value(entry.value, type_map)
            for entry in holder.map_value.entries
        }
    if which == "class_value":
        return _decode_class(holder.class_value, type_map)
    if which == "enum_value":
        return _decode_enum(holder.enum_value, type_map)
    if which == "union_variant_value":
        return decode_value(holder.union_variant_value.value, type_map)
    if which == "handle_value":
        return _decode_handle(holder.handle_value, type_map)
    if which in ("media_value", "prompt_ast_value"):
        raise BamlError(...)
    return None
```

Class decoding is where generated Python models enter:

```python
def _decode_class(class_value, type_map: BamlTypeMap) -> Any:
    field_dict = {
        entry.key: decode_value(entry.value, type_map)
        for entry in class_value.fields
    }
    try:
        cls = type_map.get_class(class_value.name.name)
    except BamlError:
        return field_dict

    if cls in _MEDIA_PYO3_TYPES and "_data" in field_dict:
        return field_dict["_data"]

    parameterized = _parameterize(cls, class_value.name.generic_args, type_map)
    if not _is_pydantic_model_class(cls):
        return field_dict

    private_fields = {
        k: field_dict.pop(k) for k in _HANDLE_FIELD_NAMES if k in field_dict
    }
    instance = parameterized.model_validate(field_dict)
    if private_fields:
        if instance.__pydantic_private__ is None:
            instance.__pydantic_private__ = {}
        for name, value in private_fields.items():
            instance.__pydantic_private__[name] = value
    return instance
```

Generic metadata is only used if the wire payload supplies
`class_value.name.generic_args` or `handle_value.name.generic_args`.
`_parameterize` maps each outbound `BamlTy` into a Python runtime type and then
subscripts the generated symbol:

```python
def _parameterize(cls, generic_args, type_map: BamlTypeMap):
    if not generic_args:
        return cls
    py_args = tuple(_baml_ty_to_python_type(g.ty, type_map) for g in generic_args)
    try:
        if len(py_args) == 1:
            return cls[py_args[0]]
        return cls[py_args]
    except (TypeError, AttributeError):
        return cls
```

On the Rust side, `external_to_outbound(...)` recursively translates
`BexExternalValue` to the proto. The ordinary instance path currently emits an
empty `generic_args` list:

```rust
BexExternalValue::Instance { class_name, fields } => {
    let mut baml_fields = Vec::new();
    for (key, val) in fields {
        baml_fields.push(BamlOutboundMapEntry {
            key: key.clone(),
            value: Some(external_to_outbound(val, options)?),
        });
    }
    Some(BamlValueVariant::ClassValue(BamlValueClass {
        name: Some(BamlTyName {
            name: class_name.clone(),
            generic_args: vec![],
        }),
        fields: baml_fields,
    }))
}
```

By contrast, outbound type metadata derived from a real `Ty` can preserve
generic args. This is used for list/map item metadata and tagged handles:

```rust
fn ty_to_baml_ty_name(ty: &Ty) -> BamlTyName {
    match ty {
        Ty::Class(tn, args, _) => BamlTyName {
            name: tn.display_name.to_string(),
            generic_args: ty_args_to_baml_generic_args(args, &[]),
        },
        Ty::Interface(tn, args, associated_bindings, _) => BamlTyName {
            name: tn.display_name.to_string(),
            generic_args: ty_args_to_baml_generic_args(args, associated_bindings),
        },
        _ => BamlTyName { name: format!("{ty}"), generic_args: vec![] },
    }
}
```

So the Python decoder is generic-aware, but the ordinary class value producer in
`value_encode.rs` does not currently have a `Ty` at the `Instance` arm and
therefore does not populate concrete generic args for returned class values.

## Classes, Enums, Generics, And Typemap

The generated SDK root installs a process-global typemap:

```python
from baml_core import BamlRuntime, set_type_map
from ._typemap import _TYPE_MAP

BamlRuntime.initialize_runtime_from_bytecode(_inlinedbaml.BYTECODE)
set_type_map(_TYPE_MAP)
```

`BamlTypeMap` lazily maps BAML FQNs to generated Python classes, enums, and
type aliases. It also maintains a reverse map from Python class identity to
BAML FQN for inbound Pydantic and enum encoding, but outbound decoding mainly
uses the forward FQN-to-symbol lookup.

Stdlib PyO3 re-exports such as `BamlImage` live in `baml_core.baml_py`, so the
typemap seeds hardcoded reverse overrides for:

- `baml.media.Image`
- `baml.media.Audio`
- `baml.media.Video`
- `baml.media.Pdf`
- `baml.llm.Stream`

For outbound class values, `_decode_class(...)` first decodes all fields into a
plain dict. It then resolves `class_value.name.name` through the typemap.

Class decoding cases:

- If the class FQN cannot be resolved, `_decode_class` returns the decoded field
  dict. This preserves thrown stdlib/user error payloads in contexts where a
  generated typemap entry is unavailable.
- If the resolved class is a stdlib media PyO3 type and the decoded field dict
  contains `_data`, the decoder returns that `_data` value directly. The nested
  handle decode already built the `BamlImage` / `BamlAudio` / `BamlVideo` /
  `BamlPdf` wrapper.
- Otherwise, the decoder applies any outbound generic args to the class before
  calling `model_validate(field_dict)`.
- Handle-backed private fields such as `_handle`, `_data`, and `_body` are
  removed from kwargs before `model_validate(...)` and then injected into
  `instance.__pydantic_private__`.

Outbound generic args use `BamlTy` protobuf metadata. `_baml_ty_to_python_type`
is the runtime mirror of Python codegen's `translate_ty`: it maps BAML string /
int / bigint / float / bool / null / uint8array / media / class / enum /
alias / list / map / optional / union-variant / any / unknown shapes to Python
runtime types. `_parameterize(cls, generic_args, type_map)` then calls
`cls[arg]` or `cls[args...]` when possible, falling back to `cls` on arity or
subscriptability failures.

Enum decoding resolves `enum_value.name.name` through the typemap and then
constructs the enum member with `cls(variant)`. If the variant is not a member
of that generated enum class, decoding raises `BamlError`.

## Handles

Inbound and outbound share the `BamlHandleType` enum. Python handle decoding
uses the outbound `handle_type` discriminator:

| Handle type | Python decode |
| --- | --- |
| `ADT_MEDIA_IMAGE` | `BamlImage._from_pyhandle(...)` |
| `ADT_MEDIA_AUDIO` | `BamlAudio._from_pyhandle(...)` |
| `ADT_MEDIA_VIDEO` | `BamlVideo._from_pyhandle(...)` |
| `ADT_MEDIA_PDF` | `BamlPdf._from_pyhandle(...)` |
| `ADT_TAGGED_HEAP_HANDLE` | Uses `BamlOutboundHandle.name.name` to resolve a generated class and calls `cls._from_pyhandle(...)`. |
| `HANDLE_UNSPECIFIED` | Raises `BamlError`. |
| all other handle types | Bare `BamlPyHandle`. |

`BamlStream` is pure Python in `baml_core/_stream.py`. It wraps a `BamlPyHandle`;
`next`, `next_async`, `final`, and `final_async` call the corresponding BAML
stdlib functions by reusing `encode_call_args({"self": self})` and
`decode_call_result(...)`.

## Concrete Type-Shape Examples

These examples use the `type_shapes` SDK-test fixture:

- BAML source: `baml_language/sdk_tests/fixtures/type_shapes/baml_src`
- Generated Python: `baml_language/sdk_tests/crates/python_pydantic2/type_shapes/generated`
- Python round-trip tests:
  `customizable/roundtrip_tests/test_generics.py` and
  `customizable/test_complex_models.py`

The generated typemap contains entries such as:

```python
"user.generics.Wrapper": ("baml_sdk.generics", "Wrapper")
"user.generics.NestedGenerics": ("baml_sdk.generics", "NestedGenerics")
"user.complex_models.ComplexProfile": ("baml_sdk.complex_models", "ComplexProfile")
"user.complex_models.AccountTier": ("baml_sdk.complex_models", "AccountTier")
```

### 1. Simple: `Wrapper<int>`

Fixture BAML:

```baml
class Wrapper<T> {
  value T
}

function round_trip_wrapper_int(w: Wrapper<int>) -> Wrapper<int> {
  w
}
```

Generated Python:

```python
T = typing.TypeVar("T")

class Wrapper(pydantic.BaseModel, typing.Generic[T]):
    model_config = pydantic.ConfigDict(extra="forbid")
    value: T
```

The Python test constructs:

```python
w = Wrapper[int](value=5)
assert round_trip_wrapper_int(w=w) == w
```

The returned engine value is, schematically:

```rust
BexExternalValue::Instance {
    class_name: "user.generics.Wrapper",
    fields: {
        "value": BexExternalValue::Int(5),
    },
}
```

`external_to_outbound(...)` produces:

```text
BamlOutboundValue {
  class_value: {
    name: { name: "user.generics.Wrapper", generic_args: [] },
    fields: [
      { key: "value", value: { int_value: 5 } }
    ]
  }
}
```

Python decoding:

1. `decode_value(holder, type_map)` sees `class_value`.
2. `_decode_class` recursively decodes fields, so `field_dict == {"value": 5}`.
3. `type_map.get_class("user.generics.Wrapper")` loads
   `baml_sdk.generics.Wrapper`.
4. `_parameterize(Wrapper, [], type_map)` returns bare `Wrapper`, because the
   outbound class name has no generic args.
5. `Wrapper.model_validate({"value": 5})` returns a generated Pydantic model.

The host value is effectively:

```python
baml_sdk.generics.Wrapper(value=5)
```

It is not constructed from the caller's return annotation. If the outbound wire
had instead carried `generic_args: [int]`, the same decoder would attempt to
validate through `Wrapper[int]`.

### 2. Medium: `NestedGenerics`

Fixture BAML:

```baml
class GenericLinkedList<T> {
  value T
  next GenericLinkedList<T>?
}

class NestedGenerics {
  ww Wrapper<Wrapper<int>>
  wl Wrapper<int[]>
  wr Wrapper<GenericLinkedList<int>>
}

function round_trip_nested_generics(n: NestedGenerics) -> NestedGenerics {
  n
}
```

Generated Python:

```python
class GenericLinkedList(pydantic.BaseModel, typing.Generic[T]):
    value: T
    next: typing.Optional[GenericLinkedList[T]]

class NestedGenerics(pydantic.BaseModel):
    ww: Wrapper[Wrapper[int]]
    wl: Wrapper[typing.List[int]]
    wr: Wrapper[GenericLinkedList[int]]
```

The Python test constructs:

```python
n = NestedGenerics(
    ww=Wrapper[Wrapper[int]](value=Wrapper[int](value=1)),
    wl=Wrapper[list](value=[1, 2]),
    wr=Wrapper[GenericLinkedList[int]](
        value=GenericLinkedList[int](value=9, next=None)
    ),
)
assert round_trip_nested_generics(n=n) == n
```

The returned `BexExternalValue` is schematically:

```rust
BexExternalValue::Instance {
    class_name: "user.generics.NestedGenerics",
    fields: {
        "ww": Instance("user.generics.Wrapper", {
            "value": Instance("user.generics.Wrapper", {
                "value": Int(1),
            }),
        }),
        "wl": Instance("user.generics.Wrapper", {
            "value": Array {
                element_type: Ty::Int,
                items: [Int(1), Int(2)],
            },
        }),
        "wr": Instance("user.generics.Wrapper", {
            "value": Instance("user.generics.GenericLinkedList", {
                "value": Int(9),
                "next": Null,
            }),
        }),
    },
}
```

The outbound proto keeps the class graph and list item type metadata:

```text
class_value {
  name { name: "user.generics.NestedGenerics", generic_args: [] }
  fields {
    key: "ww"
    value {
      class_value {
        name { name: "user.generics.Wrapper", generic_args: [] }
        fields {
          key: "value"
          value {
            class_value {
              name { name: "user.generics.Wrapper", generic_args: [] }
              fields { key: "value", value { int_value: 1 } }
            }
          }
        }
      }
    }
  }
  fields {
    key: "wl"
    value {
      class_value {
        name { name: "user.generics.Wrapper", generic_args: [] }
        fields {
          key: "value"
          value {
            list_value {
              item_type { int_type {} }
              items { int_value: 1 }
              items { int_value: 2 }
            }
          }
        }
      }
    }
  }
  fields {
    key: "wr"
    value {
      class_value {
        name { name: "user.generics.Wrapper", generic_args: [] }
        fields {
          key: "value"
          value {
            class_value {
              name { name: "user.generics.GenericLinkedList", generic_args: [] }
              fields { key: "value", value { int_value: 9 } }
              fields { key: "next", value {} }
            }
          }
        }
      }
    }
  }
}
```

Python decoding is recursive from the leaves upward:

1. The innermost `int_value` nodes become `1`, `2`, and `9`.
2. The empty `next` value has no oneof set, so it becomes `None`.
3. The `list_value` becomes `[1, 2]`. Python does not consult
   `item_type` for list decoding; the metadata is preserved on the wire but
   the decoder only walks `items`.
4. Each `class_value` resolves by FQN through the typemap and validates a
   decoded field dict.
5. The outer `NestedGenerics.model_validate(...)` receives decoded child values
   under fields whose generated annotations are `Wrapper[Wrapper[int]]`,
   `Wrapper[List[int]]`, and `Wrapper[GenericLinkedList[int]]`.

The final host value is a `baml_sdk.generics.NestedGenerics` instance with
nested generated Pydantic objects:

```python
NestedGenerics(
    ww=Wrapper(value=Wrapper(value=1)),
    wl=Wrapper(value=[1, 2]),
    wr=Wrapper(value=GenericLinkedList(value=9, next=None)),
)
```

Again, the current ordinary `Instance` encoder emits empty class
`generic_args`; the nested type shape still round-trips because every object
node carries a concrete class FQN and Pydantic validates against the generated
field annotations on `NestedGenerics`.

### 3. High Complexity: `ComplexProfile`

Fixture BAML:

```baml
enum AccountTier {
  Free,
  Pro,
  Enterprise,
}

class Invoice {
  id string
  status "draft" | "sent" | "paid"
  items LineItem[]
  payment CardPayment | WirePayment | null
  notes string?
}

class ComplexProfile {
  id string
  tier AccountTier
  owner ProfileOwner
  addresses PostalAddress[]
  invoices Invoice[]
  audit_trail AuditEvent[]
  metadata map<string, string>
  featured Invoice | PostalAddress | string | null
  flags (int | string | bool)[]
}
```

The Python test builds a profile containing:

- an `AccountTier.Enterprise` enum;
- nested `ProfileOwner`, `ContactMethod`, `PostalAddress`, `GeoPoint`,
  `Invoice`, `LineItem`, `CardPayment`, `WirePayment`, and `AuditEvent`
  models;
- arrays of classes and union-selected primitives;
- `map<string, string>` fields;
- `None` optional fields;
- literal string union values such as `"sent"` and `"approved"`.

A compact returned `BexExternalValue` for that test shape, keeping one or two
representative entries for each repeated field, is:

```rust
BexExternalValue::Instance {
    class_name: "user.complex_models.ComplexProfile",
    fields: {
        "id": String("profile-001"),
        "tier": Variant {
            enum_name: "user.complex_models.AccountTier",
            variant_name: "Enterprise",
        },
        "owner": Instance("user.complex_models.ProfileOwner", {
            "name": String("Ada Lovelace"),
            "primary_contact": Instance("user.complex_models.ContactMethod", {
                "label": String("email"),
                "value": String("ada@example.com"),
                "verified": Bool(true),
            }),
            "backup_contacts": Array {
                element_type: Ty::Class("user.complex_models.ContactMethod"),
                items: [
                    Instance("user.complex_models.ContactMethod", {
                        "label": String("phone"),
                        "value": String("+1-555-0100"),
                        "verified": Bool(false),
                    }),
                ],
            },
        }),
        "addresses": Array {
            element_type: Ty::Class("user.complex_models.PostalAddress"),
            items: [
                Instance("user.complex_models.PostalAddress", {
                    "line1": String("1 Compiler Way"),
                    "line2": Null,
                    "city": String("San Francisco"),
                    "region": String("CA"),
                    "postal_code": String("94107"),
                    "location": Instance("user.complex_models.GeoPoint", {
                        "lat": Float(37.7749),
                        "lng": Float(-122.4194),
                    }),
                }),
                Instance("user.complex_models.PostalAddress", {
                    "line1": String("200 Type Lane"),
                    "line2": String("Suite 42"),
                    "city": String("Oakland"),
                    "region": String("CA"),
                    "postal_code": String("94612"),
                    "location": Null,
                }),
            ],
        },
        "invoices": Array {
            element_type: Ty::Class("user.complex_models.Invoice"),
            items: [
                Instance("user.complex_models.Invoice", {
                    "id": String("inv-001"),
                    "status": Union(String("sent"), selected = "sent"),
                    "items": Array {
                        element_type: Ty::Class("user.complex_models.LineItem"),
                        items: [
                            Instance("user.complex_models.LineItem", {
                                "sku": String("sdk-pro"),
                                "quantity": Int(2),
                                "unit_price": Float(19.5),
                                "tags": Array {
                                    element_type: Ty::String,
                                    items: [String("sdk"), String("typescript")],
                                },
                                "attributes": Map {
                                    key_type: Ty::String,
                                    value_type: Ty::String,
                                    entries: {
                                        "language": String("ts"),
                                        "support": String("priority"),
                                    },
                                },
                            }),
                        ],
                    },
                    "payment": Union(
                        Instance("user.complex_models.CardPayment", {
                            "brand": String("visa"),
                            "last4": String("4242"),
                            "billing_address": Instance("user.complex_models.PostalAddress", ...),
                        }),
                        selected = "user.complex_models.CardPayment",
                    ),
                    "notes": String("first invoice"),
                }),
                Instance("user.complex_models.Invoice", {
                    "id": String("inv-002"),
                    "status": Union(String("paid"), selected = "paid"),
                    "items": Array {
                        element_type: Ty::Class("user.complex_models.LineItem"),
                        items: [
                            Instance("user.complex_models.LineItem", {
                                "sku": String("sdk-enterprise"),
                                "quantity": Int(1),
                                "unit_price": Float(250.0),
                                "tags": Array {
                                    element_type: Ty::String,
                                    items: [String("sdk"), String("enterprise")],
                                },
                                "attributes": Map {
                                    key_type: Ty::String,
                                    value_type: Ty::String,
                                    entries: {
                                        "language": String("python"),
                                        "term": String("annual"),
                                    },
                                },
                            }),
                        ],
                    },
                    "payment": Union(
                        Instance("user.complex_models.WirePayment", {
                            "bank_name": String("Boundary Bank"),
                            "routing_code": String("110000000"),
                            "reference": Null,
                        }),
                        selected = "user.complex_models.WirePayment",
                    ),
                    "notes": Null,
                }),
            ],
        },
        "audit_trail": Array {
            element_type: Ty::Class("user.complex_models.AuditEvent"),
            items: [
                Instance("user.complex_models.AuditEvent", {
                    "actor": String("system"),
                    "action": Union(String("created"), selected = "created"),
                    "context": Map {
                        key_type: Ty::String,
                        value_type: Ty::String,
                        entries: { "source": String("fixture") },
                    },
                }),
                Instance("user.complex_models.AuditEvent", {
                    "actor": String("reviewer"),
                    "action": Union(String("approved"), selected = "approved"),
                    "context": Map {
                        key_type: Ty::String,
                        value_type: Ty::String,
                        entries: {
                            "level": String("2"),
                            "region": String("us"),
                        },
                    },
                }),
            ],
        },
        "metadata": Map {
            key_type: Ty::String,
            value_type: Ty::String,
            entries: {
                "cohort": String("beta"),
                "owner_kind": String("internal"),
            },
        },
        "featured": Union(
            Instance("user.complex_models.Invoice", ...),
            selected = "user.complex_models.Invoice",
        ),
        "flags": Array {
            element_type: Ty::Union([Ty::Int, Ty::String, Ty::Bool]),
            items: [
                Union(Int(7), selected = "int"),
                Union(String("manual-review"), selected = "string"),
                Union(Bool(true), selected = "bool"),
            ],
        },
    },
}
```

The outbound proto projection keeps the same tree, but every value is converted
to its protobuf oneof. This excerpt shows the characteristic projections; the
full payload contains the repeated siblings shown in the `BexExternalValue`
above:

```text
ComplexProfile.class_value {
  name { name: "user.complex_models.ComplexProfile", generic_args: [] }
  fields { key: "id", value { string_value: "profile-001" } }
  fields {
    key: "tier"
    value {
      enum_value {
        name { name: "user.complex_models.AccountTier", generic_args: [] }
        value: "Enterprise"
      }
    }
  }
  fields {
    key: "addresses"
    value {
      list_value {
        item_type { class_type { name { name: "user.complex_models.PostalAddress" } } }
        items { class_value { name { name: "user.complex_models.PostalAddress" } ... } }
      }
    }
  }
  fields {
    key: "metadata"
    value {
      map_value {
        key_type { string_type {} }
        value_type { string_type {} }
        entries { key: "cohort", value { string_value: "beta" } }
        entries { key: "owner_kind", value { string_value: "internal" } }
      }
    }
  }
  fields {
    key: "flags"
    value {
      list_value {
        item_type { union_variant_type {} }
        items { union_variant_value { value { int_value: 7 } } }
        items { union_variant_value { value { string_value: "manual-review" } } }
        items { union_variant_value { value { bool_value: true } } }
      }
    }
  }
}
```

Python decoding proceeds mechanically:

1. Scalars decode directly: `"profile-001"`, `19.5`, `2`, `True`, and
   `None`.
2. `enum_value` resolves
   `"user.complex_models.AccountTier"` to
   `baml_sdk.complex_models.AccountTier` and constructs
   `AccountTier("Enterprise")`, yielding `AccountTier.Enterprise`.
3. `map_value` entries become ordinary Python `dict[str, Any]`. The decoder
   does not use `key_type` or `value_type` at runtime.
4. `list_value` entries become Python lists by recursively decoding `items`.
   The decoder does not use `item_type` at runtime.
5. Each nested `class_value` becomes a generated Pydantic model through
   `_decode_class`.
6. Each `union_variant_value` discards union metadata and returns only the
   decoded selected value. For example, `Union(String("sent"), selected =
   "sent")` becomes the Python string `"sent"`, and `Union(CardPayment(...),
   selected = CardPayment)` becomes a `CardPayment` instance.
7. Finally, `ComplexProfile.model_validate(field_dict)` validates the complete
   decoded object graph against the generated annotations.

The final host value is a generated `ComplexProfile` instance equivalent to the
test's input:

```python
ComplexProfile(
    id="profile-001",
    tier=AccountTier.Enterprise,
    owner=ProfileOwner(...),
    addresses=[PostalAddress(...)],
    invoices=[Invoice(status="sent", payment=CardPayment(...), ...)],
    audit_trail=[
        AuditEvent(action="created", context={"source": "fixture"}),
        AuditEvent(action="approved", context={"level": "2", "region": "us"}),
    ],
    metadata={"cohort": "beta", "owner_kind": "internal"},
    featured=Invoice(...),
    flags=[7, "manual-review", True],
)
```

This high-complexity example demonstrates the main runtime split: class and
enum nodes are typemap-driven, but list/map/union type metadata is mostly
validation context for other bridges or future consumers. The current Python
decoder recursively decodes those containers by value and relies on generated
Pydantic models to enforce the final field shape.

## Practical Consequences For Bridge Generics

- Generated `.pyi` return annotations are static-only. Runtime return decoding
  is outbound-wire-shape-driven.
- Outbound decoding is type-rich and typemap-driven. Generic return values can
  materialize as parameterized Pydantic classes when the outbound
  `BamlTyName.generic_args` are populated.
- Ordinary `BexExternalValue::Instance` outbound encoding currently emits
  `class_value.name.generic_args: []`; preserving generic args for normal class
  returns would require carrying the concrete `Ty` into that encoder arm or
  otherwise enriching the `BexExternalValue::Instance` representation.
- Union wrappers do not survive into Python values. Python receives the decoded
  selected value.
- Media and prompt AST should arrive via `handle_value` on the Python FFI path;
  inline `media_value` / `prompt_ast_value` is treated as bridge drift and
  raises `BamlError`.
- Host-callable errors may rehydrate to the original Python exception object
  when the host-value registry still has the backing handle.
