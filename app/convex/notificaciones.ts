import { v } from 'convex/values';
import { internalMutation, internalQuery, internalAction } from './_generated/server';
import { internal } from './_generated/api';

// EDS-69 Fase 1 — envío real de Reporte Diario por correo (Resend) y
// WhatsApp (Twilio). Sin 'use node': el runtime normal de las actions de
// Convex ya expone `fetch` global, así que se habla directo con las REST
// API de ambos proveedores sin agregar SDKs como dependencia nueva (mismo
// espíritu minimalista del resto del proyecto).
//
// Patrón *Impl + wrapper delgado (ver roles.ts::actualizarRolImpl,
// dashboard.ts::calcularKPIsHoyImpl): las funciones puras de abajo arman
// texto sin tocar red ni base de datos — son las que se testean sin mock.
// El fetch real vive aislado en enviarCorreoResend/enviarWhatsappTwilio.

// ---------------------------------------------------------------------
// Funciones puras — arman el contenido del mensaje, testeables sin fetch.
// ---------------------------------------------------------------------

export function armarAsuntoReporte(hoy: string): string {
  return `Reporte diario Tejaflex — ${hoy}`;
}

// Precisión 3 del Go del usuario: si no hay APP_BASE_URL configurado, el
// mensaje debe seguir siendo una frase completa y útil — nunca un "ver
// aquí:" colgado sin URL.
export function armarCuerpoCorreoReporte({ hoy, urlReporte }: { hoy: string; urlReporte: string | null }): { html: string; texto: string } {
  const frase = urlReporte
    ? `Ingresa al enlace para ver la vista de impresión del Panel de Control: ${urlReporte}`
    : 'Ingresa al Panel de Control para imprimirlo.';
  const texto = `Reporte diario Tejaflex del ${hoy} listo. ${frase}`;
  const html = `<p>Reporte diario Tejaflex del <strong>${hoy}</strong> listo.</p><p>${
    urlReporte ? `<a href="${urlReporte}">Ver la vista de impresión del Panel de Control</a>` : 'Ingresa al Panel de Control para imprimirlo.'
  }</p>`;
  return { html, texto };
}

export function armarMensajeWhatsappReporte({ hoy, urlReporte }: { hoy: string; urlReporte: string | null }): string {
  const frase = urlReporte
    ? `Ingresa aquí para verlo: ${urlReporte}`
    : 'Ingresa al Panel de Control para imprimirlo.';
  return `Reporte diario Tejaflex del ${hoy} listo. ${frase}`;
}

// ---------------------------------------------------------------------
// Normalización/dedupe de destinatarios (Ajuste 3 del Go del usuario) —
// segunda capa de defensa; la normalización principal vive en
// reporteDiario.ts::guardarConfig al momento de capturar.
// ---------------------------------------------------------------------

export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase();
}

export function normalizarWhatsapp(numero: string): string {
  const limpio = numero.trim().replace(/[\s().-]/g, '');
  return limpio;
}

function dedupe(lista: string[], normalizar: (s: string) => string): string[] {
  const vistos = new Set<string>();
  const resultado: string[] = [];
  for (const item of lista) {
    const n = normalizar(item);
    if (!n || vistos.has(n)) continue;
    vistos.add(n);
    resultado.push(n);
  }
  return resultado;
}

// ---------------------------------------------------------------------
// Envío real — un fetch por destinatario (no batch) para poder loguear
// éxito/error individual. 1 reintento si la respuesta es 5xx o hay error
// de red (no reintenta 4xx — reintentar un correo/número inválido no lo
// arregla).
// ---------------------------------------------------------------------

type ResultadoEnvio = { estado: 'enviado' | 'error'; detalleError: string | null; intentos: number; proveedorId: string | null };

const REINTENTO_ESPERA_MS = 1500;

async function conReintento(intentar: () => Promise<ResultadoEnvio>): Promise<ResultadoEnvio> {
  const primero = await intentar();
  if (primero.estado === 'enviado') return primero;
  // Solo reintenta errores que sugieren un problema transitorio (de red o
  // 5xx del proveedor) — el detalleError de un 4xx no dispara este flujo
  // porque intentar() ya lo marca como no-reintentable (ver abajo).
  if (!primero.detalleError?.startsWith('REINTENTABLE:')) return primero;
  await new Promise((r) => setTimeout(r, REINTENTO_ESPERA_MS));
  const segundo = await intentar();
  return { ...segundo, intentos: 2, detalleError: segundo.detalleError?.replace(/^REINTENTABLE:/, '') ?? segundo.detalleError };
}

