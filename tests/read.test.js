// Tests for Model.readScript, the checked reader for the state file and the
// watched plugins' manifests.
//
// Like fetch.test.js these start a shell, because what matters is what the
// script refuses to open: symlinks, hard links, non-regular files, a symlinked
// parent directory, and anything over the ceiling. Every case runs in its own
// temporary directory. The owner check cannot be exercised without root; it is
// the same comparison as the link count, which is.
//
//   node --test tests/

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Model = require("./model.js")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omapluginstats-read-"))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
function scratch() {
  const dir = path.join(root, String(counter++))
  fs.mkdirSync(dir)
  return dir
}

function read(file, max = 100) {
  // The timeout is a backstop: a FIFO the script failed to refuse would block.
  const r = spawnSync("sh", ["-c", Model.readScript, "sh", String(max), file], { encoding: "utf8", timeout: 5000 })
  return { status: r.status, stdout: r.stdout, result: Model.readResult(r.stdout, max) }
}

test("readScript reads a regular file byte for byte, trailing newlines included", () => {
  const file = path.join(scratch(), "manifest.json")
  fs.writeFileSync(file, '{"name":"Ünïcode"}\n\n')
  const r = read(file)
  assert.equal(r.status, 0)
  assert.deepEqual(r.result, { status: "ok", body: '{"name":"Ünïcode"}\n\n' })
})

test("readScript reports an absent file as absent, not refused", () => {
  // A first run has no state file yet, and must be free to create one.
  const r = read(path.join(scratch(), "state.json"))
  assert.equal(r.status, 0)
  assert.equal(r.result.status, "absent")
})

test("readScript refuses a symlink, even one pointing at a valid file", () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, "secret"), "private\n")
  fs.symlinkSync("secret", path.join(dir, "manifest.json"))
  const r = read(path.join(dir, "manifest.json"))
  assert.equal(r.result.status, "refused")
  assert.doesNotMatch(r.stdout, /private/)

  // Dangling: refused as well, rather than read as a first run.
  fs.symlinkSync("nowhere", path.join(dir, "state.json"))
  assert.equal(read(path.join(dir, "state.json")).result.status, "refused")
})

test("readScript refuses a file inside a symlinked directory", () => {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, "elsewhere"))
  fs.writeFileSync(path.join(dir, "elsewhere", "manifest.json"), '{"name":"x"}')
  fs.symlinkSync("elsewhere", path.join(dir, "some.plugin"))
  const r = read(path.join(dir, "some.plugin", "manifest.json"))
  assert.equal(r.result.status, "refused")
})

test("readScript refuses a hard-linked file", () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, "secret"), "private\n")
  fs.linkSync(path.join(dir, "secret"), path.join(dir, "manifest.json"))
  const r = read(path.join(dir, "manifest.json"))
  assert.equal(r.result.status, "refused")
  assert.doesNotMatch(r.stdout, /private/)
})

test("readScript refuses a directory and a FIFO without blocking", () => {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, "manifest.json"))
  assert.equal(read(path.join(dir, "manifest.json")).result.status, "refused")

  const fifo = path.join(scratch(), "state.json")
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0)
  const r = read(fifo)
  assert.equal(r.status, 1)
  assert.equal(r.result.status, "refused")
})

test("readScript allows exactly the ceiling and reports one byte past it as oversize", () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, "exact"), "x".repeat(100))
  assert.deepEqual(read(path.join(dir, "exact")).result, { status: "ok", body: "x".repeat(100) })

  fs.writeFileSync(path.join(dir, "over"), "x".repeat(101))
  const r = read(path.join(dir, "over"))
  assert.equal(r.status, 63)
  assert.equal(r.stdout, "oversize\n")

  fs.writeFileSync(path.join(dir, "huge"), "x".repeat(5_000_000))
  assert.equal(read(path.join(dir, "huge")).stdout, "oversize\n")
})

test("readResult trusts nothing but the documented statuses", () => {
  assert.deepEqual(Model.readResult("ok\n{}", 10), { status: "ok", body: "{}" })
  assert.deepEqual(Model.readResult("ok\n", 10), { status: "ok", body: "" })
  assert.deepEqual(Model.readResult("absent\n", 10), { status: "absent", body: "" })
  assert.deepEqual(Model.readResult("refused\n", 10), { status: "refused", body: "" })
  // Bounded again on this side, whatever produced the text.
  assert.deepEqual(Model.readResult("ok\n" + "x".repeat(11), 10), { status: "oversize", body: "" })
  // A shell that died or timed out says nothing at all.
  assert.equal(Model.readResult("", 10).status, "failed")
  assert.equal(Model.readResult(undefined, 10).status, "failed")
  assert.equal(Model.readResult("{\"watchlist\":[]}", 10).status, "failed")
})

test("stateReadError explains every status that stops the state file loading", () => {
  assert.equal(Model.stateReadError("ok"), "")
  assert.equal(Model.stateReadError("absent"), "")
  for (const status of ["oversize", "refused", "failed"]) {
    assert.match(Model.stateReadError(status), /not being saved/, status)
  }
})

// --- writeScript -----------------------------------------------------------

function write(file, text, max = 100) {
  const r = spawnSync("sh", ["-c", Model.writeScript, "sh", String(max), file, text], { encoding: "utf8", timeout: 5000 })
  return r.status
}

test("writeScript creates the file and its directory, content exact", () => {
  const file = path.join(scratch(), "omarchy", "state.json")
  assert.equal(write(file, '{"a":1}\n'), 0)
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n')
  // Leaves no temporary file behind, and reads back through readScript.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"])
  assert.deepEqual(read(file).result, { status: "ok", body: '{"a":1}\n' })
})

test("writeScript replaces a planted symlink instead of writing through it", () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, "victim"), "precious\n")
  fs.symlinkSync("victim", path.join(dir, "state.json"))
  assert.equal(write(path.join(dir, "state.json"), "{}\n"), 0)
  assert.equal(fs.readFileSync(path.join(dir, "victim"), "utf8"), "precious\n")
  assert.equal(fs.lstatSync(path.join(dir, "state.json")).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), "{}\n")
})

test("writeScript refuses a directory at the path and a symlinked parent", () => {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, "state.json"))
  assert.notEqual(write(path.join(dir, "state.json"), "{}"), 0)
  assert.deepEqual(fs.readdirSync(dir), ["state.json"])
  assert.deepEqual(fs.readdirSync(path.join(dir, "state.json")), [])

  fs.mkdirSync(path.join(dir, "elsewhere"))
  fs.symlinkSync("elsewhere", path.join(dir, "omarchy"))
  assert.notEqual(write(path.join(dir, "omarchy", "state.json"), "{}"), 0)
  assert.deepEqual(fs.readdirSync(path.join(dir, "elsewhere")), [])
})

test("writeScript refuses text over the ceiling and leaves the file alone", () => {
  const file = path.join(scratch(), "state.json")
  fs.writeFileSync(file, "old\n")
  assert.equal(write(file, "x".repeat(101)), 63)
  assert.equal(fs.readFileSync(file, "utf8"), "old\n")
  assert.equal(write(file, "x".repeat(100)), 0)
})

test("manifestName ignores a manifest over the ceiling", () => {
  const padded = '{"name":"Real"}' + " ".repeat(Model.manifestMaxBytes)
  assert.equal(Model.manifestName(padded), "")
  assert.equal(Model.manifestName(padded.slice(0, Model.manifestMaxBytes)), "Real")
})
