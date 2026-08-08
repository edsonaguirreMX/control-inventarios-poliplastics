import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Schema v3 — Control de Materias Primas Tejaflex
// Ver plan técnico completo: /Users/edson/.claude/plans/quiero-que-hagas-el-wise-creek.md
// Línea 1/2 se modela como literal fijo (no como tabla `lineas`): Lambrín/Thermo-PVC
// están fuera de alcance explícito del spec.

export default defineSchema({
  users: defineTable({
    nombre: v.string(),
    usuario: v.string(), // normalizado a minúsculas, único
    passwordHash: v.string(),
    rol: v.union(
      v.literal("operador"),
      v.literal("admin"),
      v.literal("gerencia"),
      v.literal("compras"),
      v.literal("calidad")
    ),
    activo: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_usuario", ["usuario"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    remember: v.boolean(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  materiales: defineTable({
    slug: v.string(),
    nombre: v.string(),
    variante: v.string(),
    esInterno: v.boolean(), // Triturado — única excepción a bloqueo por faltante de inventario
    esSustituto: v.boolean(), // HDPE virgen
    costoEstandar: v.number(),
    leadTimeDias: v.union(v.number(), v.null()),
    stockSeguridadDias: v.union(v.number(), v.null()),
    reorderMode: v.union(v.literal("auto"), v.literal("manual")),
    reorderManualKg: v.union(v.number(), v.null()),
    cantidadPedirKg: v.union(v.number(), v.null()),
    orden: v.number(),
    activo: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.union(v.id("users"), v.null()),
  })
    .index("by_slug", ["slug"])
    .index("by_activo_orden", ["activo", "orden"]),

  formulaCarga: defineTable({
    materialId: v.id("materiales"),
    kgPorCarga: v.number(),
    nota: v.string(),
    updatedAt: v.number(),
  }).index("by_materialId", ["materialId"]),

  parametrosProduccion: defineTable({
    // singleton — un solo documento
    cargasPorTurno: v.number(),
    turnosPorDia: v.number(),
    kgPorMetro: v.number(),
    horaInicioTurno1: v.string(), // "06:00"
    horaInicioTurno2: v.string(), // "18:00"
    diasLaborales: v.array(v.string()), // ["lunes","martes","miercoles","jueves","viernes"]
    minutosGraciaCierre: v.number(), // tolerancia antes de alertar "turno sin cerrar"
    zonaHoraria: v.string(), // "America/Mexico_City" — explícito, no implícito
    updatedAt: v.number(),
    updatedBy: v.union(v.id("users"), v.null()),
  }),

  objetivosProduccion: defineTable({
    // singleton — se agrega en tarea 6.5
    turnoL1: v.number(),
    turnoL2: v.number(),
    semana: v.number(),
    mes: v.number(),
    updatedAt: v.number(),
  }),

  capasCosto: defineTable({
    materialId: v.id("materiales"),
    fechaEntrada: v.number(),
    kgOriginal: v.number(),
    kgRestante: v.number(), // caché derivado, reconciliable contra capaMovimientos
    costoUnitario: v.number(),
    origen: v.union(
      v.literal("entrada"),
      v.literal("triturado"),
      v.literal("inventarioInicial")
    ),
    entradaId: v.union(v.id("entradas"), v.null()),
    cierreTurnoId: v.union(v.id("cierresTurno"), v.null()),
    agotada: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_material_fecha", ["materialId", "fechaEntrada"])
    .index("by_material_agotada", ["materialId", "agotada"])
    .index("by_cierreTurnoId_origen", ["cierreTurnoId", "origen"]),

  // Ledger inmutable — fuente de verdad auditable de todo movimiento de capa
  capaMovimientos: defineTable({
    capaId: v.id("capasCosto"),
    materialId: v.id("materiales"),
    tipo: v.union(
      v.literal("generacion"),
      v.literal("consumo"),
      v.literal("reversa_consumo"),
      v.literal("reversa_generacion"),
      v.literal("ajuste_incremento"),
      v.literal("ajuste_decremento")
    ),
    kg: v.number(), // siempre positivo, el signo lo da `tipo`
    costoUnitario: v.number(),
    origenTipo: v.union(
      v.literal("entrada"),
      v.literal("cierreTurno"),
      v.literal("correccion")
    ),
    origenId: v.string(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_capaId", ["capaId"])
    .index("by_origenId", ["origenId"]),

  entradas: defineTable({
    fecha: v.string(), // "YYYY-MM-DD"
    materialId: v.id("materiales"),
    cantidadKg: v.number(),
    costoUnitario: v.union(v.number(), v.null()),
    proveedor: v.string(),
    folio: v.string(),
    estado: v.union(v.literal("pendiente"), v.literal("costeada")),
    capaId: v.union(v.id("capasCosto"), v.null()),
    registradoPor: v.id("users"),
    costeadoPor: v.union(v.id("users"), v.null()),
    costeadoEn: v.union(v.number(), v.null()),
    editado: v.boolean(),
    editadoPor: v.union(v.id("users"), v.null()),
    editadoEn: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_fecha", ["fecha"])
    .index("by_estado", ["estado"])
    .index("by_materialId", ["materialId"]),

  cierresTurno: defineTable({
    fecha: v.string(), // "YYYY-MM-DD"
    linea: v.union(v.literal(1), v.literal(2)),
    turno: v.union(v.literal(1), v.literal(2)),
    cargasPreparadas: v.number(),
    metrosBuenos: v.number(),
    caballetes105Pzas: v.number(),
    caballetes106Pzas: v.number(),
    kgBuenos: v.number(),
    caballetesKg: v.number(),
    mermaTotalKg: v.number(),
    trituradoKg: v.number(),
    costoTotalConsumido: v.number(),
    costoRealPorKg: v.number(),
    costoRealPorMetro: v.number(),
    capturadoPor: v.id("users"),
    capturadoEn: v.number(),
    editado: v.boolean(),
    editadoPor: v.union(v.id("users"), v.null()),
    editadoEn: v.union(v.number(), v.null()),
    vecesRecapturado: v.number(), // 0 = original; historial real vive en correccionesHistorial
  })
    .index("by_fecha", ["fecha"])
    .index("by_fecha_linea_turno", ["fecha", "linea", "turno"]),

  cierreConsumos: defineTable({
    cierreTurnoId: v.id("cierresTurno"),
    materialId: v.id("materiales"),
    kgConsumido: v.number(),
    costoTotal: v.number(),
    faltanteKg: v.number(), // >0 solo posible si materiales.esInterno (Triturado)
    vigente: v.boolean(), // false = reemplazada por recierre/corrección, se conserva
    capasDetalle: v.array(
      v.object({
        capaId: v.id("capasCosto"),
        kgTomado: v.number(),
        costoUnitario: v.number(),
      })
    ),
  })
    .index("by_cierreTurnoId", ["cierreTurnoId"])
    .index("by_materialId", ["materialId"])
    .index("by_cierreTurnoId_vigente", ["cierreTurnoId", "vigente"]),

  // Snapshot inmutable de cada corrección/recierre
  correccionesHistorial: defineTable({
    entidad: v.union(v.literal("cierreTurno"), v.literal("entrada")),
    entidadId: v.string(),
    motivo: v.union(
      v.literal("correccion_manual"),
      v.literal("recierre_duplicado"),
      v.literal("ajuste_cantidad")
    ),
    snapshotAntes: v.string(), // JSON.stringify
    snapshotDespues: v.string(), // JSON.stringify
    nota: v.union(v.string(), v.null()),
    corregidoPor: v.id("users"),
    corregidoEn: v.number(),
  }).index("by_entidadId", ["entidadId"]),

  alertasReglas: defineTable({
    slug: v.string(),
    nombre: v.string(),
    descripcion: v.string(),
    activa: v.boolean(),
    umbral: v.union(v.number(), v.null()),
    unidad: v.union(v.string(), v.null()),
    destinatariosRoles: v.array(v.string()),
    canales: v.array(
      v.union(v.literal("correo"), v.literal("whatsapp"), v.literal("sistema"))
    ),
    updatedAt: v.number(),
    updatedBy: v.union(v.id("users"), v.null()),
  }).index("by_slug", ["slug"]),

  alertasHistorial: defineTable({
    reglaSlug: v.string(),
    fecha: v.number(),
    detalle: v.string(),
    dedupeKey: v.string(), // `${reglaSlug}:${materialId?}:${YYYY-MM-DD}`
    destinatariosRoles: v.array(v.string()),
    canales: v.array(v.string()),
  })
    .index("by_fecha", ["fecha"])
    .index("by_dedupeKey", ["dedupeKey"]),

  // Lectura por usuario, no global — una alerta leída por un rol sigue sin leer para otro
  alertasLecturas: defineTable({
    alertaId: v.id("alertasHistorial"),
    userId: v.id("users"),
    leidaEn: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_alertaId", ["alertaId"])
    .index("by_alerta_user", ["alertaId", "userId"]), // idempotencia real en marcarAlertaLeida

  reporteDiarioConfig: defineTable({
    // singleton — correos/whatsapp: captura para uso futuro (icebox I.1), v1 no los usa
    hora: v.string(), // "HH:MM"
    activo: v.boolean(),
    correos: v.array(v.string()),
    whatsapp: v.array(v.string()),
    updatedAt: v.number(),
    updatedBy: v.union(v.id("users"), v.null()),
  }),

  reporteDiarioHistorial: defineTable({
    fecha: v.number(),
    estado: v.union(v.literal("generado"), v.literal("error")),
    destinatariosCount: v.number(),
    detalleError: v.union(v.string(), v.null()),
    generadoPor: v.union(v.literal("cron"), v.literal("manual")),
  }).index("by_fecha", ["fecha"]),
});
