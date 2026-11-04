// Run with Node 18+ and the repository's easy-peasy, TypeScript, base64-js and
// date-fns dependencies installed. Native LND/keychain ports are mocked; the
// actual model, easy-peasy store and WebDAV HTTP implementation are exercised.
// To reproduce the original regression without changing the working tree:
// BLIXT_TEST_SOURCE_REF=9192d11cecf1b1a1b4cd2f77604463deda6bfd7a node --test <this-file>
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createStore } = require("easy-peasy");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
function source(file) {
  return process.env.BLIXT_TEST_SOURCE_REF
    ? execFileSync("git", ["show", `${process.env.BLIXT_TEST_SOURCE_REF}:${file}`], {
        cwd: root, encoding: "utf8",
      })
    : fs.readFileSync(path.join(root, file), "utf8");
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadModel(exportBackup) {
  const utilities = {
    unicodeStringToUint8Array: (value) => new TextEncoder().encode(value),
    waitUntilTrue: async () => {}, timeout: delay, toast: () => {},
  };
  const dependencies = {
    "easy-peasy": require("easy-peasy"),
    "base64-js": require("base64-js"),
    "date-fns": require("date-fns"),
    "../utils": utilities,
    "./index": utilities,
    "../utils/build": { Chain: "regtest", Debug: false, Flavor: "" },
    "../storage/app": { StorageItem: {}, getItemObject: async () => 0, setItemObject: async () => {} },
    "../storage/keystore": { getWebDavBackupPassword: async () => "" },
    "react-native-turbo-lnd": {
      exportAllChannelBackups: exportBackup,
      subscribeChannelEvents: () => {},
    },
    "./../utils/log": () => ({ i() {}, d() {}, e() {} }),
  };
  function evaluate(file) {
    const compiled = ts.transpileModule(source(file), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: file,
    }).outputText;
    const module = { exports: {} };
    const requirePort = (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    };
    const fn = vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
      fetch, Response, console, Uint8Array, setTimeout, clearTimeout,
    }, { filename: file });
    fn(requirePort, module, module.exports);
    return module.exports;
  }
  dependencies["../utils/webdav"] = evaluate("src/utils/webdav.ts");
  return evaluate("src/state/WebDavBackup.ts").webDavBackup;
}
function backup(contents) {
  return { multiChanBackup: { multiChanBackup: new Uint8Array(Buffer.from(contents)) } };
}
function storeFor(model, url) {
  return createStore({ settings: { webDavBackupUrl: url, webDavBackupUsername: "" }, webDavBackup: model });
}
async function serve(t, handler) {
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      await handler(req, res, Buffer.from(body, "base64").toString());
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("an overlapping backup cannot overwrite the latest SCB with an older upload", { timeout: 5000 }, async (t) => {
  const oldArrived = deferred(), newArrived = deferred(), releaseOld = deferred();
  let stored = "", exports = 0;
  const writes = [];
  t.after(() => releaseOld.resolve());
  const url = await serve(t, async (_req, res, body) => {
    if (body === "channel-A") { oldArrived.resolve(); await releaseOld.promise; }
    else newArrived.resolve();
    stored = body;
    writes.push(body);
    res.statusCode = 204; res.end();
  });
  const model = loadModel(async () => backup(++exports === 1 ? "channel-A" : "channel-A-and-B"));
  const actions = storeFor(model, url).getActions().webDavBackup;
  const old = actions.makeBackup();
  await oldArrived.promise;
  const latest = actions.makeBackup();
  await turn();
  const exportsWhileBlocked = exports;
  // The unpatched model sends the second PUT while the first is held. The
  // patched model waits, so release the first after this bounded observation.
  await Promise.race([newArrived.promise, delay(150)]);
  releaseOld.resolve();
  await Promise.all([old, latest]);
  assert.equal(stored, "channel-A-and-B", `remote writes: ${writes.join(" -> ")}`);
  assert.equal(exportsWhileBlocked, 1, "export must also wait, not just the HTTP upload");
  assert.deepEqual(writes, ["channel-A", "channel-A-and-B"]);
});

test("a failed upload rejects its caller without poisoning the next backup", { timeout: 5000 }, async (t) => {
  let requests = 0, exports = 0, stored = "";
  const url = await serve(t, async (_req, res, body) => {
    if (++requests === 1) { res.statusCode = 503; res.end("temporarily unavailable"); }
    else { stored = body; res.statusCode = 204; res.end(); }
  });
  const model = loadModel(async () => backup(`snapshot-${++exports}`));
  const actions = storeFor(model, url).getActions().webDavBackup;
  const failed = assert.rejects(actions.makeBackup(), /HTTP 503/);
  const retried = actions.makeBackup();
  await Promise.all([failed, retried]);
  assert.equal(stored, "snapshot-2");
  assert.equal(requests, 2);
});

test("a failed export does not poison the next backup", { timeout: 5000 }, async (t) => {
  let exports = 0, requests = 0;
  const url = await serve(t, async (_req, res, body) => {
    requests++;
    assert.equal(body, "recovered");
    res.statusCode = 204; res.end();
  });
  const model = loadModel(async () => {
    if (++exports === 1) throw new Error("native export unavailable");
    return backup("recovered");
  });
  const actions = storeFor(model, url).getActions().webDavBackup;
  const failed = assert.rejects(actions.makeBackup(), /native export unavailable/);
  await Promise.all([failed, actions.makeBackup()]);
  assert.equal(requests, 1);
});

test("one store's blocked upload does not block another store", { timeout: 5000 }, async (t) => {
  const firstArrived = deferred(), releaseFirst = deferred();
  let exports = 0, secondFinished = false;
  t.after(() => releaseFirst.resolve());
  const url = await serve(t, async (req, res) => {
    if (req.url.startsWith("/first/")) { firstArrived.resolve(); await releaseFirst.promise; }
    else secondFinished = true;
    res.statusCode = 204; res.end();
  });
  const model = loadModel(async () => backup(`snapshot-${++exports}`));
  const first = storeFor(model, `${url}/first`).getActions().webDavBackup.makeBackup();
  await firstArrived.promise;
  const second = storeFor(model, `${url}/second`).getActions().webDavBackup.makeBackup();
  try {
    await Promise.race([second, delay(500).then(() => { throw new Error("second store was blocked"); })]);
    assert.equal(secondFinished, true);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([first, second]);
  }
});
