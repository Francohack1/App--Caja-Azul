/* Caja Fuerte — frontend
   Habla con el backend de Apps Script definido en config.js.
   Sin dependencias: todo es HTML, CSS y JavaScript de navegador. */

(function () {
"use strict";

var CFG = window.CAJA_CONFIG || {};
var DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1, .5, .2, .1, .05, .02, .01];
var MAX_FOTOS = 6;

var S = {
  token: null, nombre: "", tab: "registrar",
  saldo: 0, movimientos: [], arqueos: [], personas: [], categorias: [],
  config: {}, totalMovimientos: 0,
  lineas: [], tipoDefault: "ingreso",
  filtro: { tipo: "todos", categoria: "todas", persona: "todas", q: "" }, verTodo: false,
  conteo: {}, arqueoNota: "", arqueoManual: "",
  pantalla: "cargando", loginErr: "", loginNombre: "", busy: false, ultimaSync: 0,
  pendientes: [], rev: -1
};

/* ================= utilidades ================= */

var $ = function (s) { return document.querySelector(s); };
var fmt = new Intl.NumberFormat(CFG.locale || "es-ES", { style: "currency", currency: CFG.moneda || "EUR" });
var money = function (n) { return fmt.format(Number(n) || 0); };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function parseNum(v) {
  var n = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? n : 0;
}
function iniciales(n) {
  return String(n || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
}
function ls(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch (e) {}
  return null;
}

function fechaDia(ms) {
  var d = new Date(ms), hoy = new Date(), ayer = new Date(Date.now() - 864e5);
  var mismo = function (a, b) { return a.toDateString() === b.toDateString(); };
  if (mismo(d, hoy)) return "Hoy";
  if (mismo(d, ayer)) return "Ayer";
  return d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
}
function hora(ms) { return new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); }
function sello(ms) {
  return new Date(ms).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

var toastT;
function toast(msg) {
  var v = document.querySelector(".toast"); if (v) v.remove();
  var el = document.createElement("div");
  el.className = "toast"; el.textContent = msg; el.setAttribute("role", "status");
  document.body.appendChild(el);
  clearTimeout(toastT); toastT = setTimeout(function () { el.remove(); }, 3400);
}

/* ================= API ================= */

function api(accion, datos) {
  if (!CFG.API || CFG.API.indexOf("PEGA_ACA") === 0) {
    return Promise.reject({ error: "sin_configurar" });
  }
  var cuerpo = Object.assign({ accion: accion, token: S.token, usuario: S.nombre }, datos || {});
  return fetch(CFG.API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(cuerpo)
  }).then(function (r) {
    if (!r.ok) throw { error: "http_" + r.status };
    return r.json();
  }).then(function (j) {
    if (j && j.error === "sesion_invalida") { cerrarSesion(true); throw j; }
    return j;
  });
}

function aplicarEstado(e, desdeCache) {
  if (!e || !e.ok) return;
  S.saldo = e.saldo;
  S.movimientos = e.movimientos || [];
  S.arqueos = e.arqueos || [];
  S.personas = e.personas || [];
  S.categorias = e.categorias || [];
  S.config = e.config || {};
  S.totalMovimientos = e.totalMovimientos || 0;
  if (typeof e.rev === "number") S.rev = e.rev;
  S.ultimaSync = desdeCache ? (e._ts || 0) : Date.now();
  if (!desdeCache) guardarEstadoCache(e);
}

/* El último estado conocido queda en el teléfono: así la app abre y muestra
   saldo e historial aunque no haya señal. */
function guardarEstadoCache(e) {
  try {
    var copia = Object.assign({}, e, { _ts: Date.now() });
    localStorage.setItem("cf_estado", JSON.stringify(copia));
  } catch (err) {
    // Si no entra (historial muy largo), guardamos una versión recortada.
    try {
      localStorage.setItem("cf_estado", JSON.stringify(
        Object.assign({}, e, { _ts: Date.now(), movimientos: (e.movimientos || []).slice(0, 200) })
      ));
    } catch (err2) {}
  }
}
function leerEstadoCache() {
  try { return JSON.parse(localStorage.getItem("cf_estado") || "null"); } catch (e) { return null; }
}

/** ¿El usuario está tipeando ahora mismo? Si sí, no le rehacemos la pantalla. */
function escribiendo() {
  var a = document.activeElement;
  return !!(a && a.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) &&
            a.closest && a.closest("#main"));
}

function refrescarCabecera() {
  var h = document.querySelector("#main header.bar");
  if (h) h.outerHTML = cabeceraHTML();
}

function refrescar() {
  return api("estado").then(function (e) {
    aplicarEstado(e);
    if (escribiendo()) refrescarCabecera(); else render();
  }).catch(function () {});
}

/**
 * Sondeo barato: pregunta solo "¿cambió algo?" leyendo cinco filas del
 * servidor. Solo si el número de revisión cambió se baja el historial entero.
 * Apps Script tiene 90 minutos de ejecución por día: con la consulta completa
 * cada 30 segundos, un teléfono olvidado abierto se comía un cuarto de la cuota.
 */
function comprobarVersion() {
  return api("version").then(function (r) {
    if (!r || !r.ok) return;
    S.ultimaSync = Date.now();
    if (r.rev !== S.rev) return refrescar();
    if (typeof r.saldo === "number" && Math.abs(r.saldo - S.saldo) > 0.005) S.saldo = r.saldo;
    refrescarCabecera();
  }).catch(function () {});
}

/* ================= cola sin conexión =================
   Un lote cargado sin señal se guarda en el teléfono (IndexedDB, que aguanta
   las fotos) y se sube solo cuando vuelve la red. Si IndexedDB no está
   disponible, cae a localStorage y, si tampoco entra, guarda sin las fotos
   avisando al usuario. */

var DB_NOMBRE = "cajafuerte", DB_TIENDA = "cola", _db = null, _sinIDB = false;

function abrirDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise(function (res, rej) {
    if (_sinIDB || !window.indexedDB) return rej(new Error("sin idb"));
    var r;
    try { r = indexedDB.open(DB_NOMBRE, 1); } catch (e) { _sinIDB = true; return rej(e); }
    r.onupgradeneeded = function () {
      if (!r.result.objectStoreNames.contains(DB_TIENDA)) {
        r.result.createObjectStore(DB_TIENDA, { keyPath: "id" });
      }
    };
    r.onsuccess = function () { _db = r.result; res(_db); };
    r.onerror = function () { _sinIDB = true; rej(r.error); };
  });
}

function tienda(modo) {
  return abrirDB().then(function (db) {
    return db.transaction(DB_TIENDA, modo).objectStore(DB_TIENDA);
  });
}
function pedir(req) {
  return new Promise(function (res, rej) {
    req.onsuccess = function () { res(req.result); };
    req.onerror = function () { rej(req.error); };
  });
}

function colaLS() {
  try { return JSON.parse(localStorage.getItem("cf_cola") || "[]"); } catch (e) { return []; }
}
function colaLSEscribir(lista) {
  try { localStorage.setItem("cf_cola", JSON.stringify(lista)); return true; }
  catch (e) { return false; }
}

function colaLeer() {
  return tienda("readonly")
    .then(function (st) { return pedir(st.getAll()); })
    .catch(function () { return colaLS(); });
}

function colaGuardar(lote) {
  return tienda("readwrite")
    .then(function (st) { return pedir(st.put(lote)); })
    .catch(function () {
      var lista = colaLS();
      lista.push(lote);
      if (colaLSEscribir(lista)) return true;
      // No entró con las fotos: reintentamos sin ellas.
      lista[lista.length - 1] = Object.assign({}, lote, {
        items: lote.items.map(function (it) { return Object.assign({}, it, { fotos: [] }); }),
        fotosPerdidas: true
      });
      if (colaLSEscribir(lista)) return "sin_fotos";
      throw new Error("no_cabe");
    });
}

function colaBorrar(id) {
  return tienda("readwrite")
    .then(function (st) { return pedir(st["delete"](id)); })
    .catch(function () {
      colaLSEscribir(colaLS().filter(function (l) { return l.id !== id; }));
    });
}

function cargarPendientes() {
  return colaLeer().then(function (lista) {
    S.pendientes = (lista || []).sort(function (a, b) { return a.tsMs - b.tsMs; });
    return S.pendientes;
  }).catch(function () { S.pendientes = []; });
}

function saldoPendiente() {
  return S.pendientes.reduce(function (acc, lote) {
    return acc + lote.items.reduce(function (a, it) {
      return a + (it.tipo === "ingreso" ? it.monto : -it.monto);
    }, 0);
  }, 0);
}
/** El saldo que ve el usuario: lo del servidor más lo que todavía no subió. */
function saldoVista() { return S.saldo + saldoPendiente(); }

