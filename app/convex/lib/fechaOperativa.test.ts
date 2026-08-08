import { describe, expect, test } from 'vitest';
import { fechaOperativa, sumarDiasISO } from './fechaOperativa';

const ZONA = 'America/Mexico_City';
const T1 = '06:00';

function utcISO(fechaISO: string, horaUTC: string): number {
  return Date.parse(`${fechaISO}T${horaUTC}:00Z`);
}

describe('fechaOperativa', () => {
  test('bloqueante de la auditoría: cierre capturado por la tarde/noche en México no salta al día UTC siguiente', () => {
    // 2026-08-08 22:00 UTC-6 (CST, sin DST) = 2026-08-09 04:00 UTC.
    // new Date().toISOString().slice(0,10) daría "2026-08-09" (el bug
    // reportado) — la fecha operativa correcta sigue siendo "2026-08-08".
    const instante = utcISO('2026-08-09', '04:00');
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-08');
  });

  test('Turno 2 cruza medianoche: una captura a las 02:00 locales pertenece al día operativo ANTERIOR', () => {
    // 2026-08-08 02:00 hora local (CST, UTC-6) = 2026-08-08 08:00 UTC.
    // Reloj local ya marca "08", pero operativamente es la cola del Turno 2
    // que empezó el 2026-08-07.
    const instante = utcISO('2026-08-08', '08:00');
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-07');
  });

  test('justo en horaInicioTurno1 (06:00 local) ya pertenece al día calendario actual', () => {
    // 2026-08-08 06:00 local = 2026-08-08 12:00 UTC.
    const instante = utcISO('2026-08-08', '12:00');
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-08');
  });

  test('un minuto antes de horaInicioTurno1 todavía pertenece al día anterior', () => {
    // 2026-08-08 05:59 local = 2026-08-08 11:59 UTC.
    const instante = utcISO('2026-08-08', '11:59');
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-07');
  });

  test('mediodía local es un caso simple sin cruce de medianoche', () => {
    // 2026-08-08 13:00 local = 2026-08-08 19:00 UTC.
    const instante = utcISO('2026-08-08', '19:00');
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-08');
  });
});

describe('sumarDiasISO', () => {
  test('resta días cruzando fin de mes', () => {
    expect(sumarDiasISO('2026-08-01', -1)).toBe('2026-07-31');
  });
  test('suma días cruzando fin de año', () => {
    expect(sumarDiasISO('2025-12-31', 1)).toBe('2026-01-01');
  });
  test('dias:0 devuelve la misma fecha', () => {
    expect(sumarDiasISO('2026-08-08', 0)).toBe('2026-08-08');
  });
});
