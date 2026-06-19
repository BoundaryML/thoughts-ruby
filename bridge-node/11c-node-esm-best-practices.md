# Does `sam/node-esm` follow current ESM package best practices?

This note re-checks `sam/node-esm` after the work since `canary@origin`. I
re-read the linked package/ESM sources and compared them to:

```sh
jj diff --from canary@origin --stat
```

The originally requested spelling, `jj diff --from --stat canary@origin`,
fails with this version of `jj` because `--from` needs the revision argument
immediately after it.

Short answer: **yes for the ESM conversion and package shape; the remaining
items are release-policy hardening.**

The branch now implements the high-value recommendations from the linked
sources:

- `@boundaryml/baml-core-node` is ESM-only.
- `package.json` has `"type": "module"`.
- the package entrypoint is `exports`-based, not `main`-based.
- the `"types"` condition is first in the export condition object.
- the published package boundary points into `dist/`.
- TypeScript compiles with `module: "nodenext"` and
  `moduleResolution: "nodenext"`.
- handwritten bridge source uses `.js` relative import specifiers.
- generated SDK source uses `.js` relative import specifiers, including
  namespace re-exports like `./child/index.js`.
- protobuf output is generated/post-processed as ESM.
- the napi wrapper is generated as an ESM file.
- tests use Vitest instead of Jest.
- generated TypeScript fixture packages are ESM packages.
- the sdk-test harness validates generated ESM shape.
- the sdk-test harness runs `attw --pack` against the packed bridge package.

The important remaining gaps are:

- no declared `engines.node` support floor
- no release/publish gate that runs build + tests + packed-artifact validation
- no `publint` check
- no audited `sideEffects` policy

## Current Package Shape

The bridge package now has the package metadata shape recommended by the
ESM-first sources:

```json
{
  "name": "@boundaryml/baml-core-node",
  "type": "module",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"]
}
```

This is the key change from the old implementation. The package no longer
advertises root-level `index.js` / `index.d.ts`, and it no longer publishes a
grab bag of root `*.js`, `*.d.ts`, `proto`, and `*.node` files. The public
package boundary is `dist/index.js` plus `dist/index.d.ts`.

That matches the direction of:

- Matt Pocock's [package guide][total-package]: build into `dist`, publish `dist`, test with
  Vitest, and use NodeNext settings for TS packages.
- Sindre Sorhus's [pure-ESM checklist][sindre-pure-esm]: use `"type": "module"`, replace `main`
  with `exports`, use full relative paths, and compile TypeScript in Node's
  ESM mode.
