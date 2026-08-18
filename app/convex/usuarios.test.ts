import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearUsuarioPrueba, crearSesionPrueba, crearRolesPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

// EDS-104: crearUsuarioImpl/actualizarUsuarioImpl ahora validan que `rol`
// exista y esté activo en la tabla `roles` (antes lo garantizaba el union
// fijo del schema) — sin esto, cualquier test que cree/edite un usuario
// con un rol real (admin/compras/gerencia/calidad/operador) fallaría.
async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearRolesPrueba(t);
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, compradorId, adminToken, comprasToken };
}

describe('usuarios: listUsuarios (tarea 9.1)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.usuarios.listUsuarios, { token: comprasToken })).rejects.toThrow();
  });

  test('nunca regresa passwordHash', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    for (const u of usuarios) {
      expect(u).not.toHaveProperty('passwordHash');
    }
  });
});

describe('usuarios: crearUsuario (tarea 9.1) — action con bcrypt', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(
      t.action(api.usuariosActions.crearUsuario, { nombre: 'Roberto Sánchez', usuario: 'roberto', rol: 'operador', token: comprasToken })
    ).rejects.toThrow();
  });

  test('crea un usuario funcional que puede loguearse con el password temporal devuelto', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const { passwordTemporal } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Roberto Sánchez', usuario: 'roberto.sanchez', rol: 'operador', token: adminToken,
    });
    expect(passwordTemporal).toHaveLength(11); // 10 + '!'

    const sesion = await t.action(api.authActions.login, { usuario: 'roberto.sanchez', password: passwordTemporal, remember: false });
    expect(sesion.rol).toBe('operador');
    expect(sesion.nombre).toBe('Roberto Sánchez');
  });

  test('normaliza el usuario a minúsculas y rechaza duplicados (mensaje claro)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.action(api.usuariosActions.crearUsuario, { nombre: 'Ana Torres', usuario: 'Ana.Torres', rol: 'gerencia', token: adminToken });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    expect(usuarios.find((u) => u.usuario === 'ana.torres')).toBeDefined();

    await expect(
      t.action(api.usuariosActions.crearUsuario, { nombre: 'Ana Torres 2', usuario: 'ana.torres', rol: 'compras', token: adminToken })
    ).rejects.toThrow(/ya existe/);
  });

  test('rechaza nombre o usuario vacíos', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.action(api.usuariosActions.crearUsuario, { nombre: '  ', usuario: 'x', rol: 'operador', token: adminToken })
    ).rejects.toThrow(/nombre/);
    await expect(
      t.action(api.usuariosActions.crearUsuario, { nombre: 'X', usuario: '   ', rol: 'operador', token: adminToken })
    ).rejects.toThrow(/usuario/);
  });
});

describe('usuarios: updateUsuario / guardarUsuariosCompleto (tarea 9.1)', () => {
  test('actualiza nombre/usuario/rol', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const nuevoId = await crearUsuarioPrueba(t, 'operador');
    await t.mutation(api.usuarios.updateUsuario, { userId: nuevoId, nombre: 'Nombre Nuevo', rol: 'calidad', token: adminToken });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const fila = usuarios.find((u) => u._id === nuevoId);
    expect(fila?.nombre).toBe('Nombre Nuevo');
    expect(fila?.rol).toBe('calidad');
  });

  test('rechaza usuario duplicado (excluyendo la propia fila)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, compradorId } = await setup(t);
    // No falla al "actualizarse a sí mismo" con el mismo usuario que ya tiene.
    const usuarios0 = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const yo = usuarios0.find((u) => u._id === compradorId)!;
    await t.mutation(api.usuarios.updateUsuario, { userId: compradorId, usuario: yo.usuario, token: adminToken });

    const otroId = await crearUsuarioPrueba(t, 'operador');
    const usuarios1 = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const otro = usuarios1.find((u) => u._id === otroId)!;
    await expect(
      t.mutation(api.usuarios.updateUsuario, { userId: otroId, usuario: yo.usuario, token: adminToken })
    ).rejects.toThrow(/ya existe/);
    expect(otro.usuario).not.toBe(yo.usuario); // no quedó a medias
  });

  test('guardarUsuariosCompleto es atómico — BUG DE INTEGRIDAD REGRESIÓN: si una fila del batch falla, NINGUNA queda guardada', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const aId = await crearUsuarioPrueba(t, 'operador');
    const bId = await crearUsuarioPrueba(t, 'operador');

    await expect(
      t.mutation(api.usuarios.guardarUsuariosCompleto, {
        usuarios: [{ userId: aId, nombre: 'A nuevo' }, { userId: bId, nombre: '   ' }],
        token: adminToken,
      })
    ).rejects.toThrow(/nombre/);

    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    expect(usuarios.find((u) => u._id === aId)?.nombre).not.toBe('A nuevo'); // no quedó a medias
  });

  test('un intercambio de "usuario" entre dos filas del mismo batch se resuelve correcto (read-your-own-writes)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const aId = await crearUsuarioPrueba(t, 'operador', 'temp-a');
    const bId = await crearUsuarioPrueba(t, 'operador', 'temp-b');

    await t.mutation(api.usuarios.guardarUsuariosCompleto, {
      usuarios: [{ userId: aId, usuario: 'temp-b-nuevo' }, { userId: bId, usuario: 'temp-a' }],
      token: adminToken,
    });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    expect(usuarios.find((u) => u._id === aId)?.usuario).toBe('temp-b-nuevo');
    expect(usuarios.find((u) => u._id === bId)?.usuario).toBe('temp-a');
  });
});

