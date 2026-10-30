# FiscalOS ← PFOS: qué toma FiscalOS, qué no y cómo se conecta

**Separación (decisión de Nicolás, 28/10/2026).** PFOS es la única fuente comercial: ventas, costo de la mercadería,
equivalencias, packs y variantes, comisiones, Mercado Ads, Flex, Full, logística y la rentabilidad comercial por mes,
publicación, SKU y variante. FiscalOS es impositivo: IVA, IIBB, Ganancias, autónomos, DDJJ, retenciones, percepciones,
anticipos, pagos, deudas y vencimientos, y la **conciliación** de lo fiscal con PFOS. FiscalOS no tiene un segundo motor
de costos ni de rentabilidad. **No se modificó PFOS ni su base.**

## 1. Qué toma FiscalOS de PFOS (solo PALERMO FITNESS)

| Dato | De dónde (vistas de `fiscalos`) | Para qué |
|---|---|---|
| Titularidad de la cuenta | Facturas a clientes con su CAE (`conciliacion`, fuente `comprobante`; `facturas_clientes`) | Verificar que la cuenta de Mercado Libre es del CUIT: el CAE tiene que estar en tus comprobantes emitidos de ARCA (sección 4) |
| Ventas del mes con IVA | `ordenes` (fecha de venta en hora de Argentina; canceladas aparte) | **Control** contra la facturación de ARCA (facturado − ventas de ML). No reemplaza a los comprobantes emitidos |
| Retenciones de Mercado Pago | `cobros_mp`: `charges_details` de tipo impuesto a cargo del vendedor, una vez por pago | Anticipos de impuestos para conciliar con IIBB y Mis Retenciones |
| Cobertura | `cobertura` (días del mes con recolección completa) | Saber si las cifras del mes están completas al corte |

**Para proyectar Ganancias**, FiscalOS necesita el *resultado comercial* de cada mes, **antes de impuestos** (ventas −
mercadería − cargos de ML − publicidad − logística − gastos generales), tal como lo calcula PFOS. Hasta que PFOS lo
exponga consolidado (con período, cuenta, fuente, versión y cobertura), se carga a mano o por archivo en FiscalOS
(concepto «Resultado comercial del mes»). FiscalOS le resta IIBB y autónomos y aplica la escala; sin el resultado de algún
mes del año, la provisión dice «no estimable». La proyección nunca es la DJ anual (F.711), ni un anticipo, ni un saldo.

**Las demás vistas** del esquema (`ads_diario`, `devoluciones`, `importaciones`, `costos_*`) quedan instaladas y sin uso.
Cuando PFOS exponga sus resultados consolidados, el acceso se simplifica a esa interfaz (se plantea antes, como cambio
aparte).

## 2. Qué no toma FiscalOS de PFOS

- Costos, comisiones, publicidad, logística, Full, Flex y rentabilidad: los calcula PFOS.
- Ingresos Brutos determinado (CM03), cuota de autónomos y DJ anual de Ganancias: salen de ARCA o SIFERE (o se cargan
  desde el cartel de pendientes).
- La otra cuenta de Mercado Libre: **no se lee** (otro CUIT).

## 3. Lo comercial que FiscalOS ya no hace

Hasta el 28/10 FiscalOS tenía una pestaña «Rentabilidad» con costos y cargos calculados desde PFOS. Se sacó: sus cargas
manuales e importaciones viejas (por ejemplo, el costo estimado de septiembre de $ 66.500.000) se **conservan** en
`out/importados/` y se pueden ver, corregir o borrar, pero no se crean nuevas. La clasificación de proveedores
(`out/importados/proveedores.json`) también se conserva sin uso.

## 4. Separación de cuentas (solo PALERMO)

1. **En la base.** El rol de FiscalOS solo puede leer las vistas del esquema `fiscalos`, que filtran por el `user_id` de
   PALERMO (`docs/pfos-acceso.sql`):
   - las vistas tienen `security_barrier`: el filtro por cuenta se aplica antes que cualquier condición de una consulta;
   - para ese rol, las filas de la otra cuenta no existen;
   - tampoco puede leer las tablas de PFOS ni `ml_accounts` (los tokens).
