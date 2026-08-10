import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Cada 20 min — dentro del rango de 15-30 min del plan; suficiente para no
// dejar una alerta real con más de ~20 min de retraso sin sobrecargar el
// sistema evaluando constantemente. evaluarAlertas dedupe por día operativo
// vía alertasHistorial.by_dedupeKey, así que correr seguido es inofensivo.
crons.interval('evaluar alertas', { minutes: 20 }, internal.alertas.evaluarAlertas, {});

// Cada 15 min — granularidad fina para acercarse a la hora configurada de
// envío sin pasarse por mucho; generarReporteDiario deduplica contra el
// día operativo actual, así que correr seguido tampoco duplica nada.
crons.interval('generar reporte diario', { minutes: 15 }, internal.reporteDiario.generarReporteDiario, {});

// Cada hora — mayor de la auditoría de PR8: loginIntentos crecía sin
// límite (una fila por cada usuario, real o inventado, que alguna vez
// falló un login, nunca borrada sola). Acotado a 200 filas por corrida
// (ver auth.ts) para que la limpieza misma no se vuelva pesada si la
// tabla ya creció mucho; lo que sobre en una corrida se limpia en la
// siguiente.
crons.interval('limpiar intentos de login expirados', { hours: 1 }, internal.auth.limpiarLoginIntentosExpirados, {});

export default crons;
