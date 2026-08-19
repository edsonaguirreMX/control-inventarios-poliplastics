import { convexTest } from 'convex-test';
import { describe, expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { internal, api } from './_generated/api';
import { crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba, crearRolesPrueba } from './testHelpers';
import { horaLocalAInstante } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');
const ZONA = 'America/Mexico_City';
const T1 = '06:00';

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearRolesPrueba(t); // EDS-105: requireAcceso resuelve el rol contra la tabla `roles`
  await crearParametrosPrueba(t, 4);
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, adminToken, comprasToken };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reporteDiario: getConfig/guardarConfig (tarea 8.1)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.reporteDiario.getConfig, { token: comprasToken })).rejects.toThrow();
    await expect(
      t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: [], token: comprasToken })
    ).rejects.toThrow();
  });

  test('getConfig devuelve valores por default si nunca se ha configurado', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const config = await t.query(api.reporteDiario.getConfig, { token: adminToken });
    expect(config.activo).toBe(false);
    expect(config.correos).toEqual([]);
  });

  test('guardarConfig persiste — leerlo de nuevo conserva el valor', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, {
      hora: '14:30', activo: true, correos: ['a@tejaflex.com', 'b@tejaflex.com'], whatsapp: ['+52 33 1234 5678'], token: adminToken,
    });
    const config = await t.query(api.reporteDiario.getConfig, { token: adminToken });
    expect(config).toMatchObject({ hora: '14:30', activo: true, correos: ['a@tejaflex.com', 'b@tejaflex.com'] });
  });

  test('rechaza hora con formato inválido', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.reporteDiario.guardarConfig, { hora: '25:99', activo: true, correos: [], whatsapp: [], token: adminToken })
    ).rejects.toThrow(/hora inválida/);
  });

  test('rechaza un correo con formato inválido', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: ['no-es-correo'], whatsapp: [], token: adminToken })
    ).rejects.toThrow(/correo válido/);
  });

  // EDS-69 Fase 1 — antes de esta fase no existía ninguna validación de
  // formato de teléfono (el campo se capturaba pero nunca se usaba).
  test('rechaza un número de WhatsApp con formato inválido', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: ['33-1234'], token: adminToken })
    ).rejects.toThrow(/WhatsApp válido/);
  });

  // Ajuste 3 del Go del usuario — normaliza ANTES de guardar, para no
  // terminar con "Juan@X.com" y "juan@x.com" como 2 destinatarios.
  test('normaliza correo (trim+lowercase) y WhatsApp (limpia espacios/guiones/paréntesis) antes de guardar', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, {
      hora: '14:00', activo: true, correos: ['  Juan@Tejaflex.COM  '], whatsapp: ['+52 (33) 1234-5678'], token: adminToken,
    });
    const config = await t.query(api.reporteDiario.getConfig, { token: adminToken });
    expect(config.correos).toEqual(['juan@tejaflex.com']);
    expect(config.whatsapp).toEqual(['+523312345678']);
  });
});

describe('reporteDiario: generarReporteAhora (tarea 8.1)', () => {
  test('inserta un registro "manual" cada vez, sin deduplicar (a diferencia del cron)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken });
    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken });
    const historial = await t.query(api.reporteDiario.listHistorial, { token: adminToken });
    expect(historial.filter((h) => h.generadoPor === 'manual')).toHaveLength(2);
  });

  test('destinatariosCount refleja lo configurado', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, {
      hora: '14:00', activo: true, correos: ['a@tejaflex.com', 'b@tejaflex.com'], whatsapp: ['+523312345678'], token: adminToken,
    });
    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken });
    const historial = await t.query(api.reporteDiario.listHistorial, { token: adminToken });
    expect(historial[0].destinatariosCount).toBe(3);
  });

  test('BLOQUEANTE (auditoría PR6): también crea una notificación in-app en la campana, no solo el registro de historial', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, comprasToken } = await setup(t);
    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken });

    // Visible como no leída para un rol destinatario real (Compras, uno de
    // ROLES_DASHBOARD) — sin esto, el reporte quedaba "invisible" salvo que
    // alguien entrara a mano al historial de Reporte Diario.
    const noLeidas = await t.query(api.alertas.noLeidasParaMi, { token: comprasToken });
    const notif = noLeidas.find((n) => n.reglaSlug === 'reporte-diario-generado');
    expect(notif).toBeDefined();
    expect(notif?.nombreRegla).toBe('Reporte diario generado');
    expect(notif?.detalle).toMatch(/vista de impresión/);
  });
});

