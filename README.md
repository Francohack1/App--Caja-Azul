# Caja Azul

App para llevar el control de la caja fuerte de un local: quién metió o sacó dinero, cuánto, por qué, con foto, y si el recuento real cuadra.

Funciona desde el móvil de cualquier persona del equipo con una contraseña compartida: nadie necesita crear una cuenta. Se instala desde el navegador en un toque y sigue funcionando en el cuarto sin cobertura donde suele estar la caja.

- **Frontend**: HTML, CSS y JavaScript sin dependencias. Se publica en GitHub Pages.
- **Backend**: un Google Apps Script sobre tu propia cuenta. La hoja de cálculo es la base de datos, Drive guarda las fotos y las copias, y Gmail manda los avisos.
- **Coste**: cero. Todo entra en las cuotas gratuitas de Google.

---

## Qué hace

| | |
|---|---|
| **Registro en lote** | Varios montos con su concepto en una sola carga: te identificás una vez y cargás todo junto. |
| **Categorías rápidas** | Salarios, Proveedores, Servicios, Compras, Otros. En salarios y proveedores aparece además el campo de a quién se le entregó. |
| **Fotos** | Hasta 6 por movimiento, comprimidas en el teléfono antes de subir. Quedan **privadas** en tu Drive: la app las pide al servidor, nunca por enlace público. |
| **Mail automático** | Sale solo en cada movimiento, en cada arqueo y en cada edición o anulación. No hay resumen diario: solo avisa cuando pasa algo. |
| **Arqueo** | Desglose por billetes y monedas de euro o total directo. Compara con el saldo y, si hay diferencia, la registra como ajuste. |
| **Edición con auditoría** | Un movimiento se puede corregir o anular, pero hay que decir por qué. Queda el valor anterior, el nuevo, quién lo tocó y cuándo. |
| **Aviso de tope** | Si el efectivo pasa del importe que fijes, llega un mail para llevarlo al banco. |
| **Copias** | CSV automático a Drive cada madrugada, y CSV a mano cuando quieras. |
| **Funciona sin señal** | Se instala en el móvil como una app. Abre sin conexión con el último saldo e historial, deja cargar movimientos con sus fotos, y los sube solos cuando vuelve la red. |
| **Control de acceso** | La contraseña se valida en el servidor. 5 fallos bloquean ese teléfono y 12 desde cualquier origen bloquean todo, 15 minutos, con aviso por mail. |

---

## Instalación

Son 15 minutos. Hacelo una sola vez.

### 1 — Crear la hoja y pegar el script

