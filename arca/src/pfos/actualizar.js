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
import { dirFotos } from './fotos.js';

function escribir(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * Con una conexión ya abierta (o una función de consulta compatible con pg), controla el rol y la cuenta, lee y arma los
 * meses pedidos. Devuelve las fotos (no escribe). `cuentaEsperada`: FISCALOS_PFOS_CUENTA.
 */
export async function fotosDesde(db, { meses, outDir, cuentaEsperada = null, log = () => {} }) {
  const rol = await controlarRol(db);
  log(`Rol de solo lectura comprobado: ${rol}`);
  const cuenta = await controlarCuenta(db, cuentaEsperada);
  log(`Cuenta de las vistas: ${cuenta}${cuentaEsperada ? ' (la configurada)' : ' (configurá FISCALOS_PFOS_CUENTA para fijarla)'}`);
  const comunes = await leerComunes(db);
  log(`Listas de costos: ${comunes.listas.map((l) => `${l.supplier} desde ${l.valid_from}`).join(', ') || 'ninguna'} · SKU con decisión en PFOS: ${comunes.mapeos.size}`);
  const datosDir = path.join(outDir, 'datos');
  const fotos = [];
  for (const mes of meses) {
    log(`Leyendo ${mes}…`);
    const datos = await leerMes(db, mes);
    const arca = textoComprobantes(datosDir, 'comprobantes-emitidos', 'emitidos', mes);
    const foto = armarMes({ mes, datos, comunes, textosArca: arca ? [arca.texto] : [] });
    foto.rol = rol; foto.cuentaPfos = cuenta;
    fotos.push(foto);
    log(`  ${mes}: ${foto.ventas.ordenes} órdenes · costo ${foto.lineas['costo-mercaderia'].importe} (${foto.costo.cobertura ?? '—'} % de unidades) · cuenta ${foto.cuenta.verificada ? 'verificada' : `NO verificada: ${foto.cuenta.motivo}`}`);
  }
  return fotos;
}

/** Comando completo: conecta con FISCALOS_PFOS_URL, arma las fotos y las guarda. */
export async function actualizarPfos({ outDir, meses, url = process.env.FISCALOS_PFOS_URL, cuentaEsperada = process.env.FISCALOS_PFOS_CUENTA ?? null, log = console.error }) {
  const db = await conectar(url);
  try {
    const fotos = await fotosDesde(db, { meses, outDir, cuentaEsperada, log });
    for (const f of fotos) escribir(path.join(dirFotos(outDir), `${f.mes}.json`), JSON.stringify(f, null, 2));
    return fotos;
  } finally {
    await db.end().catch(() => {});
  }
}
