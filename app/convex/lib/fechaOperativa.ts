/**
 * "Fecha operativa" — el día calendario al que pertenece una captura,
 * considerando que Turno 2 cruza medianoche: todo lo capturado entre las
 * 00:00 y `horaInicioTurno1` pertenece operativamente al día calendario
 * ANTERIOR (la cola del Turno 2 que empezó ese día anterior), no al día
 * calendario real del reloj en ese instante.
 *
 * Fuente única de esta regla — nunca usar `new Date().toISOString()`
 * directo para "hoy" en cierres/entradas/correcciones: eso da la fecha en
 * UTC, que en México puede estar adelantada hasta 6-7 horas respecto al
 * reloj local y desalinear duplicados, recierres, la ventana de corrección
 * y el dashboard (bloqueante de la auditoría de PR 3).
 */
export function fechaOperativa(instanteMs: number, zonaHoraria: string, horaInicioTurno1: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = fmt.formatToParts(new Date(instanteMs));
  const get = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '00';
  const fechaCalendario = `${get('year')}-${get('month')}-${get('day')}`;
  // Algunos motores ICU devuelven "24" para la medianoche con hour12:false
  // en vez de "00" (con el día ya avanzado correctamente en `day`) — se
  // normaliza para que la comparación de abajo sea siempre correcta.
  const horaLocal = get('hour') === '24' ? '00' : get('hour');
  const minutoLocal = get('minute');

  if (`${horaLocal}:${minutoLocal}` < horaInicioTurno1) {
    return sumarDiasISO(fechaCalendario, -1);
  }
  return fechaCalendario;
}

/** Suma (o resta, con `dias` negativo) días calendario a una fecha "YYYY-MM-DD". */
export function sumarDiasISO(fechaISO: string, dias: number): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}