export async function enviarCorreoResend(params: {
  destinatario: string;
  asunto: string;
  html: string;
  texto: string;
  idempotencyKey: string;
}): Promise<ResultadoEnvio> {
  const apiKey = process.env.RESEND_API_KEY;
  const remitente = process.env.RESEND_REMITENTE;
  if (!apiKey || !remitente) {
    return { estado: 'error', detalleError: 'RESEND_API_KEY/RESEND_REMITENTE no configurados — corre `npx convex env set RESEND_API_KEY <valor>` (y RESEND_REMITENTE).', intentos: 1, proveedorId: null };
  }
  return conReintento(async (): Promise<ResultadoEnvio> => {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': params.idempotencyKey,
        },
        body: JSON.stringify({
          from: remitente,
          to: [params.destinatario],
          subject: params.asunto,
          html: params.html,
          text: params.texto,
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        return { estado: 'enviado', detalleError: null, intentos: 1, proveedorId: data.id ?? null };
      }
      const cuerpo = await res.text().catch(() => '');
      const prefijo = res.status >= 500 ? 'REINTENTABLE:' : '';
      return { estado: 'error', detalleError: `${prefijo}Resend respondió ${res.status}: ${cuerpo.slice(0, 300)}`, intentos: 1, proveedorId: null };
    } catch (err) {
      return { estado: 'error', detalleError: `REINTENTABLE:error de red al llamar Resend: ${err instanceof Error ? err.message : String(err)}`, intentos: 1, proveedorId: null };
    }
  });
}

export async function enviarWhatsappTwilio(params: { destinatario: string; mensaje: string }): Promise<ResultadoEnvio> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const templateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID; // opcional
  if (!sid || !token || !from) {
    return { estado: 'error', detalleError: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM no configurados — corre `npx convex env set TWILIO_ACCOUNT_SID <valor>` (y los otros 2).', intentos: 1, proveedorId: null };
  }
  return conReintento(async (): Promise<ResultadoEnvio> => {
    try {
      const destinoWhatsapp = params.destinatario.startsWith('whatsapp:') ? params.destinatario : `whatsapp:${params.destinatario}`;
      const cuerpo = new URLSearchParams({ To: destinoWhatsapp, From: from });
      if (templateSid) {
        // Producción real (fuera de ventana de 24h) requiere un Message
        // Template aprobado por Meta — sin esto, texto libre (abajo) solo
        // funciona en el sandbox de pruebas de Twilio.
        cuerpo.set('ContentSid', templateSid);
        cuerpo.set('ContentVariables', JSON.stringify({ 1: params.mensaje }));
      } else {
        cuerpo.set('Body', params.mensaje);
      }
      // btoa (no Buffer) — el runtime normal de Convex actions es un
      // isolate estilo navegador/edge, no Node, así que Buffer no existe
      // sin 'use node'. sid/token de Twilio son ASCII puro, así que btoa
      // sobre el string directo es seguro (sin caracteres fuera de Latin1).
      const authBase64 = btoa(`${sid}:${token}`);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authBase64}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: cuerpo.toString(),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (res.ok) {
        return { estado: 'enviado', detalleError: null, intentos: 1, proveedorId: data.sid ?? null };
      }
      const prefijo = res.status >= 500 ? 'REINTENTABLE:' : '';
      return { estado: 'error', detalleError: `${prefijo}Twilio respondió ${res.status} (código ${data.code ?? '?'}): ${data.message ?? 'sin detalle'}`, intentos: 1, proveedorId: null };
    } catch (err) {
      return { estado: 'error', detalleError: `REINTENTABLE:error de red al llamar Twilio: ${err instanceof Error ? err.message : String(err)}`, intentos: 1, proveedorId: null };
    }
  });
}

// ---------------------------------------------------------------------
// Persistencia — únicas funciones que tocan ctx.db, invocadas por la
// action de abajo.
// ---------------------------------------------------------------------

export const registrarEnvio = internalMutation({
  args: {
    referenciaId: v.id('reporteDiarioHistorial'),
    canal: v.union(v.literal('correo'), v.literal('whatsapp')),
    destinatario: v.string(),
    estado: v.union(v.literal('enviado'), v.literal('error')),
    detalleError: v.union(v.string(), v.null()),
    intentos: v.number(),
    proveedorId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('notificacionesEnvios', { origen: 'reporteDiario', fecha: Date.now(), ...args });
  },
});

