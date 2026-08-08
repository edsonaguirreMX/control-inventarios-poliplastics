# Documento de Funcionalidades
## Sistema de Control Diario de Materias Primas — Tejaflex

**Objetivo del sistema:** Reemplazar el archivo Excel actual (control diario de materias primas para las líneas 1 y 2 de Tejaflex) por una aplicación web responsiva, manteniendo exactamente la misma lógica de negocio ya validada, pero permitiendo captura desde celular/tablet en piso de producción y consulta en tiempo real del estado de inventario y costos.

**Alcance inicial:** Líneas 1 y 2 de Tejaflex (8 materias primas por receta). Diseñado para poder expandirse después a Lambrín y Thermo-PVC sin rediseñar la arquitectura.

> Nota: la sección de usuarios y flujo de captura (quién captura, desde dónde, en qué momento) se define en una siguiente sesión. Este documento cubre las funcionalidades y reglas de negocio del sistema.

---

## 1. Módulo: Catálogo de Materiales

**Qué hace:** Mantiene la lista maestra de las 8 materias primas de la receta y sus parámetros de control.

**Materiales incluidos:**
1. HDPE reciclado peletizado
2. HDPE virgen peletizado (sustituto)
3. HDPE reciclado en hojuela
4. HDPE reciclado en hojuela sin lavar
5. Carbonato de calcio peletizado
6. Masterbatch de color
7. Aditivo UV
8. Triturado (material molido generado internamente)

**Datos por material:**
- Nombre, unidad base (kg)
- Costo estándar (editable)
- Lead time del proveedor (días)
- Stock de seguridad (días) — 7 días por default, aplicado a todos los materiales
- Punto de reorden — **calculado automáticamente**: consumo diario promedio × (lead time + días de stock de seguridad), con opción de sobrescribir manualmente si el usuario lo requiere
- % meta en mezcla (para verificación real vs. teórico)

**Regla especial:** El triturado se valúa a **$0** al reingresar a inventario, porque su costo ya fue absorbido en el cálculo de costo real del día en que se generó como merma. Esto evita duplicar el costo.

---

## 2. Módulo: Parámetros de Producción y Receta

**Qué hace:** Define los parámetros fijos de producción que alimentan todos los cálculos de consumo teórico.

- Batches por turno: 16
- Turnos por día: 2
- Producción teórica por línea: ~2,200 kg/día
- Peso teórico: 4 kg/metro
- Tabla de receta: porcentaje de cada uno de los 8 materiales por batch
- Verificación automática: consumo real vs. consumo teórico (según batches realmente corridos ese día), para detectar desviaciones de receta

---

## 3. Módulo: Entradas (Recepción de Materia Prima)

**Qué hace:** Registra cada recepción de materia prima y mantiene el costeo PEPS/FIFO.

**Captura por movimiento:**
- Fecha
- Material
- Cantidad recibida (kg)
- Costo unitario
- Proveedor (opcional)
- Folio/referencia (opcional)

**Lógica interna (invisible para quien captura):**
- Cada entrada crea una "capa de costo" nueva (cantidad + costo unitario + fecha), siguiendo la lógica PEPS: las salidas van a consumir primero la capa más antigua disponible.
- El sistema debe mantener el histórico completo de capas, incluso las ya agotadas, para trazabilidad.

---

## 4. Módulo: Salidas (Consumo por Línea)

**Qué hace:** Registra el consumo real de materiales en producción, línea por línea.

**Captura por movimiento:**
- Fecha
- Material
- Línea (1 o 2)
- Cantidad consumida (kg)

**Lógica interna:**
- Cálculo exacto del costo de cada salida usando las capas PEPS vigentes en ese momento (puede consumir de más de una capa si la primera no alcanza).
- Debe actualizar el saldo y el valor de inventario de cada material en tiempo real.

---

## 5. Módulo: Merma

**Qué hace:** Registra la merma generada en producción y su destino.

**Dos destinos posibles de la merma:**
1. **Triturado** → regresa a inventario como materia prima válida, valuado en $0 (evita doble conteo de costo).
2. **Caballetes/Cumbreras** → producto vendible aparte (se recalienta en horno). Requiere captura manual de los kg desviados a este destino.

**Comportamiento:**
- La merma se calcula automáticamente a partir de los datos de la hoja/módulo de Costos (producción real vs. teórica).
- Solo requiere captura manual para los kg que se desvían a caballetes/cumbreras — el resto se infiere.

---

## 6. Módulo: Costos

**Qué hace:** Calcula y mantiene el histórico de costo real de producción.

**Cálculos:**
- Costo estándar por kg y por metro (basado en receta teórica y costos estándar del catálogo).
- **Costo real por kg bueno producido** = costo real total consumido ÷ kg buenos realmente producidos ese día. Esta fórmula hace que el costo de la merma se absorba automáticamente en el costo del producto bueno, sin necesidad de una línea de costo de merma separada.
- Costo real por metro (usando el factor de 4 kg/m).
- **Histórico diario**: cada día queda registrado con su costo real por kg y por metro, para poder ver tendencias y comparar contra el costo estándar.

---

