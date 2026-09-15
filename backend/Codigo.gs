/**
 * Caja Fuerte — backend en Google Apps Script
 * =================================================================
 * Base de datos: la propia hoja de cálculo que contiene este script.
 * Fotos y copias: carpetas en tu Google Drive.
 * Avisos: tu propio Gmail (MailApp).
 *
 * Instalación: mirá el README del repo. En resumen:
 *   1. Ejecutá instalar() una vez desde el editor.
 *   2. Implementar > Nueva implementación > Aplicación web
 *      · Ejecutar como: Yo
 *      · Quién tiene acceso: Cualquier usuario
 *   3. Copiá la URL /exec y pegala en config.js del frontend.
 * =================================================================
 */

var HOJAS = {
  MOV: 'Movimientos',
  ARQ: 'Arqueos',
  AUD: 'Auditoria',
  CFG: 'Config',
  PER: 'Personas'
};

var COLS = {
  MOV: ['id','tsISO','tsMs','tipo','monto','categoria','concepto','destinatario',
        'usuario','loteId','fotos','estado','version','editadoPor','editadoTsISO',
        'tsServidorISO','offline'],
  ARQ: ['id','tsISO','tsMs','usuario','esperado','contado','diferencia','detalle',
        'manual','nota','ajusteMovId'],
  AUD: ['tsISO','tsMs','usuario','accion','entidad','entidadId','antes','despues','detalle'],
  CFG: ['clave','valor'],
  PER: ['nombre','activo','creadoISO']
};

var CATEGORIAS = ['Salarios','Proveedores','Servicios','Compras','Otros'];

var LOCK_MAX_FALLOS = 5;        // fallos seguidos antes de bloquear
var LOCK_MINUTOS = 15;          // duración del bloqueo
var TOKEN_DIAS = 30;            // validez de la sesión
var MAX_MOV_RESPUESTA = 800;    // movimientos que viajan al teléfono

/* ================================================================
 *  ENTRADAS HTTP
 * ================================================================ */

