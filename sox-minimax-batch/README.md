# SOX · Videos 360° (MiniMax H3 → Drive)

App web independiente (no toca PFOS). Toma las fotos de cada SKU de tu Drive, hace girar cada media una vuelta completa con MiniMax H3 y sube a **TERMINADOS - VIDEOS/<SKU>/** el video vertical de 15 segundos (`<SKU>.mp4`) y su descripción (`<SKU>.txt`).

## Qué hace, exactamente

1. **Escanea todo el Drive** desde la carpeta raíz y agrupa las fotos por el **nombre del archivo** (`TE132B-C1-NEGRO-01.webp` → SKU TE132B, color Negro). No importa en qué carpeta estén.
   - Descarta las `ALL` (la foto con todas juntas), las texturas y las carpetas "Fotos en contexto".
   - De cada color usa **una sola foto**: la `-01` si hay varios ángulos.
   - Si el color tiene versión **fondo oscuro** (`-DARK`), usa esas. Si al SKU le falta la versión oscura de algún color, usa las originales para que no falte ninguno. En la pantalla lo podés cambiar.
   - Las tomas `REFLECTIVO` se usan sólo si ese color no tiene otra foto.
   - En cada SKU ves las miniaturas y **podés sacar variantes con un clic** antes de generar.
2. **Prepara cada foto en 9:16** (1080×1920), estirando el fondo de la misma foto, sin franjas negras.
3. **MiniMax H3 768P** anima cada foto: la media da **una vuelta completa de 360°** y termina de frente (se le pasa la misma foto como primer y último cuadro).
4. **Arma el video de 15 s exactos**: cada variante ocupa 15 / N segundos. El clip se **acelera o frena, no se recorta**, así la vuelta siempre queda entera. Corte seco entre colores, sin audio.
5. **Sube MP4 + TXT** a `TERMINADOS - VIDEOS/<SKU>/`. Si ya existían, los reemplaza.
6. El TXT sale de **PF_Master_v11 → PUBLICACIONES_OBJETIVO** (título y `Descripcion_conversion` de la publicación x1). Si el SKU no está ahí, arma un texto con los datos técnicos del catálogo SOX.

| Variantes | Segundos por color en el video | Segundos que se le piden a MiniMax | Costo aprox. (USD 0,08/s) |
|---|---|---|---|
| 2 | 7,5 | 8 c/u | 1,28 |
| 3 | 5 | 5 c/u | 1,20 |
| 4 | 3,75 | 4 c/u | 1,28 |
| 5 | 3 | 4 c/u | 1,60 |
| 7 | 2,1 | 4 c/u | 2,24 |

**Control de gasto**
- Antes de generar te muestra el costo estimado y te pide confirmación.
- Los SKUs que ya tienen video en TERMINADOS se marcan y se ocultan.
- Si se corta algo (cerraste la pestaña, falló el armado, falló una variante), al volver a tocar **Procesar/Reintentar** reutiliza lo que ya se generó y sólo regenera lo que falta. Queda guardado en ese navegador.

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
| `APP_SECRET` | cualquier texto largo inventado (ej. 40 letras y números al azar) |
| `NEXT_PUBLIC_BASE_URL` | tu URL del paso 1, sin `/` al final |
| `DRIVE_ROOT_FOLDER_ID` | `1RFTQStpZh7Mh4KSaMwaeouYvNLvr6uAd` |
| `DRIVE_OUTPUT_FOLDER_ID` | `1ttwG1wyBlkmlhivEQxP10V42vx3avGj3` |
| `DRIVE_CATALOG_FILE_ID` | `1WNdDIxQP3IjFd5VCnIx3es88HIxPyQUD` |
| `DRIVE_TEXTS_FILE_ID` | `1UeZXjPpYZfEIUMhvH2G2hRLu1XRahXe3` |

Tip: si copiás las líneas de `.env.example` y las pegás en el campo "Key", Vercel las separa solas; completá las que están vacías antes de guardar.

### Paso 5 · Volver a publicar (para que tome las variables)

En la misma PowerShell:

```
npx vercel@latest --prod
```

### Paso 6 · Piloto con un solo SKU

1. Abrí tu URL → **Conectar Google** → elegí tu cuenta. Google va a avisar "Google no verificó esta app": **Continuar** (la app es tuya).
2. **Escanear Drive** → en el filtro poné `TE132B` → revisá que salgan Negro, Blanco, Océano y Salmón → **Procesar**.
3. En ~3–6 minutos aparece "terminado" con el link a la carpeta. Mirá el video.
4. Si te gusta cómo gira, sacá el filtro y usá **Procesar N pendientes** (dejá la pestaña abierta; con "en paralelo 2" hace dos SKUs a la vez).

## Si algo falla

- **"Faltan variables en Vercel"**: falta cargar alguna del paso 4 o no hiciste el paso 5.
- **Error de Google `redirect_uri_mismatch`**: la URL del paso 3 tiene que ser idéntica a `NEXT_PUBLIC_BASE_URL` + `/api/auth/google/callback`.
- **"Sesión de Google vencida"** (pasa cada 7 días mientras la app está en modo prueba): tocá "Conectar Google" otra vez.
- **Una variante falla en MiniMax** (moderación, saldo): tocá **Reintentar**; sólo regenera esa.
- **La media no gira completa o queda casi quieta**: destildá "forzar que termine de frente" y probá de nuevo ese SKU.

## Opcionales

`MINIMAX_MODEL` (default `MiniMax-H3`), `MINIMAX_RESOLUTION` (`768P` o `2K`), `MINIMAX_PRICE_PER_SECOND` (para el estimado; 2K es 0.13), `MINIMAX_BASE_URL` (default `https://api.minimax.io`).

## Local

```
npm install
cp .env.example .env.local   # completar, con NEXT_PUBLIC_BASE_URL=http://localhost:3000
npm run dev
```
(En Google Cloud agregá también `http://localhost:3000` y `http://localhost:3000/api/auth/google/callback`.)
