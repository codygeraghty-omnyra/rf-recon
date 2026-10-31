"use strict";
/* RF Recon (beta), full web version: the PC app's own Python server, run in this browser (Pyodide) for the work you
   keep: missions, captures, the field log, labels, DAS jobs and their files, talk groups, your own layers. shim.js
   starts it the first time one is used, so a plain search never waits for it. Your work is kept in this browser
   (IndexedDB, /rfr) and never sent anywhere; the FCC data is the pack in use. web/webhost.py does the Python side. */
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

let py = null, host = null, boot = null;
const sync = populate => new Promise((ok, no) => py.FS.syncfs(populate, e => e ? no(e) : ok()));

async function start(pack, grantee) {
  py = await loadPyodide({indexURL: PYODIDE});
  await py.loadPackage(["sqlite3", "ssl", "pyodide-http"]);  // ssl: imported (not used here) by the live-ships module
  const files = await (await fetch("py/files.json", {cache: "no-cache"})).json();  // publish.py: the app's Python and reference files
  await Promise.all(files.map(async f => {
    const r = await fetch("py/" + f, {cache: "no-cache"});
    if (!r.ok) throw new Error(`Couldn't load ${f} (${r.status}).`);
    py.FS.mkdirTree("/app/" + f.split("/").slice(0, -1).join("/"));
    py.FS.writeFile("/app/" + f, new Uint8Array(await r.arrayBuffer()));
  }));
  py.FS.mkdirTree("/rfr");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/rfr");
  await sync(true);  // your saved work, back from this browser's storage
  if (pack) py.FS.writeFile("/pack.db", new Uint8Array(pack));
  if (grantee) py.FS.writeFile("/grantee.db", new Uint8Array(grantee));
  py.runPython("import sys; sys.path.insert(0, '/app')");
  host = py.pyimport("webhost");
  await sync(false);
}

onmessage = async ({data: m}) => {
  try {
    if (m.kind === "start") {
      boot = boot || start(m.pack, m.grantee);
      await boot;
      return postMessage({id: m.id, ok: true});
    }
    await boot;
    if (m.kind === "history") {  // the pack's history files, for the history layer (fieldpack.build_history)
      const paths = m.files.map((b, i) => { const p = `/hist${i}.db`; py.FS.writeFile(p, new Uint8Array(b)); return p; });
      host.attach_history(py.toPy(paths));
      return postMessage({id: m.id, ok: true});
    }
    if (m.kind === "grantee") {
      py.FS.writeFile("/grantee.db", new Uint8Array(m.file));
      return postMessage({id: m.id, ok: true});
    }
    const res = host.call(m.method, m.path, m.query || "", m.body ? new Uint8Array(m.body) : null, m.ctype || "");
    const [status, headers, body] = res.toJs({dict_converter: Object.fromEntries});
    res.destroy();
    if (m.method !== "GET") await sync(false);  // keep what changed
    const buf = body.slice().buffer;
    postMessage({id: m.id, ok: true, status, headers, body: buf}, [buf]);
  } catch (e) {
    const lines = String(e && e.message || e).split("\n").filter(l => l.trim() && !l.startsWith("See https://"));
    postMessage({id: m.id, ok: false, error: lines.slice(-1)[0] || "RF Recon's engine stopped"});
  }
};
