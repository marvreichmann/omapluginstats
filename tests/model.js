// Loads Model.js for the test runner.
//
// Model.js is a QML `.pragma library`: plain JavaScript with no QML imports and
// no dependencies beyond the standard globals, which is exactly what makes it
// the file worth testing. It has no export statement, so rather than keeping a
// list of names in step here, its top-level declarations are collected and
// returned — a function added to Model.js is testable without touching this
// file.
//
// It is evaluated in *this* realm rather than a vm sandbox on purpose: an array
// built in another realm has another realm's Array.prototype, and every
// deepEqual against it fails while printing two values that look identical.
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  // Meaningful to the QML engine, a syntax error to everything else.
  .replace(/^\s*\.pragma\s+library\s*$/m, "")

const declarations = [...source.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1])

const factory = vm.runInThisContext(
  `(function () {\n${source}\nreturn { ${declarations.join(", ")} }\n})`,
  { filename: "Model.js" }
)

module.exports = factory()
