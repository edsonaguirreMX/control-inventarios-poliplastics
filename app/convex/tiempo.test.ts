import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';
import { fechaOperativa } from './lib/fechaOperativa';

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
