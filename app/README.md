# Tejaflex — app

Backend en Convex + frontend en Node/Express.

## Desarrollo local

```
npm install
npx convex dev     # backend: base de datos + funciones (deja una terminal corriendo)
npm run dev:web    # frontend: sirve las páginas (en otra terminal)
```

## Despliegue

- **Convex**: `npx convex deploy` (o queda automatizado en el pipeline de build).
- **Railway**: apunta esta carpeta (`app/`) como raíz del proyecto; variable de entorno `CONVEX_URL` con la del deployment de producción de Convex.

_En construcción — ver `Documento_Funcionalidades_Control_Materias_Primas.md` y `diseno/` en la raíz del repo para el alcance completo._