export const cerrarResumenEnvio = internalMutation({
  args: {
    reporteDiarioHistorialId: v.id('reporteDiarioHistorial'),
    enviosOk: v.number(),
    enviosError: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.reporteDiarioHistorialId, { enviosOk: args.enviosOk, enviosError: args.enviosError });
  },
});

// internalQuery (solo lectura) — es la clave de idempotencia real: antes de
// intentar (re)enviar a un (referenciaId, canal, destinatario) se consulta
// esto vía el índice compuesto by_referencia_canal_destinatario (nunca
// by_referenciaId completo, para no escanear todo el historial de un
// reporte por cada destinatario).
export const yaEnviado = internalQuery({
  args: {
    referenciaId: v.id('reporteDiarioHistorial'),
    canal: v.union(v.literal('correo'), v.literal('whatsapp')),
    destinatario: v.string(),
  },
  handler: async (ctx, args) => {
    const existente = await ctx.db
      .query('notificacionesEnvios')
      .withIndex('by_referencia_canal_destinatario', (q) =>
        q.eq('referenciaId', args.referenciaId).eq('canal', args.canal).eq('destinatario', args.destinatario))
      .filter((q) => q.eq(q.field('estado'), 'enviado'))
      .first();
    return existente !== null;
  },
});

// ---------------------------------------------------------------------
// Orquestador — dispara ambos canales, loguea cada intento, y SIEMPRE
// cierra el resumen (Ajuste 4 del Go del usuario) aunque 0 destinatarios,
// falten variables de entorno, o todos los intentos fallen.
// ---------------------------------------------------------------------

// URL pública de la app — no existe hoy ningún env var de este tipo del
// lado de Convex (solo CONVEX_URL, que es la URL del backend, no del
// frontend). Sin APP_BASE_URL configurado, armarCuerpoCorreoReporte/
// armarMensajeWhatsappReporte arman una frase completa sin link colgado.
function urlReporteActual(): string | null {
  const base = process.env.APP_BASE_URL;
  return base ? `${base.replace(/\/$/, '')}/panel-control.html?autoprint=1` : null;
}

export const enviarReporteDiarioNotificaciones = internalAction({
  args: {
    reporteDiarioHistorialId: v.id('reporteDiarioHistorial'),
    correos: v.array(v.string()),
    whatsapp: v.array(v.string()),
    hoy: v.string(),
  },
  handler: async (ctx, args) => {
    const correos = dedupe(args.correos, normalizarCorreo);
    const whatsapp = dedupe(args.whatsapp, normalizarWhatsapp);
    const urlReporte = urlReporteActual();
    const asunto = armarAsuntoReporte(args.hoy);
    const { html, texto } = armarCuerpoCorreoReporte({ hoy: args.hoy, urlReporte });
    const mensajeWhatsapp = armarMensajeWhatsappReporte({ hoy: args.hoy, urlReporte });

    let enviosOk = 0;
    let enviosError = 0;

    for (const destinatario of correos) {
      const yaExiste = await ctx.runQuery(internal.notificaciones.yaEnviado, {
        referenciaId: args.reporteDiarioHistorialId, canal: 'correo', destinatario,
      });
      if (yaExiste) { enviosOk++; continue; }
      const idempotencyKey = `reporteDiario:${args.reporteDiarioHistorialId}:correo:${destinatario}`;
      const resultado = await enviarCorreoResend({ destinatario, asunto, html, texto, idempotencyKey });
      if (resultado.estado === 'enviado') enviosOk++; else enviosError++;
      await ctx.runMutation(internal.notificaciones.registrarEnvio, { referenciaId: args.reporteDiarioHistorialId, canal: 'correo', destinatario, ...resultado });
    }

    for (const destinatario of whatsapp) {
      const yaExiste = await ctx.runQuery(internal.notificaciones.yaEnviado, {
        referenciaId: args.reporteDiarioHistorialId, canal: 'whatsapp', destinatario,
      });
      if (yaExiste) { enviosOk++; continue; }
      const resultado = await enviarWhatsappTwilio({ destinatario, mensaje: mensajeWhatsapp });
      if (resultado.estado === 'enviado') enviosOk++; else enviosError++;
      await ctx.runMutation(internal.notificaciones.registrarEnvio, { referenciaId: args.reporteDiarioHistorialId, canal: 'whatsapp', destinatario, ...resultado });
    }

    await ctx.runMutation(internal.notificaciones.cerrarResumenEnvio, { reporteDiarioHistorialId: args.reporteDiarioHistorialId, enviosOk, enviosError });
  },
});
