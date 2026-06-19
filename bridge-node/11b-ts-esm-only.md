# What `ts-esm-only` implements

This note explains the old `ts-esm-only` bookmark in the terms used by
`11-js-ts-module-systems.md`.

The bookmark on origin points at:

- `3a73c127`: `migrate ts package to esm exports only`
- `33cc0c9c`: `fix generators, migrate to vitest to fix esm test issues`

The branch is old relative to current `canary`, so a whole-tree diff against
today's `canary@origin` is mostly repository drift. The useful diff is from the
branch's parent, `626cc4b2`, to `33cc0c9c`.

## Summary

`ts-esm-only` tries to move the old TypeScript runtime package,
`engine/language_client_typescript`, from the note's L3 shape to the L2/L4
shape:

- Before: TypeScript source with `import`/`export` syntax, but emitted and
  packaged as CommonJS.
- After: a package whose `.js` files are parsed as native ESM and whose exports
  are ESM-only.

In the language of `11-js-ts-module-systems.md`, the branch tries to make
`@boundaryml/baml` behave like:

- L2: native ESM library, because published `.js` files are ESM under
  `"type": "module"`.
- L4: TypeScript NodeNext ESM, because the handwritten TypeScript wrapper files
  are compiled with `module: "nodenext"` and `moduleResolution: "nodenext"`.

It stops trying to support this as the main runtime shape:

- L1/L3: CommonJS library, loaded with `require(...)` and exported through
  `module.exports` or `exports`.

## What changed

The branch makes five related changes.

### 1. The package becomes ESM by package type

`engine/language_client_typescript/package.json` gets:

```json
{
  "type": "module"
}
```

In the terms of the module-systems note, this changes the parse goal of `.js`
files in the package:

- Before: `.js` with no `"type"` was treated as CommonJS.
- After: `.js` with `"type": "module"` is treated as ESM.

That one line is decisive. Once it is present, files like `index.js`,
`native.js`, `stream.js`, and `type_builder.js` can no longer rely on CommonJS
globals such as:

```js
require
exports
module.exports
__dirname
__filename
```

They must be valid ESM modules.

### 2. The package export map becomes import-only

Before the branch, the package had export entries like:

```json
{
  "exports": {
    ".": "./index.js",
    "./native": "./native.js",
    "./type_builder": "./type_builder.js"
  }
}
```

After the branch, the entries become condition objects with `types` and
`import`:

```json
{
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./index.js"
    },
    "./native": {
      "types": "./native.d.ts",
      "import": "./native.js"
    },
    "./type_builder": {
      "types": "./type_builder.d.ts",
      "import": "./type_builder.js"
    }
  }
}
```

This is the `Package exports maps and dual packages` section of
`11-js-ts-module-systems.md`.

The important part is what is missing: there is no `require` condition. That
makes the package ESM-only from the package boundary. An ESM consumer can use:

```js
import { BamlRuntime } from "@boundaryml/baml";
import { FieldType } from "@boundaryml/baml/native";
```

A CommonJS consumer cannot safely do:

```js
const baml = require("@boundaryml/baml");
```

That is the table's R6/R16 situation: CommonJS consuming an ESM library is
async-only through dynamic `import(...)`.

```js
async function main() {
  const baml = await import("@boundaryml/baml");
}
```

### 3. The napi-generated wrapper becomes ESM

The build script changes from:

```json
{
  "build:napi-debug": "napi build --js ./native.js --dts ./native.d.ts --platform"
}
```

to:

```json
{
  "build:napi-debug": "napi build --js ./native.js --esm --dts ./native.d.ts --platform"
}
```

The resulting `native.js` changes from CommonJS exports:

```js
const { createRequire } = require("node:module");

module.exports = nativeBinding;
module.exports.BamlRuntime = nativeBinding.BamlRuntime;
module.exports.FieldType = nativeBinding.FieldType;
```

to ESM-compatible code:

```js
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = new URL(".", import.meta.url).pathname;

const { BamlRuntime, FieldType } = nativeBinding;
export { BamlRuntime };
export { FieldType };
```