function doGet(e) {
  return json_({ ok: true, servicio: 'Caja Fuerte', version: 2 });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }

  var accion = String(req.accion || '');

  try {
    // Acciones que no requieren sesión iniciada
    if (accion === 'ping')  return json_({ ok: true, instalado: estaInstalado_() });
    if (accion === 'login') return json_(login_(req));

    // A partir de acá hace falta un token válido
    var sesion = verificarToken_(req.token);
    if (!sesion) return json_({ ok: false, error: 'sesion_invalida' });
    var usuario = String(req.usuario || sesion.nombre || 'desconocido').slice(0, 60);

    switch (accion) {
      case 'estado':        return json_(estado_());
      case 'registrarLote': return json_(registrarLote_(req, usuario));
      case 'editarMov':     return json_(editarMov_(req, usuario));
      case 'anularMov':     return json_(anularMov_(req, usuario));
      case 'guardarArqueo': return json_(guardarArqueo_(req, usuario));
      case 'foto':          return json_(leerFoto_(req));
      case 'addPersona':    return json_(addPersona_(req, usuario));
      case 'setConfig':     return json_(setConfigPublica_(req, usuario));
      case 'auditoria':     return json_(leerAuditoria_(req));
      case 'backup':        return json_(backupAhora_(usuario));
      case 'mailAhora':     return json_(mailResumen_(usuario, null));
      default:              return json_({ ok: false, error: 'accion_desconocida' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server', detalle: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================
 *  INSTALACIÓN
 * ================================================================ */

/** Escribe la clave solo si todavía no tiene valor. */
function setConfigSiVacio_(clave, valor) {
  if (String(getConfig_(clave) || '') === '') { setConfig_(clave, valor); return true; }
  return false;
}

/** ¿Sigue existiendo esa carpeta de Drive? */
function carpetaViva_(id) {
  if (!id) return false;
  try { return !DriveApp.getFolderById(id).isTrashed(); } catch (e) { return false; }
}

/**
 * Ejecutá esta función desde el editor de Apps Script.
 * Es segura de volver a ejecutar: la primera vez crea las hojas, las carpetas
 * de Drive, la contraseña inicial y el disparador de la copia. En las
 * siguientes solo añade lo que falte — NO toca la contraseña, ni el salt, ni
 * las carpetas, ni los ajustes que ya tengas puestos.
 */
function instalar() {
  var ss = SpreadsheetApp.getActive();
  var primeraVez = false;

  Object.keys(HOJAS).forEach(function (k) {
    var nombre = HOJAS[k];
    var h = ss.getSheetByName(nombre);
    if (!h) h = ss.insertSheet(nombre);

    if (h.getLastRow() === 0) {
      h.appendRow(COLS[k]);
      h.getRange(1, 1, 1, COLS[k].length).setFontWeight('bold');
      h.setFrozenRows(1);
      return;
    }

    // Hoja que ya existía: añade al final las columnas que falten.
    var head = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String);
    var faltan = COLS[k].filter(function (c) { return head.indexOf(c) < 0; });
    if (faltan.length) {
      h.getRange(1, head.length + 1, 1, faltan.length).setValues([faltan]).setFontWeight('bold');
      Logger.log('Hoja ' + nombre + ': columnas añadidas → ' + faltan.join(', '));
    }
  });
  _cacheEncabezados = {};

  var hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1') || ss.getSheetByName('Hoja1');
  if (hoja1 && ss.getSheets().length > 1 && hoja1.getLastRow() === 0) ss.deleteSheet(hoja1);

  // --- Carpetas de Drive: solo si no hay unas válidas ya ---
  var raiz;
  if (carpetaViva_(getConfig_('carpetaRaiz')) &&
      carpetaViva_(getConfig_('carpetaFotos')) &&
      carpetaViva_(getConfig_('carpetaBackups'))) {
    raiz = DriveApp.getFolderById(getConfig_('carpetaRaiz'));
  } else {
    raiz = DriveApp.createFolder('Caja Fuerte — ' + ss.getName());
    setConfig_('carpetaRaiz', raiz.getId());
    setConfig_('carpetaFotos', raiz.createFolder('Fotos').getId());
    setConfig_('carpetaBackups', raiz.createFolder('Backups').getId());
    Logger.log('Carpetas de Drive creadas en: ' + raiz.getUrl());
  }

  // --- Contraseña: NUNCA se pisa una que ya exista ---
  var passInicial = '1234';
  if (String(getConfig_('salt') || '') === '' || String(getConfig_('passwordHash') || '') === '') {
    var salt = Utilities.getUuid();
    setConfig_('salt', salt);
    setConfig_('passwordHash', hash_(passInicial + ':' + salt));
    primeraVez = true;
  }

  // --- Ajustes: solo se rellenan los que estén vacíos ---
  setConfigSiVacio_('emails', Session.getEffectiveUser().getEmail());
  setConfigSiVacio_('saldoBase', '0');
  setConfigSiVacio_('limiteAlerta', '0');
  setConfigSiVacio_('nombreCaja', 'Caja fuerte del local');
  setConfigSiVacio_('avisoCadaMovimiento', 'si');

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('hmac')) {
    props.setProperty('hmac', Utilities.getUuid() + Utilities.getUuid());
  }

  crearDisparadores();

  Logger.log('Listo.');
  Logger.log('Carpeta en Drive: ' + raiz.getUrl());
  if (primeraVez) {
    Logger.log('Contraseña inicial: ' + passInicial + '  (cambiala desde Ajustes en la app)');
    return 'Instalado. Contraseña inicial: ' + passInicial;
  }
  Logger.log('Ya estaba instalado: se actualizó lo que faltaba y no se tocó la contraseña.');
  return 'Actualizado. La contraseña sigue siendo la que tenías.';
}

/** Vuelve a crear el disparador automático de la copia de seguridad. */
function crearDisparadores() {
  // Borra también 'tareaResumenDiario' de instalaciones anteriores: el resumen
  // diario se quitó a propósito. El único aviso programado es la copia de seguridad.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'tareaBackupDiario' || f === 'tareaResumenDiario') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tareaBackupDiario').timeBased().atHour(3).everyDays(1).create();
}

/** Cambia la contraseña desde el editor, por si te quedás afuera. */
function resetearPassword() {
  var nueva = '1234';
  setConfig_('passwordHash', hash_(nueva + ':' + getConfig_('salt')));
  PropertiesService.getScriptProperties().setProperty('hmac', Utilities.getUuid() + Utilities.getUuid());
  return 'Contraseña puesta en ' + nueva + '. Todas las sesiones abiertas quedaron cerradas.';
}

function estaInstalado_() {
  return !!SpreadsheetApp.getActive().getSheetByName(HOJAS.MOV);
}

/* ================================================================
 *  ACCESO
 * ================================================================ */

function hash_(txt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function firmar_(payload) {
  var secreto = PropertiesService.getScriptProperties().getProperty('hmac') || 'sin-secreto';
  var bytes = Utilities.computeHmacSha256Signature(payload, secreto);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function crearToken_(nombre) {
  var exp = Date.now() + TOKEN_DIAS * 864e5;
  var huella = getConfig_('passwordHash').slice(0, 12);
  var payload = nombre + '|' + exp + '|' + huella;
  return Utilities.base64EncodeWebSafe(payload) + '.' + firmar_(payload);
}

function verificarToken_(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  var partes = token.split('.');
  var payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString();
  } catch (e) { return null; }
  if (firmar_(payload) !== partes[1]) return null;

  var campos = payload.split('|');
  var exp = Number(campos[1]);
  if (!exp || Date.now() > exp) return null;
  // Si cambió la contraseña, las sesiones viejas dejan de valer.
  if (campos[2] !== getConfig_('passwordHash').slice(0, 12)) return null;
  return { nombre: campos[0] };
}

function claveBloqueo_(disp) {
  return 'fallos_' + String(disp || 'anon').replace(/[^\w-]/g, '').slice(0, 40);
}

function login_(req) {
  var props = PropertiesService.getScriptProperties();
  var clave = claveBloqueo_(req.dispositivo);
  var reg = {};
  try { reg = JSON.parse(props.getProperty(clave) || '{}'); } catch (e) {}

  if (reg.bloqueadoHasta && Date.now() < reg.bloqueadoHasta) {
    var min = Math.ceil((reg.bloqueadoHasta - Date.now()) / 60000);
    auditar_(req.nombre || '—', 'login_bloqueado', 'acceso', '', '', '', 'dispositivo ' + (req.dispositivo || '?'));
    return { ok: false, error: 'bloqueado', minutos: min };
  }

  var nombre = String(req.nombre || '').trim().slice(0, 40);
  var pass = String(req.password || '');
  var esperado = getConfig_('passwordHash');

  if (!nombre) return { ok: false, error: 'falta_nombre' };

  if (!esperado || hash_(pass + ':' + getConfig_('salt')) !== esperado) {
    reg.fallos = (reg.fallos || 0) + 1;
    if (reg.fallos >= LOCK_MAX_FALLOS) {
      reg.bloqueadoHasta = Date.now() + LOCK_MINUTOS * 60000;
      reg.fallos = 0;
      avisarIntrusion_(nombre, req.dispositivo);
    }
    props.setProperty(clave, JSON.stringify(reg));
    auditar_(nombre, 'login_fallido', 'acceso', '', '', '', 'dispositivo ' + (req.dispositivo || '?'));
    return {
      ok: false,
      error: 'password',
      restantes: Math.max(0, LOCK_MAX_FALLOS - (reg.fallos || 0))
    };
  }

  props.deleteProperty(clave);
  registrarPersona_(nombre);
  auditar_(nombre, 'login', 'acceso', '', '', '', 'dispositivo ' + (req.dispositivo || '?'));

  return { ok: true, token: crearToken_(nombre), nombre: nombre, estado: estado_() };
}

function avisarIntrusion_(nombre, disp) {
  var destinos = getConfig_('emails');
  if (!destinos) return;
  try {
    MailApp.sendEmail({
      to: destinos,
      subject: '⚠️ Caja fuerte — ' + LOCK_MAX_FALLOS + ' intentos fallidos de acceso',
      htmlBody: '<p>Se bloqueó el acceso durante ' + LOCK_MINUTOS + ' minutos después de ' +
        LOCK_MAX_FALLOS + ' contraseñas incorrectas seguidas.</p>' +
        '<p>Nombre usado: <b>' + escHtml_(nombre || '—') + '</b><br>' +
        'Dispositivo: <code>' + escHtml_(disp || '—') + '</code><br>' +
        'Hora: ' + fechaLarga_(new Date()) + '</p>' +
        '<p>Si no fuiste vos ni nadie del equipo, cambiá la contraseña desde Ajustes.</p>'
    });
  } catch (e) {}
}

/* ================================================================
 *  LECTURA DE LA HOJA
 * ================================================================ */

function hoja_(k) {
  var h = SpreadsheetApp.getActive().getSheetByName(HOJAS[k]);
  if (!h) throw new Error('Falta la hoja ' + HOJAS[k] + '. Ejecutá instalar() de nuevo.');
  return h;
}

/**
 * Los nombres de columna salen del encabezado real de la hoja, no de COLS.
 * Así una hoja creada con una versión anterior sigue funcionando aunque el
 * código nuevo tenga columnas de más: instalar() las añade al final y todo
 * se sigue leyendo por nombre.
 */
var _cacheEncabezados = {};
function encabezados_(k) {
  if (_cacheEncabezados[k]) return _cacheEncabezados[k];
  var h = hoja_(k), n = h.getLastColumn();
  var head = n ? h.getRange(1, 1, 1, n).getValues()[0].map(String) : [];
  if (!head.length) head = COLS[k].slice();
  _cacheEncabezados[k] = head;
  return head;
}

function leerTabla_(k) {
  var h = hoja_(k), n = h.getLastRow();
  if (n < 2) return [];
  var cols = encabezados_(k);
  var datos = h.getRange(2, 1, n - 1, cols.length).getValues();
  return datos.map(function (fila, i) {
    var o = { _fila: i + 2 };
    cols.forEach(function (c, j) { o[c] = fila[j]; });
    return o;
  });
}

function agregarFila_(k, obj) {
  var cols = encabezados_(k);
  hoja_(k).appendRow(cols.map(function (c) { return obj[c] !== undefined ? obj[c] : ''; }));
}

function actualizarFila_(k, fila, obj) {
  var cols = encabezados_(k);
  var h = hoja_(k);
  var actual = h.getRange(fila, 1, 1, cols.length).getValues()[0];
  cols.forEach(function (c, j) { if (obj[c] !== undefined) actual[j] = obj[c]; });
  h.getRange(fila, 1, 1, cols.length).setValues([actual]);
}

function getConfig_(clave) {
  var t = leerTabla_('CFG');
  for (var i = 0; i < t.length; i++) if (String(t[i].clave) === clave) return String(t[i].valor);
  return '';
}

function setConfig_(clave, valor) {
  var h = hoja_('CFG');
  var t = leerTabla_('CFG');
  for (var i = 0; i < t.length; i++) {
    if (String(t[i].clave) === clave) { h.getRange(t[i]._fila, 2).setValue(valor); return; }
  }
  h.appendRow([clave, valor]);
}

function registrarPersona_(nombre) {
  var t = leerTabla_('PER');
  for (var i = 0; i < t.length; i++) if (String(t[i].nombre) === nombre) return;
  agregarFila_('PER', { nombre: nombre, activo: 'si', creadoISO: new Date().toISOString() });
}

/* ================================================================
 *  ESTADO
 * ================================================================ */

function saldoActual_() {
  var base = Number(getConfig_('saldoBase')) || 0;
  return leerTabla_('MOV').reduce(function (acc, m) {
    if (String(m.estado) === 'anulado') return acc;
    return acc + (String(m.tipo) === 'ingreso' ? Number(m.monto) : -Number(m.monto));
  }, base);
}

function estado_() {
  var movs = leerTabla_('MOV');
  var base = Number(getConfig_('saldoBase')) || 0;
  var saldo = movs.reduce(function (acc, m) {
    if (String(m.estado) === 'anulado') return acc;
    return acc + (String(m.tipo) === 'ingreso' ? Number(m.monto) : -Number(m.monto));
  }, base);

  var recientes = movs.slice(-MAX_MOV_RESPUESTA).reverse().map(function (m) {
    return {
      id: String(m.id), tsMs: Number(m.tsMs), tipo: String(m.tipo), monto: Number(m.monto),
      categoria: String(m.categoria || ''), concepto: String(m.concepto || ''),
      destinatario: String(m.destinatario || ''), usuario: String(m.usuario || ''),
      loteId: String(m.loteId || ''), fotos: String(m.fotos || '').split(',').filter(Boolean),
      estado: String(m.estado || 'activo'), version: Number(m.version) || 1,
      editadoPor: String(m.editadoPor || ''), offline: String(m.offline || '') === 'si'
    };
  });

  var arqueos = leerTabla_('ARQ').slice(-60).reverse().map(function (a) {
    return {
      id: String(a.id), tsMs: Number(a.tsMs), usuario: String(a.usuario || ''),
      esperado: Number(a.esperado), contado: Number(a.contado), diferencia: Number(a.diferencia),
      nota: String(a.nota || ''), ajusteMovId: String(a.ajusteMovId || '')
    };
  });

  return {
    ok: true,
    saldo: redondear_(saldo),
    totalMovimientos: movs.length,
    movimientos: recientes,
    arqueos: arqueos,
    personas: leerTabla_('PER').filter(function (p) { return String(p.activo) !== 'no'; })
                               .map(function (p) { return String(p.nombre); }),
    categorias: CATEGORIAS,
    config: {
      nombreCaja: getConfig_('nombreCaja'),
      emails: getConfig_('emails'),
      limiteAlerta: Number(getConfig_('limiteAlerta')) || 0,
      avisoCadaMovimiento: getConfig_('avisoCadaMovimiento') !== 'no',
      carpetaDrive: 'https://drive.google.com/drive/folders/' + getConfig_('carpetaRaiz')
    },
    servidorMs: Date.now()
  };
}

function redondear_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ================================================================
 *  MOVIMIENTOS
 * ================================================================ */

/**
 * Decide la hora del movimiento.
 * Normalmente manda el servidor. Si el lote se cargó sin conexión, respeta la
 * hora del teléfono para que el movimiento caiga en el día en que realmente
 * pasó, pero solo dentro de una ventana razonable y dejando constancia en
 * `tsServidorISO` de cuándo llegó de verdad.
 */
function horaDelLote_(req, ahora) {
  if (!req.offline) return { ms: ahora.getTime(), offline: false };
  var t = Number(req.tsClienteMs);
  if (!t || !isFinite(t)) return { ms: ahora.getTime(), offline: true };
  var margenFuturo = 6 * 3600e3;     // 6 horas de tolerancia por relojes adelantados
  var margenPasado = 30 * 864e5;     // 30 días hacia atrás como mucho
  if (t > ahora.getTime() + margenFuturo || t < ahora.getTime() - margenPasado) {
    return { ms: ahora.getTime(), offline: true };
  }
  return { ms: t, offline: true };
}

function registrarLote_(req, usuario) {
  var items = req.items || [];
  if (!items.length) return { ok: false, error: 'lote_vacio' };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ahora = new Date();
    var cuando = horaDelLote_(req, ahora);
    var loteId = Utilities.getUuid().slice(0, 8);
    var guardados = [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var monto = redondear_(Number(it.monto));
      if (!(monto > 0)) continue;

      var tipo = String(it.tipo) === 'retiro' ? 'retiro' : 'ingreso';
      var id = Utilities.getUuid().slice(0, 12);
      var fotoIds = guardarFotos_(it.fotos || [], id);

      agregarFila_('MOV', {
        id: id,
        tsISO: new Date(cuando.ms + i).toISOString(),
        tsMs: cuando.ms + i,
        tsServidorISO: ahora.toISOString(),
        offline: cuando.offline ? 'si' : 'no',
        tipo: tipo,
        monto: monto,
        categoria: String(it.categoria || '').slice(0, 30),
        concepto: String(it.concepto || '').slice(0, 200),
        destinatario: String(it.destinatario || '').slice(0, 80),
        usuario: usuario,
        loteId: loteId,
        fotos: fotoIds.join(','),
        estado: 'activo',
        version: 1,
        editadoPor: '',
        editadoTsISO: ''
      });

      guardados.push({ id: id, tipo: tipo, monto: monto,
                       categoria: it.categoria || '', concepto: it.concepto || '',
                       destinatario: it.destinatario || '', fotos: fotoIds.length });
    }

    if (!guardados.length) return { ok: false, error: 'sin_montos_validos' };

    auditar_(usuario, 'alta_lote', 'movimiento', loteId, '', JSON.stringify(guardados),
             guardados.length + ' movimientos' +
             (cuando.offline ? ' · cargados sin conexión el ' + fechaLarga_(new Date(cuando.ms)) : ''));

    var nuevoSaldo = saldoActual_();
    if (getConfig_('avisoCadaMovimiento') !== 'no') {
      mailMovimientos_(usuario, guardados, nuevoSaldo, loteId, cuando);
    }
    revisarLimite_(nuevoSaldo);

    return { ok: true, loteId: loteId, guardados: guardados.length, estado: estado_() };
  } finally {
    lock.releaseLock();
  }
}

function editarMov_(req, usuario) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var t = leerTabla_('MOV');
    var m = null;
    for (var i = 0; i < t.length; i++) if (String(t[i].id) === String(req.id)) { m = t[i]; break; }
    if (!m) return { ok: false, error: 'no_existe' };
    if (String(m.estado) === 'anulado') return { ok: false, error: 'anulado' };

    var antes = {
      tipo: String(m.tipo), monto: Number(m.monto), categoria: String(m.categoria || ''),
      concepto: String(m.concepto || ''), destinatario: String(m.destinatario || '')
    };
    var despues = {
      tipo: String(req.tipo) === 'retiro' ? 'retiro' : 'ingreso',
      monto: redondear_(Number(req.monto)),
      categoria: String(req.categoria || '').slice(0, 30),
      concepto: String(req.concepto || '').slice(0, 200),
      destinatario: String(req.destinatario || '').slice(0, 80)
    };
    if (!(despues.monto > 0)) return { ok: false, error: 'monto_invalido' };

    var motivo = String(req.motivo || '').slice(0, 200);
    if (!motivo) return { ok: false, error: 'falta_motivo' };

    var fotosNuevas = guardarFotos_(req.fotosNuevas || [], String(m.id));
    var fotos = String(m.fotos || '').split(',').filter(Boolean).concat(fotosNuevas);

    actualizarFila_('MOV', m._fila, {
      tipo: despues.tipo, monto: despues.monto, categoria: despues.categoria,
      concepto: despues.concepto, destinatario: despues.destinatario,
      fotos: fotos.join(','), version: (Number(m.version) || 1) + 1,
      editadoPor: usuario, editadoTsISO: new Date().toISOString()
    });

    auditar_(usuario, 'edicion', 'movimiento', String(m.id),
             JSON.stringify(antes), JSON.stringify(despues), motivo);

    var nuevoSaldo = saldoActual_();
    mailEdicion_(usuario, String(m.id), antes, despues, motivo, nuevoSaldo);
    revisarLimite_(nuevoSaldo);

    return { ok: true, estado: estado_() };
  } finally {
    lock.releaseLock();
  }
}