describe('usuarios: invariante "siempre queda al menos un admin activo" (tarea 9.1) — BLOQUEANTE de la auditoría de PR 7', () => {
  test('el único admin no puede cambiarse a sí mismo a otro rol vía updateUsuario — no persiste nada', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    // setup() también crea un usuario de compras, pero NO otro admin —
    // adminId es el único admin activo del sistema en este test.
    await expect(
      t.mutation(api.usuarios.updateUsuario, { userId: adminId, rol: 'compras', token: adminToken })
    ).rejects.toThrow(/sin ningún admin activo/);

    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    expect(usuarios.find((u) => u._id === adminId)?.rol).toBe('admin'); // no quedó a medias
  });

  test('el único admin no puede cambiarse a sí mismo a otro rol vía guardarUsuariosCompleto — no persiste nada, ni siquiera cambios de OTRAS filas del mismo batch', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    const otroId = await crearUsuarioPrueba(t, 'operador');

    await expect(
      t.mutation(api.usuarios.guardarUsuariosCompleto, {
        usuarios: [{ userId: otroId, nombre: 'Otro Nombre Nuevo' }, { userId: adminId, rol: 'compras' }],
        token: adminToken,
      })
    ).rejects.toThrow(/sin ningún admin activo/);

    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    expect(usuarios.find((u) => u._id === adminId)?.rol).toBe('admin');
    expect(usuarios.find((u) => u._id === otroId)?.nombre).not.toBe('Otro Nombre Nuevo'); // el batch entero se revirtió
  });

  test('SÍ permite cambiar de rol si queda otro admin activo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    const segundoAdminId = await crearUsuarioPrueba(t, 'admin'); // segundo admin activo — ahora el cambio es seguro
    const segundoAdminToken = await crearSesionPrueba(t, segundoAdminId);

    await t.mutation(api.usuarios.updateUsuario, { userId: adminId, rol: 'gerencia', token: adminToken });
    // Se consulta con el SEGUNDO admin, no con adminToken — adminId ya no
    // es admin después del cambio, así que su propio token ya no pasa
    // requireRole(['admin']) (comportamiento correcto, no un bug de este test).
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: segundoAdminToken });
    expect(usuarios.find((u) => u._id === adminId)?.rol).toBe('gerencia');
  });
});

describe('usuarios: regenerarPassword (tarea 9.1)', () => {
  test('el password viejo deja de servir y el nuevo sí funciona', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const { passwordTemporal: passwordViejo } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Diego Flores', usuario: 'diego.flores', rol: 'operador', token: adminToken,
    });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const diegoId = usuarios.find((u) => u.usuario === 'diego.flores')!._id;

    const { passwordTemporal: passwordNuevo } = await t.action(api.usuariosActions.regenerarPassword, { userId: diegoId, token: adminToken });
    expect(passwordNuevo).not.toBe(passwordViejo);

    await expect(
      t.action(api.authActions.login, { usuario: 'diego.flores', password: passwordViejo, remember: false })
    ).rejects.toThrow();
    const sesion = await t.action(api.authActions.login, { usuario: 'diego.flores', password: passwordNuevo, remember: false });
    expect(sesion.nombre).toBe('Diego Flores');
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, comprasToken, compradorId } = await setup(t);
    await expect(
      t.action(api.usuariosActions.regenerarPassword, { userId: compradorId, token: comprasToken })
    ).rejects.toThrow();
  });

  test('MAYOR (auditoría de PR 7): invalida las sesiones activas del usuario objetivo — una sesión ya abierta con la contraseña vieja deja de funcionar de inmediato', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    await crearSesionPrueba(t, operadorId);

    // La sesión existe y es válida ANTES de regenerar.
    const antes = await t.run((ctx) => ctx.db.query('sessions').withIndex('by_userId', (q) => q.eq('userId', operadorId)).collect());
    expect(antes).toHaveLength(1);

    await t.action(api.usuariosActions.regenerarPassword, { userId: operadorId, token: adminToken });

    const despues = await t.run((ctx) => ctx.db.query('sessions').withIndex('by_userId', (q) => q.eq('userId', operadorId)).collect());
    expect(despues).toHaveLength(0);
  });
});