var sincronizando = false;
function sincronizar() {
  if (sincronizando || !S.token || !S.pendientes.length || !navigator.onLine) {
    return Promise.resolve();
  }
  sincronizando = true;
  var lote = S.pendientes[0];

  return api("registrarLote", {
    items: lote.items, tsClienteMs: lote.tsMs, offline: true,
    usuario: lote.usuario, loteCliente: lote.id
  }).then(function (r) {
    sincronizando = false;
    if (r && r.ok) aplicarEstado(r.estado);
    // Si el servidor lo rechazó, igual lo sacamos: si no, tapona la cola para siempre.
    var rechazado = !(r && r.ok);
    return colaBorrar(lote.id).then(cargarPendientes).then(function () {
      render();
      if (rechazado) { toast("El servidor rechazó un movimiento pendiente"); return; }
      if (S.pendientes.length) return sincronizar();
      toast("Movimientos pendientes subidos");
    });
  }).catch(function () {
    sincronizando = false;   // sigue sin red: lo reintentamos más tarde
  });
}

window.addEventListener("online", function () {
  if (S.pantalla === "app") { render(); sincronizar().then(refrescar); }
});
window.addEventListener("offline", function () {
  if (S.pantalla === "app") render();
});

/* ================= imágenes ================= */

function comprimir(file) {
  return new Promise(function (res) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 900, sc = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        var q = .55, out = c.toDataURL("image/jpeg", q);
        while (out.length > 190000 && q > .25) { q -= .08; out = c.toDataURL("image/jpeg", q); }
        res(out);
      };
      img.onerror = function () { res(null); };
      img.src = fr.result;
    };
    fr.onerror = function () { res(null); };
    fr.readAsDataURL(file);
  });
}

/* ================= borrador ================= */

function nuevaLinea() {
  return { id: uid(), tipo: S.tipoDefault, monto: "", categoria: "", concepto: "", destinatario: "", fotos: [] };
}
function guardarBorrador() {
  try {
    ls("cf_draft", JSON.stringify({
      t: S.tipoDefault,
      l: S.lineas.map(function (l) { return Object.assign({}, l, { fotos: [] }); })
    }));
  } catch (e) {}
}
function cargarBorrador() {
  try {
    var d = JSON.parse(ls("cf_draft") || "null");
    if (d && d.l && d.l.length) {
      S.tipoDefault = d.t || "ingreso";
      S.lineas = d.l.map(function (l) { return Object.assign({ fotos: [] }, l, { fotos: [] }); });
      return;
    }
  } catch (e) {}
  S.lineas = [nuevaLinea()];
}

/* ================= arranque ================= */

cargarBorrador();

(function arrancar() {
  if (!CFG.API || CFG.API.indexOf("PEGA_ACA") === 0) { S.pantalla = "sin-config"; render(); return; }
  S.token = ls("cf_token");
  S.nombre = ls("cf_nombre") || "";
  if (!S.token) { S.pantalla = "login"; render(); return; }

  var cache = leerEstadoCache();

  cargarPendientes().then(function () {
    // Con estado guardado abrimos ya, aunque no haya señal, y refrescamos detrás.
    if (cache && cache.ok) { aplicarEstado(cache, true); S.pantalla = "app"; render(); }

    return api("estado").then(function (e) {
      if (e && e.ok) { aplicarEstado(e); S.pantalla = "app"; }
      else if (S.pantalla !== "app") { S.pantalla = "login"; }
      render();
      return sincronizar();
    }).catch(function (err) {
      if (err && err.error === "sesion_invalida") S.pantalla = "login";
      else if (S.pantalla !== "app") S.pantalla = "sin-red";
      render();
    });
  });
})();

setInterval(function () {
  if (S.pantalla === "app" && !S.busy && !document.getElementById("ov") && !document.hidden) {
    sincronizar().then(comprobarVersion);
  }
}, 90000);

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && S.pantalla === "app") sincronizar().then(comprobarVersion);
});

/* ================= render ================= */

function render() {
  var pant = $("#pantalla"), main = $("#main"), nav = $("#nav");

  if (S.pantalla !== "app") {
    nav.classList.add("hidden"); main.classList.add("hidden"); pant.classList.remove("hidden");
    pant.innerHTML = pantallaHTML();
    enlazarPantalla();
    return;
  }

  pant.classList.add("hidden"); main.classList.remove("hidden"); nav.classList.remove("hidden");
  main.innerHTML = cabeceraHTML() + (
    S.tab === "registrar" ? vistaRegistrar() :
    S.tab === "historial" ? vistaHistorial() :
    S.tab === "arqueo"    ? vistaArqueo()    : vistaAjustes()
  );
  Array.prototype.forEach.call(document.querySelectorAll("#nav [data-tab]"), function (b) {
    b.setAttribute("aria-current", String(b.dataset.tab === S.tab));
  });
  enlazarMain();
}

/* ---------- pantallas de acceso ---------- */

function pantallaHTML() {
  if (S.pantalla === "sin-config") {
    return '<div class="card stack center">' +
      '<h1 class="h-lg">Falta conectar el backend</h1>' +
      '<p class="note">Abrí <code>config.js</code> y pegá en <code>API</code> la URL que te dio Apps Script ' +
      'al implementar la aplicación web (termina en <code>/exec</code>).</p></div>';
  }
  if (S.pantalla === "sin-red") {
    return '<div class="card stack center">' +
      '<h1 class="h-lg">No se pudo conectar</h1>' +
      '<p class="note">Revisá la señal del teléfono y volvé a intentar. Nada de lo ya registrado se pierde.</p>' +
      '<button class="btn primary wide" type="button" data-p="reintentar">Reintentar</button></div>';
  }
  if (S.pantalla === "cargando") {
    return '<div class="center"><div class="eyebrow">Caja Azul</div><h1 class="h-lg">Conectando…</h1></div>';
  }

  var recordado = S.loginNombre || ls("cf_nombre") || "";
  return '<div class="center"><div class="eyebrow">Caja Azul</div>' +
    '<h1 class="h-lg">Entrar</h1>' +
    '<p class="note" style="margin-top:6px">Tu nombre queda en cada movimiento que cargues.</p></div>' +
    '<form class="card stack" id="loginForm">' +
      '<div><label class="f" for="lg-nombre">Tu nombre</label>' +
        '<input class="inp" id="lg-nombre" name="nombre" autocomplete="name" required maxlength="40" ' +
        'value="' + esc(recordado) + '" placeholder="Franco"></div>' +
      '<div><label class="f" for="lg-pass">Contraseña de la caja</label>' +
        '<input class="inp" id="lg-pass" name="password" type="password" ' +
        'autocomplete="current-password" required placeholder="••••••"></div>' +
      (S.loginErr ? '<div class="err">' + esc(S.loginErr) + '</div>' : '') +
      '<button class="btn primary wide" type="submit" id="lg-ok"' + (S.busy ? " disabled" : "") + '>' +
        (S.busy ? "Entrando…" : "Entrar") + '</button>' +
      '<p class="note">La contraseña es la misma para todo el equipo. Se comprueba en el servidor: ' +
      'después de varios intentos fallidos el acceso se bloquea y llega un aviso por mail.</p>' +
    '</form>';
}

function enlazarPantalla() {
  var f = $("#loginForm");
  if (f) f.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (S.busy) return;
    var nombre = f.nombre.value.trim(), pass = f.password.value;
    S.loginNombre = nombre;
    if (nombre.length < 2 || !pass) { S.loginErr = "Poné tu nombre y la contraseña."; render(); return; }

    S.busy = true; S.loginErr = ""; render();
    var disp = ls("cf_disp") || uid(); ls("cf_disp", disp);

    fetch(CFG.API, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ accion: "login", nombre: nombre, password: pass, dispositivo: disp })
    }).then(function (r) { return r.json(); }).then(function (j) {
      S.busy = false;
      if (j && j.ok) {
        S.token = j.token; S.nombre = j.nombre; S.loginNombre = "";
        ls("cf_token", j.token); ls("cf_nombre", j.nombre);
        aplicarEstado(j.estado);
        S.pantalla = "app"; S.loginErr = "";
      } else if (j && j.error === "bloqueado") {
        S.loginErr = "Acceso bloqueado por intentos fallidos. Probá de nuevo en " + j.minutos + " minutos.";
      } else if (j && j.error === "password") {
        S.loginErr = "Contraseña incorrecta." + (j.restantes ? " Te quedan " + j.restantes + " intentos." : "");
      } else {
        S.loginErr = "No se pudo entrar. Revisá la conexión.";
      }
      render();
    }).catch(function () {
      S.busy = false; S.loginErr = "No se pudo conectar con el servidor."; render();
    });
  });

  if (f && S.loginErr) {
    var pw = document.getElementById("lg-pass");
    if (pw) { try { pw.focus(); } catch (e) {} }
  }

  var re = document.querySelector('[data-p="reintentar"]');
  if (re) re.addEventListener("click", function () {
    S.pantalla = "cargando"; render();
    api("estado").then(function (e) {
      if (e && e.ok) { aplicarEstado(e); S.pantalla = "app"; } else S.pantalla = "login";
      render();
    }).catch(function () { S.pantalla = "sin-red"; render(); });
  });
}

function cerrarSesion(silencioso) {
  ls("cf_token", null);
  S.token = null; S.pantalla = "login";
  S.loginErr = silencioso ? "La sesión caducó. Volvé a entrar." : "";
  render();
}

/* ---------- cabecera ---------- */