function anularMov_(req, usuario) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var t = leerTabla_('MOV');
    var m = null;
    for (var i = 0; i < t.length; i++) if (String(t[i].id) === String(req.id)) { m = t[i]; break; }
    if (!m) return { ok: false, error: 'no_existe' };

    var motivo = String(req.motivo || '').slice(0, 200);
    if (!motivo) return { ok: false, error: 'falta_motivo' };

    var nuevoEstado = String(m.estado) === 'anulado' ? 'activo' : 'anulado';
    actualizarFila_('MOV', m._fila, {
      estado: nuevoEstado,
      version: (Number(m.version) || 1) + 1,
      editadoPor: usuario,
      editadoTsISO: new Date().toISOString()
    });

    auditar_(usuario, nuevoEstado === 'anulado' ? 'anulacion' : 'reactivacion',
             'movimiento', String(m.id),
             JSON.stringify({ estado: String(m.estado), monto: Number(m.monto) }),
             JSON.stringify({ estado: nuevoEstado }), motivo);

    var nuevoSaldo = saldoActual_();
    mailSimple_('Caja fuerte — movimiento ' + (nuevoEstado === 'anulado' ? 'anulado' : 'reactivado'),
      '<p><b>' + escHtml_(usuario) + '</b> ' + (nuevoEstado === 'anulado' ? 'anuló' : 'reactivó') +
      ' un movimiento de <b>' + dinero_(Number(m.monto)) + '</b> (' + escHtml_(String(m.concepto || '—')) + ').</p>' +
      '<p>Motivo: ' + escHtml_(motivo) + '</p>' +
      '<p>Saldo en caja fuerte: <b>' + dinero_(nuevoSaldo) + '</b></p>');

    return { ok: true, estado: estado_() };
  } finally {
    lock.releaseLock();
  }
}

