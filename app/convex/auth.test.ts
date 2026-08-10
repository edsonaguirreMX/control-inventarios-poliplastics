import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { crearUsuarioPrueba, crearSesionPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

afterEach(() => {
  vi.useRealTimers();
});

// EDS-70 (auditoría de PR1): authActions.login no tenía rate limiting —
// una cuenta podía atacarse por fuerza bruta sin freno. Estas pruebas
// reproducen el escenario del hallazgo y verifican el fix.
describe('authActions.login: rate limiting (EDS-70)', () => {
  async function crearAdminYUsuarioObjetivo(t: Awaited<ReturnType<typeof convexTest>>) {
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    const { passwordTemporal } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Objetivo Prueba', usuario: 'objetivo.prueba', rol: 'operador', token: adminToken,
    });
    return { passwordTemporal };
  }

  test('5 intentos fallidos bloquean el 6º intento aunque el password sea correcto', async () => {
    const t = convexTest(schema, modules);
    const { passwordTemporal } = await crearAdminYUsuarioObjetivo(t);

    for (let i = 0; i < 5; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }

    // 6º intento — ya con el password REAL — debe rechazarse por rate
    // limit, no por credenciales, y con un mensaje distinto que lo explique.
    await expect(
      t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: passwordTemporal, remember: false })
    ).rejects.toThrow(/Demasiados intentos fallidos/);
  });

  // Actualizado en la re-review de PR8 (commit posterior a ae8d49b):
  // limpiarIntentosLogin ya NO borra toda la fila al primer éxito — solo
  // deshace la reserva propia de ese login exitoso (ver
  // "limpiarIntentosLogin no debe borrar reservas ajenas en vuelo" más
  // abajo). Consecuencia intencional: fallos previos ya resueltos NO se
  // olvidan por completo con un solo éxito, solo se descuenta uno. Es el
  // trade-off aceptado a cambio de que un login exitoso concurrente no
  // pueda borrarle al atacante sus intentos fallidos todavía en vuelo.
  test('un login exitoso limpia SOLO su propia reserva — los fallos previos ya resueltos siguen contando', async () => {
    const t = convexTest(schema, modules);
    const { passwordTemporal } = await crearAdminYUsuarioObjetivo(t);

    // 3 fallos (bajo el umbral de 5) + 1 éxito.
    for (let i = 0; i < 3; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow();
    }
    await t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: passwordTemporal, remember: false });

    // La propia reserva del login exitoso también incrementó `intentos`
    // (3 → 4) antes de saberse que iba a tener éxito; limpiarIntentosLogin
    // solo descuenta esa reserva propia (4 → 3) — quedan los 3 fallos
    // previos intactos, ya NO se resetea a 0. Con eso hacen falta solo 2
    // fallos más (no 5) para llegar al umbral de bloqueo.
    for (let i = 0; i < 2; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }
    await expect(
      t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: passwordTemporal, remember: false })
    ).rejects.toThrow(/Demasiados intentos fallidos/);
  });

  test('el bloqueo es por usuario — atacar a "objetivo.prueba" no bloquea el login de otra cuenta', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Objetivo Prueba', usuario: 'objetivo.prueba', rol: 'operador', token: adminToken,
    });
    const { passwordTemporal: passwordOtro } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Otro Usuario', usuario: 'otro.usuario', rol: 'operador', token: adminToken,
    });

    for (let i = 0; i < 6; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow();
    }

    // "otro.usuario" nunca fue atacado — su login normal debe seguir
    // funcionando sin importar cuántas veces fallara "objetivo.prueba".
    const sesion = await t.action(api.authActions.login, { usuario: 'otro.usuario', password: passwordOtro, remember: false });
    expect(sesion.usuario).toBe('otro.usuario');
  });

  test('la ventana de 15 minutos expira sola — pasado ese tiempo, los intentos viejos no cuentan', async () => {
    const t = convexTest(schema, modules);
    const { passwordTemporal } = await crearAdminYUsuarioObjetivo(t);

    const inicio = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(inicio);

    for (let i = 0; i < 4; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }

    // Avanza 16 minutos — la ventana de 15 min ya expiró, el contador
    // debe reiniciarse en el próximo fallo en vez de sumar al anterior.
    vi.setSystemTime(inicio + 16 * 60 * 1000);

    // Si los 4 fallos de ANTES de la ventana siguieran contando, bastaría
    // con 1 fallo más (4+1=5) para bloquear. En cambio hacen falta 5
    // fallos nuevos completos — eso prueba que el contador sí se reinició.
    for (let i = 0; i < 5; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }

    // El 5º fallo (recién contado arriba) ya dejó la cuenta bloqueada —
    // este 6º intento, aunque use el password real, debe rechazarse por
    // rate limit.
    await expect(
      t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: passwordTemporal, remember: false })
    ).rejects.toThrow(/Demasiados intentos fallidos/);
  });

  test('usuario inexistente también cuenta para el rate limit (no solo password incorrecto)', async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'no.existe.jamas', password: 'x', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }
    await expect(
      t.action(api.authActions.login, { usuario: 'no.existe.jamas', password: 'x', remember: false })
    ).rejects.toThrow(/Demasiados intentos fallidos/);
  });

  // BLOQUEANTE (auditoría de PR8): la versión anterior checaba el bloqueo
  // con una query de LECTURA separada de la mutation que registraba el
  // fallo (llamada recién DESPUÉS de bcrypt). Bajo intentos concurrentes,
  // varias llamadas podían leer "no bloqueado" antes de que ninguna
  // registrara nada — el conteo final en la tabla terminaba correcto
  // (Convex serializa mutations), pero el GATE que debía impedir correr
  // bcrypt de más ya se había pasado de largo en todas. Este test dispara
  // 6 intentos fallidos EN PARALELO (Promise.all, no un for secuencial
  // como los de arriba) — con el fix (admitirIntentoLogin, mutation
  // atómica que checa Y reserva en la misma transacción), Convex serializa
  // las 6 llamadas entre sí y solo las primeras 5 quedan admitidas a
  // procesar credenciales, sin importar que se dispararan a la vez.
  test('BLOQUEANTE (auditoría de PR8): 6 intentos fallidos CONCURRENTES — solo 5 pasan a procesamiento, el resto queda bloqueado sin correr bcrypt', async () => {
    const t = convexTest(schema, modules);
    await crearAdminYUsuarioObjetivo(t);

    const resultados = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      )
    );

    const porCredenciales = resultados.filter(
      (r) => r.status === 'rejected' && /Usuario o contraseña incorrectos/.test(String((r as PromiseRejectedResult).reason))
    );
    const porRateLimit = resultados.filter(
      (r) => r.status === 'rejected' && /Demasiados intentos fallidos/.test(String((r as PromiseRejectedResult).reason))
    );

    // Sin el fix, esto podía dar 6 rechazos por credenciales (los 6
    // corrieron bcrypt) y 0 por rate limit — la señal exacta de que el
    // límite no frenó nada bajo concurrencia real.
    expect(porCredenciales).toHaveLength(5);
    expect(porRateLimit).toHaveLength(1);
  });
});

