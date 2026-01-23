# 🚀 Deploy en Vercel - Guía Rápida

## ✅ Código ya subido a GitHub

El código está en: https://github.com/rodrigotapia32/rap2.0.git

## Pasos para Deploy

### 1. Conectar con Vercel

1. Ve a [vercel.com](https://vercel.com)
2. Inicia sesión con GitHub
3. Click en "Add New..." → "Project"
4. Importa el repositorio: `rodrigotapia32/rap2.0`
5. Vercel detectará automáticamente Next.js

### 2. Configurar Variables de Entorno (CRÍTICO)

Antes de hacer deploy, agrega estas variables:

1. En la página de configuración del proyecto, ve a "Environment Variables"
2. Agrega estas **cuatro** variables (necesitas el `app_id` y `secret` del dashboard de Pusher):

```
NEXT_PUBLIC_PUSHER_KEY = cb5daaae59105d0c5bc1
NEXT_PUBLIC_PUSHER_CLUSTER = us2
PUSHER_APP_ID = 2105961
PUSHER_SECRET = b16d04c0163af1a5a60e
```

⚠️ **IMPORTANTE**: 
- `NEXT_PUBLIC_*` son públicas (visibles en el cliente)
- `PUSHER_APP_ID` y `PUSHER_SECRET` son privadas (solo servidor)

3. Asegúrate de que estén marcadas para:
   - ✅ Production
   - ✅ Preview
   - ✅ Development

### 3. Hacer Deploy

1. Click en "Deploy"
2. Espera a que termine el build (2-3 minutos)
3. ¡Listo! Tu app estará en `https://rap2-0.vercel.app` (o el nombre que elijas)

### 4. Verificar que Funciona

1. Abre la URL de Vercel en dos navegadores diferentes
2. Crea una sala en uno
3. Únete con el código en el otro
4. Deberías ver "Pusher conectado" en la consola

## ⚠️ IMPORTANTE: Habilitar Client Events en Pusher

Antes de probar, asegúrate de:

1. Ir a [dashboard.pusher.com](https://dashboard.pusher.com)
2. Seleccionar tu app "smooth-hat-411"
3. Settings → App Settings
4. **Habilitar "Client Events"** (toggle)
5. Guardar

Sin esto, los mensajes no funcionarán.

## 🔍 Verificar Build

Si el build falla, revisa:
- Variables de entorno están configuradas
- `package.json` tiene todas las dependencias
- No hay errores de TypeScript

## 📝 Notas

- El servidor WebSocket local (`server/websocket-server.js`) NO se usa en producción
- Pusher maneja toda la comunicación en tiempo real
- Los beats se sirven desde `public/beats/` (estático)

## 🎯 URL de Producción

Una vez deployado, tu app estará en:
`https://[tu-proyecto].vercel.app`

¡Listo para probar! 🎤🔥