/* ================================================================
 *  FOTOS  (privadas: nunca se comparten por enlace)
 * ================================================================ */

function guardarFotos_(fotos, movId) {
  if (!fotos || !fotos.length) return [];
  var carpeta;
  try { carpeta = DriveApp.getFolderById(getConfig_('carpetaFotos')); }
  catch (e) { return []; }

  var ids = [];
  for (var i = 0; i < fotos.length && i < 6; i++) {
    try {
      var base64 = String(fotos[i]).replace(/^data:image\/\w+;base64,/, '');
      var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg',
        movId + '-' + (i + 1) + '.jpg');
      ids.push(carpeta.createFile(blob).getId());
    } catch (e) {}
  }
  return ids;
}

function leerFoto_(req) {
  try {
    var f = DriveApp.getFileById(String(req.id));
    var padre = getConfig_('carpetaFotos');
    var ok = false;
    var it = f.getParents();
    while (it.hasNext()) if (it.next().getId() === padre) { ok = true; break; }
    if (!ok) return { ok: false, error: 'fuera_de_carpeta' };

    return {
      ok: true,
      dataUrl: 'data:image/jpeg;base64,' + Utilities.base64Encode(f.getBlob().getBytes())
    };
  } catch (e) {
    return { ok: false, error: 'no_encontrada' };
  }
}