2. **En FiscalOS, la configuración:**
   - `FISCALOS_PFOS_CUENTA` es **obligatoria**: sin ella no se abre ninguna conexión;
   - `FISCALOS_PFOS_EXCLUIDAS` (la otra cuenta) nunca se acepta como cuenta;
   - cada vista tiene que traer una sola cuenta, la configurada.
3. **Por CAE.** Las facturas a clientes de la cuenta, del reporte de comprobantes cargado en «Conciliación» de PFOS, tienen
   que estar en **tus comprobantes emitidos de ARCA** con el **mismo CAE** y el mismo punto de venta y número:
   - hacen falta al menos 20 CAE **distintos** en el mes (se cuentan facturas, no filas de productos), y que coincida el
     95 %; un CAE que aparece con dos números distintos no cuenta;
   - punto de venta + número solos **nunca** validan, porque se repiten entre CUIT distintos;
   - sin evidencia suficiente, el mes queda «cuenta no verificada» y sus datos no se usan.

## 5. Seguridad del acceso

- **Rol propio, mínimo.** `fiscalos_lectura`:
  - solo tiene `SELECT` sobre las vistas, con la sesión en solo lectura;
  - se crea con SQL, **no** desde la consola de Neon (los roles de la consola heredan `neon_superuser`).
- **Controles antes de leer.** Si el rol no cumple con algo de esto, FiscalOS no lee nada:
  - no es superusuario;
  - no hereda permisos de otro rol;
  - no es dueño de ningún objeto;
  - no puede escribir en ninguna tabla;
  - **no puede crear** objetos en ningún esquema ni esquemas en la base;
  - no puede leer tablas de PFOS directamente.
- **Objetos temporales.** PostgreSQL deja crearlos a todos los roles (privilegio TEMP de PUBLIC). Duran lo que dura la
  sesión y no tocan datos de PFOS. Quitarlo afectaría a todos los roles de la base, así que se deja como está.
- **Clave.**
  - La genera `fiscalos.ps1 pfos-clave` con el generador criptográfico de Node (`crypto.randomBytes`, 256 bits, 64
    caracteres hexadecimales). Solo usa 0-9 y a-f, así que no hay que codificarla para la URL.
  - Queda **solo** en `arca\.env` (`FISCALOS_PFOS_CLAVE`).
  - El SQL lleva el **verificador SCRAM-SHA-256** (la clave cifrada, como la guarda PostgreSQL): la clave real no aparece
    en el SQL ni en el historial de Neon.
- **URL.** FiscalOS la arma desde `FISCALOS_PFOS_HOST`, `FISCALOS_PFOS_BASE` y la clave, con el usuario fijo
  `fiscalos_lectura`:
  - forma: `postgresql://fiscalos_lectura:<clave>@<host>/<base>?sslmode=require`;
  - si se usa `FISCALOS_PFOS_URL` a mano, la clave va codificada para URL (`encodeURIComponent`);
  - FiscalOS rechaza una URL con otro usuario (por ejemplo, el dueño).
- **Nada público.** Las fotos por mes quedan en `out/pfos/` (local, fuera de git). La app escucha solo en 127.0.0.1.

## 6. Instalación (cuando Nicolás lo apruebe)

1. **Proyecto correcto.** En Neon, abrir el proyecto de **PFOS Mercado Libre**: es la base con `pfos_money_records`, **no**
   «PFOS TASKS».
2. **Comprobación previa (solo lectura).** Abrir `docs/pfos-comprobacion.sql` y reemplazar `<ID_CUENTA>` (PALERMO) y
   `<ID_EXCLUIDA>` (la otra cuenta). Correrlo en el SQL Editor. Devuelve 16 filas, cada una con su resultado:
   - **BLOQUEA**: estructura incompatible (tablas o columnas), cuenta incorrecta o permisos inseguros (PUBLIC puede leer
     tablas de PFOS o crear en `public`). **No se instala**: se manda el resultado para revisarlo. El SQL de acceso no
     cambia permisos globales de la base;
   - **advertencia**: faltan datos (días de ventas, cobros o Ads; menos de 20 CAE distintos en septiembre u octubre;
     reportes). Se puede instalar: ese mes queda incompleto o «cuenta no verificada» en FiscalOS, con su diagnóstico a la
     vista;
   - si la consulta falla con «relation "pfos_money_records" does not exist», es la base equivocada.
