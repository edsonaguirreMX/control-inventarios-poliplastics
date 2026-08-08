import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

// Datos maestros extraídos tal cual del mockup aprobado (diseno/ y app/public/):
// catalogo-materiales.html (DEFAULTS), parametros-produccion.html (FORMULA/STATE),
// alertas-configuracion.html (REGLAS). No inventar valores — si cambian, se
// cambian primero en el mockup y se refleja aquí.

export const isSeeded = internalQuery({
  args: {},
  handler: async (ctx) => {
    const existente = await ctx.db.query('materiales').first();
    return existente !== null;
  },
});

const MATERIALES = [
  {
    slug: 'hdpe-r-pel', nombre: 'HDPE reciclado', variante: 'peletizado',
    esInterno: false, esSustituto: false, costoEstandar: 14.5,
    leadTimeDias: 10, stockSeguridadDias: 7,
    reorderMode: 'manual' as const, reorderManualKg: 38000, cantidadPedirKg: 20000,
    kgPorCarga: 25, notaFormula: '',
  },
  {
    slug: 'hdpe-v-pel', nombre: 'HDPE virgen', variante: 'peletizado (sustituto)',
    esInterno: false, esSustituto: true, costoEstandar: 22.8,
    leadTimeDias: 15, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 5000,
    kgPorCarga: 0, notaFormula: 'sustituto — comparte cupo con reciclado',
  },
  {
    slug: 'hdpe-r-hoj', nombre: 'HDPE reciclado', variante: 'en hojuela',
    esInterno: false, esSustituto: false, costoEstandar: 11.2,
    leadTimeDias: 8, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 6000,
    kgPorCarga: 50, notaFormula: '',
  },
  {
    slug: 'hdpe-r-hoj-sl', nombre: 'HDPE reciclado', variante: 'hojuela sin lavar',
    esInterno: false, esSustituto: false, costoEstandar: 8.4,
    leadTimeDias: 8, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 4000,
    kgPorCarga: 7.5, notaFormula: '',
  },
  {
    slug: 'caco3', nombre: 'Carbonato de calcio', variante: 'peletizado',
    esInterno: false, esSustituto: false, costoEstandar: 6.9,
    leadTimeDias: 12, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 8000,
    kgPorCarga: 50, notaFormula: '',
  },
  {
    slug: 'masterbatch', nombre: 'Masterbatch', variante: 'de color',
    esInterno: false, esSustituto: false, costoEstandar: 48.0,
    leadTimeDias: 20, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 2000,
    kgPorCarga: 2.5, notaFormula: '',
  },
  {
    slug: 'aditivo-uv', nombre: 'Aditivo UV', variante: '',
    esInterno: false, esSustituto: false, costoEstandar: 65.0,
    leadTimeDias: 25, stockSeguridadDias: 7,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: 800,
    kgPorCarga: 1.5, notaFormula: '',
  },
  {
    slug: 'triturado', nombre: 'Triturado', variante: 'interno — se valúa en $0',
    esInterno: true, esSustituto: false, costoEstandar: 0,
    leadTimeDias: null, stockSeguridadDias: null,
    reorderMode: 'auto' as const, reorderManualKg: null, cantidadPedirKg: null,
    kgPorCarga: 12.5, notaFormula: 'aproximado — varía con la merma',
  },
];