This is not cosmetic. In native ESM, `module.exports` does not exist. The old
wrapper was an L1 CommonJS module. The branch rewrites it into an L2 native ESM
module while still using `createRequire(...)` internally where the native addon
loading path needs CommonJS-like loading behavior.

That is a valid ESM pattern: ESM at the package boundary, `createRequire` only
as an internal escape hatch for Node APIs and native addon files.

### 4. The TypeScript wrapper source moves to NodeNext ESM rules

The branch adds `engine/language_client_typescript/tsconfig.build.json`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "rootDir": "./typescript_src",
    "outDir": "./",
    "allowJs": true,
    "declaration": true,
    "declarationMap": true,
    "strict": true
  }
}
```

This corresponds to `TypeScript NodeNext / Node16 ESM` in the module-systems
note.

The source imports are adjusted toward runtime file names:

```ts
export * from "./safe_imports.js";
export * from "./errors.js";
export { BamlStream } from "./stream.js";
export { BamlRuntime } from "./native.js";
```

That is the R19 rule:

> In source, write `.js` for a neighboring `.ts` that emits `.js`.

Without those `.js` suffixes, Node's native ESM resolver does not load relative
imports like `./native` from emitted JavaScript. CommonJS historically accepted
extensionless local imports because `require("./native")` probes extensions.
Native ESM does not do that for relative file imports.

The branch also removes an old CommonJS-only browser guard pattern:

```ts
Object.defineProperty(exports, "Image", {
  get: () => browserError("Image"),
  enumerable: true
});
```

That pattern mutates the CommonJS `exports` object. In ESM, exports are lexical
module bindings, not a mutable `exports` object. The branch replaces it with
real ESM exports:

```ts
import { BamlAudio, BamlImage, BamlPdf, BamlVideo } from "./native.js";

export const Image = createBrowserGuard("Image", BamlImage);
export const Audio = createBrowserGuard("Audio", BamlAudio);
export const Pdf = createBrowserGuard("Pdf", BamlPdf);
export const Video = createBrowserGuard("Video", BamlVideo);
```

This preserves the user-facing names while making them valid ESM bindings.

### 5. Generated TypeScript imports are rewritten for ESM consumers

The Rust TypeScript generator already had an ESM transformation that added
`.js` suffixes to relative imports when generating ESM output.

The branch expands that transformation to also touch BAML package internals:

```rust
let is_relative = path.starts_with("./") || path.starts_with("../");
let is_baml_internal = path.starts_with("@boundaryml/baml/");

if is_relative || is_baml_internal {
    // add .js when there is no JS/TS/CSS/JSON/etc extension
}
```

That means generated code changes in this direction:

```ts
import { FieldType } from "@boundaryml/baml/native";
```

to:

```ts
import { FieldType } from "@boundaryml/baml/native.js";
```

The branch's intent is clear: generated ESM should name runtime JavaScript
files, not extensionless TypeScript-era paths.

However, this is also the most suspicious part of the branch in terms of the
module-systems note. Relative imports and package subpath imports have different
rules.

For a relative ESM import, this is correct:

```ts
import { add } from "../lib/math.js";
```

For a package export map, the consumer must import an exact exported key:

```ts
import { FieldType } from "@boundaryml/baml/native";
```

The branch's package export map exposes `./native`, not `./native.js`.
Therefore this generated import:

```ts
import { FieldType } from "@boundaryml/baml/native.js";
```

would require the package to also expose:

```json
{
  "exports": {
    "./native.js": {
      "types": "./native.d.ts",
      "import": "./native.js"
    }
  }
}
```

The branch does not appear to add that export key. So the transformation matches
the intuition for relative Node ESM imports, but may over-apply that intuition
to package subpaths.

## Why Jest changed to Vitest

The TypeScript integration tests move from Jest to Vitest.

Before:

```json
{
  "test": "node --expose-gc ./node_modules/jest/bin/jest.js",
  "devDependencies": {
    "jest": "...",
    "ts-jest": "...",
    "@swc/jest": "..."
  }
}
```

After:

```json
{
  "test": "vitest run --passWithNoTests",
  "devDependencies": {
    "vite": "...",
    "vitest": "..."
  },
  "type": "module"
}
```

This is not part of the runtime package itself. It is test infrastructure that
removes a CommonJS-oriented test runner path.

Jest plus `ts-jest` often compiles TypeScript tests through CommonJS-shaped
transforms unless carefully configured. That can hide ESM problems or introduce
CommonJS problems that real ESM consumers would not see. Vitest/Vite are more
natural for ESM package testing, especially with `type: "module"` test
packages.

The new Vitest config aliases package imports to built files:

```ts
resolve: {
  alias: {
    "@boundaryml/baml": path.join(engineRoot, "index.js"),
    "@boundaryml/baml/native": path.join(engineRoot, "native.js"),
    "@boundaryml/baml/type_builder": path.join(engineRoot, "type_builder.js"),
    "@boundaryml/baml/logging": path.join(engineRoot, "logging.js")
  }
}
```

That keeps the integration tests pointed at the local built runtime package.

## What the ESM smoke tests check

The `integ-tests/typescript-esm` package adds a small import test:

```json
{
  "scripts": {
    "test-import": "node test-import.js && node test-import.mjs && tsx test-import.ts"
  }
}
```

The test files all do:

```ts
import { HTTPRequest } from "@boundaryml/baml";