3. **Clave.** En la PC: `fiscalos.ps1 actualizar` y después `fiscalos.ps1 pfos-clave`:
   - guarda la clave en `arca\.env`;
   - imprime el verificador (`SCRAM-SHA-256$4096:…`).
4. **Acceso.** Abrir `docs/pfos-acceso.sql`, reemplazar `<ID_CUENTA>` y `<VERIFICADOR>`, y correrlo **como dueño**:
   - si Neon rechaza el verificador, correr `fiscalos.ps1 pfos-clave -Nueva -Texto`, usar esa clave en su lugar y después
     borrar ese SQL del historial;
   - al final del archivo están las comprobaciones (todas `false`) y cómo deshacer.
5. **Configuración.** En `arca\.env` (ver `.env.example`):
   - `FISCALOS_PFOS_HOST`: el host del proyecto, de la cadena de conexión de Neon;
   - `FISCALOS_PFOS_BASE`;
   - `FISCALOS_PFOS_CUENTA` (PALERMO);
   - `FISCALOS_PFOS_EXCLUIDAS` (la otra cuenta).
6. **Prueba.** `fiscalos.ps1 pfos -Periodo "2026-09,2026-10"`. La consola dice:
   - qué rol se usó y que pasó los controles;
   - si la cuenta quedó verificada por CAE en cada mes (o en otro mes, con la conciliación fiscal pendiente);
   - las ventas del mes con IVA y las retenciones de Mercado Pago, con su cobertura.

## 7. Corrección 1 (sobre la instalación ya hecha; no se reinstala nada)

**Qué corrigió.** Al pegar `pfos-acceso.sql`, la «ñ» de `'campaña'` llegó con otra codificación y la vista de Mercado Ads
quedó vacía (`'campaÃ±a'`). La corrección escribe la ñ como `U&'campa\00F1a'` (solo ASCII, no depende de la
codificación) y suma a `fiscalos.costos_items` la descripción y el código como figura en la lista.

**Estado:** aplicada en la base real el 27/10 (revisión de la PR #2): Ads devuelve septiembre 30 días y octubre 26 días.
No hace falta volver a correrla. FiscalOS ya no lee esas dos vistas (Ads y costos son de PFOS); el archivo queda para
instalaciones que no la tengan. `pfos-acceso.sql` ya trae la forma corregida.

## 8. Decisiones de costo confirmadas (para implementar en PFOS, no en FiscalOS)

Confirmadas por Nicolás durante la revisión de la PR #2 (27 y 28/10/2026). Se dejan anotadas para trabajarlas en PFOS:
- **VINCHA = VINCHA01**, por unidad; **MUÑE = MUÑEQUERA01**, por par; TE172 = TE75C; DE160A = DE160C.
- Manguitas (MA01C, MA10C, MA20C, MA21C, MA26C) y pantorrilleras (PA01C, PA10C, PA21C, PA26C, FUPA01C, FUPA02C,
  HOCKEY01) «A CONFIRMAR»: por par.
- **PANTU01** por par, con el costo del talle vendido: adulto M/L/XL $ 11.400; niño 1/2 $ 9.600; caminante $ 8.000 (de
  lista, sin IVA, antes del factor 0,855). Sin talle inequívoco, queda para revisión.
- **PANTU64**: el mismo costo de fábrica que PANTU01 para el mismo talle; por par.
- **PIERNA = PIERNA 1** (medias de motocross), $ 12.100 de lista, factor 0,665.
- Lo que falte costear no es cero: se estima a la vista o el costo no se da por completo. Un reporte con cobertura sin
  validar no cuenta como completo.