## 7. Módulo: Dashboard / Panel de Control

**Qué hace:** Vista general del estado del sistema, pensada para consulta rápida (no solo captura).

**Debe mostrar:**
- Existencia actual de cada material (kg y valor)
- Alertas visuales (rojo/amarillo) cuando un material cruza su punto de reorden
- Costo real del día más reciente vs. costo estándar (por kg y por metro)
- Tendencia de costo real de los últimos N días (gráfica simple)
- % de merma del día más reciente y tendencia

---

## 8. Reglas de negocio que deben preservarse sin excepción

1. Costeo estrictamente PEPS/FIFO — nunca promedio ponderado.
2. El triturado reingresa a inventario en $0.
3. El costo de la merma se absorbe en el costo por kg bueno, no se contabiliza como línea de gasto separada.
4. El punto de reorden siempre se calcula por fórmula (consumo diario × (lead time + stock de seguridad)), con posibilidad de override manual, pero el valor calculado debe seguir visible como referencia.
5. Todo movimiento (entrada, salida, merma) debe quedar con fecha y trazabilidad — nada se sobrescribe, todo se acumula históricamente.

---

## 9. Fuera de alcance en esta primera versión

- Líneas de Lambrín y Thermo-PVC (se agregarán después, reutilizando la misma arquitectura).
- Integración con proveedores o compras automáticas.
- Facturación o integración contable (CONTPAQi).

---

## 10. Usuarios, Roles y Flujo de Captura

### 10.1 Quién captura
Los **operadores de piso de producción** capturan directamente los movimientos de su línea (entradas, salidas, merma). Esto tiene implicaciones directas en el diseño:

- La interfaz de captura debe ser **extremadamente simple**: pantalla móvil, selección por dropdown/botones en vez de texto libre siempre que sea posible, teclado numérico para cantidades, mínimo de campos obligatorios.
- No se debe asumir conocimiento del sistema de costeo — el operador solo captura **cantidades físicas** (kg recibidos, kg consumidos, kg de merma y su destino). Todo el cálculo de costos (PEPS, costo real, etc.) ocurre detrás, invisible para quien captura.
- Conviene precargar valores frecuentes (ej. la línea del operador ya seleccionada según su usuario, lista de materiales limitada a los 8 de la receta) para minimizar errores de captura.

### 10.2 Cuándo se captura
La captura es **consolidada al final de cada turno**, no movimiento por movimiento en tiempo real. Esto significa:

- El sistema necesita una pantalla de **"Cierre de turno"** por línea, donde el operador registra de una sola vez: todas las entradas recibidas en el turno, todo el consumo por material, y la merma generada (con su destino: triturado o caballetes/cumbreras).
- Como son 2 turnos al día por línea, se esperan **hasta 4 cierres de turno diarios** (2 líneas × 2 turnos).
- El sistema debe dejar claro qué turnos ya fueron cerrados y cuáles siguen pendientes, para evitar huecos en el histórico.
- No se requiere sincronización en tiempo real: es aceptable (y preferible, dado este flujo) que los cálculos de costo e inventario se actualicen al momento de guardar el cierre de turno.

### 10.3 Roles y permisos

| Rol | Qué hace | Qué ve |
|---|---|---|
| **Operador de línea** | Captura el cierre de turno de su línea | Solo su formulario de captura; no necesita ver costos ni dashboard |
| **Edson (admin)** | Supervisa todo, ajusta catálogo/costos estándar | Acceso completo: dashboard, histórico, catálogo, edición de parámetros |
| **Gerente/Comercial de planta** | Consulta desempeño de costos y producción | Dashboard (costos, tendencias, merma) — sin edición |
| **Compras** | Decide cuándo y cuánto reordenar | Dashboard enfocado en existencias y alertas de punto de reorden |
| **Calidad/Producción** | Monitorea desviaciones de receta y merma | Dashboard enfocado en verificación real vs. teórico y % de merma |

**Implicación técnica clave:** el sistema necesita **autenticación con roles** desde el diseño inicial (no se puede agregar "después" sin retrabajo) — cada usuario ve solo lo que le corresponde a su rol. Esto también aplica para el módulo de Catálogo/Parámetros: solo el rol admin debería poder editar costos estándar y puntos de reorden manuales.

### 10.4 Ajuste al Módulo 7 (Dashboard)

Dado que ahora hay múltiples roles viendo el dashboard, este módulo se divide conceptualmente en vistas:

- **Vista Compras:** existencias actuales + alertas de reorden (rojo/amarillo).
- **Vista Calidad/Producción:** verificación real vs. teórico + % de merma y tendencia.
- **Vista Gerencia/Comercial:** costo real vs. estándar (por kg y por metro) + tendencia histórica.
- **Vista Admin (tú):** las tres anteriores combinadas, más acceso a catálogo y parámetros.

---

## Siguiente paso

Con usuarios, roles y flujo de captura ya definidos, el documento de funcionalidades está completo. El siguiente paso según la guía es la **Fase 2.2**: alimentar este documento a Codex o Claude Design para generar las primeras propuestas de diseño visual (empezando por la pantalla de cierre de turno del operador, que es la de uso más frecuente).