function cabeceraHTML() {
  var saldo = saldoVista();
  var nPend = S.pendientes.reduce(function (a, l) { return a + l.items.length; }, 0);
  var alDia = (Date.now() - S.ultimaSync) < 150000;   // holgura sobre el sondeo de 90 s
  var enLinea = navigator.onLine !== false;

  var clase, texto;
  if (nPend) {
    clase = "bad";
    texto = nPend + (nPend === 1 ? " movimiento sin subir" : " movimientos sin subir");
  } else if (!enLinea) {
    clase = "bad";
    texto = "Sin conexión · mostrando lo último guardado";
  } else if (!alDia) {
    clase = "";
    texto = "Sincronizando…";
  } else {
    clase = "ok";
    texto = S.totalMovimientos + " movimiento" + (S.totalMovimientos === 1 ? "" : "s") + " · al día";
  }

  return '<header class="bar">' +
    '<div class="bar-row"><div>' +
      '<div class="eyebrow">' + esc(S.config.nombreCaja || "Caja Azul") + '</div>' +
      '<div class="saldo-val' + (saldo < 0 ? " neg" : "") + '">' + money(saldo) + '</div>' +
    '</div>' +
    '<button class="whoami" type="button" data-act="perfil">' +
      '<span class="avatar">' + esc(iniciales(S.nombre)) + '</span>' + esc(S.nombre.split(" ")[0]) +
    '</button></div>' +
    '<button class="sync" type="button" data-act="refrescar" title="Tocá para actualizar">' +
      '<span class="dot ' + clase + '"></span>' + esc(texto) +
      '<span class="recargar" aria-hidden="true">↻</span></button>' +
    '</header>';
}

/* ---------- registrar ---------- */

function totales() {
  var ing = 0, ret = 0, n = 0;
  S.lineas.forEach(function (l) {
    var v = parseNum(l.monto);
    if (v > 0) { n++; if (l.tipo === "ingreso") ing += v; else ret += v; }
  });
  return { ing: ing, ret: ret, neto: ing - ret, n: n };
}

function vistaRegistrar() {
  var t = totales(), base = saldoVista();
  return '<div class="section">' +
    (navigator.onLine === false
      ? '<div class="banner" style="margin-bottom:12px">Sin conexión. Podés cargar igual: ' +
        'queda guardado en el teléfono y se sube solo cuando vuelva la señal.</div>' : "") +
    '<div class="seg" role="group" aria-label="Tipo por defecto">' +
      '<button type="button" data-t="ingreso" data-act="deftipo" aria-pressed="' + (S.tipoDefault === "ingreso") + '">Ingreso</button>' +
      '<button type="button" data-t="retiro" data-act="deftipo" aria-pressed="' + (S.tipoDefault === "retiro") + '">Retiro</button>' +
    '</div>' +

    '<div class="stack" style="margin-top:12px">' +
      S.lineas.map(lineaHTML).join("") +
      '<button class="btn wide" type="button" data-act="addlinea">+ Agregar otro monto</button>' +
    '</div>' +

    '<div class="card stack" style="margin-top:14px">' +
      '<dl style="margin:0">' +
        '<div class="tot"><dt>Ingresos</dt><dd class="pos">+' + money(t.ing) + '</dd></div>' +
        '<div class="tot"><dt>Retiros</dt><dd class="neg">−' + money(t.ret) + '</dd></div>' +
        '<div class="tot big"><dt>Saldo después</dt><dd class="' + (base + t.neto < 0 ? "neg" : "") + '">' +
          money(base + t.neto) + '</dd></div>' +
      '</dl>' +
      (base + t.neto < 0
        ? '<div class="banner">El saldo quedaría en negativo. Revisá los montos antes de confirmar.</div>' : "") +
      '<button class="btn primary wide" type="button" data-act="guardar"' +
        ((t.n === 0 || S.busy) ? " disabled" : "") + '>' +
        (S.busy ? "Guardando…" : "Registrar " + (t.n || "") + " movimiento" + (t.n === 1 ? "" : "s")) +
      '</button>' +
      '<p class="note">Se guardan juntos con tu nombre y la hora. El mail con el balance sale solo.</p>' +
    '</div></div>';
}

function lineaHTML(l, i) {
  var cats = (S.categorias.length ? S.categorias : ["Salarios", "Proveedores", "Servicios", "Compras", "Otros"]);
  return '<div class="linea" data-t="' + l.tipo + '">' +
    '<div class="linea-top">' +
      '<button class="tipo-pill" type="button" data-t="' + l.tipo + '" data-act="fliptipo" data-i="' + i + '">' +
        (l.tipo === "ingreso" ? "Ingreso" : "Retiro") + '</button>' +
      '<input class="inp monto-in" id="monto-' + l.id + '" inputmode="decimal" placeholder="0,00" ' +
        'value="' + esc(l.monto) + '" data-act="monto" data-i="' + i + '" aria-label="Monto"> ' +
      (S.lineas.length > 1
        ? '<button class="x-btn" type="button" data-act="dellinea" data-i="' + i + '" aria-label="Quitar">✕</button>' : "") +
    '</div>' +

    '<div class="cats">' + cats.map(function (c) {
      return '<button type="button" data-act="cat" data-i="' + i + '" data-c="' + esc(c) + '" ' +
        'aria-pressed="' + (l.categoria === c) + '">' + esc(c) + '</button>';
    }).join("") + '</div>' +

    '<input class="inp" id="concepto-' + l.id + '" placeholder="Concepto" maxlength="200" ' +
      'value="' + esc(l.concepto) + '" data-act="concepto" data-i="' + i + '" aria-label="Concepto">' +

    (l.categoria === "Salarios" || l.categoria === "Proveedores"
      ? '<input class="inp" id="dest-' + l.id + '" maxlength="80" ' +
        'placeholder="' + (l.tipo === "retiro" ? "Entregado a" : "Recibido de") + '" ' +
        'value="' + esc(l.destinatario) + '" data-act="dest" data-i="' + i + '" aria-label="Persona o empresa">' : "") +

    '<div class="fotos">' +
      l.fotos.map(function (f, j) {
        return '<span class="thumb-wrap"><img class="thumb" src="' + f + '" alt="Foto ' + (j + 1) + '">' +
          '<button class="thumb-x" type="button" data-act="delfoto" data-i="' + i + '" data-j="' + j + '" ' +
          'aria-label="Quitar foto">✕</button></span>';
      }).join("") +
      (l.fotos.length < MAX_FOTOS
        ? '<label class="foto-lbl">📷 ' + (l.fotos.length ? "Otra" : "Foto") +
          '<input type="file" accept="image/*" capture="environment" multiple data-act="foto" data-i="' + i + '"></label>'
        : "") +
    '</div></div>';
}

/* ---------- historial ---------- */

/** Los pendientes se ven en el historial como movimientos normales, marcados. */
function movimientosVista() {
  var pend = [];
  S.pendientes.forEach(function (lote) {
    lote.items.forEach(function (it, j) {
      pend.push({
        id: "pend:" + lote.id + ":" + j, loteCola: lote.id,
        tsMs: lote.tsMs + j, tipo: it.tipo, monto: it.monto,
        categoria: it.categoria || "", concepto: it.concepto || "",
        destinatario: it.destinatario || "", usuario: lote.usuario,
        fotos: [], nFotos: (it.fotos || []).length,
        estado: "activo", version: 1, editadoPor: "", pendiente: true
      });
    });
  });
  return pend.concat(S.movimientos).sort(function (a, b) { return b.tsMs - a.tsMs; });
}