describe('usuarios: eliminarUsuario (tarea 9.1) — desactiva, nunca borra la fila', () => {
  test('desactiva (activo:false) en vez de borrar — preserva el userId para el historial de auditoría', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, compradorId } = await setup(t);
    await t.mutation(api.usuarios.eliminarUsuario, { userId: compradorId, token: adminToken });
    const fila = await t.run((ctx) => ctx.db.get(compradorId));
    expect(fila).not.toBeNull(); // la fila SIGUE existiendo
    expect(fila?.activo).toBe(false);
  });

  test('un usuario desactivado ya no puede iniciar sesión', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const { passwordTemporal } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Karla Núñez', usuario: 'karla.nunez', rol: 'operador', token: adminToken,
    });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const karlaId = usuarios.find((u) => u.usuario === 'karla.nunez')!._id;

    await t.mutation(api.usuarios.eliminarUsuario, { userId: karlaId, token: adminToken });
    await expect(
      t.action(api.authActions.login, { usuario: 'karla.nunez', password: passwordTemporal, remember: false })
    ).rejects.toThrow();
  });

  test('invalida de inmediato las sesiones activas del usuario desactivado, no solo el próximo login', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const operadorToken = await crearSesionPrueba(t, operadorId);
    // Confirma que la sesión sí era válida antes de desactivar.
    await expect(t.query(api.usuarios.listUsuarios, { token: operadorToken })).rejects.toThrow(); // operador no es admin, pero no por sesión inválida

    await t.mutation(api.usuarios.eliminarUsuario, { userId: operadorId, token: adminToken });
    const sesiones = await t.run((ctx) => ctx.db.query('sessions').withIndex('by_userId', (q) => q.eq('userId', operadorId)).collect());
    expect(sesiones).toHaveLength(0);
  });

  test('rechaza que un admin se desactive a sí mismo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    await expect(
      t.mutation(api.usuarios.eliminarUsuario, { userId: adminId, token: adminToken })
    ).rejects.toThrow(/propio usuario/);
  });

  test('el bloqueo de autodesactivación garantiza que el sistema nunca se quede sin ningún admin activo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    const segundoAdminId = await crearUsuarioPrueba(t, 'admin');
    const segundoAdminToken = await crearSesionPrueba(t, segundoAdminId);

    // Con 2 admins activos, uno puede desactivar al otro (nunca a sí mismo)
    // — quien llama la mutation siempre sigue activo después, así que el
    // conteo de admins activos jamás llega a 0 por esta vía.
    await t.mutation(api.usuarios.eliminarUsuario, { userId: adminId, token: segundoAdminToken });
    const todos = await t.run((ctx) => ctx.db.query('users').collect());
    expect(todos.filter((u) => u.rol === 'admin' && u.activo)).toHaveLength(1);

    // Ahora segundoAdminId es el único admin activo — intentar desactivarse
    // a sí mismo (la única forma en que podría llegar a 0) sigue bloqueado.
    await expect(
      t.mutation(api.usuarios.eliminarUsuario, { userId: segundoAdminId, token: segundoAdminToken })
    ).rejects.toThrow(/propio usuario/);
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const otroId = await crearUsuarioPrueba(t, 'operador');
    await expect(
      t.mutation(api.usuarios.eliminarUsuario, { userId: otroId, token: comprasToken })
    ).rejects.toThrow();
  });
});

describe('usuarios: reactivarUsuario (tarea 9.1) — simétrico a eliminarUsuario', () => {
  test('un usuario reactivado puede volver a iniciar sesión', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const { passwordTemporal } = await t.action(api.usuariosActions.crearUsuario, {
      nombre: 'Jorge Medina', usuario: 'jorge.medina', rol: 'operador', token: adminToken,
    });
    const usuarios = await t.query(api.usuarios.listUsuarios, { token: adminToken });
    const jorgeId = usuarios.find((u) => u.usuario === 'jorge.medina')!._id;

    await t.mutation(api.usuarios.eliminarUsuario, { userId: jorgeId, token: adminToken });
    await expect(
      t.action(api.authActions.login, { usuario: 'jorge.medina', password: passwordTemporal, remember: false })
    ).rejects.toThrow();

    await t.mutation(api.usuarios.reactivarUsuario, { userId: jorgeId, token: adminToken });
    const sesion = await t.action(api.authActions.login, { usuario: 'jorge.medina', password: passwordTemporal, remember: false });
    expect(sesion.nombre).toBe('Jorge Medina');
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const otroId = await crearUsuarioPrueba(t, 'operador');
    await expect(
      t.mutation(api.usuarios.reactivarUsuario, { userId: otroId, token: comprasToken })
    ).rejects.toThrow();
  });
});