// Mayor (re-review de CodeRabbit sobre el commit ae8d49b, mismo punto que
// ya había señalado en la ronda anterior): limpiarIntentosLogin borraba la
// fila COMPLETA de loginIntentos al primer login exitoso — bajo intentos
// concurrentes, eso también borraba las reservas de OTROS intentos del
// mismo usuario que seguían en vuelo (ya admitidos por admitirIntentoLogin,
// pendientes de que su bcrypt resuelva), dándole al atacante un cupo nuevo
// de 5 intentos gratis. El fix decrementa en 1 (deshace solo la reserva
// propia) en vez de borrar todo.
describe('auth: limpiarIntentosLogin no debe borrar reservas ajenas en vuelo (mayor de la re-review de PR8)', () => {
  test('un login exitoso concurrente decrementa su propia reserva, no resetea el contador de otros intentos en vuelo', async () => {
    const t = convexTest(schema, modules);
    const usuario = 'objetivo.concurrente';

    // 4 intentos del atacante, ya admitidos (reservados) por
    // admitirIntentoLogin — simulan requests fallidos todavía en vuelo
    // (su bcrypt aún no resuelve).
    for (let i = 0; i < 4; i++) {
      const { admitido } = await t.mutation(internal.auth.admitirIntentoLogin, { usuario });
      expect(admitido).toBe(true);
    }

    // Un 5º intento CONCURRENTE — este es el que va a resultar exitoso
    // (password correcto) — también se reserva primero, como cualquier
    // otro (admitirIntentoLogin no sabe todavía si va a fallar o no).
    const quinto = await t.mutation(internal.auth.admitirIntentoLogin, { usuario });
    expect(quinto.admitido).toBe(true);

    // Ese 5º intento resuelve como éxito y limpia SU reserva.
    await t.mutation(internal.auth.limpiarIntentosLogin, { usuario });

    // La fila sigue existiendo con el conteo de los 4 intentos del
    // atacante que seguían en vuelo — NO se resetea a 0.
    const registro = await t.run((ctx) =>
      ctx.db.query('loginIntentos').withIndex('by_usuario', (q) => q.eq('usuario', usuario)).unique()
    );
    expect(registro).not.toBeNull();
    expect(registro!.intentos).toBe(4);

    // El atacante manda 2 intentos más: el 5º real del atacante (permitido,
    // completa el límite de 5) y el 6º (debe quedar bloqueado). Si el paso
    // anterior hubiera reseteado el contador a 0, ambos se habrían admitido
    // de más.
    const sextoGlobal = await t.mutation(internal.auth.admitirIntentoLogin, { usuario });
    expect(sextoGlobal.admitido).toBe(true);
    const septimoGlobal = await t.mutation(internal.auth.admitirIntentoLogin, { usuario });
    expect(septimoGlobal.admitido).toBe(false);
  });

  test('cuando nadie más tiene una reserva en vuelo, limpiarIntentosLogin sí borra la fila completa (caso común)', async () => {
    const t = convexTest(schema, modules);
    const usuario = 'objetivo.solo';

    await t.mutation(internal.auth.admitirIntentoLogin, { usuario });
    await t.mutation(internal.auth.limpiarIntentosLogin, { usuario });

    const registro = await t.run((ctx) =>
      ctx.db.query('loginIntentos').withIndex('by_usuario', (q) => q.eq('usuario', usuario)).unique()
    );
    expect(registro).toBeNull();
  });
});