function vistaHistorial() {
  var f = S.filtro;
  var lista = movimientosVista().filter(function (m) {
    return (f.tipo === "todos" || m.tipo === f.tipo)
      && (f.categoria === "todas" || m.categoria === f.categoria)
      && (f.persona === "todas" || m.usuario === f.persona)
      && (!f.q || (m.concepto + " " + m.destinatario).toLowerCase().indexOf(f.q.toLowerCase()) >= 0);
  });

  var TOPE = 120;
  var recortado = !S.verTodo && lista.length > TOPE;
  var restantes = recortado ? lista.length - TOPE : 0;
  if (recortado) lista = lista.slice(0, TOPE);

  var dias = [];
  lista.forEach(function (m) {
    var k = new Date(m.tsMs).toDateString();
    if (!dias.length || dias[dias.length - 1].k !== k) dias.push({ k: k, ms: m.tsMs, items: [] });
    dias[dias.length - 1].items.push(m);
  });

  var cats = S.categorias.length ? S.categorias : [];

  return '<div class="section">' +
    '<div class="section-head"><h2 style="font-size:17px">Historial</h2>' +
      '<button class="btn sm" type="button" data-act="exportar">Descargar CSV</button></div>' +

    '<div class="card stack">' +
      '<input class="inp" id="f-q" placeholder="Buscar en concepto o destinatario" ' +
        'value="' + esc(f.q) + '" data-act="fq" aria-label="Buscar">' +
      '<div class="grid2">' +
        '<select class="inp" id="f-tipo" data-act="ftipo" aria-label="Tipo">' +
          '<option value="todos"' + (f.tipo === "todos" ? " selected" : "") + '>Todos</option>' +
          '<option value="ingreso"' + (f.tipo === "ingreso" ? " selected" : "") + '>Ingresos</option>' +
          '<option value="retiro"' + (f.tipo === "retiro" ? " selected" : "") + '>Retiros</option>' +
        '</select>' +
        '<select class="inp" id="f-cat" data-act="fcat" aria-label="Categoría">' +
          '<option value="todas"' + (f.categoria === "todas" ? " selected" : "") + '>Toda categoría</option>' +
          cats.map(function (c) {
            return '<option value="' + esc(c) + '"' + (f.categoria === c ? " selected" : "") + '>' + esc(c) + '</option>';
          }).join("") +
        '</select>' +
      '</div>' +
      '<select class="inp" id="f-per" data-act="fper" aria-label="Persona">' +
        '<option value="todas"' + (f.persona === "todas" ? " selected" : "") + '>Toda persona</option>' +
        S.personas.map(function (p) {
          return '<option value="' + esc(p) + '"' + (f.persona === p ? " selected" : "") + '>' + esc(p) + '</option>';
        }).join("") +
      '</select>' +
    '</div>' +

    (dias.length ? dias.map(function (d) {
      var ing = d.items.filter(function (m) { return m.tipo === "ingreso" && m.estado !== "anulado"; })
                       .reduce(function (a, m) { return a + m.monto; }, 0);
      var ret = d.items.filter(function (m) { return m.tipo === "retiro" && m.estado !== "anulado"; })
                       .reduce(function (a, m) { return a + m.monto; }, 0);
      // Un día con solo ingresos no necesita mostrar "−0,00 €": ocupa lugar y
      // en pantallas angostas empuja la fecha a dos líneas.
      var partes = [];
      if (ing) partes.push("+" + money(ing));
      if (ret) partes.push("−" + money(ret));
      var resumen = partes.length ? partes.join(" · ")
        : d.items.length + (d.items.length === 1 ? " anulado" : " anulados");
      return '<section class="day"><div class="day-head"><h3>' + esc(fechaDia(d.ms)) + '</h3>' +
        '<div class="num">' + resumen + '</div></div>' +
        d.items.map(function (m) {
          var nf = m.pendiente ? m.nFotos : m.fotos.length;
          return '<button class="mov" type="button" data-t="' + m.tipo + '" data-anulado="' +
            (m.estado === "anulado" ? "si" : "no") + '"' + (m.pendiente ? ' data-pend="si"' : '') +
            ' data-act="vermov" data-id="' + esc(m.id) + '">' +
            '<span class="mk"></span><span class="desc">' +
              '<b>' + esc(m.concepto || (m.tipo === "ingreso" ? "Ingreso" : "Retiro")) +
              (m.categoria ? '<span class="tag">' + esc(m.categoria) + '</span>' : "") +
              (m.pendiente ? '<span class="tag pend">sin subir</span>' : "") + '</b>' +
              '<span>' + hora(m.tsMs) + ' · ' + esc(m.usuario) +
                (m.destinatario ? " · " + esc(m.destinatario) : "") +
                (nf ? " · " + nf + "📎" : "") +
                (m.version > 1 ? " · editado" : "") +
                (m.offline && !m.pendiente ? " · cargado sin conexión" : "") +
                (m.estado === "anulado" ? " · ANULADO" : "") +
              '</span></span>' +
            '<span class="amt">' + (m.tipo === "ingreso" ? "+" : "−") + money(m.monto) + '</span></button>';
        }).join("") + '</section>';
    }).join("") : '<div class="empty">No hay movimientos con ese filtro.</div>') +
    (recortado
      ? '<button class="btn wide" type="button" data-act="vertodo" style="margin-top:16px">' +
        'Ver los ' + restantes + ' movimientos anteriores</button>'
      : "") +
  '</div>';
}

/* ---------- arqueo ---------- */

function contado() {
  if (S.arqueoManual !== "") return parseNum(S.arqueoManual);
  return DENOMS.reduce(function (a, d) { return a + d * (parseInt(S.conteo[d], 10) || 0); }, 0);
}

function vistaArqueo() {
  var esp = saldoVista(), con = contado(), dif = con - esp, ok = Math.abs(dif) < 0.005;
  var sinContar = (con === 0 && S.arqueoManual === "");
  var ult = S.arqueos[0];
  var dias = ult ? Math.floor((Date.now() - ult.tsMs) / 864e5) : null;
  var nPend = S.pendientes.reduce(function (a, l) { return a + l.items.length; }, 0);
  var bloqueado = nPend > 0 || navigator.onLine === false;

  return '<div class="section">' +
    '<div class="section-head"><h2 style="font-size:17px">Arqueo de caja</h2></div>' +

    (bloqueado
      ? '<div class="banner malo" style="margin-bottom:12px">' +
        (nPend
          ? "Hay " + nPend + (nPend === 1 ? " movimiento sin subir" : " movimientos sin subir") +
            ". El arqueo se guarda en el servidor y necesita el saldo definitivo: subilos primero."
          : "El arqueo necesita conexión. Contá el efectivo igual y confirmá cuando vuelva la señal.") +
        '</div>' : "") +

    (dias === null
      ? '<div class="banner" style="margin-bottom:12px">Todavía no se hizo ningún arqueo.</div>'
      : (dias >= 7 ? '<div class="banner" style="margin-bottom:12px">Hace ' + dias +
          ' días que no se cuenta el efectivo.</div>' : "")) +

    '<div class="card stack">' +
      '<dl style="margin:0">' +
        '<div class="tot"><dt>Saldo según la app</dt><dd>' + money(esp) + '</dd></div>' +
        '<div class="tot"><dt>Contado ahora</dt><dd>' + money(con) + '</dd></div>' +
      '</dl>' +
      (sinContar
        ? '<div class="diff-box neutro">' +
            '<span class="eyebrow" style="color:inherit;opacity:.8">Diferencia</span>' +
            '<strong>—</strong>' +
            '<span style="font-size:12.5px;font-weight:600">Contá el efectivo para comparar</span>' +
          '</div>'
        : '<div class="diff-box ' + (ok ? "ok" : "bad") + '">' +
            '<span class="eyebrow" style="color:inherit;opacity:.8">Diferencia</span>' +
            '<strong>' + (dif > 0 ? "+" : "") + money(dif) + '</strong>' +
            '<span style="font-size:12.5px;font-weight:600">' +
              (ok ? "Cuadra" : (dif > 0 ? "Sobra efectivo" : "Falta efectivo")) + '</span>' +
          '</div>') +
      '<button class="btn primary wide" type="button" data-act="arqueo-ok"' +
        ((S.busy || sinContar || bloqueado) ? " disabled" : "") + '>Confirmar arqueo</button>' +
      '<button class="btn wide" type="button" data-act="arqueo-ajuste"' +
        (S.busy ? " disabled" : "") +
        ((ok || sinContar || bloqueado) ? " hidden" : "") + '>' +
        'Confirmar y registrar el ajuste de ' + money(Math.abs(dif)) + '</button>' +
    '</div>' +

    '<div class="section-head" style="margin-top:20px"><h3 style="font-size:14px">Recuento por denominación</h3>' +
      '<button class="btn sm ghost" type="button" data-act="limpiar-conteo">Limpiar</button></div>' +
    '<div class="card stack">' +
      '<div class="denoms">' + DENOMS.map(function (d) {
        return '<label class="denom"><span>' + (d >= 1 ? d + " €" : (Math.round(d * 100)) + " c") + '</span>' +
          '<input inputmode="numeric" placeholder="0" value="' + esc(S.conteo[d] || "") + '" ' +
          'data-act="denom" data-d="' + d + '" aria-label="Cantidad de ' + d + ' euros"></label>';
      }).join("") + '</div>' +
      '<div><label class="f" for="arq-manual">…o escribí el total contado directo</label>' +
        '<input class="inp num" id="arq-manual" inputmode="decimal" placeholder="Total" ' +
        'value="' + esc(S.arqueoManual) + '" data-act="arqmanual"></div>' +
      '<div><label class="f" for="arq-nota">Nota (opcional)</label>' +
        '<input class="inp" id="arq-nota" maxlength="200" placeholder="ej. faltan tickets de proveedor" ' +
        'value="' + esc(S.arqueoNota) + '" data-act="arqnota"></div>' +
    '</div>' +

    '<div class="section-head" style="margin-top:20px"><h3 style="font-size:14px">Arqueos anteriores</h3></div>' +
    (S.arqueos.length ? '<div class="stack">' + S.arqueos.slice(0, 12).map(function (a) {
      var cuadra = Math.abs(a.diferencia) < 0.005;
      return '<div class="card" style="padding:12px">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
        '<div><b style="font-size:14px">' + esc(sello(a.tsMs)) + '</b>' +
          '<div class="note">' + esc(a.usuario) + ' · contó ' + money(a.contado) + ' sobre ' + money(a.esperado) +
          (a.ajusteMovId ? " · ajuste registrado" : "") + '</div>' +
          (a.nota ? '<div class="note" style="margin-top:3px">“' + esc(a.nota) + '”</div>' : "") + '</div>' +
        '<div class="num" style="font-weight:600;color:' + (cuadra ? "var(--in)" : "var(--out)") + '">' +
          (a.diferencia > 0 ? "+" : "") + money(a.diferencia) + '</div></div></div>';
    }).join("") + '</div>' : '<div class="empty">Todavía no se hizo ningún arqueo.</div>') +
  '</div>';
}