- [TypeScript 4.7's Node ESM model][ts-47]: TypeScript follows Node package `exports`
  and package `"type"` under `node16`/`nodenext`.
- [Node's package docs][node-packages]: new packages should use `exports`, which also
  intentionally encapsulates non-exported subpaths.

## What We Now Implement

### 1. ESM-only is the chosen compatibility policy

[Anthony Fu's newer guidance][antfu-esm-only] recommends ESM-only for new packages because dual
ESM/CJS output adds interop, type, dependency-resolution, and package-size
complexity. Sindre's guide makes the same recommendation more forcefully.

This branch follows that policy. The export map has `types` and `import`, but
no `require` condition:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

That means CommonJS consumers are not a first-class target. They must use
dynamic `import("@boundaryml/baml-core-node")`, or migrate the consuming code
to ESM. This is the expected tradeoff for an ESM-only package.

Node 22+ has been improving `require()` support for ESM modules, but this
package does not currently expose a `require`, `module-sync`, or `default`
condition. So the package should still be documented as import-only.

### 2. We no longer publish CommonJS as `.js` under `"type": "module"`

The old failure mode was:

1. keep compiling TypeScript to CommonJS,
2. add `"type": "module"`,
3. let Node parse emitted `.js` files as ESM,
4. fail at runtime on `exports`, `module.exports`, or `require`.

The branch avoids that. `bridge_nodejs/tsconfig.json` now uses:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "rootDir": "./typescript_src",
    "outDir": "./dist"
  }
}
```

The package diff changes `module: "commonjs"` to `module: "nodenext"` and adds
`moduleResolution: "nodenext"`. That is the TypeScript-side change that makes
`"type": "module"` mean real ESM output instead of CommonJS masquerading as
ESM.

### 3. Relative imports use emitted `.js` specifiers

[Matt Pocock's import-extension article][total-js-extensions] and Sindre's guide both call out the
same NodeNext rule: TypeScript source should import the emitted JavaScript
specifier:

```ts
export { BamlStream } from "./stream.js";
```

not:

```ts
export { BamlStream } from "./stream";
export { BamlStream } from "./stream.ts";
```

The bridge source now follows this pattern:

```ts
import { encodeCallArgs, decodeCallResult } from "./proto.js";
export { BamlStream } from "./stream.js";
```

The generated SDK emitter follows it too. Cross-leaf imports and namespace
re-exports now point at concrete `index.js` specifiers:

```ts
import type * as lorem from "../lorem/index.js";
export * as aws from "./aws/index.js";
```

The sdk-test harness also enforces this. For every generated TypeScript SDK
fixture, `esm_output` scans `generated/baml_sdk/**/*.ts` and fails if a
relative `from "./..."` / `from "../..."` specifier does not end in `.js`.

### 4. The `exports` map is intentionally small

Node's package docs recommend `exports` for new packages and explain that it
encapsulates subpaths. That is what we want here:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

There is only a top-level public entrypoint. Internal files such as
`dist/native.js`, `dist/proto.js`, `dist/typemap.js`, and generated protobuf
support files are runtime implementation details, not public subpath exports.

TypeScript's `"types"` condition is first, matching TypeScript's package
exports guidance.

One optional compatibility knob is still absent: `"default":
"./dist/index.js"`. That could help runtimes or tools that do not use
`"import"` but do use `"default"`. I would not add it automatically unless we
have a concrete consumer/tooling reason, because the current package contract
is deliberately Node ESM import-only.

### 5. We publish from `dist/`

The build now emits package artifacts into `dist/`, and `files` is just
`["dist"]`.

The relevant build changes are:

- `build:clean` removes old `dist` output before rebuilding.
- `build:napi-*` writes `dist/native.js` and `dist/native.d.ts`.
- `napi build` runs with `--esm`.
- `build:proto` uses `pbjs -t static-module -w es6`.
- `build:ts_build` emits JS, declarations, and maps into `dist`.
- `build:copy-proto` copies generated protobuf support into `dist/proto`.
- `build:tag-generated-files` tags generated `dist/**/*.js` and
  `dist/**/*.d.ts` files.

That aligns with the package-layout guidance: consumers install built output,
not source files and loose root build artifacts.

### 6. The napi wrapper's `createRequire` use is acceptable

Sindre's checklist says to replace ordinary `require()` / `module.exports`
with ESM syntax. That remains the right rule for package source and public
entrypoints.

The napi-generated wrapper is the special case. It is itself an ESM file:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
```

It uses `createRequire` to load local `.node` binaries and optional
platform-specific native packages. Anthony Fu's dual-package article and the
TypeScript docs both describe `createRequire` as the Node escape hatch for
interop cases like this. The important package boundary is still ESM:

- no public CommonJS entrypoint
- no `module.exports`
- package entrypoint imports from `dist/index.js`
- named ESM exports from the bridge source

### 7. Protobuf output is ESM-compatible

The protobuf generation changed from:

```sh
pbjs -t static-module -w commonjs
```

to:

```sh
pbjs -t static-module -w es6
```

Then `tag-generated-files.js` post-processes the generated protobuf runtime
import to include the NodeNext-compatible package subpath:

```js
import $protobuf from "protobufjs/minimal.js";
```

It also rewrites the generated declaration's `Long` import away from
TypeScript's CommonJS-style `import = require` form:

```ts
import Long from "long";
```

That keeps both the generated JS and generated declarations aligned with the
package's ESM-only shape.

### 8. Tests moved from Jest to Vitest

[Matt Pocock's package guide][total-package] uses Vitest, and
[Mark Erikson's modernization writeup][mark-esm] specifically calls out Jest as one of the pain points during ESM
migrations.

This branch replaces Jest with Vitest for:

- `bridge_nodejs/package.json`
- `bridge_nodejs/vitest.config.ts`
- `bridge_nodejs/tests/run_vitest.rs`
- generated `sdk_test_typescript_node` fixture packages
- fixture test imports, which now import from `vitest`

The generated fixture package template is now:

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run"
  }
}
```

Its `tsconfig.json` also uses NodeNext module settings, so the generated SDK is
tested in the same module mode consumers will use.

### 9. SDK fixture tests now validate ESM output

The sdk-test harness has a new `esm_output` regression check. It validates
that every generated TypeScript fixture:

- has `"type": "module"` in `generated/package.json`
- has `module: "nodenext"` and `moduleResolution: "nodenext"` in
  `generated/tsconfig.json`
- contains ESM import/export syntax
- does not contain `module.exports`
- does not contain `exports.`
- does not contain `require(`
- uses `.js` on every relative import specifier

This is one of the most useful post-implementation checks because it catches
the accidental CJS regression that `"type": "module"` would otherwise hide
until runtime.

### 10. Are The Types Wrong is now part of the harness

[Mark Erikson's article][mark-esm] is the strongest reminder that package metadata,
conditional exports, and declaration files are easy to get subtly wrong.
[`Are The Types Wrong`][attw] is built for exactly that surface area.

The bridge package now has:

```json
{
  "scripts": {
    "attw": "attw --pack"
  },
  "devDependencies": {
    "@arethetypeswrong/cli": "0.18.3"
  }
}
```

The generated `sdk_test_typescript_node` test module also emits a package-level
test that runs:

```sh
pnpm exec attw --pack
```

from `sdks/nodejs/bridge_nodejs`.

That is better than only testing repo-local source files. It validates the
packed npm artifact, which is the shape real consumers install.

### 11. The napi toolchain is current for this branch

The branch updates the Node and Rust napi toolchain:

```json
{
  "devDependencies": {
    "@napi-rs/cli": "3.7.0"
  }
}
```

```toml
napi = { version = "3.9.0", default-features = false }
napi-derive = "3.5.6"
napi-build = "2.3.2"
```

This is not a generic ESM checklist item, but it matters here because the
native wrapper is part of the published JavaScript package shape.

## What Still Does Not Fully Conform

### 1. No `engines.node` field yet

[Sindre recommends][sindre-pure-esm] declaring a modern Node floor, for example:

```json
{
  "engines": {
    "node": ">=18"
  }
}
```

The package currently has no `engines` field.

Given the local dev tooling, `>=20` would be a reasonable package policy if
BAML is willing to make Node 20 the runtime floor:

```json
{
  "engines": {
    "node": ">=20"
  }
}
```

But that is a product/support decision, not a purely technical cleanup.
`@arethetypeswrong/cli` requiring modern Node as a dev dependency does not by
itself prove that runtime consumers must be on Node 20.

### 2. No `sideEffects` field yet

Some package checklists recommend:

```json
{
  "sideEffects": false
}
```

I would not add that blindly here.

This package loads native bindings, exposes process/runtime state, installs
exit hooks, and generated SDK entrypoints initialize runtime state at module
evaluation time. Omitting `sideEffects` is safer than claiming the package is
tree-shake-pure without an audit.

### 3. No release-aware publish gate yet

[Matt Pocock's package guide][total-package] wires build/test checks into CI and publishing.
This branch now has the right ingredients:

- `pnpm build:release`
- `pnpm test`
- `pnpm attw`
- sdk-test fixture `tsc`
- sdk-test fixture `vitest`
- sdk-test `esm_output`

But `bridge_nodejs/package.json` does not yet have a `prepublishOnly` or
equivalent release gate:

```json
{
  "scripts": {
    "prepublishOnly": "pnpm build:release && pnpm test && pnpm attw"
  }
}
```

The exact command should match BAML's native-release matrix and monorepo CI
flow. The important best-practice point is that packed-artifact validation
should run before publish, not just during local development.

### 4. No `publint` check yet

ATTW checks TypeScript package/type correctness. `publint` checks a different
slice of package-publishing mistakes, and [Anthony Fu explicitly recommends it][antfu-dual]
for package verification.

Adding it would be a reasonable next hardening step:

```json
{
  "scripts": {
    "publint": "publint"
  },
  "devDependencies": {
    "publint": "..."
  }
}
```

I would run both `attw --pack` and `publint` because they catch different
classes of problems.

### 5. We do not ship dual ESM/CJS

This is not a gap relative to the ESM-only decision. It is a deliberate
non-conformance with older dual-package compatibility guidance.

[Anthony Fu's older dual-package article][antfu-dual] is useful if CommonJS support becomes
a requirement:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  }
}
```

But supporting that cleanly would require separate CJS output, CJS-compatible
declarations/conditions, and more interop testing. It would reintroduce the
complexity this branch intentionally avoids.

## Recommended Next Steps

If we want `@boundaryml/baml-core-node` to match the full best-practice
checklist, I would do these in order:

1. Decide and declare the Node runtime floor (`>=18` vs `>=20`).
2. Add a release-aware package gate that runs build, Vitest, ATTW, and the
   relevant sdk-test harness before publish.
3. Add `publint` and include it in the same gate.
4. Audit side effects before adding `sideEffects: false`; otherwise leave the
   field absent intentionally.
5. Consider a `"default": "./dist/index.js"` condition only if a concrete
   runtime/tool needs it.

## Verdict

`sam/node-esm` now conforms to the core current ESM package best practices:

- ESM-only package boundary
- `"type": "module"`
- exports-only package entrypoint
- `types` condition first
- `dist/` publishing layout
- real ESM TypeScript output
- NodeNext TypeScript settings
- `.js` relative imports in handwritten and generated TS
- ESM-compatible protobuf output
- napi ESM wrapper
- Vitest-based testing
- generated SDK ESM regression tests
- packed-artifact validation with ATTW

The remaining work is not the ESM conversion itself. It is publishing policy:
declare the runtime Node floor, gate releases on the package checks, add
`publint`, and decide whether `sideEffects` should be absent or explicitly
false.

[total-package]: https://www.totaltypescript.com/how-to-create-an-npm-package
[total-js-extensions]: https://www.totaltypescript.com/relative-import-paths-need-explicit-file-extensions-in-ecmascript-imports
[sindre-pure-esm]: https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c
[antfu-esm-only]: https://antfu.me/posts/move-on-to-esm-only
[antfu-dual]: https://antfu.me/posts/publish-esm-and-cjs
[mark-esm]: https://blog.isquaredsoftware.com/2023/08/esm-modernization-lessons/
[attw]: https://github.com/arethetypeswrong/arethetypeswrong.github.io
[ts-47]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-7.html
[node-packages]: https://nodejs.org/api/packages.html
