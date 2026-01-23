# Configuración de Pusher

Pusher es un servicio de WebSocket que funciona perfectamente con Vercel. Sigue estos pasos para configurarlo:

## 1. Crear cuenta en Pusher

1. Ve a [https://pusher.com](https://pusher.com)
2. Crea una cuenta gratuita (hasta 200,000 mensajes/día)
3. Verifica tu email

## 2. Crear una nueva App

1. En el dashboard, haz click en "Create app"
2. Configura:
   - **Name**: Rap 2.0 (o el nombre que prefieras)
   - **Cluster**: Elige el más cercano (us2 para USA, eu para Europa, etc.)
   - **Front-end tech**: Vanilla JS
   - **Back-end tech**: Node.js
3. Click en "Create app"

## 3. Obtener credenciales

En la página de tu app, ve a la pestaña "App Keys". Verás:
- **app_id**
- **key** (esta es la que necesitas)
- **secret** (no la necesitas para el cliente)
- **cluster** (ej: us2, eu, ap1)

## 4. Configurar variables de entorno

### Desarrollo local

Crea un archivo `.env.local` en la raíz del proyecto:

```env
NEXT_PUBLIC_PUSHER_KEY=tu_key_aqui
NEXT_PUBLIC_PUSHER_CLUSTER=us2
```

### Vercel

1. Ve a tu proyecto en [vercel.com](https://vercel.com)
2. Settings → Environment Variables
3. Agrega:
   - `NEXT_PUBLIC_PUSHER_KEY` = tu key de Pusher
   - `NEXT_PUBLIC_PUSHER_CLUSTER` = tu cluster (ej: us2)

## 5. Habilitar Client Events (⚠️ CRÍTICO)

**IMPORTANTE**: Sin esto, la aplicación NO funcionará.

En el dashboard de Pusher:
1. Ve a tu app (smooth-hat-411)
2. Settings → App Settings
3. **Habilita "Client Events"** (toggle switch)
4. Guarda los cambios

Sin esta opción habilitada, los usuarios no podrán enviar mensajes entre sí.

**Nota**: En el plan gratuito, los client events están limitados a 10 eventos/minuto por conexión. Para producción, considera usar un servidor backend para enviar eventos.

## 6. Configurar CORS (si es necesario)

Si tienes problemas de CORS:
1. En Pusher dashboard → Settings → App Settings
2. Agrega tu dominio (ej: `https://tu-app.vercel.app`)
3. O usa `*` para desarrollo (no recomendado para producción)

## Listo!

Una vez configurado, la aplicación usará Pusher automáticamente en lugar del WebSocket local.

## Límites del plan gratuito

- ✅ 200,000 mensajes/día
- ✅ 100 conexiones simultáneas
- ✅ 10 client events/minuto por conexión
- ✅ Soporte de presencia channels

Para más información, visita: [Pusher Documentation](https://pusher.com/docs)
