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
    // EDS-104 (Fase 1 de EDS-103, roles personalizables): antes era un
    // v.union(v.literal(...)) fijo de 5 valores — ahora es el `slug` de un
    // documento en `roles`. Convex ya no valida en el schema que sea uno
    // de un conjunto fijo (por definición, ahora es dinámico); la
    // validación de "existe y está activo en `roles`" se mueve al handler
    // de crearUsuarioImpl/actualizarUsuarioImpl (usuarios.ts/
    // usuariosActions.ts).
    rol: v.string(),
    activo: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_usuario", ["usuario"]),

  // EDS-104 — roles personalizables: qué pantallas puede ver cada uno.
  // Mismo patrón que `materiales`/`alertasReglas` (slug único + by_slug,
  // activo, orden, updatedAt/updatedBy). `paginas` es una lista de slugs
  // del catálogo fijo de páginas (ver convex/lib/paginas.ts) — solo 9 de
  // las 11 páginas son configurables aquí; "gestion-usuarios" y
  // "gestion-roles" quedan admin-only hardcodeado por seguridad (un rol
  // personalizable no debe poder auto-otorgarse acceso a Gestión de Roles
  // y escalar sus propios privilegios).
  roles: defineTable({
    slug: v.string(),
    nombre: v.string(),
    paginas: v.array(v.string()),
    // Dos conceptos distintos, aunque hoy coincidan siempre en "admin"
    // (segunda ronda de revisión — no fusionarlos en un solo booleano):
    // `protegido` = no se puede editar/desactivar/eliminar desde Gestión
    // de Roles (candado de EDICIÓN). `bypassAcceso` = pasa cualquier
    // chequeo de requireAcceso sin importar qué traiga `paginas` (candado
    // de AUTORIZACIÓN). Evita que el sistema quede sin nadie que pueda
    // administrar — mismo espíritu que verificarQuedaAlMenosUnAdminActivo
    // en usuarios.ts, que ahora se replantea en términos de `protegido`
    // en vez del string 'admin'.
    protegido: v.boolean(),
    bypassAcceso: v.boolean(),
    // EDS-111 — vistas internas de Panel de Control (Compras/Calidad/
    // Gerencia) permitidas para este rol, independiente de `paginas`.
    // `panel-control` en `paginas` es "puede ENTRAR a la pantalla";
    // `vistasPanel` es "cuáles de las 3 vistas de solo-lectura ve dentro
    // de ella" — mismos datos del backend para las 3 (sin filtrado por
    // rol, confirmado antes de construir esto), la vista es puro
    // renderizado. La pestaña "Admin" (Configuración) NO es una vista de
    // este catálogo — se queda admin-only fija, ajena a este campo.
    // Opcional a propósito: no requiere migrar los roles ya sembrados en
    // dev/prod (mismo criterio que se evitó en EDS-109 para `reactivados`
    // — un campo nuevo en Convex exige que TODOS los documentos existentes
    // ya lo cumplan salvo que sea opcional).
    vistasPanel: v.optional(v.array(v.string())),
    activo: v.boolean(),
    orden: v.number(),
    updatedAt: v.number(),
    updatedBy: v.union(v.id("users"), v.null()),
  }).index("by_slug", ["slug"])
    .index("by_activo_orden", ["activo", "orden"]),

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
    // EDS-88: cuántas líneas se consideran activas para el consumo diario
    // teórico (kgPorCarga × cargasPorTurno × turnosPorDia × lineasActivas)
    // que alimenta el punto de reorden — antes hardcoded a 2 en
    // materiales.ts. Opcional (no v.number() a secas) porque el singleton
    // ya existe en producción sin este campo; el código lo trata como
    // `?? 2` en vez de requerir una migración antes de desplegar.
    lineasActivas: v.optional(v.number()),
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
      v.literal("inventarioInicial"),
      v.literal("ajusteManual") // EDS-93 — ajuste manual de entrada (admin)
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
      v.literal("correccion"),
      v.literal("inventarioInicial"),
      v.literal("ajusteManual") // EDS-93 — ajuste manual de entrada/salida (admin)
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

  // EDS-93 — ajustes manuales de inventario (entrada/salida), capturados
  // por Admin en cualquier momento, siempre fechados con el día real de
  // captura (nunca retrofechados, a diferencia de un cierre de turno).
  // Nada se edita ni se revierte una vez guardado — misma disciplina que
  // el resto del sistema; un ajuste mal capturado se corrige con uno
  // contrario, no editando este.
  ajustesInventario: defineTable({
    materialId: v.id("materiales"),
    tipo: v.union(v.literal("entrada"), v.literal("salida")),
    kg: v.number(), // siempre positivo, el signo lo da `tipo`
    motivo: v.string(), // obligatorio, no vacío — auditoría
    fecha: v.string(), // "YYYY-MM-DD", fecha operativa del momento de captura
    costoUnitario: v.union(v.number(), v.null()), // solo tipo:"entrada" (puede ser 0)
    costoTotal: v.number(), // entrada: kg×costoUnitario; salida: costo real de las capas consumidas (FIFO)
    capaId: v.union(v.id("capasCosto"), v.null()), // solo tipo:"entrada" — la capa nueva creada
    capasDetalle: v.union(
      v.array(
        v.object({
          capaId: v.id("capasCosto"),
          kgTomado: v.number(),
          costoUnitario: v.number(),
        })
      ),
      v.null()
    ), // solo tipo:"salida" — mismo shape que cierreConsumos.capasDetalle
    registradoPor: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_fecha", ["fecha"])
    .index("by_materialId", ["materialId"]),

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
    // singleton — correos/whatsapp: capturados desde el día 1, EDS-69 Fase 1
    // ya los usa de verdad (envío real por Resend/Twilio, ver notificaciones.ts).
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
    // EDS-69 Fase 1 — opcionales a propósito: filas sembradas antes de esta
    // fase no tienen envío real que resumir, no se migran. Los llena
    // notificaciones.ts::cerrarResumenEnvio una vez que termina de intentar
    // el envío (siempre, incluso si todos los intentos fallan o falta
    // configurar el proveedor — nunca queda a medias).
    enviosOk: v.optional(v.number()),
    enviosError: v.optional(v.number()),
  }).index("by_fecha", ["fecha"]),

  // EDS-69 Fase 1 — log de cada intento de envío real (correo/WhatsApp) de
  // una notificación. `origen` ya incluye 'alerta' aunque Fase 2 (EDS-112)
  // todavía no lo usa, para no requerir una migración de schema cuando esa
  // fase arranque. El índice compuesto es la clave de idempotencia: antes
  // de reintentar un envío se consulta esta combinación exacta (no
  // by_referenciaId completo) para no reenviar duplicados si la action se
  // reejecuta.
  notificacionesEnvios: defineTable({
    origen: v.union(v.literal("reporteDiario"), v.literal("alerta")),
    referenciaId: v.id("reporteDiarioHistorial"),
    canal: v.union(v.literal("correo"), v.literal("whatsapp")),
    destinatario: v.string(),
    estado: v.union(v.literal("enviado"), v.literal("error")),
    detalleError: v.union(v.string(), v.null()),
    intentos: v.number(), // 1, o 2 si hubo reintento por error 5xx/red
    proveedorId: v.union(v.string(), v.null()), // id de Resend / SID de Twilio
    fecha: v.number(),
  })
    .index("by_referenciaId", ["referenciaId"])
    .index("by_referencia_canal_destinatario", ["referenciaId", "canal", "destinatario"])
    .index("by_fecha", ["fecha"]),

  // Rate limiting de authActions.login (EDS-70, deuda de la auditoría de
  // PR1) — por `usuario` (no por IP: Convex actions no exponen la IP real
  // del cliente sin infraestructura adicional, y el objetivo es frenar
  // fuerza bruta dirigida a UNA cuenta conocida, no un spray de usuarios).
  // Ventana deslizante simple: se reinicia sola si el primer intento de la
  // ventana ya expiró en vez de acumular para siempre.
  loginIntentos: defineTable({
    usuario: v.string(), // normalizado igual que users.usuario
    intentos: v.number(),
    primerIntentoEn: v.number(),
    bloqueadoHasta: v.union(v.number(), v.null()),
    // Cuándo esta fila deja de ser relevante (fin del bloqueo, o fin de la
    // ventana si nunca llegó a bloquear) — usado por el cron de limpieza
    // (mayor de la auditoría de PR8: sin esto, loginIntentos crece sin
    // límite con cada usuario, real o inventado, que alguna vez falló un
    // login).
    expiresAt: v.number(),
  }).index("by_usuario", ["usuario"])
    .index("by_expiresAt", ["expiresAt"]),
});
