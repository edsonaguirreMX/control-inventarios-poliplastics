import { convexTest } from 'convex-test';
import { describe, expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import {
  armarAsuntoReporte,
  armarCuerpoCorreoReporte,
  armarMensajeWhatsappReporte,
  normalizarCorreo,
  normalizarWhatsapp,
  enviarCorreoResend,
  enviarWhatsappTwilio,
  intentarConstruirAdjuntoPdf,
} from './notificaciones';
import type { DatosReportePdf } from './reportePdf';

const modules = import.meta.glob('./**/*.ts');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------
// Funciones puras — sin fetch, sin mock.
// ---------------------------------------------------------------------

describe('notificaciones: funciones puras de armado de mensaje', () => {
  test('armarAsuntoReporte incluye la fecha', () => {
    expect(armarAsuntoReporte('2026-08-19')).toBe('Reporte diario Tejaflex — 2026-08-19');
  });

  test('armarCuerpoCorreoReporte con urlReporte incluye el link', () => {
    const { html, texto } = armarCuerpoCorreoReporte({ hoy: '2026-08-19', urlReporte: 'https://aocapp.net/panel-control.html?autoprint=1' });
    expect(texto).toContain('https://aocapp.net/panel-control.html?autoprint=1');
    expect(html).toContain('href="https://aocapp.net/panel-control.html?autoprint=1"');
  });

  // Precisión 3 del Go del usuario: sin APP_BASE_URL, frase completa, nunca
  // un "ver aquí:" colgado sin URL.
  test('armarCuerpoCorreoReporte sin urlReporte da una frase completa, sin link colgado', () => {
    const { html, texto } = armarCuerpoCorreoReporte({ hoy: '2026-08-19', urlReporte: null });
    expect(texto).toBe('Reporte diario Tejaflex del 2026-08-19 listo. Ingresa al Panel de Control para imprimirlo.');
    expect(html).not.toContain('href=');
    expect(html).not.toMatch(/ver aquí:?\s*$/i);
  });

  // EDS-113 — mención del adjunto solo cuando existe de verdad (nunca
  // promete un PDF que no se logró construir).
  test('armarCuerpoCorreoReporte con conAdjuntoPdf menciona el PDF adjunto', () => {
    const { html, texto } = armarCuerpoCorreoReporte({ hoy: '2026-08-19', urlReporte: null, conAdjuntoPdf: true });
    expect(texto).toContain('Se adjunta el reporte en PDF.');
    expect(html).toContain('Se adjunta el reporte en PDF.');
  });

  test('armarCuerpoCorreoReporte sin conAdjuntoPdf NO menciona ningún PDF', () => {
    const { html, texto } = armarCuerpoCorreoReporte({ hoy: '2026-08-19', urlReporte: null });
    expect(texto).not.toContain('PDF');
    expect(html).not.toContain('PDF');
  });

  test('armarMensajeWhatsappReporte sin urlReporte da una frase completa', () => {
    const msg = armarMensajeWhatsappReporte({ hoy: '2026-08-19', urlReporte: null });
    expect(msg).toBe('Reporte diario Tejaflex del 2026-08-19 listo. Ingresa al Panel de Control para imprimirlo.');
  });

  test('armarMensajeWhatsappReporte con urlReporte incluye el link', () => {
    const msg = armarMensajeWhatsappReporte({ hoy: '2026-08-19', urlReporte: 'https://aocapp.net/panel-control.html?autoprint=1' });
    expect(msg).toContain('https://aocapp.net/panel-control.html?autoprint=1');
  });
});

describe('notificaciones: normalización (Ajuste 3 del Go del usuario)', () => {
  test('normalizarCorreo hace trim + lowercase', () => {
    expect(normalizarCorreo('  Juan@Tejaflex.COM  ')).toBe('juan@tejaflex.com');
  });

  test('normalizarWhatsapp limpia espacios/guiones/paréntesis', () => {
    expect(normalizarWhatsapp('+52 (33) 1234-5678')).toBe('+523312345678');
  });
});

// ---------------------------------------------------------------------
// Envío real — fetch mockeado (Ajuste 1 del Go del usuario: el PR no se
// bloquea esperando credenciales reales; esto es lo que sí gatea el PR).
// ---------------------------------------------------------------------

describe('notificaciones: enviarCorreoResend (fetch mockeado)', () => {
  test('sin RESEND_API_KEY/RESEND_REMITENTE configurados, error claro sin llamar fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const resultado = await enviarCorreoResend({ destinatario: 'a@x.com', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k' });
    expect(resultado.estado).toBe('error');
    expect(resultado.detalleError).toMatch(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('200 de Resend — enviado, manda Idempotency-Key, 1 intento', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'resend-123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarCorreoResend({ destinatario: 'a@x.com', asunto: 'Asunto', html: '<p>x</p>', texto: 'x', idempotencyKey: 'reporteDiario:abc:correo:a@x.com' });

    expect(resultado).toEqual({ estado: 'enviado', detalleError: null, intentos: 1, proveedorId: 'resend-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('reporteDiario:abc:correo:a@x.com');
  });

  // EDS-113 — el adjunto de PDF solo se manda cuando existe; nunca
  // `attachments: []` ni un adjunto vacío. Punto de cuidado 3 del Go del
  // usuario: confirmar que attachments[0].content existe y es base64 real.
  test('con adjuntoPdf: el body incluye attachments[0] con filename/content correctos', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'resend-789' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const contentBase64 = btoa('%PDF-1.7 contenido de prueba');
    await enviarCorreoResend({
      destinatario: 'a@x.com', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k',
      adjuntoPdf: { filename: 'Reporte Directivo Tejaflex - 2026-08-19.pdf', contentBase64 },
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe('Reporte Directivo Tejaflex - 2026-08-19.pdf');
    expect(body.attachments[0].content).toBe(contentBase64);
    expect(atob(body.attachments[0].content)).toContain('%PDF-1.7');
  });

  test('sin adjuntoPdf (o null): el body NO incluye el campo attachments', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'resend-999' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await enviarCorreoResend({ destinatario: 'a@x.com', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k', adjuntoPdf: null });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.attachments).toBeUndefined();
  });

  test('400 de Resend — error, NO reintenta (1 sola llamada a fetch)', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response('correo inválido', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarCorreoResend({ destinatario: 'no-es-correo', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k' });

    expect(resultado.estado).toBe('error');
    expect(resultado.intentos).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('500 de Resend seguido de 200 — reintenta 1 vez y termina enviado, intentos:2', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('error del servidor', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resend-456' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarCorreoResend({ destinatario: 'a@x.com', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k' });

    expect(resultado).toEqual({ estado: 'enviado', detalleError: null, intentos: 2, proveedorId: 'resend-456' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('error de red — reintenta 1 vez; si vuelve a fallar, error final sin "REINTENTABLE:" en el mensaje', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <notificaciones@aocapp.net>');
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarCorreoResend({ destinatario: 'a@x.com', asunto: 'x', html: 'x', texto: 'x', idempotencyKey: 'k' });

    expect(resultado.estado).toBe('error');
    expect(resultado.intentos).toBe(2);
    expect(resultado.detalleError).not.toMatch(/REINTENTABLE:/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('notificaciones: enviarWhatsappTwilio (fetch mockeado)', () => {
  test('sin TWILIO_* configurado, error claro sin llamar fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const resultado = await enviarWhatsappTwilio({ destinatario: '+523312345678', mensaje: 'hola' });
    expect(resultado.estado).toBe('error');
    expect(resultado.detalleError).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('201 de Twilio — enviado, texto libre (sin TWILIO_WHATSAPP_TEMPLATE_SID)', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACxxx');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
    vi.stubEnv('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: 'SMxxx', status: 'queued' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarWhatsappTwilio({ destinatario: '+523312345678', mensaje: 'Reporte listo' });

    expect(resultado).toEqual({ estado: 'enviado', detalleError: null, intentos: 1, proveedorId: 'SMxxx' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toContain('Body=');
    expect(init.body).not.toContain('ContentSid');
  });

  test('con TWILIO_WHATSAPP_TEMPLATE_SID configurado, manda ContentSid en vez de Body libre', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACxxx');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
    vi.stubEnv('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886');
    vi.stubEnv('TWILIO_WHATSAPP_TEMPLATE_SID', 'HXxxx');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: 'SMxxx' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await enviarWhatsappTwilio({ destinatario: '+523312345678', mensaje: 'Reporte listo' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toContain('ContentSid=HXxxx');
  });

  test('error 63016 (fuera de sandbox/sin opt-in) — error, no reintenta', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACxxx');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
    vi.stubEnv('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 63016, message: 'recipient not opted in' }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultado = await enviarWhatsappTwilio({ destinatario: '+525500000000', mensaje: 'hola' });

    expect(resultado.estado).toBe('error');
    expect(resultado.detalleError).toMatch(/63016/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------
// registrarEnvio / cerrarResumenEnvio / yaEnviado — mutations/query.
// ---------------------------------------------------------------------

describe('notificaciones: registrarEnvio / yaEnviado / cerrarResumenEnvio', () => {
  async function crearHistorial(t: Awaited<ReturnType<typeof convexTest>>) {
    return t.run((ctx) => ctx.db.insert('reporteDiarioHistorial', {
      fecha: Date.now(), estado: 'generado', destinatariosCount: 1, detalleError: null, generadoPor: 'manual',
    }));
  }

  test('registrarEnvio inserta con origen "reporteDiario" y la fecha actual', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    await t.mutation(internal.notificaciones.registrarEnvio, {
      referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com', estado: 'enviado', detalleError: null, intentos: 1, proveedorId: 'resend-1',
    });
    const filas = await t.run((ctx) => ctx.db.query('notificacionesEnvios').collect());
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ origen: 'reporteDiario', referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com', estado: 'enviado' });
  });

  test('yaEnviado — false si no hay envío exitoso previo para esa combinación exacta', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    const existe = await t.query(internal.notificaciones.yaEnviado, { referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com' });
    expect(existe).toBe(false);
  });

  test('yaEnviado — true tras un registrarEnvio con estado "enviado" para esa combinación exacta', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    await t.mutation(internal.notificaciones.registrarEnvio, {
      referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com', estado: 'enviado', detalleError: null, intentos: 1, proveedorId: 'r1',
    });
    expect(await t.query(internal.notificaciones.yaEnviado, { referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com' })).toBe(true);
    // Un canal o destinatario distinto NO cuenta como ya enviado.
    expect(await t.query(internal.notificaciones.yaEnviado, { referenciaId: historialId, canal: 'whatsapp', destinatario: 'a@x.com' })).toBe(false);
    expect(await t.query(internal.notificaciones.yaEnviado, { referenciaId: historialId, canal: 'correo', destinatario: 'b@x.com' })).toBe(false);
  });

  test('yaEnviado — un envío previo con estado "error" NO cuenta como ya enviado (debe poder reintentarse)', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    await t.mutation(internal.notificaciones.registrarEnvio, {
      referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com', estado: 'error', detalleError: 'algo falló', intentos: 1, proveedorId: null,
    });
    expect(await t.query(internal.notificaciones.yaEnviado, { referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com' })).toBe(false);
  });

  test('cerrarResumenEnvio actualiza enviosOk/enviosError en reporteDiarioHistorial', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    await t.mutation(internal.notificaciones.cerrarResumenEnvio, { reporteDiarioHistorialId: historialId, enviosOk: 2, enviosError: 1 });
    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 2, enviosError: 1 });
  });
});

// ---------------------------------------------------------------------
// intentarConstruirAdjuntoPdf — separado del handler de la action para
// poder testearlo con un `ctx` mínimo mockeado (Punto de cuidado 3 del Go
// del usuario: probar tanto el caso feliz como la degradación con gracia).
// ---------------------------------------------------------------------

describe('notificaciones: intentarConstruirAdjuntoPdf (EDS-113)', () => {
  function datosFixture(): DatosReportePdf {
    return {
      fecha: '2026-08-19',
      kpis: {
        fecha: '2026-08-19', materiales: [], valorInventarioTotal: 0,
        pctMermaUltimoCierre: 0, produccionUltimoCierreKg: 0, produccionUltimoCierreMetros: 0,
        costoUltimoCierre: 0, costoRealPorKgUltimoCierre: 0, costoRealPorMetroUltimoCierre: 0,
        costoEstandarPorKg: 0, costoEstandarPorMetro: 0,
      },
      semana: { dias: 7, fechaDesde: '2026-08-13', fechaHasta: '2026-08-19', pctMerma: 0, produccionKg: 0, produccionMetros: 0, costoTotal: 0, costoRealPorKg: 0, costoRealPorMetro: 0 },
      seisCierres: { n: 0, costoRealPorKg: 0, costoRealPorMetro: 0 },
      objetivos: { turnoL1: 0, turnoL2: 0, semana: 0, mes: 0 },
      costoTendencia7: [],
      nCrit: 0, nWarn: 0, totalMaterialesConReorden: 0, totalMateriales: 0,
      masUrgente: null, semanaTotal: 0, mesTotal: 0,
    } as DatosReportePdf;
  }

  test('caso feliz: devuelve filename con la fecha y contentBase64 como PDF real', async () => {
    const ctxMock = { runQuery: async () => datosFixture() };
    const adjunto = await intentarConstruirAdjuntoPdf(ctxMock);
    expect(adjunto).not.toBeNull();
    expect(adjunto?.filename).toBe('Reporte Directivo Tejaflex - 2026-08-19.pdf');
    expect(atob(adjunto!.contentBase64).slice(0, 5)).toBe('%PDF-');
  });

  // Degradación con gracia (Ajuste 3 del Go del usuario): si falla la
  // consulta de datos (o la construcción del PDF), nunca lanza — el
  // llamador manda el correo igual, sin adjunto.
  test('degradación: si ctx.runQuery falla, devuelve null sin lanzar', async () => {
    const ctxMock = { runQuery: async () => { throw new Error('Convex no disponible'); } };
    await expect(intentarConstruirAdjuntoPdf(ctxMock)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Orquestador completo — enviarReporteDiarioNotificaciones (action).
// ---------------------------------------------------------------------

describe('notificaciones: enviarReporteDiarioNotificaciones (orquestador)', () => {
  async function crearHistorial(t: Awaited<ReturnType<typeof convexTest>>) {
    return t.run((ctx) => ctx.db.insert('reporteDiarioHistorial', {
      fecha: Date.now(), estado: 'generado', destinatariosCount: 0, detalleError: null, generadoPor: 'manual',
    }));
  }

  // Ajuste 4 del Go del usuario: el resumen se actualiza SIEMPRE, incluso
  // sin proveedor configurado — nunca queda a medias.
  test('sin variables de entorno configuradas: enviosOk=0, enviosError=N, no lanza', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    vi.stubGlobal('fetch', vi.fn());

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: ['a@x.com'], whatsapp: ['+523312345678'], hoy: '2026-08-19',
    });

    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 0, enviosError: 2 });
    const filas = await t.run((ctx) => ctx.db.query('notificacionesEnvios').collect());
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.estado === 'error')).toBe(true);
  });

  test('0 destinatarios: igual cierra el resumen en 0/0, sin llamar fetch', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: [], whatsapp: [], hoy: '2026-08-19',
    });

    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 0, enviosError: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('éxito en ambos canales: enviosOk=2, notificacionesEnvios refleja cada intento', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    vi.stubEnv('RESEND_API_KEY', 'k'); vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <n@aocapp.net>');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC'); vi.stubEnv('TWILIO_AUTH_TOKEN', 't'); vi.stubEnv('TWILIO_WHATSAPP_FROM', 'whatsapp:+1');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'r1' }), { status: 200 })) // correo
      .mockResolvedValueOnce(new Response(JSON.stringify({ sid: 's1' }), { status: 201 })) // whatsapp
    );

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: ['a@x.com'], whatsapp: ['+523312345678'], hoy: '2026-08-19',
    });

    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 2, enviosError: 0 });
  });

  // EDS-113 — con parámetros configurados (requeridos por datosReportePdf),
  // el correo real sale CON el PDF adjunto — confirma el wiring completo,
  // no solo las piezas por separado.
  test('con parámetros configurados: el correo sale con attachments[0] real', async () => {
    const t = convexTest(schema, modules);
    const { crearParametrosPrueba } = await import('./testHelpers');
    await crearParametrosPrueba(t, 4);
    const historialId = await crearHistorial(t);
    vi.stubEnv('RESEND_API_KEY', 'k'); vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <n@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: ['a@x.com'], whatsapp: [], hoy: '2026-08-19',
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toMatch(/^Reporte Directivo Tejaflex - .+\.pdf$/);
    expect(atob(body.attachments[0].content).slice(0, 5)).toBe('%PDF-');
    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 1, enviosError: 0 });
  });

  // Ajuste 3 del Go del usuario: dedupe/normalización defensiva dentro del
  // propio orquestador, aunque la captura principal ya normalice.
  test('deduplica destinatarios repetidos (mismo correo con distinto casing) — 1 solo fetch', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    vi.stubEnv('RESEND_API_KEY', 'k'); vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <n@aocapp.net>');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: ['A@X.com', 'a@x.com', ' a@x.com '], whatsapp: [], hoy: '2026-08-19',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 1, enviosError: 0 });
  });

  // Ajuste 2 del Go del usuario: idempotencia real — un envío ya exitoso
  // para esa combinación exacta se salta, no se reenvía.
  test('idempotencia: un destinatario ya enviado previamente para este historial NO se reenvía', async () => {
    const t = convexTest(schema, modules);
    const historialId = await crearHistorial(t);
    await t.mutation(internal.notificaciones.registrarEnvio, {
      referenciaId: historialId, canal: 'correo', destinatario: 'a@x.com', estado: 'enviado', detalleError: null, intentos: 1, proveedorId: 'r-previo',
    });
    vi.stubEnv('RESEND_API_KEY', 'k'); vi.stubEnv('RESEND_REMITENTE', 'Tejaflex <n@aocapp.net>');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.notificaciones.enviarReporteDiarioNotificaciones, {
      reporteDiarioHistorialId: historialId, correos: ['a@x.com'], whatsapp: [], hoy: '2026-08-19',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const historial = await t.run((ctx) => ctx.db.get(historialId));
    expect(historial).toMatchObject({ enviosOk: 1, enviosError: 0 });
    // No se duplica la fila de log del envío previo.
    const filas = await t.run((ctx) => ctx.db.query('notificacionesEnvios').collect());
    expect(filas).toHaveLength(1);
  });
});
