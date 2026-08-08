# Historial de Cambios y Mejoras — Control de Materias Primas (Tejaflex)

> Registro exhaustivo del trabajo funcional del proyecto: pantallas diseñadas, reglas de negocio definidas, datos capturados y mejoras aplicadas — desde la lectura de la especificación hasta el estado actual.

---

## 0. Punto de partida

Se leyó `Documento_Funcionalidades_Control_Materias_Primas.md` como especificación de referencia obligatoria para todo el proyecto. Define:

- **10 módulos**: Catálogo de Materiales, Parámetros de Producción y Receta, Entradas (recepción), Salidas (consumo por línea), Merma, Costos, Dashboard (por rol), Reglas de negocio, Fuera de alcance, Usuarios/Roles/Flujo de captura.
- **5 reglas de negocio no negociables**:
  1. Costeo estrictamente PEPS/FIFO por capas (cantidad + costo unitario + fecha) — nunca promedio ponderado.
  2. El triturado (merma reciclada) reingresa a inventario valuado en $0.
  3. El costo de la merma se absorbe en el costo real por kg bueno producido, no es una línea de gasto separada.
  4. Punto de reorden = consumo diario promedio × (lead time + stock de seguridad en días, default 7), con override manual visible junto al valor calculado.
  5. Trazabilidad total: todo movimiento lleva fecha, nada se sobrescribe, todo se acumula históricamente.
- **Roles**: Operador de línea, Admin/Edson, Gerente/Comercial, Compras, Calidad/Producción.
- **Fuera de alcance v1**: líneas Lambrín y Thermo-PVC, integración con proveedores, facturación/CONTPAQi.

Todo el trabajo posterior se hizo respetando estas reglas.

---

## 1. Diseño de las 10 pantallas

### 1.1 Cierre de Turno (pantalla móvil del operador)

La pantalla que más iteraciones tuvo:

1. **3 propuestas visuales distintas** generadas primero, para elegir dirección de diseño.
2. Se pidió mezclar: **Propuesta B con los colores de la Propuesta A**.
3. Corrección de rumbo: **solo Propuesta A**, con un cambio de fondo importante — la materia prima es compartida entre las dos líneas, así que **debe poder capturarse sin asignarla a una línea**. Por línea/turno solo se capturan Consumo, Producción y Merma.
4. Rediseño como **wizard con dos flujos separados**:
   - **Entrada de material** (2 pasos, sin línea — va a almacén general compartido).
   - **Cierre de turno** (4 pasos: Línea/Turno → Consumo → Producción y Merma → Resumen).
5. Se incorporó la **fórmula real de producción** (kg por "carga"), con una corrección explícita: *"El masterbatch sí tiene un consumo, olvidé ponerlo, y es de 2.5 kg por carga."*
6. Se agregó **validación en tiempo real durante la captura**: advertencias inline junto al campo, con un patrón de "reconocimiento" donde el operador debe confirmar explícitamente ("Sí, es correcto") antes de continuar. Se corrigió un problema donde avanzar de paso revivía advertencias que el operador ya había confirmado segundos antes.
7. **Rango de cargas preparadas**: se acotó a **entre 10 y 20 cargas** por turno, recalculando en cascada los valores de ejemplo (cargas=14, metros=505, caballetes 1.05=12, caballetes 1.06=8, merma≈66kg/3.2%) para que no aparecieran advertencias falsas al abrir la pantalla.
8. **Fórmula fija final (kg por carga)**:

   | Material | kg / carga | Nota |
   |---|---|---|
   | HDPE reciclado peletizado | 25 | Comparte cupo con HDPE virgen (sustituto, default 0) |
   | HDPE reciclado en hojuela | 50 | |
   | HDPE reciclado hojuela sin lavar | 7.5 | |
   | Carbonato de calcio | 50 | |
   | Masterbatch de color | 2.5 | |
   | Aditivo UV | 1.5 | |
   | Triturado (interno) | ≈12.5 | Aproximado, varía |
   | **Total** | **149 kg/carga** | |

9. **(Mejora transversal, ver sección 3)** Sesión visible del operador + "Cerrar sesión", y atribución de quién cerró cada turno / registró cada entrada.

### 1.2 Panel de Control (dashboard multi-rol)