/* ================================================================
 *  ARQUEO
 * ================================================================ */

function guardarArqueo_(req, usuario) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var esperado = saldoActual_();
    var contado = redondear_(Number(req.contado));
    var dif = redondear_(contado - esperado);
    var ahora = new Date();
    var id = Utilities.getUuid().slice(0, 12);
    var ajusteId = '';

    if (req.registrarAjuste && Math.abs(dif) >= 0.005) {
      ajusteId = Utilities.getUuid().slice(0, 12);
      agregarFila_('MOV', {
        id: ajusteId, tsISO: ahora.toISOString(), tsMs: ahora.getTime() + 1,
        tipo: dif > 0 ? 'ingreso' : 'retiro', monto: Math.abs(dif),
        categoria: 'Otros',
        concepto: 'Ajuste por arqueo' + (req.nota ? ' — ' + String(req.nota).slice(0, 120) : ''),
        destinatario: '', usuario: usuario, loteId: 'arqueo-' + id, fotos: '',
        estado: 'activo', version: 1, editadoPor: '', editadoTsISO: ''
      });
    }

    agregarFila_('ARQ', {
      id: id, tsISO: ahora.toISOString(), tsMs: ahora.getTime(), usuario: usuario,
      esperado: esperado, contado: contado, diferencia: dif,
      detalle: JSON.stringify(req.detalle || {}),
      manual: req.manual ? 'si' : 'no',
      nota: String(req.nota || '').slice(0, 200),
      ajusteMovId: ajusteId
    });

    auditar_(usuario, 'arqueo', 'arqueo', id, '',
             JSON.stringify({ esperado: esperado, contado: contado, diferencia: dif }),
             String(req.nota || ''));

    mailArqueo_(usuario, esperado, contado, dif, String(req.nota || ''), !!ajusteId);

    return { ok: true, diferencia: dif, estado: estado_() };
  } finally {
    lock.releaseLock();
  }
}

