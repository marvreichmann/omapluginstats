// Tests for Model.fetchScript, the shell wrapper both fetches run through.
//
// Unlike model.test.js these do start a shell, because the script's whole job
// is what it lets out of one: a hard byte ceiling on the download and on what
// it hands to QML, failing closed on either. `curl` is replaced by a stub on
// PATH that prints $FAKE_BODY and exits $FAKE_EXIT, so nothing touches the
// network. Run with the rest of the suite:
//
//   node --test tests/

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Model = require("./model.js")

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "omapluginstats-fetch-"))
fs.writeFileSync(path.join(stubDir, "curl"), [
  "#!/bin/sh",
  'if [ -n "$FAKE_ARGS" ]; then printf "%s\\n" "$@" > "$FAKE_ARGS"; fi',
  // A file for bodies too large for an environment variable (128 KB on Linux).
  'if [ -n "$FAKE_BODY_FILE" ]; then cat "$FAKE_BODY_FILE"; else printf "%s" "$FAKE_BODY"; fi',
  'exit "${FAKE_EXIT:-0}"'
].join("\n") + "\n", { mode: 0o755 })

test.after(() => fs.rmSync(stubDir, { recursive: true, force: true }))

// Each run gets its own TMPDIR so a test can check the script cleaned up.
function run({ download = 100, output = 100, pattern = "", body = "", bodyFile = "", exit = 0, args = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(stubDir, "tmp-"))
  const argsFile = path.join(stubDir, "args-" + path.basename(tmp))
  const result = spawnSync("sh", ["-c", Model.fetchScript, "sh",
    String(download), String(output), pattern, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      TMPDIR: tmp,
      FAKE_BODY: body,
      FAKE_BODY_FILE: bodyFile,
      FAKE_EXIT: String(exit),
      FAKE_ARGS: argsFile
    }
  })
  return {
    status: result.status,
    stdout: result.stdout,
    leftovers: fs.readdirSync(tmp),
    curlArgs: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").split("\n").slice(0, -1) : []
  }
}

test("fetchScript passes a body within the ceiling through untouched", () => {
  const r = run({ body: '{"plugins":{}}\n' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '{"plugins":{}}\n')
  assert.deepEqual(r.leftovers, [])
})

test("fetchScript allows exactly the ceiling and fails closed one byte past it", () => {
  const exact = run({ download: 10, output: 10, body: "x".repeat(10) })
  assert.equal(exact.status, 0)
  assert.equal(exact.stdout, "x".repeat(10))

  const over = run({ download: 10, output: 10, body: "x".repeat(11) })
  assert.equal(over.status, 63)
  assert.equal(over.stdout, "")
  assert.deepEqual(over.leftovers, [])
})

test("fetchScript stops reading a stream far larger than the ceiling", () => {
  const bodyFile = path.join(stubDir, "flood")
  fs.writeFileSync(bodyFile, "x".repeat(5_000_000))
  const r = run({ download: 1000, output: 1000, bodyFile })
  assert.equal(r.status, 63)
  assert.equal(r.stdout, "")
})

test("fetchScript hands over nothing when curl fails, even with output", () => {
  // A partial body followed by a timeout must not reach the parser.
  const r = run({ body: '{"plugins":{"a"', exit: 28 })
  assert.equal(r.status, 28)
  assert.equal(r.stdout, "")
  assert.deepEqual(r.leftovers, [])
})

test("fetchScript filters with grep and caps what grep produces", () => {
  const body = ['  "id": "a.b",', '  "name": "x",', '  "listedAt": "2026-01-01",', ""].join("\n")
  const pattern = '^[[:space:]]*"(id|listedAt)": '
  const kept = run({ pattern, body })
  assert.equal(kept.status, 0)
  assert.equal(kept.stdout, '  "id": "a.b",\n  "listedAt": "2026-01-01",\n')

  // The download fits, but more matching lines come out than may be handed on.
  const flood = '  "id": "a.b",\n'.repeat(50)
  const r = run({ download: 10_000, output: 100, pattern, body: flood })
  assert.equal(r.status, 63)
  assert.equal(r.stdout, "")
})

test("fetchScript gives curl the ceiling and the caller's arguments verbatim", () => {
  const r = run({ download: 4096, body: "{}", args: ["-H", "Accept: application/json", "https://example.test/x?a=1&b=2"] })
  assert.equal(r.status, 0)
  // The header with a space in it arrives as one argument, not two.
  assert.deepEqual(r.curlArgs, ["--max-filesize", "4096", "-H", "Accept: application/json", "https://example.test/x?a=1&b=2"])
})