- 4 roles con vistas distintas: **Compras**, **Calidad y Producción**, **Gerencia y Comercial**, **Admin** (ve todo + selector de vista).
- Se agregó a Compras la **cantidad a pedir por material**, tomada de Catálogo de Materiales.
- Se agregó a Calidad y Producción una **gráfica de producción en metros por turno y por línea**, con acumulado semanal y mensual, todo en metros — con **línea de objetivo editable** superpuesta en cada gráfica.
- Se **quitó** la comparación de consumo real vs. teórico.
- Las gráficas por turno/línea se cambiaron de línea a **gráfica de columnas**.
- **Alertas** integradas mediante una campana, filtradas por rol, con acceso directo a la configuración de alertas.
- **Exportación**: a Excel/CSV (existencias, producción, merma, costo) y a PDF (reporte completo imprimible).
- Roles de acceso ligados al Login: cada usuario ve solo su vista correspondiente; Admin puede alternar entre todas.

### 1.3 Catálogo de Materiales y Parámetros de Producción y Fórmula

- Se **reconciliaron ambas pantallas** para que no haya dos fuentes de verdad: el "% meta en mezcla" del Catálogo quedó de **solo lectura**, derivado matemáticamente de los kg-por-carga definidos en Parámetros, en vez de poder editarse de forma independiente.
- Costo estándar, lead time, stock de seguridad y punto de reorden manual (con el valor calculado siempre visible como referencia, según la regla de negocio #4) viven en Catálogo.

### 1.4 Corrección de Capturas

- Pantalla para corregir hasta **los últimos 10 días** de Cierres de turno o Entradas de material, seleccionando día + línea + turno.
- Nació de una necesidad explícita: *"En caso de que haya un error en la captura de algunos de los datos del cierre o en la entrada de materiales poder modificarlos."*
- **(Mejora transversal, ver sección 3)** Bitácora de auditoría: quién corrigió y cuándo.

### 1.5 Login y Selección de Rol

- Iteración de diseño: de tiles con PIN → **usuario y contraseña unificado**, con pestañas para Operador y Administración con la **misma estructura** (sin diferenciarlas visualmente).
- **Sin relación fija operador↔línea/turno** — hay rotación de operadores entre líneas y turnos, así que el login no asigna ninguno de los dos.
- **"Recordar mis datos en este dispositivo"**: guarda el usuario (no la contraseña), por pestaña.
- **(Mejora transversal, ver sección 3)** El login ahora propaga el **nombre real** de la persona (no solo el rol) a las siguientes pantallas.

### 1.6 Gestión de Usuarios

- Catálogo de usuarios con nombre, usuario (texto libre, no forzado a ser correo) y contraseña editable — pedido explícito: *"El username no tiene que ser necesariamente un correo electrónico... se debería de tener un catálogo de usuarios."*
- **Regla de contraseñas definida y luego corregida:**
  1. Se pidió inicialmente: *"Cambio de contraseña obligatorio en primer ingreso. La contraseña solo la podrá modificar el administrador desde la pantalla de usuarios."*
  2. Se implementó un flujo completo de contraseña temporal que bloqueaba el primer ingreso hasta cambiarla.
  3. Se corrigió la intención real: *"Yo voy a generar la contraseña. Es decir no habrá contraseña temporal. Sólo la que yo ponga."*
  4. **Regla final vigente**: no existe contraseña temporal ni cambio obligatorio — el Administrador asigna directamente la contraseña definitiva de cada usuario.
- Función para generar una contraseña aleatoria sugerida (el Admin puede usarla tal cual o cambiarla).

### 1.7 Entradas con Costeo

- El operador solo captura kg (sin costo) en Cierre de Turno; en esta pantalla Compras/Admin completa **costo unitario, proveedor y folio**.
- Muestra las **capas de costeo PEPS** vigentes por material, consistentes con las existencias mostradas en Panel de Control (ej. HDPE reciclado peletizado: 4,800 kg @ $14.10 + 6,000 kg @ $15.28 = 10,800 kg).
- Exportación a Excel/CSV y PDF.

### 1.8 Configuración de Alertas

- 7 reglas de alerta configurables: turno sin cerrar, material crítico, material por vencer, merma alta, producción baja, costo alto, entrada sin costear — cada una con umbral, destinatarios, canal y estado activa/inactiva.
- Historial de alertas disparadas.
- Integrada con la campana de alertas de Panel de Control (mismas reglas, filtradas por rol).

### 1.9 Reporte Diario

- Configuración de un reporte automático **diario a las 2:00 pm**, en PDF, con:
  - Producción por turno/línea/total, acumulado semanal y mensual (metros), comparación contra objetivo.
  - Costo real por metro.
  - Materiales en alerta con inventario y punto de reorden.
- Checklist de contenido a incluir, destinatarios (correo y WhatsApp, con alta/baja), historial de envíos.
- Botón "Generar ahora" que produce el reporte en el momento (reutilizando la vista completa de Panel de Control en modo impresión).

---

## 2. Mejoras adicionales evaluadas

Al preguntar si faltaba algo, se propusieron 3 mejoras. Se aprobaron explícitamente las **dos primeras**:

1. ✅ **Sesión visible y "Cerrar sesión"** — implementada (sección 3.1).
2. ✅ **Bitácora de auditoría (quién hizo cada cambio)** — implementada (sección 3.2).
3. ⬜ Vista de "Bitácora" consolidada / extender la atribución de quién-hizo-qué a Gestión de Usuarios, Catálogo y Parámetros — **propuesta, no implementada**.

También quedó identificado como pendiente: Corrección de Capturas hoy **reemplaza** el valor anterior de un registro al guardar una corrección, en vez de conservar un historial de versiones — lo cual no cumple al 100% la regla de negocio #5 ("nada se sobrescribe, todo se acumula históricamente").

---

## 3. Mejoras transversales a las 10 pantallas

### 3.1 Sesión visible y "Cerrar sesión"

Implementado en **las 10 pantallas**:

- **Login** identifica a la persona real (nombre) además de su rol, y esa identidad viaja con ella al resto del sistema.
- **Cierre de Turno**: barra de sesión persistente y visible en todo momento con el nombre del operador (o "Sesión no identificada" si se entra sin pasar por Login). El aviso de cierre/entrada y cada Línea×Turno del día ahora indican quién y a qué hora se cerró.
- **Panel de Control**: se muestra "Nombre · Rol" además de solo el rol, junto con un botón "Cerrar sesión" (incluido para Admin, que antes no tenía este indicador). Esta identidad se conserva al entrar a cualquiera de las pantallas de configuración.
- **Las 7 pantallas de administración** (Catálogo, Parámetros, Corrección, Gestión de Usuarios, Entradas, Alertas, Reporte Diario) muestran el mismo indicador de sesión y devuelven a la persona identificada al volver a Panel de Control.
- Sin sesión iniciada, cualquier pantalla ofrece un estado neutro con opción de "Iniciar sesión" en vez de fallar o mostrar información incorrecta.

### 3.2 Bitácora de auditoría — quién hizo cada cambio

Implementado en **Corrección de Capturas**:

- Cada corrección (de un cierre de turno o de una entrada) queda registrada con **quién** la hizo y **cuándo** (fecha y hora reales del momento de guardar).
- El aviso de "Editado" ahora incluye la línea "Corregido por *Nombre* · fecha, hora".
- Se dejaron dos ejemplos precargados (un cierre y una entrada ya corregidos) para poder ver la bitácora funcionando sin tener que hacer una corrección primero.

---

## 4. Decisiones explícitas que no deben revertirse sin pedirlo

1. La materia prima es compartida entre líneas — las **entradas de material nunca se asignan a una línea**.
2. El Masterbatch de color **sí consume** (2.5 kg/carga) — no se debe volver a omitir.
3. Rango válido de cargas preparadas por turno: **10 a 20**.
4. El username **no** tiene que ser un correo — es texto libre asignado por el Admin.
5. **No existe contraseña temporal** — el Admin asigna la contraseña definitiva directamente; no hay flujo de "cambio obligatorio en primer ingreso".
6. En las gráficas de producción por turno/línea del Panel de Control: **columnas**, no líneas.
7. Se **quitó** la comparación de consumo real vs. teórico del Panel de Control.

---

## 5. Enlaces a las pantallas

| Pantalla | Enlace |
|---|---|
| Login y Selección de Rol | https://claude.ai/code/artifact/8f102232-a2b3-4fc8-b6d7-a21b67e5e04d |
| Cierre de Turno | https://claude.ai/code/artifact/012ac544-2123-4bcc-a891-b999f1f9988d |
| Panel de Control | https://claude.ai/code/artifact/7422e82c-b431-4e09-9713-4479c1724fdc |
| Catálogo de Materiales | https://claude.ai/code/artifact/822b457a-9605-403f-bd88-a60a80277abe |
| Parámetros de Producción y Fórmula | https://claude.ai/code/artifact/dae4efb8-0259-4711-86d7-b6efde829b21 |
| Corrección de Capturas | https://claude.ai/code/artifact/78f3138c-7051-4734-bab0-fcdf4379a2c8 |
| Gestión de Usuarios | https://claude.ai/code/artifact/a488c010-2daf-4b2c-a303-485f9886a186 |
| Entradas con Costeo | https://claude.ai/code/artifact/0c1405d6-6d85-40ec-afcc-54d378e96fd3 |
| Configuración de Alertas | https://claude.ai/code/artifact/ee8d41b8-1d87-4770-ba01-ff1dbe33b4a4 |
| Reporte Diario | https://claude.ai/code/artifact/5e291cff-a6db-432c-99a0-3e92ec67998d |