describe('reporteDiario: generarReporteDiario — cron (tarea 8.2)', () => {
  test('no genera nada si el reporte está desactivado', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: false, correos: [], whatsapp: [], token: adminToken });
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    const historial = await t.query(api.reporteDiario.listHistorial, { token: adminToken });
    expect(historial).toHaveLength(0);
  });

  test('no genera nada antes de la hora configurada', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: [], token: adminToken });

    const fakeNow = horaLocalAInstante('2026-08-11', '13:00', ZONA); // 1h antes
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    const historial = await t.run((ctx) => ctx.db.query('reporteDiarioHistorial').collect());
    expect(historial).toHaveLength(0);
  });

  test('genera exactamente UN registro "cron" por día operativo, sin importar cuántas veces corra el cron ese día', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: ['a@tejaflex.com'], whatsapp: [], token: adminToken });

    const fakeNow = horaLocalAInstante('2026-08-11', '14:05', ZONA); // 5 min después de la hora
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});

    const historial = await t.run((ctx) => ctx.db.query('reporteDiarioHistorial').collect());
    expect(historial.filter((h) => h.generadoPor === 'cron')).toHaveLength(1);
    expect(historial[0].destinatariosCount).toBe(1);
  });

  test('BLOQUEANTE (auditoría PR6): el cron también crea UNA notificación in-app no leída visible para el rol destinatario, sin duplicar en corridas repetidas', async () => {
    const t = convexTest(schema, modules);
    // La hora falsa se fija ANTES de crear las sesiones — si no, expiresAt
    // (calculado con la hora real) quedaría en el pasado en cuanto
    // adelantamos el reloj, y las queries/mutations fallarían por "sesión
    // expirada" en vez de probar lo que este test busca probar.
    const fakeNow = horaLocalAInstante('2026-08-11', '14:05', ZONA);
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    const { adminToken, comprasToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: [], token: adminToken });

    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    await t.mutation(internal.reporteDiario.generarReporteDiario, {}); // repetido — no debe duplicar la notificación

    const notificaciones = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(notificaciones.filter((n) => n.reglaSlug === 'reporte-diario-generado')).toHaveLength(1);

    const noLeidas = await t.query(api.alertas.noLeidasParaMi, { token: comprasToken });
    expect(noLeidas.find((n) => n.reglaSlug === 'reporte-diario-generado')).toBeDefined();
  });

  test('un envío "manual" el mismo día NO bloquea que el cron siga generando el suyo', async () => {
    const t = convexTest(schema, modules);
    // La hora falsa se fija ANTES de crear la sesión — si no, expiresAt
    // (calculado con la hora real) quedaría en el pasado en cuanto
    // adelantamos el reloj, y la mutation fallaría por "sesión expirada"
    // en vez de probar lo que este test busca probar.
    const fakeNow = horaLocalAInstante('2026-08-11', '14:05', ZONA);
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: [], token: adminToken });

    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken }); // manual primero
    await t.mutation(internal.reporteDiario.generarReporteDiario, {}); // cron después

    const historial = await t.run((ctx) => ctx.db.query('reporteDiarioHistorial').collect());
    expect(historial.filter((h) => h.generadoPor === 'manual')).toHaveLength(1);
    expect(historial.filter((h) => h.generadoPor === 'cron')).toHaveLength(1);
  });

  test('un día nuevo (fecha operativa distinta) sí genera un segundo registro "cron"', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: [], whatsapp: [], token: adminToken });

    vi.useFakeTimers();
    vi.setSystemTime(horaLocalAInstante('2026-08-11', '14:05', ZONA));
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});

    vi.setSystemTime(horaLocalAInstante('2026-08-12', '14:05', ZONA));
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});

    const historial = await t.run((ctx) => ctx.db.query('reporteDiarioHistorial').collect());
    expect(historial.filter((h) => h.generadoPor === 'cron')).toHaveLength(2);
  });
});

// EDS-69 Fase 1 — generarReporteAhora/generarReporteDiario agendan el
// envío real vía ctx.scheduler.runAfter(0, ...); en convex-test eso no
// corre solo, hay que forzarlo con finishAllScheduledFunctions (mismo
// patrón ya usado en auth.test.ts para la reprogramación de limpieza de
// login). El envío en sí (fetch a Resend/Twilio) se prueba a fondo en
// notificaciones.test.ts — aquí solo se confirma que el wiring dispara.
describe('reporteDiario: envío real agendado (EDS-69 Fase 1)', () => {
  test('generarReporteAhora agenda el envío — sin proveedor configurado, termina en enviosError > 0, no enviosOk sin definir', async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: ['a@tejaflex.com'], whatsapp: [], token: adminToken });

    await t.mutation(api.reporteDiario.generarReporteAhora, { token: adminToken });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const historial = await t.query(api.reporteDiario.listHistorial, { token: adminToken });
    expect(historial[0].enviosOk).toBe(0);
    expect(historial[0].enviosError).toBe(1);
  });

  test('generarReporteDiario (cron) también agenda el envío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.reporteDiario.guardarConfig, { hora: '14:00', activo: true, correos: ['a@tejaflex.com'], whatsapp: [], token: adminToken });

    vi.useFakeTimers();
    vi.setSystemTime(horaLocalAInstante('2026-08-11', '14:05', ZONA));
    await t.mutation(internal.reporteDiario.generarReporteDiario, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const historial = await t.run((ctx) => ctx.db.query('reporteDiarioHistorial').collect());
    expect(historial[0].enviosError).toBe(1);
  });
});
