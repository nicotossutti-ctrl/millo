# SOX · Videos 360° (MiniMax H3 → Drive)

App web independiente (no toca PFOS). Toma las fotos de cada SKU de tu Drive, hace girar cada media una vuelta completa con MiniMax H3 y sube a **TERMINADOS - VIDEOS/<SKU>/** el video vertical (`<SKU>.mp4`, 12 s o más según la cantidad de colores) y su descripción (`<SKU>.txt`).

## Qué hace, exactamente

1. **Escanea todo el Drive** desde la carpeta raíz y agrupa las fotos por el **nombre del archivo** (`TE132B-C1-NEGRO-01.webp` → SKU TE132B, color Negro). No importa en qué carpeta estén.
   - Usa **sólo las fotos originales**: las `-DARK` (fondo oscuro) no se usan. Si un color existe sólo en DARK, la pantalla lo avisa.
   - Descarta las `ALL` y las de `PACK` (fotos grupales), las copias (`(1)`, `- copia`), las texturas y las carpetas "Fotos en contexto".
   - De cada color usa **una sola foto**: la `-01` si hay varios ángulos. Las tomas `-OFF` / `REFLECTIVO` se usan sólo si ese color no tiene otra.
   - Productos de un solo color sin color en el nombre (`DE450C-01.webp`, `FU36B-FRENTE.webp`) salen como una variante "Único" (FRENTE es la vista principal).
   - Prefijos como `DAMA`/`HOMBRE` quedan en la etiqueta: "Negro (Dama)".
   - Códigos sin letra final: fotos `TE215-…` se suman a `TE215C` **sólo si** `TE215` no existe en el catálogo SOX y `TE215C` sí (lo marca en pantalla). Si hace falta forzar una unión, variable `SKU_ALIASES` (ej. `TE215=TE215C`).
   - En cada SKU ves las miniaturas y **podés sacar variantes con un clic** antes de generar.
2. **Prepara cada foto en 9:16** (1080×1920), estirando el fondo de la misma foto, sin franjas negras.
3. **MiniMax H3 768P** anima cada foto pidiendo una vuelta de 360°. Se le pasa la misma foto como primer y último cuadro para que termine de frente: **eso ayuda pero no garantiza los 360°**, por eso:
   - En la fila del SKU ves cada clip generado (pasá el mouse para reproducirlo).
   - Si uno no te gusta, **↻ regenera sólo ese clip** (USD 0,32 con 4 s) y se vuelve a armar el video.
   - Un aviso aproximado marca clips para mirar primero: **⚠ casi quieta** o **⚠ no termina de frente**. Detecta esos dos casos; no confirma que el giro sea completo.
4. **Arma el video**: cada color da **una vuelta de 4 s** y el video dura **al menos 12 s**: con 1 color se repite (A·A·A), con 2 vuelve el primero al final (A·B·A). Los repetidos usan el mismo clip, no se pagan de nuevo. El clip se **acelera o frena, no se recorta**, así no se pierde el final de la vuelta. Corte seco entre colores, sin audio. El armado se hace de a un SKU por vez (medido: 13–18 s con 1 CPU para 2 a 7 variantes, ~0,7 GB de RAM).
5. **Sube MP4 + TXT** a `TERMINADOS - VIDEOS/<SKU>/`. Si ya existían, los reemplaza.
6. **El TXT** tiene dos partes:
   - **GUION**: tu texto hablado, tomado del **Google Doc que se llame igual que el SKU** (como los de la carpeta CLIPS: `TE215C`, `TE251C`…). Si todavía no existe, lo deja indicado.
   - **DESCRIPCIÓN MERCADO LIBRE**: título y `Descripcion_conversion` de **PF_Master_v11 → PUBLICACIONES_OBJETIVO** (publicación x1).
   - **Actualizar TXT** rehace sólo el TXT, sin costo (por ejemplo después de escribir el guion).

| Colores | Secuencia | Largo del video | Se le pide a MiniMax | Costo aprox. (USD 0,08/s) |
|---|---|---|---|---|
| 1 | A·A·A | 12 s | 1 clip de 4 s | 0,32 |
| 2 | A·B·A | 12 s | 2 clips de 4 s | 0,64 |
| 3 | A·B·C | 12 s | 3 clips de 4 s | 0,96 |
| 4 | A·B·C·D | 16 s | 4 clips de 4 s | 1,28 |
| 5 | A·B·C·D·E | 20 s | 5 clips de 4 s | 1,60 |
| N > 5 | uno por color | N × 4 s | N clips de 4 s | N × 0,32 |

**Control de gasto**
- Antes de generar te muestra el costo estimado y te pide confirmación.
- Los SKUs que ya tienen video en TERMINADOS se marcan y se ocultan.
- **Procesar N pendientes** sólo incluye SKUs que existen en el catálogo SOX. Los que aparecen como "fuera del catálogo" (por ejemplo la línea reflectiva que no está en PV 26/27) se pueden procesar uno por uno.
- Nunca se vuelve a pagar un clip que ya salió bien: si se corta algo (cerraste la pestaña, falló una variante, venció el link de un clip), **Reintentar** regenera sólo lo que falta o falló. Queda guardado en ese navegador.

---

## Instalación (una sola vez, ~20 minutos)

Necesitás: la carpeta del proyecto descomprimida, Node.js instalado y tu cuenta de Vercel.

### Paso 1 · Subir a Vercel como proyecto nuevo

En la carpeta del proyecto: **Shift + clic derecho → Abrir PowerShell aquí**:

```
npx vercel@latest
```

Respondé:
- `Set up and deploy?` → **Y**
- `Which scope?` → tu cuenta
- `Link to existing project?` → **N** ← importante, así no toca PFOS
- `What's your project's name?` → `sox-minimax-batch`
- `In which directory is your code located?` → `./`
- `Want to modify these settings?` → **N**

Al final te da la URL de producción, por ejemplo `https://sox-minimax-batch.vercel.app`. **Anotala exacta**, la vas a usar en los pasos 3 y 4.

**Alternativa sin consola (arrastrar y soltar):** en Vercel, dentro del proyecto `sox-minimax-batch`, arrastrá la carpeta que tiene `package.json` **directamente adentro** (no una carpeta que la contenga). En la lista de archivos tienen que verse `package.json`, `app/…`, `lib/…` sin otro nombre adelante; si aparece el aviso "look like Other", soltaste la carpeta equivocada.

### Paso 2 · API key de MiniMax

En https://platform.minimax.io → **API Keys** → creá una y copiala. Cargá saldo en la cuenta (Billing).

### Paso 3 · Permiso para que la app entre a tu Drive (Google Cloud)

1. Entrá a https://console.cloud.google.com con **nicotossutti@gmail.com** y creá un proyecto nuevo, por ejemplo `SOX Videos`.
2. Buscá **Google Drive API** en la barra de búsqueda → **Habilitar**.
3. Menú → **Google Auth Platform** → **Comenzar**. Nombre de la app: `SOX Videos`, correo de asistencia: el tuyo, público: **Externo**, contacto: tu correo → Crear.
4. **Público** (Audience) → **Usuarios de prueba** → **Agregar usuarios** → `nicotossutti@gmail.com` → Guardar.
5. **Clientes** → **Crear cliente** → tipo **Aplicación web**:
   - Orígenes autorizados de JavaScript: `https://sox-minimax-batch.vercel.app` (tu URL del paso 1)
   - URI de redireccionamiento autorizados: `https://sox-minimax-batch.vercel.app/api/auth/google/callback`
   - Crear → copiá el **ID de cliente** y el **Secreto del cliente**.

### Paso 4 · Variables en Vercel

Vercel → proyecto `sox-minimax-batch` → **Settings → Environment Variables**. Cargá estas (entorno: Production):

| Nombre | Valor |
|---|---|
| `MINIMAX_API_KEY` | la key del paso 2 |
| `GOOGLE_CLIENT_ID` | ID de cliente del paso 3 |
| `GOOGLE_CLIENT_SECRET` | secreto del paso 3 |
| `APP_SECRET` | texto al azar de **32 caracteres o más** (ver abajo cómo generarlo) |
| `ALLOWED_EMAILS` | `nicotossutti@gmail.com` (las únicas cuentas de Google que pueden usar la app; separá con coma si agregás otra) |
| `APP_PASSWORD` | una contraseña para entrar a la web (recomendada: sin esto cualquiera ve la pantalla, aunque no pueda usarla) |
| `NEXT_PUBLIC_BASE_URL` | tu URL del paso 1, sin `/` al final |
| `DRIVE_ROOT_FOLDER_ID` | `1RFTQStpZh7Mh4KSaMwaeouYvNLvr6uAd` |
| `DRIVE_OUTPUT_FOLDER_ID` | `1ttwG1wyBlkmlhivEQxP10V42vx3avGj3` |
| `DRIVE_CATALOG_FILE_ID` | `1WNdDIxQP3IjFd5VCnIx3es88HIxPyQUD` |
| `DRIVE_TEXTS_FILE_ID` | `1UeZXjPpYZfEIUMhvH2G2hRLu1XRahXe3` |

Para generar `APP_SECRET`, en PowerShell:

```
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

Tip: si copiás las líneas de `.env.example` y las pegás en el campo "Key", Vercel las separa solas; completá las que están vacías antes de guardar.

### Paso 5 · Volver a publicar (para que tome las variables)

En la misma PowerShell:

```
npx vercel@latest --prod
```

### Paso 6 · Piloto con un solo SKU

1. Abrí tu URL → poné la contraseña (`APP_PASSWORD`) → **Conectar Google** → elegí tu cuenta. Google va a avisar "Google no verificó esta app": **Continuar** (la app es tuya).
2. **Escanear Drive** → en el filtro poné `TE132B` → revisá que salgan Negro, Blanco, Océano y Salmón → **Procesar**.
3. En ~3–6 minutos aparece "terminado" con el link a la carpeta. Mirá el video.
4. Si te gusta cómo gira, sacá el filtro y usá **Procesar N pendientes** (dejá la pestaña abierta; con "en paralelo 2" hace dos SKUs a la vez).

## Quién puede usarla (tu MiniMax está detrás)

Tres barreras, independientes entre sí:
1. **Contraseña de la web** (`APP_PASSWORD`): sin ella no carga ni la página ni ninguna función.
2. **Cuenta de Google autorizada** (`ALLOWED_EMAILS`): cada función que gasta o toca tu Drive revisa en cada pedido que la sesión sea de una cuenta de esa lista. Si está vacía no entra nadie. Sacar un mail de la lista le corta el acceso al instante.
3. **Login de Google protegido** (`state`): sólo se acepta la vuelta de un login que empezó en tu navegador.

Además: cargá el saldo de MiniMax de a poco (por ejemplo USD 20). Ese saldo es el techo real de lo que se puede gastar.

## Si algo falla

- **"Faltan variables en Vercel"**: falta cargar alguna del paso 4 o no hiciste el paso 5.
- **"La cuenta … no está autorizada"**: entraste con otra cuenta de Google. Tocá "desconectar" y volvé a entrar con la de `ALLOWED_EMAILS`.
- **"El inicio de sesión no empezó en este navegador o venció"**: tardaste más de 10 minutos en la pantalla de Google o abriste el link en otro navegador. Volvé a tocar "Conectar Google".
- **Error de Google `redirect_uri_mismatch`**: la URL del paso 3 tiene que ser idéntica a `NEXT_PUBLIC_BASE_URL` + `/api/auth/google/callback`.
- **"Sesión de Google vencida"** (pasa cada 7 días mientras la app está en modo prueba): tocá "Conectar Google" otra vez.
- **Una variante falla en MiniMax** (moderación, saldo): tocá **Reintentar**; sólo regenera esa.
- **Un clip no gira bien**: ↻ en ese clip y "Regenerar 1 clip". Si pasa seguido (media casi quieta), destildá "forzar que termine de frente" y probá de nuevo.

## Opcionales

`SKU_ALIASES` (uniones manuales de códigos, ej. `TE215=TE215C,XX10=XX10B`), `MINIMAX_MODEL` (default `MiniMax-H3`), `MINIMAX_RESOLUTION` (`768P` o `2K`), `MINIMAX_PRICE_PER_SECOND` (para el estimado; 2K es 0.13), `MINIMAX_BASE_URL` (default `https://api.minimax.io`).

## Local

```
npm install
cp .env.example .env.local   # completar, con NEXT_PUBLIC_BASE_URL=http://localhost:3000
npm run dev
```
(En Google Cloud agregá también `http://localhost:3000` y `http://localhost:3000/api/auth/google/callback`.)