/* ---------- ajustes ---------- */

function vistaAjustes() {
  return '<div class="section">' +
    '<div class="section-head"><h2 style="font-size:17px">Ajustes</h2></div>' +

    '<div class="card stack">' +
      '<h3 style="font-size:14px">Avisos por mail</h3>' +
      '<div><label class="f" for="cfg-emails">Destinatarios (separados por coma)</label>' +
        '<input class="inp" id="cfg-emails" placeholder="vos@mail.com, socio@mail.com" ' +
        'value="' + esc(S.config.emails || "") + '"></div>' +
      '<label class="check"><input type="checkbox" id="cfg-aviso"' +
        (S.config.avisoCadaMovimiento ? " checked" : "") + '> Avisar en cada movimiento</label>' +
      '<div><label class="f" for="cfg-limite">Avisar si el saldo supera</label>' +
        '<input class="inp num" id="cfg-limite" inputmode="decimal" placeholder="0 = sin límite" ' +
        'value="' + esc(S.config.limiteAlerta || "") + '"></div>' +
      '<p class="note">Por encima de cierto importe el seguro del local puede no cubrir el efectivo. ' +
      'Poné acá tu tope y te llega un aviso para llevarlo al banco.</p>' +
      '<button class="btn primary wide" type="button" data-act="guardar-config">Guardar avisos</button>' +
      '<button class="btn wide" type="button" data-act="mail-ahora">Mandar el balance ahora</button>' +
    '</div>' +

    (S.pendientes.length
      ? '<div class="card stack" style="margin-top:12px;border-color:var(--warn)">' +
        '<h3 style="font-size:14px">Sin subir</h3>' +
        '<p class="note">Estos lotes están guardados en este teléfono y todavía no llegaron al servidor. ' +
        'Se suben solos cuando haya señal.</p>' +
        S.pendientes.map(function (l) {
          var neto = l.items.reduce(function (a, it) {
            return a + (it.tipo === "ingreso" ? it.monto : -it.monto); }, 0);
          return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;' +
            'padding:8px 0;border-bottom:1px dotted var(--line-strong)">' +
            '<div><b style="font-size:14px">' + l.items.length + ' movimiento' +
              (l.items.length === 1 ? "" : "s") + '</b>' +
              '<div class="note">' + esc(sello(l.tsMs)) + ' · ' + esc(l.usuario) + '</div></div>' +
            '<div class="num" style="font-weight:600">' + (neto >= 0 ? "+" : "") + money(neto) + '</div></div>';
        }).join("") +
        '<button class="btn primary wide" type="button" data-act="subir-cola">Subir ahora</button>' +
        '</div>'
      : "") +

    '<div class="card stack" style="margin-top:12px">' +
      '<h3 style="font-size:14px">Historial y copias</h3>' +
      '<p class="note">Todo vive en tu Google Drive: la hoja de cálculo con los movimientos y una copia ' +
      'en CSV cada madrugada. La app no guarda nada por su cuenta.</p>' +
      '<a class="btn wide" href="' + esc(S.config.carpetaDrive || "#") + '" target="_blank" rel="noopener">' +
        'Abrir la carpeta en Drive ↗</a>' +
      '<button class="btn wide" type="button" data-act="backup">Hacer una copia ahora</button>' +
      '<button class="btn wide" type="button" data-act="exportar">Descargar CSV</button>' +
      '<button class="btn wide" type="button" data-act="ver-auditoria">Ver registro de cambios</button>' +
    '</div>' +

    '<div class="card stack" style="margin-top:12px">' +
      '<h3 style="font-size:14px">Equipo</h3>' +
      '<p class="note">Cualquiera que sepa la contraseña entra poniendo su nombre. Estas son las personas ' +
      'que ya cargaron algo:</p>' +
      '<div class="cats">' + (S.personas.length
        ? S.personas.map(function (p) { return '<button type="button" disabled>' + esc(p) + '</button>'; }).join("")
        : '<span class="note">Todavía nadie.</span>') + '</div>' +
      '<button class="btn wide" type="button" data-act="cambiar-pass">Cambiar la contraseña</button>' +
      '<button class="btn wide danger" type="button" data-act="salir">Cerrar sesión en este teléfono</button>' +
    '</div>' +

    '<p class="note center" style="margin-top:14px">' +
      (S.pendientes.length ? S.pendientes.length + ' lote(s) sin subir · ' : "") +
      S.totalMovimientos + ' movimientos · ' +
      S.arqueos.length + ' arqueo' + (S.arqueos.length === 1 ? "" : "s") + ' · última sincronización ' + hora(S.ultimaSync) + '</p>' +
  '</div>';
}

/* ================= eventos ================= */

var mainEnlazado = false;
function enlazarMain() {
  if (mainEnlazado) return;
  var m = $("#main");
  m.addEventListener("input", alEscribir);
  m.addEventListener("change", alCambiar);
  m.addEventListener("click", alClic);
  mainEnlazado = true;
}

function alEscribir(e) {
  var t = e.target, act = t.dataset.act, i = t.dataset.i;
  if (act === "monto") { S.lineas[i].monto = t.value; guardarBorrador(); refrescarTotales(); }
  else if (act === "concepto") { S.lineas[i].concepto = t.value; guardarBorrador(); }
  else if (act === "dest") { S.lineas[i].destinatario = t.value; guardarBorrador(); }
  else if (act === "fq") { S.filtro.q = t.value; repintarConFoco("f-q"); }
  else if (act === "denom") { S.conteo[t.dataset.d] = t.value; S.arqueoManual = ""; refrescarArqueo(); }
  else if (act === "arqmanual") { S.arqueoManual = t.value; refrescarArqueo(); }
  else if (act === "arqnota") { S.arqueoNota = t.value; }
}

function alCambiar(e) {
  var t = e.target, act = t.dataset.act;
  if (act === "ftipo") { S.filtro.tipo = t.value; render(); }
  else if (act === "fcat") { S.filtro.categoria = t.value; render(); }
  else if (act === "fper") { S.filtro.persona = t.value; render(); }
  else if (act === "foto") {
    var i = t.dataset.i, files = Array.prototype.slice.call(t.files || []);
    if (!files.length) return;
    var libres = MAX_FOTOS - S.lineas[i].fotos.length;
    Promise.all(files.slice(0, libres).map(comprimir)).then(function (res) {
      res.filter(Boolean).forEach(function (d) { S.lineas[i].fotos.push(d); });
      render();
    });
  }
}

function alClic(e) {
  var b = e.target.closest("[data-act]"); if (!b) return;
  var act = b.dataset.act, i = b.dataset.i;

  if (act === "deftipo") {
    S.tipoDefault = b.dataset.t;
    S.lineas.forEach(function (l) { if (!parseNum(l.monto) && !l.concepto) l.tipo = S.tipoDefault; });
    guardarBorrador(); render();
  }
  else if (act === "fliptipo") {
    S.lineas[i].tipo = S.lineas[i].tipo === "ingreso" ? "retiro" : "ingreso";
    guardarBorrador(); render();
  }
  else if (act === "cat") {
    S.lineas[i].categoria = S.lineas[i].categoria === b.dataset.c ? "" : b.dataset.c;
    guardarBorrador(); render();
  }
  else if (act === "addlinea") {
    S.lineas.push(nuevaLinea()); guardarBorrador(); render();
    var ult = S.lineas[S.lineas.length - 1];
    setTimeout(function () { var el = document.getElementById("monto-" + ult.id); if (el) el.focus(); }, 0);
  }
  else if (act === "dellinea") {
    S.lineas.splice(i, 1);
    if (!S.lineas.length) S.lineas = [nuevaLinea()];
    guardarBorrador(); render();
  }
  else if (act === "delfoto") { S.lineas[i].fotos.splice(b.dataset.j, 1); render(); }
  else if (act === "guardar") guardarLote();
  else if (act === "vermov") verMovimiento(b.dataset.id);
  else if (act === "exportar") exportarCSV();
  else if (act === "backup") hacerBackup();
  else if (act === "vertodo") { S.verTodo = true; render(); }
  else if (act === "refrescar") {
    if (navigator.onLine === false) { toast("Sin conexión"); return; }
    toast("Actualizando…");
    sincronizar().then(refrescar);
  }
  else if (act === "subir-cola") {
    if (navigator.onLine === false) { toast("Seguís sin conexión"); return; }
    toast("Subiendo…"); sincronizar();
  }
  else if (act === "mail-ahora") {
    api("mailAhora").then(function (r) {
      toast(r && r.ok ? "Mail enviado" : "No se pudo enviar el mail");
    }).catch(function () { toast("No se pudo enviar el mail"); });
  }
  else if (act === "limpiar-conteo") { S.conteo = {}; S.arqueoManual = ""; render(); }
  else if (act === "arqueo-ok") guardarArqueo(false);
  else if (act === "arqueo-ajuste") guardarArqueo(true);
  else if (act === "guardar-config") guardarConfig();
  else if (act === "cambiar-pass") hojaCambiarPass();
  else if (act === "ver-auditoria") hojaAuditoria();
  else if (act === "perfil") { S.tab = "ajustes"; render(); }
  else if (act === "salir") { ls("cf_nombre", null); cerrarSesion(false); }
}