/* ================================================================
 *  PERSONAS, CONFIG, AUDITORÍA
 * ================================================================ */

function addPersona_(req, usuario) {
  var nombre = String(req.nombre || '').trim().slice(0, 40);
  if (nombre.length < 2) return { ok: false, error: 'nombre_corto' };
  registrarPersona_(nombre);
  auditar_(usuario, 'alta_persona', 'persona', nombre, '', '', '');
  return { ok: true, estado: estado_() };
}

/** Claves que la app puede cambiar. El salt y las carpetas quedan fuera. */
function setConfigPublica_(req, usuario) {
  var permitidas = ['emails', 'limiteAlerta', 'nombreCaja', 'avisoCadaMovimiento', 'saldoBase'];
  var cambios = req.cambios || {};
  var hechos = [];

  Object.keys(cambios).forEach(function (k) {
    if (permitidas.indexOf(k) < 0) return;
    var antes = getConfig_(k);
    setConfig_(k, String(cambios[k]).slice(0, 300));
    hechos.push(k + ': "' + antes + '" → "' + cambios[k] + '"');
  });

  if (req.passwordNueva) {
    var nueva = String(req.passwordNueva);
    if (nueva.length < 4) return { ok: false, error: 'password_corta' };
    var actual = String(req.passwordActual || '');
    if (hash_(actual + ':' + getConfig_('salt')) !== getConfig_('passwordHash')) {
      return { ok: false, error: 'password_actual' };
    }
    setConfig_('passwordHash', hash_(nueva + ':' + getConfig_('salt')));
    PropertiesService.getScriptProperties().setProperty('hmac', Utilities.getUuid() + Utilities.getUuid());
    auditar_(usuario, 'cambio_password', 'config', '', '', '', 'cerró todas las sesiones');
    mailSimple_('Caja fuerte — cambió la contraseña',
      '<p><b>' + escHtml_(usuario) + '</b> cambió la contraseña de la caja fuerte. ' +
      'Todas las sesiones abiertas se cerraron y hay que volver a entrar.</p>');
    return { ok: true, sesionCerrada: true };
  }

  if (hechos.length) auditar_(usuario, 'cambio_config', 'config', '', '', '', hechos.join(' · '));
  return { ok: true, estado: estado_() };
}

function auditar_(usuario, accion, entidad, entidadId, antes, despues, detalle) {
  try {
    var ahora = new Date();
    agregarFila_('AUD', {
      tsISO: ahora.toISOString(), tsMs: ahora.getTime(), usuario: usuario,
      accion: accion, entidad: entidad, entidadId: entidadId,
      antes: antes || '', despues: despues || '', detalle: detalle || ''
    });
  } catch (e) {}
}

function leerAuditoria_(req) {
  var n = Math.min(Number(req.limite) || 120, 400);
  var t = leerTabla_('AUD').slice(-n).reverse();
  return {
    ok: true,
    filas: t.map(function (a) {
      return {
        tsMs: Number(a.tsMs), usuario: String(a.usuario), accion: String(a.accion),
        entidad: String(a.entidad), entidadId: String(a.entidadId),
        antes: String(a.antes || ''), despues: String(a.despues || ''),
        detalle: String(a.detalle || '')
      };
    })
  };
}

/* ================================================================
 *  COPIAS DE SEGURIDAD
 * ================================================================ */

