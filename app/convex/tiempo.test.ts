import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';
import { fechaOperativa, sumarDiasISO, validarFechaOperativaEnVentana } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');

describe('tiempo: obtenerFechaOperativaHoy (bloqueante de auditoría de PR 3)', () => {
  test('devuelve la fecha operativa real (America/Mexico_City), no la fecha UTC cruda', async () => {
    const t = convexTest(schema, modules);
    await crearParametrosPrueba(t, 4); // horaInicioTurno1:'06:00', zonaHoraria:'America/Mexico_City'
    const userId = await crearUsuarioPrueba(t, 'operador');
    const token = await crearSesionPrueba(t, userId);

    const resultado = await t.query(api.tiempo.obtenerFechaOperativaHoy, { token });
    const esperado = fechaOperativa(Date.now(), 'America/Mexico_City', '06:00');
    expect(resultado).toBe(esperado);
  });

  test('falla explícito si no hay parámetros de producción configurados', async () => {
    const t = convexTest(schema, modules);
    const userId = await crearUsuarioPrueba(t, 'operador');
    const token = await crearSesionPrueba(t, userId);
    await expect(t.query(api.tiempo.obtenerFechaOperativaHoy, { token })).rejects.toThrow(/parámetros de producción/);
  });

  test('requiere sesión válida', async () => {
    const t = convexTest(schema, modules);
    await crearParametrosPrueba(t, 4);
    await expect(t.query(api.tiempo.obtenerFechaOperativaHoy, { token: 'token-invalido' })).rejects.toThrow();
  });
});

// EDS-83: encontrado real — crearCierreTurno/crearEntrada(sBatch) aceptaban
// `fecha` del cliente sin validar nada (ni formato, ni rango, ni futura).
// Estas pruebas son al nivel de la función pura — la cobertura de que
// cierres.ts/entradas.ts la llaman de verdad vive en sus propios *.test.ts.
describe('lib/fechaOperativa: validarFechaOperativaEnVentana (EDS-83)', () => {
  const ZONA = 'America/Mexico_City';
  const HORA_T1 = '06:00';
  const HOY = fechaOperativa(Date.now(), ZONA, HORA_T1);

  test('rechaza formato inválido', () => {
    expect(() => validarFechaOperativaEnVentana('10-08-2026', ZONA, HORA_T1, 7)).toThrow(/formato YYYY-MM-DD/);
  });

  test('rechaza una fecha que no es calendario real (2026-02-30)', () => {
    expect(() => validarFechaOperativaEnVentana('2026-02-30', ZONA, HORA_T1, 7)).toThrow(/no es una fecha calendario real/);
  });

  test('rechaza una fecha futura', () => {
    const manana = sumarDiasISO(HOY, 1);
    expect(() => validarFechaOperativaEnVentana(manana, ZONA, HORA_T1, 7)).toThrow(/fecha futura/);
  });

  test('acepta "hoy" exacto', () => {
    expect(() => validarFechaOperativaEnVentana(HOY, ZONA, HORA_T1, 7)).not.toThrow();
  });

  test('con diasAtras:7 — acepta exactamente 7 días atrás, rechaza 8', () => {
    const hace7 = sumarDiasISO(HOY, -7);
    const hace8 = sumarDiasISO(HOY, -8);
    expect(() => validarFechaOperativaEnVentana(hace7, ZONA, HORA_T1, 7)).not.toThrow();
    expect(() => validarFechaOperativaEnVentana(hace8, ZONA, HORA_T1, 7)).toThrow(/hasta 7 días atrás/);
  });

  test('con diasAtras:null — acepta una fecha muy vieja sin límite hacia atrás (caso real: Entradas de material)', () => {
    expect(() => validarFechaOperativaEnVentana('2020-01-15', ZONA, HORA_T1, null)).not.toThrow();
  });
});