$("#nav").addEventListener("click", function (e) {
  var b = e.target.closest("[data-tab]"); if (!b) return;
  S.tab = b.dataset.tab; window.scrollTo(0, 0); render();
  // Antes cada toque de pestaña disparaba una consulta completa: 1,5 s de espera
  // para mostrar datos que ya estaban en memoria. El sondeo y el botón de
  // refrescar de la cabecera se encargan de mantenerlo al día.
});

/* actualizaciones parciales, para no perder el foco del teclado */
function refrescarTotales() {
  var t = totales(), base = saldoVista(), dds = document.querySelectorAll("#main .tot dd");
  if (dds.length >= 3) {
    dds[0].textContent = "+" + money(t.ing);
    dds[1].textContent = "−" + money(t.ret);
    dds[2].textContent = money(base + t.neto);
    dds[2].className = base + t.neto < 0 ? "neg" : "";
  }
  var btn = document.querySelector('[data-act="guardar"]');
  if (btn) {
    btn.disabled = t.n === 0 || S.busy;
    btn.textContent = "Registrar " + (t.n || "") + " movimiento" + (t.n === 1 ? "" : "s");
  }
}

function refrescarArqueo() {
  var esp = saldoVista(), con = contado(), dif = con - esp, ok = Math.abs(dif) < 0.005;
  var dds = document.querySelectorAll("#main .tot dd");
  if (dds.length >= 2) dds[1].textContent = money(con);
  var sinContar = (con === 0 && S.arqueoManual === "");
  var caja = document.querySelector(".diff-box");
  if (caja) {
    caja.className = "diff-box " + (sinContar ? "neutro" : (ok ? "ok" : "bad"));
    caja.querySelector("strong").textContent = sinContar ? "—" : (dif > 0 ? "+" : "") + money(dif);
    caja.lastElementChild.textContent = sinContar ? "Contá el efectivo para comparar"
      : (ok ? "Cuadra" : (dif > 0 ? "Sobra efectivo" : "Falta efectivo"));
  }
  var bloqueado = S.pendientes.length > 0 || navigator.onLine === false;
  var bOk = document.querySelector('[data-act="arqueo-ok"]');
  if (bOk) bOk.disabled = S.busy || sinContar || bloqueado;

  var bAj = document.querySelector('[data-act="arqueo-ajuste"]');
  if (bAj) {
    bAj.hidden = ok || sinContar || bloqueado;
    bAj.disabled = S.busy;
    bAj.textContent = "Confirmar y registrar el ajuste de " + money(Math.abs(dif));
  }
}

var repT;
function repintarConFoco(id) {
  clearTimeout(repT);
  repT = setTimeout(function () {
    var el = document.getElementById(id), pos = el ? el.selectionStart : 0;
    render();
    var el2 = document.getElementById(id);
    if (el2) { el2.focus(); try { el2.setSelectionRange(pos, pos); } catch (e) {} }
  }, 240);
}

/* ================= acciones ================= */

function guardarLote() {
  if (S.busy) return;
  var items = S.lineas.map(function (l) {
    return {
      tipo: l.tipo, monto: parseNum(l.monto), categoria: l.categoria,
      concepto: l.concepto, destinatario: l.destinatario, fotos: l.fotos
    };
  }).filter(function (l) { return l.monto > 0; });

  if (!items.length) { toast("Poné al menos un monto"); return; }

  // Siempre a la cola del teléfono, y la subida va por detrás.
  // Apps Script no baja de ~1,5 s por llamada (medido: un `ping` que no hace
  // nada tarda eso), así que esperar la respuesta era regalarle dos segundos de
  // pantalla trabada a la acción que más se repite. El id del lote lo genera el
  // teléfono, así que un reintento nunca duplica.
  encolarLote(items, uid());
}

function encolarLote(items, loteId) {
  S.busy = true; render();
  var lote = { id: loteId || uid(), tsMs: Date.now(), usuario: S.nombre, items: items };

  colaGuardar(lote).then(function (res) {
    return cargarPendientes().then(function () {
      S.busy = false;
      S.lineas = [nuevaLinea()]; ls("cf_draft", null);
      render();
      hojaGuardado(items.length, res === "sin_fotos");
      sincronizar();                 // sube mientras el usuario ya sigue con lo suyo
    });
  }).catch(function () {
    S.busy = false; render();
    toast("El teléfono no tiene espacio para guardarlo. No cierres la app.");
  });
}

function guardarArqueo(conAjuste) {
  if (S.busy) return;
  var detalle = {};
  DENOMS.forEach(function (d) { var c = parseInt(S.conteo[d], 10); if (c > 0) detalle[d] = c; });

  S.busy = true; render();
  api("guardarArqueo", {
    contado: contado(), detalle: detalle, manual: S.arqueoManual !== "",
    nota: S.arqueoNota, registrarAjuste: !!conAjuste
  }).then(function (r) {
    S.busy = false;
    if (r && r.ok) {
      aplicarEstado(r.estado);
      S.conteo = {}; S.arqueoManual = ""; S.arqueoNota = "";
      render();
      toast(Math.abs(r.diferencia) < 0.005 ? "Arqueo guardado: la caja cuadra"
        : (conAjuste ? "Arqueo y ajuste registrados" : "Arqueo guardado con diferencia"));
    } else { render(); toast("No se pudo guardar el arqueo"); }
  }).catch(function () { S.busy = false; render(); toast("No se pudo guardar el arqueo"); });
}

function guardarConfig() {
  var cambios = {
    emails: ($("#cfg-emails") || {}).value || "",
    limiteAlerta: String(parseNum(($("#cfg-limite") || {}).value || 0)),
    avisoCadaMovimiento: ($("#cfg-aviso") || {}).checked ? "si" : "no"
  };
  api("setConfig", { cambios: cambios }).then(function (r) {
    if (r && r.ok) { aplicarEstado(r.estado); render(); toast("Avisos guardados"); }
    else toast("No se pudo guardar");
  }).catch(function () { toast("No se pudo guardar"); });
}

function hacerBackup() {
  toast("Generando la copia…");
  api("backup").then(function (r) {
    if (r && r.ok) { toast("Copia guardada en Drive"); window.open(r.url, "_blank", "noopener"); }
    else toast("No se pudo guardar la copia");
  }).catch(function () { toast("No se pudo guardar la copia"); });
}

function csvLocal() {
  var filas = [["fecha", "hora", "tipo", "monto", "categoria", "concepto", "destinatario",
                "persona", "estado", "editado"]];
  S.movimientos.slice().sort(function (a, b) { return a.tsMs - b.tsMs; }).forEach(function (m) {
    var d = new Date(m.tsMs);
    filas.push([
      d.toLocaleDateString("es-ES"), hora(m.tsMs), m.tipo, String(m.monto).replace(".", ","),
      m.categoria, m.concepto, m.destinatario, m.usuario, m.estado, m.version > 1 ? "si" : "no"
    ]);
  });
  filas.push([]); filas.push(["saldo", String(S.saldo).replace(".", ",")]);
  return "﻿" + filas.map(function (r) {
    return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(";");
  }).join("\r\n");
}