// Mayor (auditoría de PR8): loginIntentos no tenía expiración ni limpieza
// — cada usuario (real o inventado por un atacante probando muchos
// nombres) que alguna vez falló un login dejaba una fila para siempre.
describe('auth: limpiarLoginIntentosExpirados (mayor de la auditoría de PR8)', () => {
  test('borra filas cuyo expiresAt ya pasó, deja intactas las que siguen vigentes', async () => {
    const t = convexTest(schema, modules);
    const inicio = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(inicio);

    // "viejo.atacado" falla una vez y nunca vuelve — su ventana expira sola.
    await expect(
      t.action(api.authActions.login, { usuario: 'viejo.atacado', password: 'x', remember: false })
    ).rejects.toThrow();

    // Avanza más allá de la ventana de 15 min de esa fila.
    vi.setSystemTime(inicio + 20 * 60 * 1000);

    // "reciente.atacado" falla justo ahora — su fila sigue vigente.
    await expect(
      t.action(api.authActions.login, { usuario: 'reciente.atacado', password: 'x', remember: false })
    ).rejects.toThrow();

    const { borrados } = await t.mutation(internal.auth.limpiarLoginIntentosExpirados, {});
    expect(borrados).toBe(1);

    const restantes = await t.run((ctx) => ctx.db.query('loginIntentos').collect());
    expect(restantes).toHaveLength(1);
    expect(restantes[0].usuario).toBe('reciente.atacado');
  });

  // Mayor (re-review de CodeRabbit sobre el commit ae8d49b): un atacante
  // que manda >200 usuarios distintos por hora crea filas expiradas más
  // rápido de lo que el cron horario (`.take(200)` por corrida) las
  // limpiaba — el rezago podía crecer sin límite igual. Fix: si un lote
  // sale lleno, la mutation se reprograma a sí misma para correr de
  // inmediato (continuación), en vez de esperar la próxima hora.
  test('flood de >200 usuarios únicos expirados: el lote lleno se reprograma solo hasta vaciar el rezago', async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const ahora = Date.now();
    const totalFilas = 250; // > LOTE (200), fuerza al menos una continuación

    await t.run(async (ctx) => {
      for (let i = 0; i < totalFilas; i++) {
        await ctx.db.insert('loginIntentos', {
          usuario: `flood.usuario.${i}`,
          intentos: 1,
          primerIntentoEn: ahora - 60 * 60 * 1000,
          bloqueadoHasta: null,
          expiresAt: ahora - 1000, // ya expirado
        });
      }
    });

    const primerLote = await t.mutation(internal.auth.limpiarLoginIntentosExpirados, {});
    // Salió lleno (200 de 250) — debe haberse reprogramado sola.
    expect(primerLote.borrados).toBe(200);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Sin la continuación, 50 filas del flood se habrían quedado esperando
    // hasta la próxima hora del cron. Con el fix, la reprogramación las
    // termina de limpiar en la misma corrida lógica.
    const restantes = await t.run((ctx) => ctx.db.query('loginIntentos').collect());
    expect(restantes).toHaveLength(0);
  });
});
