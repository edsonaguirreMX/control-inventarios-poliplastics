import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import {
  crearMaterialPrueba,
  crearUsuarioPrueba,
  crearSesionPrueba,
  crearParametrosPrueba,
} from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

// EDS-73: Convex redacta en producción el `.message` de cualquier `Error`
// normal antes de mandarlo al cliente (solo se ve completo en dev o por
// CLI) — solo el payload de un `ConvexError` llega íntegro al navegador.
// Confirmado en vivo durante el smoke test post-deploy de EDS-67
// (2026-08-10): tanto el login con credenciales inválidas como un cierre
// bloqueado por PEPS mostraban "Server Error"/"No se pudo conectar con el
// servidor" en vez del mensaje real, aunque el bloqueo en sí funcionaba
// bien (integridad intacta, nada se guardó a medias).
//
// `convex-test` NO simula esa redacción de producción (los mensajes de
// `Error` normal se ven completos igual que en dev) — así que estos tests
// no pueden probar "¿el navegador ve el mensaje?" directamente. Prueban lo
// que SÍ es correcto y suficiente aquí: que cada validación de negocio
// alcanzable por un usuario real se lanza como `ConvexError`, no `Error` —
// la única garantía que hace que el mensaje sobreviva la redacción de
// producción. La confirmación de que el navegador real ya muestra el
// mensaje se hizo aparte, con un smoke test manual repitiendo login
// inválido y cierre bloqueado por PEPS contra dev/producción (ver PR).
describe('EDS-73: errores de negocio esperados se lanzan como ConvexError (no Error)', () => {
  test('login con credenciales inválidas', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Objetivo', usuario: 'objetivo.errores', rol: 'operador', token: adminToken,
    });

    await expect(
      t.action(api.authActions.login, { usuario: 'objetivo.errores', password: 'incorrecta', remember: false })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('login bloqueado por rate limit', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Objetivo', usuario: 'objetivo.ratelimit', rol: 'operador', token: adminToken,
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        t.action(api.authActions.login, { usuario: 'objetivo.ratelimit', password: 'incorrecta', remember: false })
      ).rejects.toThrow();
    }
    // No basta con "es un ConvexError" — credenciales inválidas TAMBIÉN
    // son ConvexError ahora, así que ese chequeo solo pasaría igual si el
    // rate limit estuviera roto y el 6º intento fallara por password otra
    // vez (hallazgo de CodeRabbit en la re-review de este PR). Hace falta
    // confirmar que es específicamente el rechazo de rate limit.
    let error: unknown;
    try {
      await t.action(api.authActions.login, { usuario: 'objetivo.ratelimit', password: 'incorrecta', remember: false });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<string>).data).toMatch(/Demasiados intentos fallidos/);
  });

  test('permisos: un rol sin acceso topa con requireRole', async () => {
    const t = convexTest(schema, modules);
    const comprasId = await crearUsuarioPrueba(t, 'compras');
    const comprasToken = await crearSesionPrueba(t, comprasId);

    // listUsuarios es admin-only — cualquier otro rol debe rebotar aquí,
    // vía el mismo requireRole que protege todo el backend.
    await expect(
      t.query(api.usuarios.listUsuarios, { token: comprasToken })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('permisos: sesión inválida/inexistente', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.usuarios.listUsuarios, { token: 'token-que-no-existe' })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('PEPS: inventario insuficiente al cerrar un turno (el hallazgo real del smoke test)', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const userId = await crearUsuarioPrueba(t, 'operador');
    const token = await crearSesionPrueba(t, userId);
    await crearParametrosPrueba(t);
    // Sin ninguna capa creada — disponible 0kg, cualquier consumo > 0 debe
    // bloquear (mismo escenario exacto reproducido en producción real).

    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: '2026-08-10', linea: 1, turno: 1,
        cargasPreparadas: 1, metrosBuenos: 10,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matId, kgConsumido: 25 }],
        token,
      })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de cierre: cargasPreparadas negativo', async () => {
    const t = convexTest(schema, modules);
    const userId = await crearUsuarioPrueba(t, 'operador');
    const token = await crearSesionPrueba(t, userId);
    await crearParametrosPrueba(t);

    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: '2026-08-10', linea: 1, turno: 1,
        cargasPreparadas: -1, metrosBuenos: 10,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [],
        token,
      })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de entrada: cantidadKg no puede ser 0', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const userId = await crearUsuarioPrueba(t, 'operador');
    const token = await crearSesionPrueba(t, userId);

    await expect(
      t.mutation(api.entradas.crearEntrada, { fecha: '2026-08-10', materialId: matId, cantidadKg: 0, token })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de catálogo: costoEstandar negativo', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.materiales.updateMaterial, { materialId: matId, costoEstandar: -1, token: adminToken })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de parámetros: la fórmula completa no puede sumar 0', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    await crearParametrosPrueba(t);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.parametros.updateFormulaCarga, { materialId: matId, kgPorCarga: 0, token: adminToken })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de usuarios: usuario duplicado', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Original', usuario: 'duplicado.errores', rol: 'operador', token: adminToken,
    });

    await expect(
      t.action(api.usuariosActions.crearUsuario, {
        nombre: 'Otro', usuario: 'duplicado.errores', rol: 'compras', token: adminToken,
      })
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test('validación de usuarios: dejar al sistema sin ningún admin activo', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.usuarios.updateUsuario, { userId: adminId, rol: 'compras', token: adminToken })
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
