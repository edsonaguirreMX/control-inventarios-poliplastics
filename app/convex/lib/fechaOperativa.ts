import { ConvexError } from 'convex/values';

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

/**
 * Conversión inversa a `fechaOperativa`: dado un día calendario + hora de
 * reloj ("HH:MM") EN una zona horaria, regresa el instante (epoch ms) que
 * representa. Usada por el motor de alertas (7.2) para saber, p.ej., "¿ya
 * pasó la hora de fin del Turno 1 de hoy + minutos de gracia?".
 *
 * Técnica estándar de "ida y vuelta": se interpreta la fecha+hora deseada
 * COMO SI fuera UTC (instanteSupuesto), se formatea ese instante en la
 * zona objetivo para ver qué hora de reloj resultó ahí, y se corrige
 * `instanteSupuesto` por la diferencia — exacto en cualquier fecha/DST
 * porque usa el offset vigente en ese instante concreto, no uno fijo.
 */
export function horaLocalAInstante(fechaISO: string, horaHHMM: string, zonaHoraria: string): number {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const [hora, minuto] = horaHHMM.split(':').map(Number);
  const instanteSupuesto = Date.UTC(anio, mes - 1, dia, hora, minuto);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const partes = fmt.formatToParts(new Date(instanteSupuesto));
  const get = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '0';
  const horaParte = get('hour') === '24' ? 0 : Number(get('hour'));
  const horaLocalDeInstanteSupuesto = Date.UTC(
    Number(get('year')), Number(get('month')) - 1, Number(get('day')),
    horaParte, Number(get('minute')), Number(get('second'))
  );
  const diferencia = instanteSupuesto - horaLocalDeInstanteSupuesto;
  return instanteSupuesto + diferencia;
}

/** Día de la semana en español minúsculas SIN acentos ("miercoles", no
 * "miércoles") de una fecha "YYYY-MM-DD" — se ancla a mediodía UTC para no
 * depender de ninguna zona horaria al resolver el día calendario puro
 * (evita el borde de medianoche). Sin acentos a propósito: coincide con la
 * convención ya usada por `parametrosProduccion.diasLaborales` en el seed
 * (`['lunes','martes','miercoles','jueves','viernes']`) — Intl.DateTimeFormat
 * regresa "miércoles"/"sábado" con acento, y comparar directo contra
 * diasLaborales sin normalizar nunca los igualaría. */
export function nombreDiaSemana(fechaISO: string): string {
  const dt = new Date(`${fechaISO}T12:00:00Z`);
  const conAcento = new Intl.DateTimeFormat('es-MX', { weekday: 'long', timeZone: 'UTC' }).format(dt);
  return conAcento.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * EDS-83: valida que `fecha` (YYYY-MM-DD, capturada en cierres/entradas)
 * sea una fecha calendario real, que no sea futura, y — si `diasAtras`
 * no es `null` — que no sea más vieja que `hoy - diasAtras`. Nunca
 * confiar en que el cliente mande algo razonable solo porque la UI ya
 * restringe las opciones que ofrece (un bug de UI, o alguien llamando la
 * API directo, podría mandar cualquier string). Encontrado real: sin
 * esta validación, `crearCierreTurno`/`crearEntrada(sBatch)` aceptaban
 * `fecha` sin chequeo alguno — ni formato, ni rango, ni que no fuera
 * futura.
 *
 * `diasAtras`: ventana de captura "tardía" permitida hacia atrás (p. ej.
 * 7 para un cierre de turno — cubre un fin de semana largo de retraso
 * real en la captura; para corregir algo más viejo, el camino correcto
 * es Corrección de Capturas, con auditoría, no esta mutation). `null`
 * desactiva el límite hacia atrás — usado por Entradas de material,
 * donde SÍ es normal registrar tarde el papeleo de un recibo real viejo
 * (a diferencia de un turno, que tiene una ventana operativa acotada).
 */
export function validarFechaOperativaEnVentana(
  fecha: string,
  zonaHoraria: string,
  horaInicioTurno1: string,
  diasAtras: number | null
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new ConvexError(`Fecha inválida: "${fecha}" — se espera formato YYYY-MM-DD.`);
  }
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(anio, mes - 1, dia));
  if (dt.getUTCFullYear() !== anio || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== dia) {
    throw new ConvexError(`Fecha inválida: "${fecha}" no es una fecha calendario real.`);
  }

  const hoy = fechaOperativa(Date.now(), zonaHoraria, horaInicioTurno1);
  if (fecha > hoy) {
    throw new ConvexError(`No se puede capturar una fecha futura (${fecha}) — hoy es ${hoy}.`);
  }
  if (diasAtras !== null) {
    const limite = sumarDiasISO(hoy, -diasAtras);
    if (fecha < limite) {
      throw new ConvexError(
        `Solo se puede capturar hasta ${diasAtras} días atrás (desde ${limite}) — ${fecha} es demasiado antiguo. Para corregir algo más viejo, usa Corrección de Capturas.`
      );
    }
  }
}