function csv_() {
  var filas = [['id','fecha','hora','tipo','monto_eur','categoria','concepto','destinatario',
                'persona','lote','estado','version','editado_por','fotos',
                'sin_conexion','llegada_al_servidor']];
  var tz = Session.getScriptTimeZone();

  leerTabla_('MOV').forEach(function (m) {
    var d = new Date(Number(m.tsMs));
    filas.push([
      String(m.id),
      Utilities.formatDate(d, tz, 'dd/MM/yyyy'),
      Utilities.formatDate(d, tz, 'HH:mm'),
      String(m.tipo),
      String(Number(m.monto)).replace('.', ','),
      String(m.categoria || ''), String(m.concepto || ''), String(m.destinatario || ''),
      String(m.usuario || ''), String(m.loteId || ''), String(m.estado || 'activo'),
      String(m.version || 1), String(m.editadoPor || ''),
      String(String(m.fotos || '').split(',').filter(Boolean).length),
      String(m.offline || 'no'), String(m.tsServidorISO || '')
    ]);
  });

  filas.push([]);
  filas.push(['saldo', String(saldoActual_()).replace('.', ',')]);

  return '﻿' + filas.map(function (r) {
    return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(';');
  }).join('\r\n');
}

function backupAhora_(usuario) {
  try {
    var carpeta = DriveApp.getFolderById(getConfig_('carpetaBackups'));
    var nombre = 'caja-fuerte-' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmm') + '.csv';
    var f = carpeta.createFile(Utilities.newBlob(csv_(), 'text/csv', nombre));
    auditar_(usuario || 'automático', 'backup', 'archivo', f.getId(), '', '', nombre);
    return { ok: true, url: f.getUrl(), nombre: nombre };
  } catch (e) {
    return { ok: false, error: 'drive', detalle: String(e && e.message || e) };
  }
}

function tareaBackupDiario() {
  backupAhora_('automático');
  // Deja como mucho 90 copias.
  try {
    var carpeta = DriveApp.getFolderById(getConfig_('carpetaBackups'));
    var archivos = [], it = carpeta.getFiles();
    while (it.hasNext()) archivos.push(it.next());
    archivos.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
    while (archivos.length > 90) archivos.shift().setTrashed(true);
  } catch (e) {}
}

/* ================================================================
 *  AVISOS POR MAIL
 * ================================================================ */

function dinero_(n) {
  var v = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',');
  return v.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €';
}
function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function fechaLarga_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd/MM/yyyy 'a las' HH:mm");
}

function envolver_(titulo, cuerpo) {
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;' +
    'color:#12131a;line-height:1.5">' +
    '<div style="border-left:4px solid #3d3aa8;padding-left:12px;margin-bottom:16px">' +
    '<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#75798a">' +
    escHtml_(getConfig_('nombreCaja') || 'Caja fuerte') + '</div>' +
    '<div style="font-size:19px;font-weight:700">' + escHtml_(titulo) + '</div></div>' +
    cuerpo +
    '<p style="font-size:11px;color:#75798a;margin-top:22px;border-top:1px solid #dfe2eb;padding-top:10px">' +
    'Aviso automático · ' + fechaLarga_(new Date()) + '</p></div>';
}

