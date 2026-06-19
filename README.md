Hi Ryan! Thanks for helping out with getting Ruby bindings going for BAML :)

Some basic background:

- BAML is now a fully featured programming language, with its own compiler and VM/runtime
- In engine-baml, host language bindings were called "baml_client". In the new language we are calling these SDKs and they are implemented as follows:

```
baml_language/sdks/
├── go      // incomplete, mostly proof of concept
│   ├── bridge_go
│   └── sdkgen_go
├── nodejs  // in alpha stage
│   ├── bridge_nodejs
│   └── sdkgen_typescript_node
└── python  // in alpha stage
	├── rust
	│   ├── bridge_python
	│   └── sdkgen_python_pydantic2
	└── src
	    └── baml_core    // this is python_src, basically
```

Generators will look familiar to you ([baml-demos](https://github.com/BoundaryML/baml-demos/blob/main/baml_src/generators.baml) has examples):
```
generator target {
    output_type: "python/pydantic",
    output_dir: "python_demo",
    default_client_mode: "sync",  // this is a noop, we need to drop support for this field
    naming_convention: "preserve-case",
}

generator ts_target {
    output_type: "typescript/node",
    output_dir: "typescript_demo",
    naming_convention: "preserve-case",
}
```

# Included documents

`bridge-ref/` contains reference documents about the currently implemented behavior of the Python and TS SDKs.

`bridge-node/` contains the documents I handwrote / wrote-in-tandem-with-Claude to guide the implementation, and then implemented using `/goal` prompts:
- `00*` docs were handwritten
- `01` through `06` were implementation plans that Claude generated and which I then proofread and revised until there were no remaining open questions
- `10` through `12` were documents that I used to track followup work (this is not the complete list of followup items)

I would suggest using every document in `bridge-ref/` and `bridge-node/00b-overview.md` as your starting points.

# Recommendations

I would strongly recommend manually writing Ruby versions of the ref documents
- I used these as my baseline goal documents, i.e. these were the documents I used to steer the generation of the implementation plan docs
- Once the goal documents are high-quality, generating the implementation plan isn't too hard

I would also suggest making your coding agent implement a swath of things, seeing what _doesn't_ work and learning from it, then throwing away what it did and re-doing the plans and simply re-implementing from scratch. It's really easy to get trapped in a local suboptima if you try to rescue a poorly done implementation.

I've also gotten a _lot_ of mileage out of asking Claude to "read this document and tell me if there are any inconsistencies in it" - this comes in really helpful for identifying everything from mismatched parentheses to "here's a contradiction in your definition of this critical runtime abstraction".

# SDK structure

This is a simplified version of the phase-by-phase implementation strategy I used to implement the Python and Node.js SDKs (the full overview document that I gave to Claude is in 00b-overview.md), but written to explain to _you_, Ryan, (1) what changes you need to make to each phase and (2) what design decisions you'll need to make.

(This breakdown is also written to give you a sense of why I broke down the phases in the way that I did.)

1. set up test coverage in `sdk_tests/` paralleling the existing test coverage
	- `sdk_tests/README.md` details how to run the current tests (`cargo nextest run -p sdk_test_python_pydantic2` and `cargo nextest run -p sdk_test_typescript_node`) and add new test cases
	- `sdk_tests/DEVELOPMENT.md` explains more about the design of the test infrastructure and the nitty gritty there.
2. set up the "bridge" - the code in the host language that provides the BAML runtime through a type-erased API, i.e. the library that allows loading a `baml_src/` codebase into memory and invoking BAML functions using a "bytes in" "bytes out" approach with no type safety
	- In Python and TypeScript we implement and distribute the bridge using Rust FFI libraries (pyo3 and napi)
	- In Golang, we implement the bridge using `dlopen("lib_bridge_cffi.dylib")` (see `baml_language/sdks/go/bridge_go/cffi/lib.go`) and distribute it on-the-fly using a "download the `.dylib` from github releases" strategy.
	- In Ruby we _probably_ want to use the Golang approach - engine-BAML went with the Rust FFI approach (using [magnus](https://docs.rs/magnus/latest/magnus/)) and build speeds / cross-compiling became prohibitively painful (because Ruby toolchain management has painful singleton semantics)
		- I would suggest using `"baml-bridge"` as the package name for Ruby - we have plans in place to rename the Python and NPM packages to match this naming convention.
	- In all of Python, TS, and Go, we've added implementations for things like `@trace` and span managers etc - in Ruby we can just disregard these. These are stub implementations ported from `engine/` that are not tested and under active design today.
	- It _is_ important to understand how `call_function` will work, and importantly what `defineFunction` will look like - the per-function call trampoline. The best way to understand this will be by reading the various ref documents.
3. decide what the shape of the generated SDK should be
	- Look at bridge-ref/00a-ref-python-examples.md and bridge-ref/00a-ref-python-examples.md, then prepare another document with the Ruby examples.
	- **It's very important to prepare the example document manually.** I've tried to use Claude to automate this, and inevitably it ends up making critical mistakes. It's still super useful to use CC to review this doc, but the examples doc is _incredibly_ information-dense and has a lot of opportunities to get the rules wrong.
	- It's useful to ping pong between
4. set up SDK generation scaffolding
	- for every top-level symbol (functions, classes, enums, etc) that we need to generate in the host language, emit a placeholder - do NOT attempt to emit the whole symbol definition (SDK generation is broken up into 3 phases because it's too complex otherwise)
	- this is important because it forces the coding agent to implement generating the correct set of _files_, based on the symbols it needs to generate, before it implements generating symbols
5. implement type translation for SDK generation: `translate_ty`
	- Given a BAML type `T_baml`, what host language type `T_host` will that generate as?
	- This will be the core primitive used to implement every other part of SDK generation:
		- Given a BAML function `function my_fn(arg1: T_baml1, arg2: T_baml2) -> T_baml_ret`, what will be the corresponding host function type (what will the arg types be? what will the return type be? what will the throws type be?)
		- Given a BAML class `class T_baml_class { field1: T_baml1, field2: T_baml2 }`, what will be the corresponding host class type (what will the field types be?)
6. implement SDK generation itself:
	- for every top-level symbol (functions, classes, enums, etc) that we need to generate in the host language, actually instantiate it correctly, instead of just emitting a placeholder
7. encode and decode `call_function` args
	- set up outbound deserialization
		- baml_outbound.proto values to host lang values
		- how does union deserialization work?
	- set up inbound serialization
		- host lang values to baml_inbound.proto values
	- the generated SDK should include a `type_map` that is used for both inbound serialization and outbound deserialization
		- that is, given a `BamlOutboundValue` of type `T_baml`, the bridge/generated code should be able to use the generated type map to construct a corresponding instance of `T_host`; the same goes for inbound serialization
		- the idea of `BexExternalValue` and `BamlOutboundValue` is that those types should contain enough information for instances of `BexExternalValue` and `BamlOutboundValue` to be 99% self-describing - the only thing they don't contain is the _definition_ of a type
8. set up the release process (GitHub workflows, OIDC, etc)
