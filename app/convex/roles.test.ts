import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { requireAcceso } from './lib/auth';
import {
  crearUsuarioPrueba, crearSesionPrueba, crearRolesPrueba,
} from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearRolesPrueba(t);
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, compradorId, adminToken, comprasToken };
}

describe('roles: listRoles (EDS-104)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.roles.listRoles, { token: comprasToken })).rejects.toThrow();
  });

  test('devuelve los 5 roles base, ordenados por `orden`', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    expect(roles.map((r) => r.slug)).toEqual(['admin', 'gerencia', 'compras', 'calidad', 'operador']);
    const admin = roles.find((r) => r.slug === 'admin')!;
    expect(admin.protegido).toBe(true);
    expect(admin.bypassAcceso).toBe(true);
  });
});

describe('roles: crearRol (EDS-104)', () => {
  test('crea un rol nuevo con slug derivado del nombre', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const r = await t.mutation(api.roles.crearRol, {
      nombre: 'Supervisión Técnica', paginas: ['panel-control'], token: adminToken,
    });
    expect(r.slug).toBe('supervision_tecnica');
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const nuevo = roles.find((x) => x.slug === r.slug)!;
    expect(nuevo.nombre).toBe('Supervisión Técnica');
    expect(nuevo.paginas).toEqual(['panel-control']);
    expect(nuevo.protegido).toBe(false);
    expect(nuevo.bypassAcceso).toBe(false);
  });

  test('rechaza nombre vacío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.roles.crearRol, { nombre: '   ', paginas: [], token: adminToken })
    ).rejects.toThrow();
  });

  test('rechaza una página que no existe en el catálogo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.roles.crearRol, { nombre: 'Rol X', paginas: ['pagina-inventada'], token: adminToken })
    ).rejects.toThrow();
  });

  test('rechaza gestion-usuarios/gestion-roles — no son asignables', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.roles.crearRol, { nombre: 'Rol Y', paginas: ['gestion-usuarios'], token: adminToken })
    ).rejects.toThrow();
    await expect(
      t.mutation(api.roles.crearRol, { nombre: 'Rol Z', paginas: ['gestion-roles'], token: adminToken })
    ).rejects.toThrow();
  });

  test('slug colisiona → sufijo numérico, nunca sobrescribe', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const r1 = await t.mutation(api.roles.crearRol, { nombre: 'Compras', paginas: ['panel-control'], token: adminToken });
    // "Compras" normaliza al mismo slug que el rol base "compras" ya sembrado.
    expect(r1.slug).toBe('compras_2');
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    expect(roles.filter((r) => r.slug.startsWith('compras')).length).toBe(2);
  });
});

describe('roles: actualizarRol (EDS-104)', () => {
  test('actualiza nombre y páginas de un rol no protegido', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const gerencia = roles.find((r) => r.slug === 'gerencia')!;
    await t.mutation(api.roles.actualizarRol, {
      rolId: gerencia._id, nombre: 'Gerencia General', paginas: ['panel-control', 'reporte-diario'], token: adminToken,
    });
    const actualizado = (await t.query(api.roles.listRoles, { token: adminToken })).find((r) => r.slug === 'gerencia')!;
    expect(actualizado.nombre).toBe('Gerencia General');
    expect(actualizado.paginas).toEqual(['panel-control', 'reporte-diario']);
  });

  test('rechaza editar el rol protegido (admin)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const admin = roles.find((r) => r.slug === 'admin')!;
    await expect(
      t.mutation(api.roles.actualizarRol, { rolId: admin._id, nombre: 'Superadmin', token: adminToken })
    ).rejects.toThrow();
  });
});

describe('roles: eliminarRol / reactivarRol (EDS-104)', () => {
  test('rechaza eliminar el rol protegido (admin)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const admin = roles.find((r) => r.slug === 'admin')!;
    await expect(
      t.mutation(api.roles.eliminarRol, { rolId: admin._id, token: adminToken })
    ).rejects.toThrow();
  });

  test('rechaza eliminar un rol con usuarios activos asignados', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t); // compradorId ya tiene rol "compras"
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const compras = roles.find((r) => r.slug === 'compras')!;
    await expect(
      t.mutation(api.roles.eliminarRol, { rolId: compras._id, token: adminToken })
    ).rejects.toThrow(/usuarios activos/);
  });

  test('elimina (soft-delete) un rol sin usuarios activos, y se puede reactivar', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    const calidad = roles.find((r) => r.slug === 'calidad')!; // nadie tiene este rol en setup()
    await t.mutation(api.roles.eliminarRol, { rolId: calidad._id, token: adminToken });
    let actual = (await t.query(api.roles.listRoles, { token: adminToken })).find((r) => r.slug === 'calidad')!;
    expect(actual.activo).toBe(false);

    await t.mutation(api.roles.reactivarRol, { rolId: calidad._id, token: adminToken });
    actual = (await t.query(api.roles.listRoles, { token: adminToken })).find((r) => r.slug === 'calidad')!;
    expect(actual.activo).toBe(true);
  });
});

