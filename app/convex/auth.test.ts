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

  test('un login exitoso limpia el contador — intentos fallidos previos no se acumulan después', async () => {
    const t = convexTest(schema, modules);
    const { passwordTemporal } = await crearAdminYUsuarioObjetivo(t);

    // 3 fallos (bajo el umbral de 5) + 1 éxito.
    for (let i = 0; i < 3; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow();
    }
    await t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: passwordTemporal, remember: false });

    // Si el contador NO se limpió, estos 4 fallos (3 previos + 4) ya
    // pasarían de 5 y bloquearían antes de tiempo. Deben seguir siendo
    // rechazos por credenciales, no por rate limit.
    for (let i = 0; i < 4; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.prueba', password: 'incorrecta', remember: false })
      ).rejects.toThrow(/Usuario o contraseña incorrectos/);
    }
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
});
