# Rap 2.0 - Freestyle 1v1

Aplicación web minimalista para batallas de freestyle rap 1v1 en tiempo real usando WebRTC.

## Stack Tecnológico

- **Next.js 14** (App Router)
- **TypeScript**
- **WebRTC** (audio P2P)
- **WebSocket** (signaling)
- **Web Audio API** (control de volúmenes)

## Características

- ✅ Conexión P2P de audio en tiempo real
- ✅ Sistema de salas con códigos únicos
- ✅ Sincronización de beats
- ✅ Controles de audio independientes (beat, mic, oponente)
- ✅ Sistema de "listo" y cuenta regresiva
- ✅ UI minimalista y clara

## Instalación

```bash
npm install
```

## Desarrollo

### 1. Iniciar servidor WebSocket (terminal 1)

```bash
node server/websocket-server.js
```

El servidor WebSocket correrá en `ws://localhost:3001`

### 2. Iniciar aplicación Next.js (terminal 2)

```bash
npm run dev
```

La aplicación estará disponible en `http://localhost:3000`

## Estructura del Proyecto

```
rap2.0/
├── app/
│   ├── api/              # API routes
│   ├── room/[roomId]/    # Página de sala
│   ├── create/           # Crear sala
│   ├── join/             # Unirse a sala
│   └── page.tsx          # Home
├── hooks/
│   ├── useWebRTC.ts      # Hook para WebRTC
│   └── useAudioControls.ts # Hook para controles de audio
├── lib/
│   └── websocket.ts      # Cliente WebSocket
├── server/
│   └── websocket-server.js # Servidor WebSocket
└── public/
    └── beats/            # Archivos de beats (.mp3)
```

## Beats

Coloca los archivos de beats en `public/beats/`:
- `beat1.mp3`
- `beat2.mp3`

## Deploy en Vercel

### ✅ Código ya subido a GitHub

El repositorio está en: https://github.com/rodrigotapia32/rap2.0.git

### 🚀 Pasos Rápidos para Deploy

1. **Conectar con Vercel**:
   - Ve a [vercel.com](https://vercel.com)
   - Inicia sesión con GitHub
   - Importa el repositorio `rodrigotapia32/rap2.0`

2. **Configurar Variables de Entorno** (antes de deploy):
   ```
   NEXT_PUBLIC_PUSHER_KEY=cb5daaae59105d0c5bc1
   NEXT_PUBLIC_PUSHER_CLUSTER=us2
   ```

3. **Habilitar Client Events en Pusher**:
   - Dashboard Pusher → App "smooth-hat-411"
   - Settings → App Settings → Habilitar "Client Events"

4. **Deploy**: Click en "Deploy" y espera 2-3 minutos

**Ver `VERCEL_DEPLOY.md` para guía completa paso a paso.**

## Uso

1. **Crear sala**: Ingresa tu nickname y crea una sala. Obtendrás un código único.
2. **Unirse a sala**: Ingresa el código de sala y tu nickname.
3. **Conectar**: Los usuarios se conectarán automáticamente vía WebRTC.
4. **Prepararse**: Selecciona un beat y presiona "Estoy listo".
5. **Batalla**: Cuando ambos estén listos, comenzará la cuenta regresiva y la batalla.

## Notas Técnicas

- Usa STUN público de Google para NAT traversal
- Estructura preparada para TURN (no implementado aún)
- Audio only (sin video)
- Sincronización de beats basada en timestamps del servidor
