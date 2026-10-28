/**
 * `pfos:actualizar`: lee de PFOS lo FISCAL (solo lectura, solo la cuenta del contribuyente) y deja una FOTO por mes en
 * out/pfos/AAAA-MM.json: verificación de la cuenta por CAE, ventas como control y retenciones de Mercado Pago. La app
 * usa esas fotos: no se conecta a PFOS cada vez que se abre un mes, y lo que muestra queda fechado («datos de PFOS del …»). Nada de esto va al repositorio (out/ está ignorado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { conectar, controlarRol, controlarCuenta, leerMes } from './lectura.js';
import { armarMes } from './mes.js';
import { textoComprobantes } from '../app/comprobantes.js';
import { dirFotos, leerFotos } from './fotos.js';
import { titularidad } from './cuenta.js';

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
  const datosDir = path.join(outDir, 'datos');
  const fotos = [];
  for (const mes of meses) {
    log(`Leyendo ${mes}…`);
    const datos = await leerMes(db, mes);
    const arca = textoComprobantes(datosDir, 'comprobantes-emitidos', 'emitidos', mes);
    const foto = armarMes({ mes, datos, textosArca: arca ? [arca.texto] : [], generado });
    foto.rol = rol; foto.cuentaPfos = cuenta;
    fotos.push(foto);
  }
  // Titularidad: un mes sin evidencia propia (el mes en curso) puede apoyarse en otro mes verificado por CAE con la misma
  // cuenta; su conciliación fiscal sigue pendiente.
  const otras = [...fotos, ...leerFotos(outDir).filter((f) => !fotos.some((x) => x.mes === f.mes))];
  for (const foto of fotos) {
    const t = titularidad(foto, otras);
    log(`  ${foto.mes}${foto.mesCerrado ? '' : ` (al corte del ${foto.corte ?? '—'})`}: ${foto.ventas.ordenes} órdenes, ${foto.ventas.totalConIva} con IVA · retenciones de MP ${foto.retencionesMp.importe} (${foto.retencionesMp.cobertura ?? '—'} % de las ventas con su cobro)`);
    log(`     cuenta: ${foto.cuenta.verificada ? 'verificada por CAE' : t.usable ? `verificada en otro mes — ${t.motivo}` : `NO verificada: ${foto.cuenta.motivo}`}`);
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