console.log(typeof HTTPRequest);
```

In terms of the compatibility table, these test the happy paths for an ESM-only
library:

- C2 native ESM JavaScript importing an L2 native ESM package.
- C4-ish TypeScript/ESM execution through `tsx`.

They do not test CommonJS `require("@boundaryml/baml")`, because the branch is
explicitly ESM-only.

## The compatibility move

Before `ts-esm-only`, the package was effectively:

| Item | Shape |
| --- | --- |
| BAML runtime package | L3, TypeScript compiled to CommonJS, plus napi CommonJS wrapper |
| Main consumer path | C1/C3-style CommonJS-compatible loading |
| Relative imports | Extensionless paths were tolerated after CJS emit |
| Export mechanism | `module.exports` / `exports` |
| Tests | Jest/ts-jest, CommonJS-friendly |

After `ts-esm-only`, the intended shape is:

| Item | Shape |
| --- | --- |
| BAML runtime package | L2/L4, native ESM `.js` package with NodeNext TS build |
| Main consumer path | C2/C4/C5 ESM or bundler users |
| Relative imports | Runtime `.js` suffixes |
| Export mechanism | Static ESM `export` bindings |
| Tests | Vitest/Vite, ESM-friendly |

So the practical compatibility shift is:

- R13-style consumers, TypeScript compiled to CommonJS, are no longer the main
  target.
- R7/R9/R19-style consumers, native ESM and TypeScript NodeNext ESM, become the
  main target.
- C1/C3 CommonJS consumers need dynamic `import(...)` or a separate CommonJS
  build, but this branch does not add a dual package.

## Impact on user code importing `@boundaryml/baml`

`engine/language_client_typescript` is the old source for the published Node
package `@boundaryml/baml`. User code normally consumes it through package
imports such as:

```ts
import { BamlRuntime } from "@boundaryml/baml";
import { FieldType } from "@boundaryml/baml/native";
```

or, in CommonJS:

```js
const baml = require("@boundaryml/baml");
```

The important behavior change is that `ts-esm-only` changes the package being
imported. Before the branch, `@boundaryml/baml` was a CommonJS-shaped package.
After the branch, it is intended to be an ESM-only package.

| User codebase                           | Pre-`ts-esm-only` changes                                                                                                      | Post-`ts-esm-only` changes                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CommonJS JavaScript application, C1     | Direct `require("@boundaryml/baml")` worked because the package was CommonJS-shaped.                                           | Direct `require("@boundaryml/baml")` should fail because the package is ESM-only; use async `import("@boundaryml/baml")` or provide a separate CommonJS build. |
| TypeScript compiled to CommonJS, C3     | Source could use `import` syntax, but emitted JavaScript used `require("@boundaryml/baml")`, which worked.                     | Source may still typecheck, but emitted `require("@boundaryml/baml")` is no longer compatible with an ESM-only package.                                        |
| Native ESM JavaScript application, C2   | Imported a CommonJS package through Node's ESM-to-CJS interop; default import was safest, named imports depended on inference. | Static ESM named imports are the intended path and should bind to real ESM exports.                                                                            |
| TypeScript NodeNext ESM application, C4 | TypeScript could look ESM-native, but runtime still crossed into a CommonJS package.                                           | TypeScript, emitted JavaScript, Node resolution, package `exports`, and runtime module format are intended to line up as ESM.                                  |
| TypeScript bundler-mode application, C5 | Bundler handled package resolution and CommonJS interop details.                                                               | Bundler may still smooth over details, but success in bundler mode does not prove the package works in plain Node ESM; package subpath spelling still matters. |

### CommonJS application codebase

This is C1 in the module-systems note, plus C3 if the application is TypeScript
compiled with `module: "commonjs"`.

Typical JavaScript:

```js
const { BamlRuntime } = require("@boundaryml/baml");
```

Typical TypeScript compiled to CommonJS:

```ts
import { BamlRuntime } from "@boundaryml/baml";
```

which emits roughly:

```js
const baml_1 = require("@boundaryml/baml");
```

Pre-change behavior:

- This was the most natural consumer shape.
- The package's `.js` files were CommonJS.
- The package used `module.exports` and `exports`.
- `require("@boundaryml/baml")` could synchronously load the runtime.
- Top-level initialization happened during the `require(...)` call.

Post-change behavior:

- This is no longer directly supported by the package boundary.
- The package export map has `import` entries but no `require` entries.
- The `.js` files are ESM because the package has `"type": "module"`.
- `require("@boundaryml/baml")` should fail rather than synchronously load the
  package.
- CommonJS code must switch to async dynamic import:

```js
async function main() {
  const { BamlRuntime } = await import("@boundaryml/baml");
}
```

That is a real compatibility break for CommonJS applications and for TypeScript
applications that still emit CommonJS.

### Native ESM JavaScript codebase

This is C2 in the module-systems note: `.mjs`, or `.js` in a package with
`"type": "module"`.

Typical code:

```js
import { BamlRuntime } from "@boundaryml/baml";
import { FieldType } from "@boundaryml/baml/native";
```

Pre-change behavior:

- Native ESM was importing a CommonJS package.
- Node can usually import CommonJS from ESM, but the safest shape is a default
  import:

```js
import baml from "@boundaryml/baml";