1. Entrá en [sheets.new](https://sheets.new) y ponele un nombre, por ejemplo **Caja Azul**.
2. Menú **Extensiones → Apps Script**.
3. Borrá todo lo que haya en `Código.gs` y pegá el contenido de [`backend/Codigo.gs`](backend/Codigo.gs).
4. Guardá con `Ctrl+S`.

### 2 — Ejecutar la instalación

1. En el desplegable de funciones elegí **`instalar`** y dale a **Ejecutar**.
2. Google te va a pedir permisos: elegí tu cuenta, tocá **Configuración avanzada → Ir a (nombre del proyecto)** y **Permitir**. Es tu propio script sobre tus propios datos; la advertencia sale porque el proyecto no está verificado por Google.
3. Cuando termine, abrí **Ver → Registro de ejecución**. Ahí está la contraseña inicial: **`1234`**. Cambiala desde la app en cuanto entres.

Esto crea las hojas `Movimientos`, `Arqueos`, `Auditoria`, `Config` y `Personas`, una carpeta en tu Drive con subcarpetas `Fotos` y `Backups`, y la tarea automática de copia de seguridad a las 3 de la mañana.

> `instalar()` se puede volver a ejecutar cuando quieras: la primera vez crea todo, y de ahí en adelante solo añade lo que falte. **No toca la contraseña, ni las carpetas, ni los ajustes que ya tengas puestos.** Es lo que hay que hacer al actualizar el script a una versión con columnas nuevas.

### 3 — Publicar la aplicación web

1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. En el engranaje, elegí el tipo **Aplicación web**.
3. Configurá:
   - **Ejecutar como**: *Yo* (tu cuenta)
   - **Quién tiene acceso**: *Cualquier usuario*
4. **Implementar** y copiá la **URL de la aplicación web**. Termina en `/exec`.

> «Cualquier usuario» significa que la dirección responde sin pedir cuenta de Google. No significa que cualquiera vea los datos: sin la contraseña, la API no devuelve nada.

> Los mails salen **desde la cuenta de Google donde está el script**, y las carpetas de fotos y copias se crean en ese Drive. Si usás la cuenta del local, tenelo presente.

### 4 — Conectar el frontend

Abrí `config.js` y pegá la URL:

```js
window.CAJA_CONFIG = {
  API: 'https://script.google.com/macros/s/AKfycb.../exec',
  moneda: 'EUR',
  locale: 'es-ES'
};
```

### 5 — Subirlo a GitHub Pages

```bash
git init
git add .
git commit -m "Caja fuerte"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/caja-fuerte.git
git push -u origin main
```

En el repo: **Settings → Pages → Source: Deploy from a branch → main / (root)**. Al minuto tenés la app en `https://TU-USUARIO.github.io/caja-fuerte/`.

GitHub Pages sirve por HTTPS, que es lo que necesita el modo sin conexión para funcionar.

### 6 — Repartirlo al equipo

Mandales el enlace y la contraseña, y pediles que la instalen:

- **Android / Chrome**: menú ⋮ → *Instalar aplicación* (o *Añadir a pantalla de inicio*).
- **iPhone / Safari**: botón compartir → *Añadir a pantalla de inicio*.

Instalada queda como una app más, a pantalla completa y sin barra de navegador. **Es el paso que activa el modo sin conexión**, así que no lo saltees: la caja fuerte suele estar en un cuarto sin cobertura.

### 7 — Cargar el dinero que ya hay en la caja

La app arranca en cero, así que el primer día tenés que decirle cuánto efectivo hay realmente dentro. Elegí una de las dos:

- **Como movimiento** (recomendado): entrá y registrá un **Ingreso** con el total, categoría *Otros* y concepto «Saldo inicial». Queda en el historial y en la auditoría, con tu nombre y la fecha.
- **Como saldo de partida**: en la hoja `Config`, poné el importe en la fila `saldoBase`. Útil también más adelante, si algún día archivás los movimientos viejos para aligerar la hoja.

Después hacé un **arqueo** contando los billetes: si cuadra, ya está todo alineado.

### 8 — Comprobar que la cadena entera funciona

Cinco minutos, una sola vez, antes de repartirla al equipo:

1. Entrá con la contraseña nueva. → Deberías ver el saldo.
2. Registrá un ingreso de prueba de 1 € con una foto. → Te tiene que llegar el mail en menos de un minuto, y la foto tiene que abrirse desde el historial.
3. Anulá ese movimiento poniendo «prueba» como motivo. → Segundo mail, y el saldo vuelve a lo de antes.
4. Ajustes → **Ver registro de cambios**. → Tienen que aparecer el alta y la anulación.
5. Ajustes → **Hacer una copia ahora**. → Se abre el CSV en Drive.
6. Poné el teléfono en modo avión y cargá otro movimiento de prueba. → Tiene que quedar en ámbar como «sin subir». Sacá el modo avión y esperá unos segundos: sube solo. Anulalo después.

Si los seis pasos salen bien, está todo conectado.

---

## Actualizar a una versión nueva

1. **Backend**: pegá el `backend/Codigo.gs` nuevo en el editor, guardá y ejecutá **`instalar()`**. Es seguro: respeta la contraseña, las carpetas y los ajustes; solo agrega lo que falte.
2. **Publicar el cambio**: Implementar → **Gestionar implementaciones** → editar (lápiz) → **Versión: Nueva** → Implementar. La URL no cambia. Si creás una implementación nueva en vez de editar la existente, te da otra URL y tenés que rehacer el `config.js`.
3. **Frontend**: subí los archivos y **subí `VERSION` en `sw.js`** (`'v2'` → `'v3'`). Sin eso, los teléfonos que ya tienen la app instalada siguen con la versión vieja.

---

## Cada día

- **Cargar movimientos** — elegí Ingreso o Retiro, poné el monto, tocá la categoría, escribí el concepto y sacá la foto. «Agregar otro monto» para seguir sumando líneas. Todo se guarda de una.
- **Arqueo** — contá el efectivo por denominación y confirmá. Si no cuadra, podés registrar el ajuste en el mismo paso.
- **Corregir algo** — tocá el movimiento en el historial, **Editar** o **Anular**, y escribí el motivo. Nada se borra.

### Sin señal

Cargá igual. Los movimientos quedan en ámbar con la etiqueta **sin subir**, el saldo de arriba ya los cuenta, y suben solos en cuanto vuelve la red — con la fecha y hora reales de cuando los cargaste, no de cuando subieron. Podés cerrar la app sin perder nada.

Lo único que queda bloqueado es el **arqueo**: se guarda en el servidor y necesita el saldo definitivo, así que primero tienen que subir los pendientes. Contá el efectivo igual y confirmá cuando haya señal.

---

## Cómo está armado

```
index.html            estructura de la página
styles.css            diseño (claro y oscuro, pensado para el móvil)
app.js                toda la lógica del frontend, incluida la cola sin conexión
config.js             la única línea que tenés que tocar: la URL del backend
sw.js                 service worker: guarda la app para abrirla sin señal
manifest.webmanifest  datos de instalación en el móvil
iconos/               iconos de la app
backend/
  Codigo.gs           el Apps Script entero
```

### El sondeo y la cuota de Google

Apps Script da 90 minutos de ejecución por día en cuentas gratuitas, y leer la hoja entera cuesta un par de segundos. Por eso la app no pregunta el estado completo: cada 90 segundos pregunta solo un número de revisión y el saldo, leyendo cinco filas de `Config`. Baja el historial entero únicamente cuando ese número cambió, o cuando tocás la línea de estado de la cabecera para forzarlo.

Cada operación que escribe sube el contador `rev` y guarda el saldo en `saldoCache`. Si alguien edita la hoja a mano, ese saldo queda desfasado hasta la siguiente consulta completa, que lo recalcula desde las filas.

### Cómo funciona el modo sin conexión

El `sw.js` guarda la app (HTML, CSS, JS, fuentes) en el teléfono, así que abre sin red. **Los datos nunca se cachean**: las llamadas al Apps Script van siempre al servidor. Lo que hace la app es guardar el último estado recibido en `localStorage` para tener algo que mostrar, y meter los movimientos nuevos en una cola en IndexedDB —que aguanta las fotos— hasta que haya señal.

Si IndexedDB no está disponible cae a `localStorage`, y si tampoco entran las fotos guarda solo el texto y te avisa.

### Hojas de la base de datos

| Hoja | Para qué |
|---|---|
| `Movimientos` | Un movimiento por fila, con su versión y quién lo editó por última vez. |
| `Arqueos` | Cada recuento, con lo esperado, lo contado y la diferencia. |
| `Auditoria` | Todo lo que pasó: altas, ediciones (valor anterior y nuevo), anulaciones, arqueos, entradas, intentos fallidos y cambios de ajustes. |
| `Config` | Contraseña (con hash), destinatarios, tope de alerta, ids de las carpetas. |
| `Personas` | Quiénes cargaron algo alguna vez. |

Podés mirar y filtrar todo directamente en la hoja de cálculo, pero **no edites las celdas a mano**: la app calcula el saldo desde ahí y un cambio manual no queda auditado.

---

## Seguridad: qué protege y qué no

**Lo que hace bien:**

- La contraseña nunca se guarda: solo su hash SHA-256 con salt.
- La validación es del lado del servidor. Alterar el JavaScript en el navegador no sirve de nada.
- La sesión es un token firmado con HMAC que caduca a los 30 días. Al cambiar la contraseña, todas las sesiones abiertas se cierran.
- Dos contadores de intentos fallidos: 5 bloquean ese teléfono, 12 en 15 minutos bloquean el acceso para todos. El segundo existe porque el identificador de teléfono lo genera el propio navegador, y sin él bastaba con cambiarlo en cada intento para no bloquearse nunca. Los dos avisan por mail.
- El nombre de quien carga cada movimiento sale del token firmado, no del cuerpo del pedido: no se puede firmar algo con el nombre de otro. Si el teléfono declara un nombre distinto, queda anotado en la auditoría.
- Cada lote lleva un identificador generado por el teléfono. Si la respuesta del servidor se pierde justo después de escribir y el teléfono reintenta, el servidor lo reconoce y no lo duplica.
- Las fotos están en tu Drive sin compartir. Viajan por la API, autenticadas.
- La marca de tiempo la pone el servidor, así que cambiar la hora del móvil no altera el registro. La excepción es lo cargado sin conexión, que usa la hora del teléfono para caer en el día correcto: esas filas quedan marcadas con `offline = si` y guardan aparte, en `tsServidorISO`, cuándo llegaron de verdad. La hora del teléfono solo se acepta dentro de una ventana razonable (hasta 6 horas hacia adelante, 30 días hacia atrás); fuera de eso manda el servidor.
- Nada se borra nunca: se anula, y queda el rastro.

**Lo que no hace:**

- Una contraseña compartida no distingue personas. El nombre lo escribe cada uno al entrar: sirve para saber quién cargó qué entre gente de confianza, no para probarlo ante un tercero. Si algún día hace falta eso, el paso siguiente es un PIN por persona sobre esta misma base.
- La dirección de GitHub Pages es pública. La contraseña es lo único que separa a un desconocido de la pantalla de acceso, así que poné una buena y cambiala cuando alguien deje el equipo.
- El `<meta name="robots" content="noindex">` pide a los buscadores que no la indexen, pero no es una garantía.

---

## Problemas frecuentes

| Síntoma | Qué pasa |
|---|---|
| «Falta conectar el backend» | No pegaste la URL en `config.js`, o quedó el texto de ejemplo. |
| «No se pudo conectar» | La implementación no está como *Cualquier usuario*, o la URL no termina en `/exec`. |
| Los mails no llegan | Revisá los destinatarios en Ajustes y mirá la carpeta de spam. Gmail permite unos 100 mails por día en cuentas gratuitas. |
| La app deja de responder a media tarde y al otro día anda | Se agotó la cuota de Apps Script (90 min de ejecución por día en cuentas gratuitas). Subí el intervalo del sondeo en `app.js` o mirá quién dejó la app abierta todo el día. |
| Cambiaste el script y no se nota | Apps Script sirve la versión implementada, no la guardada. **Implementar → Gestionar implementaciones → editar → Versión: Nueva**. La URL no cambia. |
| Cambiaste el frontend y los móviles siguen con lo viejo | El service worker guarda la versión anterior. Subí `VERSION` en `sw.js` (`'v1'` → `'v2'`) y volvé a publicar. |
| No aparece la opción de instalar | Tiene que ser HTTPS. En `file://` o por IP local no va. |
| Te quedaste afuera | En el editor de Apps Script ejecutá `resetearPassword()`: la deja en `1234`. (`instalar()` ya no sirve para esto: respeta la contraseña que haya.) |
| Tocaste las hojas a mano y el saldo no cuadra | Hacé un arqueo y registrá el ajuste. El saldo vuelve a coincidir con el efectivo real. |

---

## Cambiar cosas

- **Categorías**: la constante `CATEGORIAS` al principio de `Codigo.gs`.
- **Hora de la copia diaria**: `crearDisparadores()`, y volvé a ejecutarla.
- **Intentos y bloqueo**: `LOCK_MAX_FALLOS`, `LOCK_MAX_GLOBAL`, `LOCK_VENTANA_MIN` y `LOCK_MINUTOS`.
- **Duración de la sesión**: `TOKEN_DIAS`.
- **Cada cuánto sondea**: el `setInterval` de 90000 ms en `app.js`.
- **Nombre de la app en el teléfono**: `<title>` en `index.html` y `name` / `short_name` en `manifest.webmanifest`. El texto de la cabecera es `nombreCaja`, en Ajustes.
- **Moneda**: `moneda` y `locale` en `config.js`.
- **Qué se guarda para abrir sin red**: la lista `ARCHIVOS` en `sw.js`.
