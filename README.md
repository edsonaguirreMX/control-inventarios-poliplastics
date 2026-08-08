# Control de Materias Primas — Tejaflex

Sistema de control de materias primas para la planta de extrusión Tejaflex (líneas 1 y 2), que reemplaza el control diario en Excel.

## Estructura del repositorio

- **`Documento_Funcionalidades_Control_Materias_Primas.md`** — especificación funcional de referencia: módulos, reglas de negocio (PEPS/FIFO, merma, punto de reorden) y roles. Toda decisión de diseño o de código debe respetarla.
- **`diseno/`** — mockups HTML/CSS/JS autocontenidos de las 10 pantallas del sistema (diseño visual aprobado, con datos de ejemplo). Sirven como referencia visual y funcional para construir la aplicación real; no son la aplicación en sí.
- **`app/`** — la aplicación viva: backend en [Convex](https://convex.dev) (base de datos + funciones) y frontend en Node/Express que sirve las pantallas conectadas a datos reales. Ver `app/README.md` para correrla en desarrollo y desplegarla.

## Pantallas

| Pantalla | Rol principal |
|---|---|
| Login y Selección de Rol | Todos |
| Cierre de Turno | Operador de línea |
| Panel de Control | Compras / Calidad y Producción / Gerencia y Comercial / Admin |
| Catálogo de Materiales | Admin |
| Parámetros de Producción y Fórmula | Admin |
| Corrección de Capturas | Admin |
| Gestión de Usuarios | Admin |
| Entradas con Costeo | Compras / Admin |
| Configuración de Alertas | Admin |
| Reporte Diario | Admin |
