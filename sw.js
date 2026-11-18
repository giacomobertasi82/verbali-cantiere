/* Verbali di cantiere – lavoratore di fondo (service worker).
 * Tiene in memoria l'app, i caratteri e le librerie, così si apre anche senza rete in cantiere,
 * e risponde agli indirizzi _blob/<id> (foto e PDF) leggendo dal dispositivo o, se mancano, dal Drive. */
"use strict";
var VERSIONE = "vc-2026-11-18e";
var GUSCIO = ["./", "index.html", "motore.js", "config.js", "manifest.webmanifest",
  "font/LiberationSans-Regular.ttf", "font/LiberationSans-Bold.ttf", "icone/icona-192.png", "icone/icona-512.png", "icone/icona-180.png"];
var ESTERNI = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", function (ev) {
  ev.waitUntil(caches.open(VERSIONE).then(function (c) { return c.addAll(GUSCIO); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (ev) {
  ev.waitUntil(caches.keys().then(function (kk) {
    return Promise.all(kk.filter(function (k) { return k !== VERSIONE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// stesso database dell'app (stessa struttura: chi lo apre per primo lo crea)
function idb() {
  return new Promise(function (ok, ko) {
    var r = indexedDB.open("verbali-di-cantiere", 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs", { keyPath: "k" });
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
      if (!d.objectStoreNames.contains("coda")) d.createObjectStore("coda", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    r.onsuccess = function () { ok(r.result); };
    r.onerror = function () { ko(r.error); };
  });
}
function leggi(store, k) {
  return idb().then(function (d) {
    return new Promise(function (ok, ko) { var q = d.transaction(store).objectStore(store).get(k); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ko(q.error); }; });
  });
}
function scrivi(store, v) {
  return idb().then(function (d) {
    return new Promise(function (ok, ko) { var q = d.transaction(store, "readwrite").objectStore(store).put(v); q.onsuccess = function () { ok(); }; q.onerror = function () { ko(q.error); }; });
  });
}
function dalDrive(id, rec) {
  return Promise.all([leggi("meta", "google"), leggi("meta", "cartelle")]).then(function (x) {
    var tok = x[0], c = x[1];
    if (!tok || !tok.token || Date.now() > tok.scade - 60000) throw new Error("accesso");
    var h = { Authorization: "Bearer " + tok.token };
    var fidP = rec && rec.fid ? Promise.resolve(rec.fid) : !c ? Promise.reject(new Error("cartelle")) :
      fetch("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({ q: "name contains '" + id + "' and '" + c.file + "' in parents and trashed = false", fields: "files(id,name)", spaces: "drive" }), { headers: h })
        .then(function (r) { return r.json(); }).then(function (r) { var f = (r.files || []).filter(function (y) { return y.name.indexOf(id) === 0; })[0]; if (!f) throw new Error("assente"); return f.id; });
    return fidP.then(function (fid) {
      return fetch("https://www.googleapis.com/drive/v3/files/" + fid + "?alt=media", { headers: h }).then(function (r) {
        if (!r.ok) throw new Error("drive " + r.status);
        return r.blob().then(function (b) {
          return b.arrayBuffer().then(function (buf) {
            return scrivi("blobs", { id: id, buf: buf, tipo: b.type, fid: fid, dirty: false, del: false }).then(function () { return new Blob([buf], { type: b.type }); });
          });
        });
      });
    });
  });
}
function rispostaBlob(id) {
  return leggi("blobs", id).then(function (r) {
    if (r && r.buf) return new Blob([r.buf], { type: r.tipo || "application/octet-stream" });
    if (r && r.del) throw new Error("eliminato");
    return dalDrive(id, r);
  }).then(function (b) { return new Response(b, { headers: { "Content-Type": b.type, "Cache-Control": "no-store" } }); },
    function () { return new Response("", { status: 404 }); });
}

self.addEventListener("fetch", function (ev) {
  var req = ev.request; if (req.method !== "GET") return;
  var u = new URL(req.url);
  var m = /\/_blob\/([0-9a-f]{16,64})$/.exec(u.pathname);
  if (m && u.origin === self.location.origin) { ev.respondWith(rispostaBlob(m[1])); return; }
  if (u.origin === self.location.origin) {
    // l'app: dalla rete se risponde entro 4 secondi (così arrivano subito gli aggiornamenti), altrimenti dalla memoria
    // (in cantiere senza segnale si apre lo stesso)
    ev.respondWith(caches.open(VERSIONE).then(function (c) {
      var dallaMemoria = function () {
        return c.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || (req.mode === "navigate" ? c.match("index.html") : null) || new Response("", { status: 504 });
        });
      };
      var rete = fetch(req, { cache: "no-cache" }).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; });
      var tempo = new Promise(function (ok) { setTimeout(function () { ok(null); }, 4000); });
      return Promise.race([rete.then(null, function () { return null; }), tempo]).then(function (r) {
        if (r && r.ok) return r;
        rete.catch(function () {});
        return dallaMemoria();
      });
    }));
    return;
  }
  if (ESTERNI.test(req.url)) {
    ev.respondWith(caches.open(VERSIONE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; });
      });
    }));
  }
  // Google, Claude e tutto il resto: direttamente in rete, senza memoria
});
