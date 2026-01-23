# Guía de Deploy - Rap 2.0

## ⚠️ Limitación Importante: WebSocket en Vercel

Vercel **NO soporta WebSockets persistentes** en sus Serverless Functions. El servidor WebSocket actual (`server/websocket-server.js`) no funcionará directamente en Vercel.

## Opciones para Deploy

### Opción 1: Servicio WebSocket Externo (Recomendado)

Usa un servicio de WebSocket como backend:

#### Pusher (Gratis hasta 200k mensajes/día)
1. Crear cuenta en [Pusher](https://pusher.com)
2. Crear un nuevo app
3. Instalar: `npm install pusher pusher-js`
4. Reemplazar `lib/websocket.ts` con cliente Pusher

#### Ably (Gratis hasta 6M mensajes/mes)
1. Crear cuenta en [Ably](https://ably.com)
2. Crear un nuevo app
3. Instalar: `npm install ably`
4. Reemplazar `lib/websocket.ts` con cliente Ably

#### Socket.io con servidor separado
- Deployar servidor Socket.io en Railway, Render, o Heroku
- Usar cliente Socket.io en el frontend

### Opción 2: Serverless Functions de Vercel (Limitado)

Puedes usar Serverless Functions, pero con limitaciones:
- No son conexiones persistentes
- Timeout de 10 segundos (Hobby) o 60 segundos (Pro)
- No ideal para WebRTC signaling en tiempo real

### Opción 3: Deploy Híbrido

- **Frontend (Next.js)**: Vercel
- **WebSocket Server**: Railway, Render, o Fly.io (gratis)

## Pasos para Deploy en Vercel

### 1. Preparar el repositorio

```bash
# Asegúrate de tener todo commiteado
git add .
git commit -m "Preparado para deploy"
git push origin main
```

### 2. Conectar con Vercel

1. Ve a [vercel.com](https://vercel.com)
2. Importa el repositorio de GitHub
3. Vercel detectará automáticamente Next.js
4. Configura variables de entorno si es necesario

### 3. Variables de Entorno

En Vercel, agrega:
```
NEXT_PUBLIC_WS_URL=wss://tu-servidor-websocket.com
```

### 4. Deploy

Vercel hará deploy automáticamente en cada push a `main`.

## Estructura del Proyecto para Vercel

El proyecto ya está configurado para Vercel:
- ✅ `next.config.js` configurado
- ✅ `package.json` con scripts correctos
- ✅ Estructura de App Router
- ✅ Sin dependencias de servidor Node.js en el build

## Notas Importantes

1. **Beats**: Los archivos en `public/beats/` se servirán estáticamente
2. **WebSocket**: Necesitarás un servicio externo o servidor separado
3. **STUN/TURN**: Los servidores STUN públicos funcionan, pero para producción considera un servidor TURN

## Alternativas Completas

Si quieres una solución todo-en-uno:

- **Railway**: Soporta WebSockets nativos
- **Render**: Soporta WebSockets con plan pago
- **Fly.io**: Soporta WebSockets, tiene tier gratis

¿Quieres que implemente la integración con Pusher o Ably para que funcione directamente en Vercel?