describe('roles: seedRolesBase (EDS-104)', () => {
  test('siembra los 5 roles base en una base vacía', async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(api.roles.seedRolesBase, {});
    expect(r.insertados).toBe(5);
    expect(r.yaExistian).toBe(0);
    expect(r.usuariosHuerfanos).toEqual([]);
  });

  test('idempotente por rol: correrlo 2 veces no duplica nada', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.roles.seedRolesBase, {});
    const r2 = await t.mutation(api.roles.seedRolesBase, {});
    expect(r2.insertados).toBe(0);
    expect(r2.yaExistian).toBe(5);
    // no hay query pública de roles sin sesión — se verifica indirecto:
    // crear un usuario admin y confirmar que listRoles sigue viendo 5.
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    expect(roles.length).toBe(5);
  });

  test('completa una siembra parcial sin pisar el rol que ya existía editado', async () => {
    const t = convexTest(schema, modules);
    // Simula una corrida parcial anterior: solo "admin" existe, y alguien
    // ya le cambió el nombre a mano (verifica que el 2º rol NO lo pisa).
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('roles', {
        slug: 'admin', nombre: 'Admin (renombrado a mano)', paginas: ['panel-control'],
        protegido: true, bypassAcceso: true, activo: true, orden: 0, updatedAt: now, updatedBy: null,
      });
    });
    const r = await t.mutation(api.roles.seedRolesBase, {});
    expect(r.insertados).toBe(4); // los otros 4, "admin" ya existía
    expect(r.yaExistian).toBe(1);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    const roles = await t.query(api.roles.listRoles, { token: adminToken });
    expect(roles.find((x) => x.slug === 'admin')!.nombre).toBe('Admin (renombrado a mano)');
    expect(roles.length).toBe(5);
  });

  test('reporta usuarios huérfanos (rol activo sin fila correspondiente en roles)', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('users', {
        nombre: 'Fantasma', usuario: 'fantasma', passwordHash: 'x',
        rol: 'rol_que_no_existe', activo: true, createdAt: now, updatedAt: now,
      });
    });
    const r = await t.mutation(api.roles.seedRolesBase, {});
    expect(r.usuariosHuerfanos).toEqual([{ usuario: 'fantasma', rol: 'rol_que_no_existe' }]);
  });
});

describe('lib/auth: requireAcceso (EDS-104) — sin call sites reales todavía (Fase 2 los migra)', () => {
  test('rechaza sin token / con rol inactivo o inexistente', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t);
    await expect(t.run((ctx) => requireAcceso(ctx, null, 'panel-control'))).rejects.toBeInstanceOf(ConvexError);

    const fantasmaId = await crearUsuarioPrueba(t, 'rol_inexistente' as any);
    const fantasmaToken = await crearSesionPrueba(t, fantasmaId);
    await expect(t.run((ctx) => requireAcceso(ctx, fantasmaToken, 'panel-control'))).rejects.toThrow(/ya no existe o está inactivo/);
  });

  test('acepta si el rol tiene acceso a la página pedida; rechaza si no', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t);
    const compradorId = await crearUsuarioPrueba(t, 'compras');
    const comprasToken = await crearSesionPrueba(t, compradorId);
    await expect(t.run((ctx) => requireAcceso(ctx, comprasToken, 'panel-control'))).resolves.toBeDefined();
    await expect(t.run((ctx) => requireAcceso(ctx, comprasToken, 'entradas-costeo'))).resolves.toBeDefined();
    await expect(t.run((ctx) => requireAcceso(ctx, comprasToken, 'gestion-usuarios'))).rejects.toThrow(/No autorizado/);
  });

  test('acepta CUALQUIER página si el rol trae bypassAcceso (admin)', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await expect(t.run((ctx) => requireAcceso(ctx, adminToken, 'gestion-roles'))).resolves.toBeDefined();
    await expect(t.run((ctx) => requireAcceso(ctx, adminToken, 'cierre-turno'))).resolves.toBeDefined();
  });

  test('basta con tener acceso a UNA de varias páginas pedidas', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t);
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const operadorToken = await crearSesionPrueba(t, operadorId);
    await expect(
      t.run((ctx) => requireAcceso(ctx, operadorToken, ['entradas-costeo', 'cierre-turno']))
    ).resolves.toBeDefined();
  });
});