const ALERTAS_REGLAS = [
  {
    slug: 'turno-sin-cerrar', nombre: 'Turno sin cerrar',
    descripcion: 'Avisa si un turno no se cierra dentro del tiempo esperado después de terminar.',
    activa: true, umbral: 30, unidad: 'min',
    destinatariosRoles: ['admin'], canales: ['correo', 'sistema'] as const,
  },
  {
    slug: 'material-critico', nombre: 'Material en punto de reorden crítico',
    descripcion: 'Avisa en cuanto un material cruza por debajo de su punto de reorden.',
    activa: true, umbral: null, unidad: null,
    destinatariosRoles: ['compras'], canales: ['correo', 'whatsapp', 'sistema'] as const,
  },
  {
    slug: 'material-por-vencer', nombre: 'Material por vencer su punto de reorden',
    descripcion: 'Avisa cuando un material entra a la zona amarilla, antes de volverse crítico.',
    activa: true, umbral: 15, unidad: '%',
    destinatariosRoles: ['compras'], canales: ['sistema'] as const,
  },
  {
    slug: 'merma-alta', nombre: '% de merma por arriba de la meta',
    descripcion: 'Avisa cuando la merma del día supera la meta por más de este margen.',
    activa: true, umbral: 1.0, unidad: 'pp',
    destinatariosRoles: ['calidad', 'admin'], canales: ['correo', 'sistema'] as const,
  },
  {
    slug: 'produccion-baja', nombre: 'Producción por debajo del objetivo',
    descripcion: 'Avisa cuando la producción acumulada de la semana cae debajo de este % del objetivo.',
    activa: true, umbral: 90, unidad: '%',
    destinatariosRoles: ['calidad', 'gerencia'], canales: ['sistema'] as const,
  },
  {
    slug: 'costo-alto', nombre: 'Costo real por arriba del estándar',
    descripcion: 'Avisa cuando el costo real por kg supera el costo estándar por más de este margen.',
    activa: true, umbral: 5, unidad: '%',
    destinatariosRoles: ['gerencia', 'admin'], canales: ['correo', 'sistema'] as const,
  },
  {
    slug: 'entrada-sin-costear', nombre: 'Entrada pendiente de costeo',
    descripcion: 'Avisa cuando una entrada lleva más de este número de días sin costo unitario.',
    activa: false, umbral: 3, unidad: 'días',
    destinatariosRoles: ['compras'], canales: ['sistema'] as const,
  },
];

export const insertSeedData = internalMutation({
  args: {
    adminPasswordHash: v.string(),
  },
  handler: async (ctx, { adminPasswordHash }) => {
    const yaExiste = await ctx.db.query('materiales').first();
    if (yaExiste) {
      throw new Error(
        'El seed ya se corrió antes (materiales no está vacío) — no se vuelve a insertar. Idempotente por diseño.'
      );
    }

    const now = Date.now();

    for (let i = 0; i < MATERIALES.length; i++) {
      const m = MATERIALES[i];
      const materialId = await ctx.db.insert('materiales', {
        slug: m.slug,
        nombre: m.nombre,
        variante: m.variante,
        esInterno: m.esInterno,
        esSustituto: m.esSustituto,
        costoEstandar: m.costoEstandar,
        leadTimeDias: m.leadTimeDias,
        stockSeguridadDias: m.stockSeguridadDias,
        reorderMode: m.reorderMode,
        reorderManualKg: m.reorderManualKg,
        cantidadPedirKg: m.cantidadPedirKg,
        orden: i + 1,
        activo: true,
        updatedAt: now,
        updatedBy: null,
      });

      await ctx.db.insert('formulaCarga', {
        materialId,
        kgPorCarga: m.kgPorCarga,
        nota: m.notaFormula,
        updatedAt: now,
      });
    }

    await ctx.db.insert('parametrosProduccion', {
      cargasPorTurno: 8,
      turnosPorDia: 2,
      kgPorMetro: 4,
      horaInicioTurno1: '06:00',
      horaInicioTurno2: '18:00',
      diasLaborales: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
      minutosGraciaCierre: 60,
      zonaHoraria: 'America/Mexico_City',
      updatedAt: now,
      updatedBy: null,
    });

    for (const r of ALERTAS_REGLAS) {
      await ctx.db.insert('alertasReglas', {
        slug: r.slug,
        nombre: r.nombre,
        descripcion: r.descripcion,
        activa: r.activa,
        umbral: r.umbral,
        unidad: r.unidad,
        destinatariosRoles: r.destinatariosRoles,
        canales: [...r.canales],
        updatedAt: now,
        updatedBy: null,
      });
    }

    await ctx.db.insert('users', {
      nombre: 'Edson Aguirre',
      usuario: 'edson',
      passwordHash: adminPasswordHash,
      rol: 'admin',
      activo: true,
      createdAt: now,
      updatedAt: now,
    });

    return { materiales: MATERIALES.length, alertas: ALERTAS_REGLAS.length };
  },
});