function exportarCSV() {
  var blob = new Blob([csvLocal()], { type: "text/csv;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "caja-azul-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

/* ================= capas ================= */

function hoja(html) {
  cerrarHoja();
  var ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "ov";
  ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
  ov.addEventListener("click", function (e) { if (e.target === ov) cerrarHoja(); });
  document.body.appendChild(ov);
  var c = ov.querySelector("#ov-close");
  if (c) c.addEventListener("click", cerrarHoja);
  return ov;
}
function cerrarHoja() { var o = document.getElementById("ov"); if (o) o.remove(); }
document.addEventListener("keydown", function (e) { if (e.key === "Escape") cerrarHoja(); });

function hojaGuardado(n, sinFotos) {
  var enLinea = navigator.onLine !== false;
  hoja('<div class="center" style="margin-bottom:12px">' +
    '<div class="eyebrow">Guardado</div>' +
    '<h2 style="font-size:20px;margin-top:4px">' + n + ' movimiento' + (n === 1 ? "" : "s") +
    ' registrado' + (n === 1 ? "" : "s") + '</h2></div>' +
    '<dl style="margin:0"><div class="tot big"><dt>Saldo en la caja</dt>' +
    '<dd class="' + (saldoVista() < 0 ? "neg" : "") + '">' + money(saldoVista()) + '</dd></div></dl>' +
    (sinFotos ? '<div class="banner" style="margin-top:12px">No hubo espacio para las fotos, ' +
      'así que se guardó solo el texto. Sacá la foto de nuevo más tarde.</div>' : "") +
    '<p class="note" style="margin:12px 0">' +
      (enLinea
        ? 'Subiendo al servidor; el mail sale en unos segundos. No hace falta esperar.'
        : 'Sin conexión: queda en el teléfono y sube solo cuando vuelva la señal, ' +
          'con la fecha y hora de ahora. Podés cerrar la app.') +
    '</p>' +
    '<button class="btn primary wide" type="button" id="ov-close">Listo</button>');
}

function hojaPendienteDetalle(m) {
  var ov = hoja(
    '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
      '<div><div class="eyebrow">Sin subir · ' + (m.tipo === "ingreso" ? "Ingreso" : "Retiro") +
        (m.categoria ? " · " + esc(m.categoria) : "") + '</div>' +
        '<h2 style="font-size:19px;margin-top:4px">' + esc(m.concepto || "Sin concepto") + '</h2></div>' +
      '<div class="num" style="font-size:20px;font-weight:600;color:' +
        (m.tipo === "ingreso" ? "var(--in)" : "var(--out)") + '">' +
        (m.tipo === "ingreso" ? "+" : "−") + money(m.monto) + '</div></div>' +

    '<div class="banner" style="margin-top:12px">Está guardado en este teléfono y todavía no llegó ' +
    'al servidor. Se sube solo cuando vuelva la conexión.</div>' +

    '<dl style="margin:12px 0 0">' +
      '<div class="tot"><dt>Cargado por</dt><dd class="plano">' + esc(m.usuario) + '</dd></div>' +
      '<div class="tot"><dt>Fecha y hora</dt><dd class="plano">' + esc(sello(m.tsMs)) + '</dd></div>' +
      (m.nFotos ? '<div class="tot"><dt>Fotos</dt><dd class="plano">' + m.nFotos + '</dd></div>' : "") +
    '</dl>' +

    '<div class="stack" style="margin-top:14px">' +
      (navigator.onLine !== false
        ? '<button class="btn primary wide" type="button" data-p="subir">Intentar subirlo ahora</button>' : "") +
      '<button class="btn wide danger" type="button" data-p="tirar">Descartar todo el lote</button>' +
      '<button class="btn ghost wide" type="button" id="ov-close">Cerrar</button>' +
    '</div>');

  var sub = ov.querySelector('[data-p="subir"]');
  if (sub) sub.addEventListener("click", function () {
    this.disabled = true; this.textContent = "Subiendo…";
    sincronizar().then(function () { cerrarHoja(); });
  });

  ov.querySelector('[data-p="tirar"]').addEventListener("click", function () {
    if (!window.confirm("Se descarta el lote entero que quedó sin subir. No se puede deshacer.")) return;
    colaBorrar(m.loteCola).then(cargarPendientes).then(function () {
      cerrarHoja(); render(); toast("Lote descartado");
    });
  });
}

function verMovimiento(id) {
  if (String(id).indexOf("pend:") === 0) {
    var lista = movimientosVista();
    for (var k = 0; k < lista.length; k++) if (lista[k].id === id) { hojaPendienteDetalle(lista[k]); return; }
    return;
  }
  var m = null;
  for (var i = 0; i < S.movimientos.length; i++) if (S.movimientos[i].id === id) { m = S.movimientos[i]; break; }
  if (!m) return;
  var anulado = m.estado === "anulado";

  var ov = hoja(
    '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
      '<div><div class="eyebrow">' + (m.tipo === "ingreso" ? "Ingreso" : "Retiro") +
        (m.categoria ? " · " + esc(m.categoria) : "") + '</div>' +
        '<h2 style="font-size:19px;margin-top:4px">' + esc(m.concepto || "Sin concepto") + '</h2></div>' +
      '<div class="num" style="font-size:20px;font-weight:600;color:' +
        (m.tipo === "ingreso" ? "var(--in)" : "var(--out)") + (anulado ? ";text-decoration:line-through" : "") +
        '">' + (m.tipo === "ingreso" ? "+" : "−") + money(m.monto) + '</div></div>' +

    (anulado ? '<div class="banner malo" style="margin-top:12px">Este movimiento está anulado: ' +
      'no cuenta para el saldo, pero queda en el historial.</div>' : "") +

    '<dl style="margin:12px 0 0">' +
      '<div class="tot"><dt>Cargado por</dt><dd class="plano">' + esc(m.usuario) + '</dd></div>' +
      '<div class="tot"><dt>Fecha y hora</dt><dd class="plano">' + esc(sello(m.tsMs)) + '</dd></div>' +
      (m.destinatario ? '<div class="tot"><dt>' + (m.tipo === "retiro" ? "Entregado a" : "Recibido de") +
        '</dt><dd class="plano">' + esc(m.destinatario) + '</dd></div>' : "") +
      (m.version > 1 ? '<div class="tot"><dt>Editado</dt><dd class="plano">' + esc(m.editadoPor) +
        ' · versión ' + m.version + '</dd></div>' : "") +
    '</dl>' +

    '<div id="ov-fotos" class="stack" style="margin-top:12px">' +
      (m.fotos.length ? '<p class="note">Cargando ' + m.fotos.length + ' foto(s)…</p>' : "") + '</div>' +

    '<div class="stack" style="margin-top:14px">' +
      (anulado
        ? '<button class="btn wide" type="button" data-m="reactivar">Reactivar movimiento</button>'
        : '<button class="btn wide" type="button" data-m="editar">Editar</button>' +
          '<button class="btn wide danger" type="button" data-m="anular">Anular</button>') +
      '<button class="btn ghost wide" type="button" id="ov-close">Cerrar</button>' +
    '</div>');

  var ed = ov.querySelector('[data-m="editar"]');
  if (ed) ed.addEventListener("click", function () { hojaEditar(m); });
  var an = ov.querySelector('[data-m="anular"]');
  if (an) an.addEventListener("click", function () { hojaAnular(m, "anular"); });
  var re = ov.querySelector('[data-m="reactivar"]');
  if (re) re.addEventListener("click", function () { hojaAnular(m, "reactivar"); });

  if (m.fotos.length) {
    Promise.all(m.fotos.map(function (fid) {
      return api("foto", { id: fid }).then(function (r) { return r && r.ok ? r.dataUrl : null; })
        .catch(function () { return null; });
    })).then(function (urls) {
      var box = document.getElementById("ov-fotos");
      if (!box) return;
      var buenas = urls.filter(Boolean);
      box.innerHTML = buenas.length
        ? buenas.map(function (u) {
            return '<img src="' + u + '" alt="Comprobante" ' +
              'style="width:100%;border-radius:10px;border:1px solid var(--line)">';
          }).join("")
        : '<p class="note">Las fotos no se pudieron cargar.</p>';
    });
  }
}

function hojaEditar(m) {
  var cats = S.categorias.length ? S.categorias : ["Salarios", "Proveedores", "Servicios", "Compras", "Otros"];
  var ov = hoja(
    '<h2 style="font-size:18px">Editar movimiento</h2>' +
    '<p class="note" style="margin:6px 0 12px">Queda registrado quién lo cambió, qué cambió y por qué. ' +
    'La versión anterior no se borra.</p>' +
    '<div class="stack">' +
      '<div class="seg" role="group">' +
        '<button type="button" data-e="tipo" data-t="ingreso" aria-pressed="' + (m.tipo === "ingreso") + '">Ingreso</button>' +
        '<button type="button" data-e="tipo" data-t="retiro" aria-pressed="' + (m.tipo === "retiro") + '">Retiro</button>' +
      '</div>' +
      '<div><label class="f" for="ed-monto">Monto</label>' +
        '<input class="inp num" id="ed-monto" inputmode="decimal" value="' + esc(m.monto) + '"></div>' +
      '<div class="cats" id="ed-cats">' + cats.map(function (c) {
        return '<button type="button" data-e="cat" data-c="' + esc(c) + '" aria-pressed="' +
          (m.categoria === c) + '">' + esc(c) + '</button>';
      }).join("") + '</div>' +
      '<div><label class="f" for="ed-concepto">Concepto</label>' +
        '<input class="inp" id="ed-concepto" maxlength="200" value="' + esc(m.concepto) + '"></div>' +
      '<div><label class="f" for="ed-dest">Entregado a / recibido de</label>' +
        '<input class="inp" id="ed-dest" maxlength="80" value="' + esc(m.destinatario) + '"></div>' +
      (m.fotos.length
        ? '<div><span class="f">Fotos adjuntas</span>' +
          '<div class="cats">' + m.fotos.map(function (id, j) {
            return '<button type="button" data-e="foto" data-id="' + esc(id) + '">' +
              '📎 Foto ' + (j + 1) + '</button>';
          }).join("") + '</div>' +
          '<p class="note" style="margin-top:6px">Tocá una para marcarla; se borra al guardar el cambio.</p></div>'
        : "") +
      '<div><label class="f" for="ed-motivo">Motivo del cambio (obligatorio)</label>' +
        '<input class="inp" id="ed-motivo" maxlength="200" placeholder="ej. me equivoqué al tipear el monto"></div>' +
      '<div class="err hidden" id="ed-err"></div>' +
      '<button class="btn primary wide" type="button" id="ed-ok">Guardar el cambio</button>' +
      '<button class="btn wide" type="button" id="ov-close">Cancelar</button>' +
    '</div>');

  var tipo = m.tipo, cat = m.categoria, quitar = [];

  ov.addEventListener("click", function (e) {
    var b = e.target.closest("[data-e]"); if (!b) return;
    if (b.dataset.e === "tipo") {
      tipo = b.dataset.t;
      Array.prototype.forEach.call(ov.querySelectorAll('[data-e="tipo"]'), function (x) {
        x.setAttribute("aria-pressed", String(x.dataset.t === tipo));
      });
    } else if (b.dataset.e === "cat") {
      cat = (cat === b.dataset.c) ? "" : b.dataset.c;
      Array.prototype.forEach.call(ov.querySelectorAll('[data-e="cat"]'), function (x) {
        x.setAttribute("aria-pressed", String(x.dataset.c === cat));
      });
    } else if (b.dataset.e === "foto") {
      var id = b.dataset.id, i = quitar.indexOf(id);
      if (i < 0) quitar.push(id); else quitar.splice(i, 1);
      b.classList.toggle("quitar", quitar.indexOf(id) >= 0);
    }
  });

  ov.querySelector("#ed-ok").addEventListener("click", function () {
    var err = ov.querySelector("#ed-err");
    var motivo = ov.querySelector("#ed-motivo").value.trim();
    var monto = parseNum(ov.querySelector("#ed-monto").value);
    if (!motivo) { err.textContent = "Escribí por qué lo cambiás."; err.classList.remove("hidden"); return; }
    if (!(monto > 0)) { err.textContent = "El monto tiene que ser mayor que cero."; err.classList.remove("hidden"); return; }

    this.disabled = true; this.textContent = "Guardando…";
    api("editarMov", {
      id: m.id, tipo: tipo, monto: monto, categoria: cat,
      concepto: ov.querySelector("#ed-concepto").value,
      destinatario: ov.querySelector("#ed-dest").value, motivo: motivo,
      fotosQuitar: quitar
    }).then(function (r) {
      if (r && r.ok) { aplicarEstado(r.estado); cerrarHoja(); render(); toast("Movimiento editado y registrado"); }
      else { err.textContent = "No se pudo guardar."; err.classList.remove("hidden"); }
    }).catch(function () { err.textContent = "No se pudo conectar."; err.classList.remove("hidden"); });
  });
}

function hojaAnular(m, modo) {
  var anular = modo === "anular";
  var ov = hoja(
    '<h2 style="font-size:18px">' + (anular ? "Anular movimiento" : "Reactivar movimiento") + '</h2>' +
    '<p class="note" style="margin:6px 0 12px">' +
    (anular
      ? "El movimiento no se borra: deja de contar para el saldo y queda marcado como anulado, con tu nombre y el motivo."
      : "Vuelve a contar para el saldo. También queda registrado.") + '</p>' +
    '<div class="stack">' +
      '<div class="card" style="padding:12px">' +
        '<b>' + esc(m.concepto || "Sin concepto") + '</b>' +
        '<div class="note">' + (m.tipo === "ingreso" ? "+" : "−") + money(m.monto) + ' · ' +
          esc(sello(m.tsMs)) + ' · ' + esc(m.usuario) + '</div></div>' +
      '<div><label class="f" for="an-motivo">Motivo (obligatorio)</label>' +
        '<input class="inp" id="an-motivo" maxlength="200" placeholder="ej. cargado dos veces por error"></div>' +
      '<div class="err hidden" id="an-err"></div>' +
      '<button class="btn wide ' + (anular ? "danger" : "primary") + '" type="button" id="an-ok">' +
        (anular ? "Anular" : "Reactivar") + '</button>' +
      '<button class="btn wide" type="button" id="ov-close">Cancelar</button>' +
    '</div>');

  ov.querySelector("#an-ok").addEventListener("click", function () {
    var err = ov.querySelector("#an-err");
    var motivo = ov.querySelector("#an-motivo").value.trim();
    if (!motivo) { err.textContent = "Escribí el motivo."; err.classList.remove("hidden"); return; }
    this.disabled = true; this.textContent = "Guardando…";
    api("anularMov", { id: m.id, motivo: motivo }).then(function (r) {
      if (r && r.ok) {
        aplicarEstado(r.estado); cerrarHoja(); render();
        toast(anular ? "Movimiento anulado" : "Movimiento reactivado");
      } else { err.textContent = "No se pudo guardar."; err.classList.remove("hidden"); }
    }).catch(function () { err.textContent = "No se pudo conectar."; err.classList.remove("hidden"); });
  });
}

function hojaCambiarPass() {
  var ov = hoja(
    '<h2 style="font-size:18px">Cambiar la contraseña</h2>' +
    '<p class="note" style="margin:6px 0 12px">Es la misma para todo el equipo. Al cambiarla se cierran ' +
    'todas las sesiones abiertas y cada uno tiene que volver a entrar con la nueva.</p>' +
    '<div class="stack">' +
      '<div><label class="f" for="cp-act">Contraseña actual</label>' +
        '<input class="inp" id="cp-act" type="password" autocomplete="current-password"></div>' +
      '<div><label class="f" for="cp-new">Contraseña nueva</label>' +
        '<input class="inp" id="cp-new" type="password" autocomplete="new-password"></div>' +
      '<div class="err hidden" id="cp-err"></div>' +
      '<button class="btn primary wide" type="button" id="cp-ok">Guardar</button>' +
      '<button class="btn wide" type="button" id="ov-close">Cancelar</button>' +
    '</div>');

  ov.querySelector("#cp-ok").addEventListener("click", function () {
    var err = ov.querySelector("#cp-err");
    var act = ov.querySelector("#cp-act").value, nue = ov.querySelector("#cp-new").value;
    if (nue.length < 4) { err.textContent = "La nueva tiene que tener al menos 4 caracteres."; err.classList.remove("hidden"); return; }
    this.disabled = true;
    api("setConfig", { passwordActual: act, passwordNueva: nue }).then(function (r) {
      if (r && r.ok) { cerrarHoja(); toast("Contraseña cambiada. Volvé a entrar."); cerrarSesion(false); }
      else if (r && r.error === "password_actual") {
        err.textContent = "La contraseña actual no coincide."; err.classList.remove("hidden");
      } else { err.textContent = "No se pudo cambiar."; err.classList.remove("hidden"); }
    }).catch(function () { err.textContent = "No se pudo conectar."; err.classList.remove("hidden"); });
  });
}

function hojaAuditoria() {
  var ov = hoja('<h2 style="font-size:18px">Registro de cambios</h2>' +
    '<p class="note" style="margin:6px 0 12px">Todo lo que pasó en la caja: altas, ediciones, ' +
    'anulaciones, arqueos, intentos de acceso y cambios de configuración.</p>' +
    '<div id="aud-lista"><p class="note">Cargando…</p></div>' +
    '<button class="btn wide" type="button" id="ov-close" style="margin-top:12px">Cerrar</button>');

  var ETIQUETAS = {
    alta_lote: "Registró movimientos", edicion: "Editó un movimiento",
    anulacion: "Anuló un movimiento", reactivacion: "Reactivó un movimiento",
    arqueo: "Hizo un arqueo", backup: "Copia de seguridad",
    login: "Entró a la app", login_fallido: "Contraseña incorrecta",
    login_bloqueado: "Intento con el acceso bloqueado",
    cambio_password: "Cambió la contraseña", cambio_config: "Cambió los ajustes",
    alta_persona: "Alta de persona"
  };

  api("auditoria", { limite: 150 }).then(function (r) {
    var box = ov.querySelector("#aud-lista");
    if (!box) return;
    if (!r || !r.ok || !r.filas.length) { box.innerHTML = '<p class="note">Sin registros todavía.</p>'; return; }

    box.innerHTML = r.filas.map(function (a) {
      var peligro = a.accion.indexOf("login_f") === 0 || a.accion === "login_bloqueado";
      var cambio = "";
      if (a.accion === "edicion") {
        try {
          var A = JSON.parse(a.antes || "{}"), B = JSON.parse(a.despues || "{}");
          cambio = Object.keys(B).filter(function (k) { return String(A[k]) !== String(B[k]); })
            .map(function (k) { return k + ": " + (A[k] || "—") + "  →  " + (B[k] || "—"); }).join("\n");
        } catch (e) {}
      }
      return '<div class="aud">' +
        '<b style="color:' + (peligro ? "var(--out)" : "inherit") + '">' +
          esc(ETIQUETAS[a.accion] || a.accion) + '</b>' +
        '<div class="note">' + esc(sello(a.tsMs)) + ' · ' + esc(a.usuario) + '</div>' +
        (a.detalle ? '<div class="note" style="margin-top:2px">' + esc(a.detalle) + '</div>' : "") +
        (cambio ? '<div class="cambio">' + esc(cambio) + '</div>' : "") +
      '</div>';
    }).join("");
  }).catch(function () {
    var box = ov.querySelector("#aud-lista");
    if (box) box.innerHTML = '<p class="note">No se pudo cargar el registro.</p>';
  });
}

})();
