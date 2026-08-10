import { describe, expect, test } from 'vitest';
import { fechaOperativa, sumarDiasISO, horaLocalAInstante, nombreDiaSemana } from './fechaOperativa';

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

describe('horaLocalAInstante — inversa de fechaOperativa, usada por el motor de alertas (7.2)', () => {
  test('18:00 local en México (CST, UTC-6) es 00:00 UTC del mismo día calendario', () => {
    expect(horaLocalAInstante('2026-08-08', '18:00', ZONA)).toBe(utcISO('2026-08-09', '00:00'));
  });
  test('06:00 local en México es 12:00 UTC del mismo día', () => {
    expect(horaLocalAInstante('2026-08-08', '06:00', ZONA)).toBe(utcISO('2026-08-08', '12:00'));
  });
  test('ida y vuelta: fechaOperativa(horaLocalAInstante(f, h, z), z, T1) reproduce el mismo instante de reloj local', () => {
    const instante = horaLocalAInstante('2026-08-08', '20:30', ZONA);
    // 20:30 cae después de horaInicioTurno1 (06:00), así que sigue siendo el mismo día operativo.
    expect(fechaOperativa(instante, ZONA, T1)).toBe('2026-08-08');
  });
  test('zona sin offset (UTC) es la identidad', () => {
    expect(horaLocalAInstante('2026-08-08', '14:00', 'UTC')).toBe(utcISO('2026-08-08', '14:00'));
  });
});

describe('nombreDiaSemana', () => {
  test('2026-08-08 es sábado — sin acento, para coincidir con la convención de diasLaborales del seed', () => {
    expect(nombreDiaSemana('2026-08-08')).toBe('sabado');
  });
  test('2026-08-10 es lunes', () => {
    expect(nombreDiaSemana('2026-08-10')).toBe('lunes');
  });
  test('coincide literalmente con parametrosProduccion.diasLaborales del seed (miercoles sin acento)', () => {
    expect(nombreDiaSemana('2026-08-12')).toBe('miercoles');
  });
});