function mailSimple_(asunto, cuerpoHtml) {
  var destinos = getConfig_('emails');
  if (!destinos) return { ok: false, error: 'sin_destinatarios' };
  try {
    MailApp.sendEmail({ to: destinos, subject: asunto, htmlBody: envolver_(asunto, cuerpoHtml) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'mail', detalle: String(e && e.message || e) };
  }
}

function tablaMovs_(items) {
  var filas = items.map(function (g) {
    var signo = g.tipo === 'ingreso' ? '+' : '−';
    var color = g.tipo === 'ingreso' ? '#0e7a4f' : '#c03a22';
    return '<tr>' +
      '<td style="padding:6px 10px 6px 0;border-bottom:1px solid #eef0f5">' +
        escHtml_(g.concepto || '(sin concepto)') +
        (g.categoria ? '<br><span style="font-size:11px;color:#75798a">' + escHtml_(g.categoria) +
          (g.destinatario ? ' · ' + escHtml_(g.destinatario) : '') + '</span>' : '') +
        (g.fotos ? '<br><span style="font-size:11px;color:#75798a">' + g.fotos + ' foto(s)</span>' : '') +
      '</td>' +
      '<td style="padding:6px 0;border-bottom:1px solid #eef0f5;text-align:right;white-space:nowrap;' +
        'font-weight:600;color:' + color + '">' + signo + dinero_(g.monto) + '</td></tr>';
  }).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:14px">' + filas + '</table>';
}

function mailMovimientos_(usuario, guardados, saldo, loteId, cuando) {
  var ing = guardados.filter(function (g) { return g.tipo === 'ingreso'; })
                     .reduce(function (a, g) { return a + g.monto; }, 0);
  var ret = guardados.filter(function (g) { return g.tipo === 'retiro'; })
                     .reduce(function (a, g) { return a + g.monto; }, 0);

  var cuerpo =
    '<p style="margin:0 0 4px"><b>' + escHtml_(usuario) + '</b> registró ' +
    guardados.length + ' movimiento' + (guardados.length === 1 ? '' : 's') + '.</p>' +
    (cuando && cuando.offline
      ? '<p style="margin:0 0 10px;padding:8px 10px;background:#fcf0d9;border:1px solid #8a5a00;' +
        'border-radius:8px;color:#8a5a00;font-size:12.5px">Se cargaron sin conexión el ' +
        fechaLarga_(new Date(cuando.ms)) + ' y se subieron recién ahora.</p>'
      : '') +
    tablaMovs_(guardados) +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:14px">' +
    (ing ? '<tr><td style="padding:4px 0">Ingresos</td><td style="text-align:right;color:#0e7a4f;font-weight:600">+' + dinero_(ing) + '</td></tr>' : '') +
    (ret ? '<tr><td style="padding:4px 0">Retiros</td><td style="text-align:right;color:#c03a22;font-weight:600">−' + dinero_(ret) + '</td></tr>' : '') +
    '<tr><td style="padding:10px 0 0;border-top:2px solid #12131a;font-weight:700">Saldo en caja fuerte</td>' +
    '<td style="padding:10px 0 0;border-top:2px solid #12131a;text-align:right;font-weight:700;font-size:17px">' +
    dinero_(saldo) + '</td></tr></table>' +
    '<p style="font-size:11px;color:#75798a">Lote ' + escHtml_(loteId) + '</p>';

  return mailSimple_('Caja fuerte — saldo ' + dinero_(saldo), cuerpo);
}

function mailEdicion_(usuario, id, antes, despues, motivo, saldo) {
  var linea = function (etiqueta, a, b) {
    if (String(a) === String(b)) return '';
    return '<tr><td style="padding:5px 10px 5px 0;color:#75798a">' + etiqueta + '</td>' +
      '<td style="padding:5px 0"><span style="text-decoration:line-through;color:#c03a22">' +
      escHtml_(a || '—') + '</span> → <b>' + escHtml_(b || '—') + '</b></td></tr>';
  };

  var cuerpo =
    '<p style="margin:0 0 10px"><b>' + escHtml_(usuario) + '</b> editó un movimiento ya registrado.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
      linea('Tipo', antes.tipo, despues.tipo) +
      linea('Monto', dinero_(antes.monto), dinero_(despues.monto)) +
      linea('Categoría', antes.categoria, despues.categoria) +
      linea('Concepto', antes.concepto, despues.concepto) +
      linea('Destinatario', antes.destinatario, despues.destinatario) +
    '</table>' +
    '<p style="margin-top:12px"><b>Motivo:</b> ' + escHtml_(motivo) + '</p>' +
    '<p>Saldo en caja fuerte: <b>' + dinero_(saldo) + '</b></p>' +
    '<p style="font-size:11px;color:#75798a">Movimiento ' + escHtml_(id) +
    ' · la versión anterior queda guardada en la hoja Auditoria.</p>';

  return mailSimple_('Caja fuerte — se editó un movimiento', cuerpo);
}

function mailArqueo_(usuario, esperado, contado, dif, nota, conAjuste) {
  var cuadra = Math.abs(dif) < 0.005;
  var color = cuadra ? '#0e7a4f' : '#c03a22';
  var cuerpo =
    '<p style="margin:0 0 10px"><b>' + escHtml_(usuario) + '</b> hizo el recuento de la caja fuerte.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<tr><td style="padding:5px 0">Saldo según la app</td><td style="text-align:right;font-weight:600">' + dinero_(esperado) + '</td></tr>' +
    '<tr><td style="padding:5px 0">Contado en la caja</td><td style="text-align:right;font-weight:600">' + dinero_(contado) + '</td></tr>' +
    '<tr><td style="padding:10px 0 0;border-top:2px solid #12131a;font-weight:700">Diferencia</td>' +
    '<td style="padding:10px 0 0;border-top:2px solid #12131a;text-align:right;font-weight:700;font-size:17px;color:' +
    color + '">' + (dif > 0 ? '+' : '') + dinero_(dif) + '</td></tr></table>' +
    '<p style="margin-top:12px;font-weight:600;color:' + color + '">' +
    (cuadra ? 'La caja cuadra.' : (dif > 0 ? 'Sobra efectivo.' : 'Falta efectivo.')) + '</p>' +
    (nota ? '<p><b>Nota:</b> ' + escHtml_(nota) + '</p>' : '') +
    (conAjuste ? '<p>Se registró el ajuste como movimiento, así que el saldo de la app ya coincide con lo contado.</p>' : '');

  return mailSimple_('Caja fuerte — arqueo ' + (cuadra ? 'correcto' : 'con diferencia de ' + dinero_(dif)), cuerpo);
}

function revisarLimite_(saldo) {
  var limite = Number(getConfig_('limiteAlerta')) || 0;
  if (limite > 0 && saldo > limite) {
    mailSimple_('⚠️ Caja fuerte por encima del límite',
      '<p>El saldo llegó a <b>' + dinero_(saldo) + '</b>, por encima del límite de ' +
      dinero_(limite) + ' que fijaste.</p>' +
      '<p>Conviene llevar efectivo al banco: por encima de ese importe puede que el seguro del local no lo cubra.</p>');
  }
}

function mailResumen_(usuario, _) {
  var r = mailSimple_('Caja fuerte — saldo ' + dinero_(saldoActual_()),
    '<p><b>' + escHtml_(usuario) + '</b> pidió el balance desde la app.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<tr><td style="padding:10px 0 0;border-top:2px solid #12131a;font-weight:700">Saldo en caja fuerte</td>' +
    '<td style="padding:10px 0 0;border-top:2px solid #12131a;text-align:right;font-weight:700;font-size:17px">' +
    dinero_(saldoActual_()) + '</td></tr></table>');
  return r;
}
