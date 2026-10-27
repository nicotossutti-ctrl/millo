/**
 * `pfos:actualizar`: lee PFOS (solo lectura, solo la cuenta del contribuyente) y deja una FOTO por mes en
 * out/pfos/AAAA-MM.json. La app de FiscalOS usa esas fotos: no se conecta a PFOS cada vez que se abre un mes, y lo que
 * muestra queda fechado («datos de PFOS del …»). Nada de esto va al repositorio (out/ está ignorado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { conectar, controlarRol, controlarCuenta, leerComunes, leerMes } from './lectura.js';
import { armarMes } from './mes.js';
import { textoComprobantes } from '../app/rentabilidad.js';
import { dirFotos, leerFotos } from './fotos.js';
import { titularidad } from './cuenta.js';
import { UNIDAD_CONFIRMADA } from './costos.js';

function escribir(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * La cuenta es OBLIGATORIA y no puede ser una excluida (FISCALOS_PFOS_EXCLUIDAS: la otra cuenta, de otro CUIT). Sin esto
 * no se abre ninguna conexión.
 */
export function controlarConfiguracion(cuentaEsperada, excluidas = []) {
  if (!/^\d{6,12}$/.test(String(cuentaEsperada ?? ''))) throw new Error('falta FISCALOS_PFOS_CUENTA en arca\\.env (el user_id de Mercado Libre de la cuenta de tu CUIT): sin ella no se lee nada');
  if (excluidas.map(String).includes(String(cuentaEsperada))) throw new Error(`FISCALOS_PFOS_CUENTA (${cuentaEsperada}) está en FISCALOS_PFOS_EXCLUIDAS: esa cuenta es de otro CUIT y no se lee`);
}

/**
 * Con una conexión ya abierta (o una función de consulta compatible con pg), controla el rol y la cuenta, lee y arma los
 * meses pedidos. Devuelve las fotos (no escribe). `cuentaEsperada`: FISCALOS_PFOS_CUENTA.
 */
export async function fotosDesde(db, { meses, outDir, cuentaEsperada, excluidas = [], log = () => {}, generado = new Date().toISOString() }) {
  controlarConfiguracion(cuentaEsperada, excluidas);
  const rol = await controlarRol(db);
  log(`Rol de solo lectura comprobado: ${rol}`);
  const cuenta = await controlarCuenta(db, cuentaEsperada);
  log(`Cuenta de las vistas: ${cuenta} (la configurada en FISCALOS_PFOS_CUENTA)`);
  const comunes = await leerComunes(db);
  log(`Listas de costos: ${comunes.listas.map((l) => `${l.supplier} desde ${l.valid_from}`).join(', ') || 'ninguna'} · SKU con decisión en PFOS: ${comunes.mapeos.size}`);
  const pendientes = [...new Set([...comunes.itemsPorLista.values()].flat().filter((it) => it.presentation === 'A_CONFIRMAR')
    .map((it) => String(it.code).toUpperCase().replace(/\s+/g, '')).filter((c) => !UNIDAD_CONFIRMADA.has(c)))].sort();
  log(pendientes.length ? `Artículos «A CONFIRMAR» de la lista sin unidad confirmada (quedan sin costo): ${pendientes.join(', ')}` : 'Todos los artículos «A CONFIRMAR» de la lista tienen su unidad confirmada.');
  if (!comunes.ads?.filas) log('AVISO: la vista fiscalos.ads_diario no devuelve ninguna fila: la publicidad queda «sin datos» (no 0). Si PFOS tiene Mercado Ads, correr docs/pfos-correccion-1.sql.');
  else log(`Mercado Ads: ${comunes.ads.filas} filas, del ${comunes.ads.desde} al ${comunes.ads.hasta}`);
  const datosDir = path.join(outDir, 'datos');
  const fotos = [];
  for (const mes of meses) {
    log(`Leyendo ${mes}…`);
    const datos = await leerMes(db, mes);
    const arca = textoComprobantes(datosDir, 'comprobantes-emitidos', 'emitidos', mes);
    const foto = armarMes({ mes, datos, comunes, textosArca: arca ? [arca.texto] : [], generado });
    foto.rol = rol; foto.cuentaPfos = cuenta;
    fotos.push(foto);
  }
  // Titularidad: un mes sin evidencia propia (el mes en curso) puede apoyarse en otro mes verificado por CAE con la misma
  // cuenta: rentabilidad operativa provisoria, conciliación fiscal pendiente.
  const otras = [...fotos, ...leerFotos(outDir).filter((f) => !fotos.some((x) => x.mes === f.mes))];
  for (const foto of fotos) {
    const t = titularidad(foto, otras);
    const pub = foto.lineas.publicidad;
    log(`  ${foto.mes}${foto.mesCerrado ? '' : ` (al corte del ${foto.corte ?? '—'})`}: ${foto.ventas.ordenes} órdenes · costo ${foto.lineas['costo-mercaderia'].importe} (${foto.costo.cobertura ?? '—'} % de unidades; ${foto.costo.unidadesParaRevision ?? 0} u. para revisión) · publicidad ${pub.importe == null ? 'SIN DATOS' : `${pub.importe} (${foto.ads.dias}/${foto.ads.diasEsperados} días)`}`);
    log(`     cuenta: ${foto.cuenta.verificada ? 'verificada por CAE' : t.provisoria ? `provisoria — ${t.motivo}` : `NO verificada: ${foto.cuenta.motivo}`}`);
    const motivos = Object.entries(foto.costo.motivos ?? {}).sort((a, b) => b[1] - a[1]);
    if (motivos.length) log(`     sin costo, por motivo: ${motivos.map(([k, n]) => `${k} ${n} u.`).join(' · ')}`);
  }
  return fotos;
}

/** Comando completo: controla la configuración, conecta (arca\\.env), arma las fotos y las guarda. */
export async function actualizarPfos({ outDir, meses, cuentaEsperada = process.env.FISCALOS_PFOS_CUENTA,
  excluidas = String(process.env.FISCALOS_PFOS_EXCLUIDAS ?? '').split(/[,\s]+/).filter(Boolean), log = console.error }) {
  controlarConfiguracion(cuentaEsperada, excluidas); // antes de conectar
  const db = await conectar();
  try {
    const fotos = await fotosDesde(db, { meses, outDir, cuentaEsperada, excluidas, log });
    for (const f of fotos) escribir(path.join(dirFotos(outDir), `${f.mes}.json`), JSON.stringify(f, null, 2));
    return fotos;
  } finally {
    await db.end().catch(() => {});
  }
}