const { BamlRuntime } = baml;
```

- Named imports from CommonJS can work only when Node can infer them. The old
  emitted package had many `Object.defineProperty(exports, "...")` assignments,
  so some named imports may have worked, but that was CommonJS interop rather
  than true ESM.
- The package's own internal imports were still CommonJS `require(...)`, so
  extensionless internal paths were tolerated.

Post-change behavior:

- Native ESM becomes the primary intended consumer shape.
- Static named imports are real ESM imports:

```js
import { BamlRuntime } from "@boundaryml/baml";
```

- Package subpaths should use the export-map key:

```js
import { FieldType } from "@boundaryml/baml/native";
```

- Relative imports inside the package must include runtime `.js` suffixes, but
  user package imports should follow the package export map.

The caveat is the branch's generator behavior around package subpaths. If
generated user code imports `@boundaryml/baml/native.js`, the package must
export `./native.js`. The branch's package map appears to export `./native`
instead.

### TypeScript NodeNext ESM codebase

This is C4 in the module-systems note: TypeScript using `module: "nodenext"` and
`moduleResolution: "nodenext"` so emitted code follows Node's real ESM rules.

Typical `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext"
  }
}
```

Typical code:

```ts
import { BamlRuntime } from "@boundaryml/baml";
import { FieldType } from "@boundaryml/baml/native";
```

Pre-change behavior:

- TypeScript could typecheck against ESM-shaped `.d.ts` files.
- Runtime still loaded a CommonJS package.
- This meant the source code looked like ESM, but the actual package import was
  ESM-to-CommonJS interop.
- Named imports depended on Node's CommonJS named-export detection and the
  package's declaration shape lining up with runtime behavior.

Post-change behavior:

- This becomes a first-class target.
- TypeScript checks package imports using the `exports` map and `types`
  conditions.
- Runtime loads ESM files through the `import` condition.
- Static named imports line up with real named exports from `index.js`,
  `native.js`, and the other entrypoints.
- Relative imports generated within the user's BAML client must use runtime
  `.js` suffixes when the generated client itself is ESM.

This is the cleanest TypeScript version of the branch's intended world: the
types, emitted JavaScript, Node resolver, and package export map are all meant
to describe the same ESM graph.

### Is this the right taxonomy?

It is a useful taxonomy, but it is not quite complete.

For user code that imports `@boundaryml/baml`, the cleaner taxonomy from
`11-js-ts-module-systems.md` is:

| User codebase                      | Why it matters for `@boundaryml/baml`                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| C1 CommonJS JavaScript             | Direct `require(...)` compatibility.                              |
| C2 native ESM JavaScript           | Direct Node ESM package import behavior.                          |
| C3 TypeScript compiled to CommonJS | Looks like ESM in source, but emits `require(...)`.               |
| C4 TypeScript NodeNext ESM         | TypeScript source and Node runtime both follow ESM rules.         |
| C5 TypeScript bundler mode         | Bundler controls resolution, extension handling, and CJS interop. |

Your three buckets map to important parts of that table:

- "CommonJS application codebase" covers C1 and often C3.
- "Normal ESM codebase" is probably C2, native ESM JavaScript.
- "NodeNext ESM codebase" is C4, TypeScript checked against Node ESM rules.

The missing buckets are:

- TypeScript compiled to CommonJS. This is very common, and it breaks like
  CommonJS after `ts-esm-only` even if the source uses `import` syntax.
- Bundler-mode TypeScript. This may continue to work because Vite, Webpack,
  Rollup, Bun, or esbuild can smooth over extension and interop details, but it
  is not proof that plain Node works.

So the three-bucket taxonomy is good for a high-level explanation, but the
five-bucket C1-C5 taxonomy is better when deciding whether a generated client or
published package is actually compatible with a user's project.

## Why the previous pattern failed for ESM

The previous package had three ESM blockers.

First, the emitted JavaScript was CommonJS:

```js
const native_1 = require("./native");
Object.defineProperty(exports, "BamlRuntime", {
  enumerable: true,
  get: function () {
    return native_1.BamlRuntime;
  }
});
```

That cannot be parsed and evaluated as native ESM after `"type": "module"`.

Second, the native addon wrapper exported through `module.exports`:

```js
module.exports = nativeBinding;
module.exports.BamlRuntime = nativeBinding.BamlRuntime;
```

In native ESM there is no `module.exports`. ESM consumers need real named
exports if they write:

```js
import { BamlRuntime } from "@boundaryml/baml";
```

Third, the source used extensionless local imports:

```ts
export { BamlRuntime } from "./native";
```

That worked after CommonJS emit because `require("./native")` probes for
`native.js`. It does not work as emitted ESM in Node. The emitted import must
name the runtime file:

```ts
export { BamlRuntime } from "./native.js";
```

Together, those blockers mean the old code was only superficially ESM-shaped.
It used TypeScript `import`/`export` syntax, but the runtime package was still
CommonJS. `ts-esm-only` is the branch that tries to make the runtime package
actually ESM-shaped.

## Open concern

The branch correctly distinguishes relative Node ESM imports from CommonJS
extensionless imports, but it appears to blur package subpath exports.

This is correct for local generated files:

```ts
import { x } from "./foo.js";
```

This is correct for the package export map shown in the branch:

```ts
import { FieldType } from "@boundaryml/baml/native";
```

This is only correct if the package also exports `./native.js`:

```ts
import { FieldType } from "@boundaryml/baml/native.js";
```

The diff adds generated imports of `@boundaryml/baml/native.js`, but the package
export map only shows `./native`. If reviving this branch's idea, this should be
resolved deliberately rather than copied as-is.
