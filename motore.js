/* Verbali di cantiere – motore dei dati (versione autonoma, fuori da claude.ai).
 *
 * I dati stanno sul dispositivo (IndexedDB) e ne va una copia nel Google Drive di chi usa l'app, nella cartella
 * «Verbali di cantiere» (sottocartelle «dati», un file JSON per documento, e «file», foto e PDF). Il permesso chiesto
 * a Google è drive.file: l'app vede e tocca solo i file che ha creato lei, non il resto del Drive.
 *
 * All'app offre le stesse funzioni che aveva su claude.ai, così le schermate restano quelle:
 *   window.claude.use("db" | "assets" | "sample" | "downloads")
 * e in più window.MOTORE per impostazioni, accesso a Google, chiave di Claude e importazione.
 */
(function () {
  "use strict";
  var CONF = window.VERBALI_CONF || {};
  var NOME_DB = "verbali-di-cantiere", CARTELLA = CONF.cartella || "Verbali di cantiere";
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var DRIVE = "https://www.googleapis.com/drive/v3", UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  // Claude: libreria ufficiale per JavaScript, versione fissata; modello e parametri della riscrittura degli appunti
  var SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/+esm";
  var MODELLO = "claude-opus-5-5";

  var registro = [];
  function traccia(t) { registro.push(new Date().toISOString().slice(11, 19) + " " + t); if (registro.length > 80) registro.shift(); }
  function errore(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function clone(o) { return o === undefined || o === null ? o : JSON.parse(JSON.stringify(o)); }
  function nuovoId() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function lsGet(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ------------------------------------------------------------------ IndexedDB
  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (ok, ko) {
      var r = indexedDB.open(NOME_DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs", { keyPath: "k" });
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
        if (!d.objectStoreNames.contains("coda")) d.createObjectStore("coda", { keyPath: "id" });   // foto e PDF da mandare o togliere dal Drive
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
    });
    return idbP;
  }
  function richiesta(r) { return new Promise(function (ok, ko) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ko(r.error); }; }); }
  function negozio(nome, modo) { return idb().then(function (d) { return d.transaction(nome, modo || "readonly").objectStore(nome); }); }
  function idbGet(nome, k) { return negozio(nome).then(function (s) { return richiesta(s.get(k)); }); }
  function idbPut(nome, v, k) { return negozio(nome, "readwrite").then(function (s) { return richiesta(k === undefined ? s.put(v) : s.put(v, k)); }); }
  function idbDel(nome, k) { return negozio(nome, "readwrite").then(function (s) { return richiesta(s.delete(k)); }); }
  function idbTutti(nome) { return negozio(nome).then(function (s) { return richiesta(s.getAll()); }); }
  function idbConta(nome) { return negozio(nome).then(function (s) { return richiesta(s.count()); }); }

  // ------------------------------------------------------------------ documenti (stessa forma del database di claude.ai)
  var mem = {};          // "raccolta/id" -> { k, coll, id, data, upd, del, dirty, fid, mt }
  var ascolti = [];
  var memoriaSoltanto = false;
  var pronto = idbTutti("docs").then(function (rr) { rr.forEach(function (r) { mem[r.k] = r; }); }, function (e) {
    memoriaSoltanto = true; console.error("IndexedDB non disponibile", e);
  });

  function snapRaccolta(coll, filtro) {
    var docs = Object.keys(mem).filter(function (k) { var r = mem[k]; return r.coll === coll && !r.del && (!filtro || filtro(r.data || {})); })
      .map(function (k) { var r = mem[k]; return { id: r.id, exists: true, data: function () { return clone(r.data); } }; });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, forEach: function (f) { docs.forEach(f); } };
  }
  function snapDoc(path) {
    var r = mem[path], c = !!(r && !r.del);
    return { id: path.split("/")[1], exists: c, data: function () { return c ? clone(r.data) : undefined; } };
  }
  function avvisa(colls) {
    ascolti.slice().forEach(function (a) {
      if (colls.indexOf(a.coll) < 0) return;
      try { a.cb(a.doc ? snapDoc(a.doc) : snapRaccolta(a.coll, a.filtro)); } catch (e) { console.error(e); }
    });
  }
  function ascolta(a) {
    ascolti.push(a);
    pronto.then(function () { setTimeout(function () { if (ascolti.indexOf(a) >= 0) try { a.cb(a.doc ? snapDoc(a.doc) : snapRaccolta(a.coll, a.filtro)); } catch (e) { console.error(e); } }, 0); });
    return function () { var i = ascolti.indexOf(a); if (i >= 0) ascolti.splice(i, 1); };
  }
  function scrivi(path, data, cancella) {
    var p = String(path).split("/");
    if (p.length !== 2 || !p[0] || !p[1]) return Promise.reject(errore("invalid_argument", "percorso non valido: " + path));
    return pronto.then(function () {
      var r = mem[path] || { k: path, coll: p[0], id: p[1] };
      r.data = cancella ? null : clone(data); r.del = !!cancella; r.dirty = true;
      r.upd = Math.max(Date.now(), (r.upd || 0) + 1);
      mem[path] = r;
      return (memoriaSoltanto ? Promise.resolve() : idbPut("docs", r)).then(function () { avvisa([p[0]]); programma(); });
    });
  }
  function filtroWhere(prec, campo, op, val) {
    return function (d) {
      if (prec && !prec(d)) return false;
      var x = d ? d[campo] : undefined;
      return op === "==" ? x === val : op === "!=" ? x !== val : op === "in" ? (val || []).indexOf(x) >= 0 : false;
    };
  }
  function raccolta(coll, filtro) {
    return {
      onSnapshot: function (cb) { return ascolta({ coll: coll, filtro: filtro, cb: cb }); },
      get: function () { return pronto.then(function () { return snapRaccolta(coll, filtro); }); },
      where: function (campo, op, val) { return raccolta(coll, filtroWhere(filtro, campo, op, val)); }
    };
  }
  var db = {
    collection: function (coll) { return raccolta(coll, null); },
    doc: function (path) {
      return {
        get: function () { return pronto.then(function () { return snapDoc(path); }); },
        set: function (d) { return scrivi(path, d); },
        update: function (d) {
          return pronto.then(function () {
            var r = mem[path]; if (!r || r.del) throw errore("not_found", "documento non trovato");
            var x = clone(r.data) || {}; Object.keys(d || {}).forEach(function (k) { x[k] = d[k]; }); return scrivi(path, x);
          });
        },
        delete: function () { return pronto.then(function () { return mem[path] && !mem[path].del ? scrivi(path, null, true) : undefined; }); },
        onSnapshot: function (cb) { return ascolta({ coll: String(path).split("/")[0], doc: path, cb: cb }); }
      };
    }
  };

  // ------------------------------------------------------------------ foto e PDF (al posto degli asset di claude.ai)
  var urlLocali = {};
  function estensione(tipo) { return { "image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf", "image/webp": ".webp" }[tipo] || ""; }
  var assets = {
    upload: function (blob, opt) {
      var id = nuovoId(), tipo = (opt && opt.type) || blob.type || "application/octet-stream";
      return blob.arrayBuffer().then(function (buf) {
        var rec = { id: id, buf: buf, tipo: tipo, nome: blob.name || "", fid: null, dirty: true, del: false };
        return idbPut("blobs", rec).then(function () { return idbPut("coda", { id: id }); });
      }).then(function () { programma(); return { id: id, url: "_blob/" + id }; });
    },
    delete: function (id) {
      if (!id) return Promise.resolve();
      if (urlLocali[id]) { URL.revokeObjectURL(urlLocali[id]); delete urlLocali[id]; }
      return idbGet("blobs", id).then(function (r) {
        r = r || { id: id, fid: null }; r.buf = null; r.del = true; r.dirty = true;
        return idbPut("blobs", r).then(function () { return idbPut("coda", { id: id }); });
      }).then(function () { programma(); });
    }
  };
  function leggiBlob(id) {
    return idbGet("blobs", id).then(function (r) {
      if (r && r.buf) return new Blob([r.buf], { type: r.tipo || "application/octet-stream" });
      if (r && r.del) throw errore("not_found", "file eliminato");
      return scaricaBlob(id, r);
    });
  }
  // fetch("_blob/<id>") dell'app: risponde dal dispositivo, o dal Drive se il file è stato fatto su un altro dispositivo
  var fetchOriginale = window.fetch.bind(window);
  var RE_BLOB = /(?:^|\/)_blob\/([0-9a-f]{16,64})(?:[?#].*)?$/;
  window.fetch = function (input, init) {
    var u = typeof input === "string" ? input : input && input.url;
    var m = u && RE_BLOB.exec(u);
    if (!m) return fetchOriginale(input, init);
    return leggiBlob(m[1]).then(function (b) { return new Response(b, { status: 200, headers: { "Content-Type": b.type } }); },
      function () { return new Response("", { status: 404 }); });
  };
  // <img src="_blob/<id>">: senza service worker l'immagine non si carica da sola; la si prende qui e si rimette l'indirizzo
  document.addEventListener("error", function (ev) {
    var el = ev.target; if (!el || el.tagName !== "IMG" || el.dataset.vcProvato) return;
    var m = RE_BLOB.exec(el.getAttribute("src") || ""); if (!m) return;
    el.dataset.vcProvato = "1";
    urlBlob(m[1]).then(function (u) { if (u) el.src = u; });
  }, true);
  function urlBlob(id) {
    if (urlLocali[id]) return Promise.resolve(urlLocali[id]);
    return leggiBlob(id).then(function (b) { urlLocali[id] = URL.createObjectURL(b); return urlLocali[id]; }, function () { return null; });
  }

  // ------------------------------------------------------------------ PDF al telefono (al posto di downloads.save)
  var downloads = {
    save: function (r) {
      var nome = r.filename || "verbale.pdf", tipo = (r.data && r.data.type) || "application/pdf";
      var file = new File([r.data], nome, { type: tipo });
      var puo = false; try { puo = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { puo = false; }
      if (puo) return navigator.share({ files: [file], title: nome }).then(function () { return { saved: true }; },
        function (e) { if (e && e.name === "AbortError") throw errore("cancelled", "annullato"); return scarica(file); });
      return Promise.resolve(scarica(file));
    }
  };
  function scarica(file) {
    var u = URL.createObjectURL(file), a = document.createElement("a");
    a.href = u; a.download = file.name; document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
    return { saved: true };
  }

  // ------------------------------------------------------------------ Claude (riscrittura degli appunti)
  var SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["lavorazioni", "programma", "inosservanze", "disposizioni", "note", "avvisi"],
    properties: {
      lavorazioni: { type: "string" }, programma: { type: "string" },
      inosservanze: { type: "array", items: { type: "string" } }, disposizioni: { type: "array", items: { type: "string" } },
      note: { type: "string" }, avvisi: { type: "array", items: { type: "string" } }
    }
  };
  var sdkP = null;
  function sdk() {
    if (!sdkP) sdkP = import(SDK_URL).then(function (m) { return m.default || m.Anthropic; }, function (e) { sdkP = null; throw errore("rete", "libreria di Claude non raggiungibile"); });
    return sdkP;
  }
  var sample = {
    json: function (prompt, opt) {
      var chiave = lsGet("vc:claude") || "";
      if (!chiave) return Promise.reject(errore("no_key", "manca la chiave di Claude"));
      var segnale = opt && opt.signal;
      return sdk().then(function (Anthropic) {
        var client = new Anthropic({ apiKey: chiave, dangerouslyAllowBrowser: true });
        // se il modello declina la richiesta, il servizio la ripete da solo su un altro modello («fallbacks»)
        return client.beta.messages.create({
          model: MODELLO, max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
          messages: [{ role: "user", content: prompt }]
        }, { signal: segnale }).then(function (r) {
          if (r.stop_reason === "refusal") throw errore("refused", "richiesta declinata");
          if (r.stop_reason === "max_tokens") throw errore("invalid_json", "risposta troncata");
          var testo = (r.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
          try { return JSON.parse(testo); } catch (e) { throw errore("invalid_json", "risposta non leggibile"); }
        }, function (e) {
          if (e && e.code) throw e;
          if ((segnale && segnale.aborted) || (Anthropic.APIUserAbortError && e instanceof Anthropic.APIUserAbortError)) throw errore("cancelled", "");
          if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw errore("bad_key", "chiave non valida");
          if (e instanceof Anthropic.RateLimitError) throw errore("rate_limited", "");
          if (e instanceof Anthropic.APIConnectionError) throw errore("rete", "");
          if (e instanceof Anthropic.APIError && e.status === 402) throw errore("credito", "credito esaurito");
          throw errore("api", (e && e.message) || "errore di Claude");
        });
      });
    }
  };

  // ------------------------------------------------------------------ accesso a Google
  var G = lsGet("vc:google") || { token: null, scade: 0, collegato: false, email: "" };
  var stato = { inCorso: false, ultima: lsGet("vc:ultimaSync"), errore: "", daInviare: 0, accesso: "" };
  function salvaG() { lsSet("vc:google", G); idbPut("meta", { token: G.token, scade: G.scade }, "google").catch(function () {}); }
  function tokenValido() { return !!G.token && Date.now() < G.scade - 120000; }
  // ritorno dalla pagina di Google: #access_token=…&expires_in=…&state=…  oppure  #error=…
  (function () {
    var h = location.hash || "";
    if (h.indexOf("access_token=") < 0 && h.indexOf("error=") < 0) return;
    var p = new URLSearchParams(h.slice(1)), atteso = lsGet("vc:statoAccesso");
    if (atteso && p.get("state") === atteso) {
      if (p.get("access_token")) {
        G.token = p.get("access_token"); G.scade = Date.now() + (Number(p.get("expires_in")) || 3600) * 1000; G.collegato = true; salvaG();
      } else stato.accesso = p.get("error") || "errore";
    }
    lsSet("vc:statoAccesso", null);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  })();
  function accedi(silenzioso) {
    if (!CONF.googleClientId) return false;
    var st = nuovoId(); lsSet("vc:statoAccesso", st); lsSet("vc:ultimoTentativo", Date.now());
    var q = new URLSearchParams({ client_id: CONF.googleClientId, redirect_uri: location.origin + location.pathname,
      response_type: "token", scope: SCOPE, include_granted_scopes: "true", state: st });
    if (silenzioso) q.set("prompt", "none");
    if (G.email) q.set("login_hint", G.email);
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q.toString());
    return true;
  }
  function scollega() {
    var t = G.token; G = { token: null, scade: 0, collegato: false, email: "" }; salvaG();
    if (t) fetchOriginale("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }).catch(function () {});
    idbDel("meta", "cartelle").catch(function () {}); idbDel("meta", "ultimoPull").catch(function () {});
    notifica();
  }

  // ------------------------------------------------------------------ Google Drive
  function g(metodo, url, corpo, tipo) {
    if (!tokenValido()) return Promise.reject(errore("auth", "accesso a Google scaduto"));
    var hd = { Authorization: "Bearer " + G.token }; if (tipo) hd["Content-Type"] = tipo;
    return fetchOriginale(url, { method: metodo, headers: hd, body: corpo }).then(function (r) {
      if (r.status === 401) { G.token = null; salvaG(); throw errore("auth", "accesso a Google scaduto"); }
      if (r.status === 404) throw errore("not_found", "file non trovato nel Drive");
      if (!r.ok) return r.text().then(function (t) { throw errore("drive", "Drive " + r.status + ": " + t.slice(0, 160)); });
      return r;
    });
  }
  function gj(metodo, url, corpo, tipo) { return g(metodo, url, corpo, tipo).then(function (r) { return r.status === 204 ? null : r.json(); }); }
  function qs(o) { return new URLSearchParams(o).toString(); }
  function multipart(meta, blob, tipo) {
    var b = "vc" + nuovoId();
    return { corpo: new Blob(["--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
      "\r\n--" + b + "\r\nContent-Type: " + tipo + "\r\n\r\n", blob, "\r\n--" + b + "--"]), tipo: "multipart/related; boundary=" + b };
  }
  function trovaOCrea(nome, padre) {
    var q = "name = '" + nome.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and '" + padre + "' in parents and trashed = false";
    return gj("GET", DRIVE + "/files?" + qs({ q: q, fields: "files(id)", spaces: "drive" })).then(function (r) {
      if (r.files && r.files.length) return r.files[0].id;
      return gj("POST", DRIVE + "/files?fields=id", JSON.stringify({ name: nome, mimeType: "application/vnd.google-apps.folder", parents: [padre] }), "application/json")
        .then(function (x) { return x.id; });
    });
  }
  function cartelle() {
    return idbGet("meta", "cartelle").then(function (c) {
      if (c && c.root && c.dati && c.file) return c;
      return trovaOCrea(CARTELLA, "root").then(function (root) {
        return trovaOCrea("dati", root).then(function (dati) {
          return trovaOCrea("file", root).then(function (file) {
            var c2 = { root: root, dati: dati, file: file };
            return idbPut("meta", c2, "cartelle").then(function () { return c2; });
          });
        });
      });
    });
  }
  function cercaFile(id, c) {
    return gj("GET", DRIVE + "/files?" + qs({ q: "name contains '" + id + "' and '" + c.file + "' in parents and trashed = false", fields: "files(id,name)", spaces: "drive" }))
      .then(function (r) { var f = (r.files || []).filter(function (x) { return x.name.indexOf(id) === 0; })[0]; return f ? f.id : null; });
  }
  function scaricaBlob(id, rec) {
    if (!tokenValido()) return Promise.reject(errore("auth", "file non presente su questo dispositivo"));
    return cartelle().then(function (c) {
      return (rec && rec.fid ? Promise.resolve(rec.fid) : cercaFile(id, c)).then(function (fid) {
        if (!fid) throw errore("not_found", "file non trovato nel Drive");
        return g("GET", DRIVE + "/files/" + fid + "?alt=media").then(function (r) { return r.blob(); }).then(function (b) {
          return b.arrayBuffer().then(function (buf) {
            var nr = { id: id, buf: buf, tipo: b.type || (rec && rec.tipo) || "application/octet-stream", fid: fid, dirty: false, del: false };
            return idbPut("blobs", nr).then(function () { return new Blob([buf], { type: nr.tipo }); });
          });
        });
      });
    });
  }

  function spingiDoc(r, c) {
    var upd = r.upd, corpo = JSON.stringify({ coll: r.coll, id: r.id, upd: r.upd, del: !!r.del, data: r.data });
    var crea = function () {
      var m = multipart({ name: r.coll + "~" + r.id + ".json", parents: [c.dati], mimeType: "application/json" }, new Blob([corpo]), "application/json");
      return gj("POST", UPLOAD + "/files?uploadType=multipart&fields=id,modifiedTime", m.corpo, m.tipo);
    };
    var p = r.fid ? gj("PATCH", UPLOAD + "/files/" + r.fid + "?uploadType=media&fields=id,modifiedTime", corpo, "application/json")
      .then(null, function (e) { if (e.code === "not_found") return crea(); throw e; }) : crea();
    return p.then(function (x) {
      var cur = mem[r.k]; if (!cur) return;
      cur.fid = x.id; cur.mt = x.modifiedTime; if (cur.upd === upd) cur.dirty = false;
      return idbPut("docs", cur);
    });
  }
  function spingiBlob(id, c) {
    return idbGet("blobs", id).then(function (r) {
      if (!r) return idbDel("coda", id);
      if (r.del) {
        return (r.fid ? Promise.resolve(r.fid) : cercaFile(id, c)).then(function (fid) {
          return fid ? g("DELETE", DRIVE + "/files/" + fid).then(null, function (e) { if (e.code !== "not_found") throw e; }) : null;
        }).then(function () { return idbDel("blobs", id); }).then(function () { return idbDel("coda", id); });
      }
      if (!r.dirty) return idbDel("coda", id);
      var m = multipart({ name: id + estensione(r.tipo), parents: [c.file], mimeType: r.tipo }, new Blob([r.buf], { type: r.tipo }), r.tipo);
      return gj("POST", UPLOAD + "/files?uploadType=multipart&fields=id", m.corpo, m.tipo).then(function (x) {
        r.fid = x.id; r.dirty = false; return idbPut("blobs", r);
      }).then(function () { return idbDel("coda", id); });
    });
  }
  function spingiTutto(c) {
    var sporchi = Object.keys(mem).map(function (k) { return mem[k]; }).filter(function (r) { return r.dirty; });
    traccia("spingi: " + sporchi.length + " documenti");
    var seq = Promise.resolve();
    sporchi.forEach(function (r) { seq = seq.then(function () { return spingiDoc(r, c); }); });
    return seq.then(function () { return idbTutti("coda"); }).then(function (coda) {
      traccia("spingi: " + coda.length + " file in coda");
      var s2 = Promise.resolve();
      coda.forEach(function (x) { s2 = s2.then(function () { return spingiBlob(x.id, c); }); });
      return s2;
    });
  }
  function chiaveDaNome(n) { var m = /^([^~]+)~(.+)\.json$/.exec(n || ""); return m ? m[1] + "/" + m[2] : null; }
  function tira(c) {
    traccia("tira: inizio");
    return idbGet("meta", "ultimoPull").then(function (ult) {
      var q = "'" + c.dati + "' in parents and trashed = false";
      if (ult) q += " and modifiedTime > '" + new Date(Date.parse(ult) - 120000).toISOString() + "'";
      var tutti = [];
      var pagina = function (tok) {
        var o = { q: q, fields: "nextPageToken,files(id,name,modifiedTime)", pageSize: "1000", spaces: "drive" }; if (tok) o.pageToken = tok;
        return gj("GET", DRIVE + "/files?" + qs(o)).then(function (r) { tutti = tutti.concat(r.files || []); return r.nextPageToken ? pagina(r.nextPageToken) : tutti; });
      };
      return pagina(null).then(function (fs) {
        traccia("tira: " + fs.length + " file nell'elenco");
        var max = ult, cambiate = {}, seq = Promise.resolve();
        fs.forEach(function (f) {
          if (!max || f.modifiedTime > max) max = f.modifiedTime;
          var loc = mem[chiaveDaNome(f.name)];
          if (loc && loc.fid === f.id && loc.mt === f.modifiedTime) return;    // è l'ultima scrittura fatta da qui
          seq = seq.then(function () {
            return gj("GET", DRIVE + "/files/" + f.id + "?alt=media").then(function (x) {
              if (!x || !x.coll || !x.id) return;
              var key = x.coll + "/" + x.id, cur = mem[key];
              if (cur && (cur.upd || 0) >= (x.upd || 0)) {
                if (!cur.fid) { cur.fid = f.id; cur.mt = f.modifiedTime; return idbPut("docs", cur); }
                return;
              }
              mem[key] = { k: key, coll: x.coll, id: x.id, data: x.del ? null : x.data, del: !!x.del, upd: x.upd || 0, dirty: false, fid: f.id, mt: f.modifiedTime };
              cambiate[x.coll] = true;
              return idbPut("docs", mem[key]);
            }, function (e) { if (e.code !== "not_found") throw e; });
          });
        });
        return seq.then(function () { traccia("tira: scaricati"); return max ? idbPut("meta", max, "ultimoPull") : null; })
          .then(function () { var cc = Object.keys(cambiate); traccia("tira: fine, cambiate " + cc.join(",")); if (cc.length) avvisa(cc); });
      });
    });
  }
  // foto e PDF dei verbali non ancora archiviati, e intestazione: presenti anche su questo dispositivo
  function idNecessari() {
    var ids = {};
    Object.keys(mem).forEach(function (k) {
      var r = mem[k]; if (r.del || !r.data) return;
      if (r.coll === "verbali" && r.data.stato !== "archiviato") {
        (r.data.foto || []).forEach(function (f) { if (f && f.id) ids[f.id] = 1; });
        (r.data.mezzi || []).forEach(function (m) { if (m && m.foto) ids[m.foto] = 1; });
        if (r.data.pdf && r.data.pdf.id) ids[r.data.pdf.id] = 1;
      }
      if (r.coll === "impostazioni") ["testata", "piede"].forEach(function (x) { if (r.data[x]) ids[r.data[x]] = 1; });
    });
    return Object.keys(ids);
  }
  function precarica() {
    traccia("precarica");
    var seq = Promise.resolve();
    idNecessari().forEach(function (id) {
      seq = seq.then(function () { return idbGet("blobs", id).then(function (r) { if (!(r && (r.buf || r.del))) return scaricaBlob(id, r).then(null, function () {}); }); });
    });
    return seq;
  }

  // ------------------------------------------------------------------ sincronizzazione
  var timer = null;
  function notifica() { try { window.dispatchEvent(new CustomEvent("vc:stato", { detail: statoPubblico() })); } catch (e) {} }
  function statoPubblico() {
    return { configurato: !!CONF.googleClientId, collegato: !!G.collegato, tokenValido: tokenValido(), email: G.email || "",
      inCorso: stato.inCorso, ultima: stato.ultima, errore: stato.errore, daInviare: stato.daInviare, accesso: stato.accesso,
      claude: !!lsGet("vc:claude"), memoriaSoltanto: memoriaSoltanto };
  }
  function conteggio() {
    var n = Object.keys(mem).filter(function (k) { return mem[k].dirty; }).length;
    return idbConta("coda").then(function (c) { stato.daInviare = n + c; notifica(); }, function () { stato.daInviare = n; notifica(); });
  }
  function programma(ms) { clearTimeout(timer); timer = setTimeout(sincronizza, ms === undefined ? 4000 : ms); conteggio(); }
  function sincronizza() {
    if (stato.inCorso) { stato.ancora = true; return Promise.resolve(statoPubblico()); }
    if (!CONF.googleClientId || !G.collegato) return conteggio().then(statoPubblico);
    if (!tokenValido()) { stato.errore = "accesso"; return conteggio().then(statoPubblico); }
    stato.inCorso = true; stato.errore = ""; notifica(); traccia("copia: inizio");
    return pronto.then(function () {
      return (G.email ? Promise.resolve() : gj("GET", DRIVE + "/about?fields=user(emailAddress)").then(function (a) { G.email = (a && a.user && a.user.emailAddress) || ""; salvaG(); }, function () {}))
        .then(cartelle);
    }).then(function (c) {
      return spingiTutto(c).then(function () { return tira(c); }).then(function () { return spingiTutto(c); }).then(precarica);
    }).then(function () {
      stato.ultima = new Date().toISOString(); lsSet("vc:ultimaSync", stato.ultima); traccia("copia: fine");
    }, function (e) {
      if (e && e.code === "not_found") idbDel("meta", "cartelle").catch(function () {});
      stato.errore = e && e.code === "auth" ? "accesso" : (e && e.message) || "errore";
      console.warn("sincronizzazione", e); traccia("copia: errore " + ((e && (e.code || e.message)) || e));
    }).then(function () {
      stato.inCorso = false;
      if (stato.ancora) { stato.ancora = false; programma(1500); }
      return conteggio();
    }).then(statoPubblico);
  }
  window.addEventListener("online", function () { programma(800); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") programma(800); });
  setInterval(function () { if (document.visibilityState === "visible") sincronizza(); }, 120000);

  // all'apertura: se l'accesso a Google è scaduto e la rete c'è, lo si rinnova senza chiedere nulla (una volta ogni 2 minuti al massimo)
  function rinnovoAllAvvio() {
    if (!CONF.googleClientId || !G.collegato || tokenValido() || stato.accesso) return false;
    if (Date.now() - (lsGet("vc:ultimoTentativo") || 0) < 120000) return false;
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 3000);
    fetchOriginale(DRIVE + "/about", { signal: ctl.signal, cache: "no-store" }).then(function () { clearTimeout(t); accedi(true); }, function () { clearTimeout(t); });
    return true;
  }

  // ------------------------------------------------------------------ importazione da file (cantieri, libreria, impostazioni)
  // Accetta: un cantiere (con "imprese"), un pacchetto { cantieri: {id: dati}, libreria: {...}, impostazioni: {...} },
  // o un documento singolo { collection, id, data }.
  function importa(testo) {
    var x; try { x = JSON.parse(String(testo).replace(/^﻿/, "")); } catch (e) { return Promise.reject(errore("invalid_json", "il file non è un JSON leggibile")); }
    if (x && x.data && typeof x.data === "object" && !x.imprese && !x.cantieri) x = x.data;
    var scritture = [];
    if (x && x.imprese) scritture.push(["cantieri/" + (x.commessa || x.id || nuovoId().slice(0, 8)), x]);
    if (x && x.cantieri && typeof x.cantieri === "object") Object.keys(x.cantieri).forEach(function (k) { scritture.push(["cantieri/" + k, x.cantieri[k]]); });
    if (x && x.libreria) scritture.push(["libreria/prescrizioni", x.libreria]);
    if (x && x.categorie && !x.imprese) scritture.push(["libreria/prescrizioni", x]);
    if (x && x.impostazioni) scritture.push(["impostazioni/profilo", x.impostazioni]);
    if (!scritture.length) return Promise.reject(errore("vuoto", "nel file non ci sono cantieri né prescrizioni da importare"));
    return scritture.reduce(function (p, w) { return p.then(function () { return scrivi(w[0], w[1]); }); }, Promise.resolve())
      .then(function () { return scritture.map(function (w) { return w[0]; }); });
  }

  // ------------------------------------------------------------------ interfaccia per l'app
  window.claude = {
    use: function (n) {
      var s = { db: db, assets: assets, sample: sample, downloads: downloads }[n] || null;
      return pronto.then(function () { return s; });
    }
  };
  window.MOTORE = {
    stato: statoPubblico,
    accedi: function () { return accedi(false); },
    scollega: scollega,
    sincronizza: function () { clearTimeout(timer); return sincronizza(); },
    rinnovoAllAvvio: rinnovoAllAvvio,
    chiaveClaude: function (k) { if (k === undefined) return lsGet("vc:claude") || ""; lsSet("vc:claude", (k || "").trim() || null); notifica(); },
    importa: importa,
    urlBlob: urlBlob,
    leggiBlob: leggiBlob,
    traccia: function () { return registro.slice(); },
    modello: MODELLO
  };
  pronto.then(function () { conteggio(); if (tokenValido()) programma(300); });
})();
