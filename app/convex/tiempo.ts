import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireUser } from './lib/auth';
import { fechaOperativa } from './lib/fechaOperativa';

// Única fuente de verdad de "qué día es hoy" para el frontend — nunca
// `new Date().toISOString().slice(0,10)` en el cliente (fecha UTC, se
// desalinea del reloj de México y de la regla de Turno 2 cruzando
// medianoche). Cualquier página que necesite "hoy" para capturar un cierre
// o una entrada debe pedirlo aquí, no calcularlo localmente.
export const obtenerFechaOperativaHoy = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('obtenerFechaOperativaHoy: no hay parámetros de producción configurados (parametrosProduccion vacío).');
    }
    return fechaOperativa(Date.now(), params.zonaHoraria, params.horaInicioTurno1);
  },
});
