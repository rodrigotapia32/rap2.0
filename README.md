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

### ✅ Configurado con Pusher

El proyecto está configurado para usar **Pusher** como servicio de WebSocket, que funciona perfectamente con Vercel.

### Pasos para Deploy

1. **Configurar Pusher** (ver `PUSHER_SETUP.md`):
   - Crear cuenta en [pusher.com](https://pusher.com)
   - Crear una app
   - Obtener `key` y `cluster`

2. **Variables de entorno en Vercel**:
   ```
   NEXT_PUBLIC_PUSHER_KEY=tu_pusher_key
   NEXT_PUBLIC_PUSHER_CLUSTER=us2
   ```

3. **Push a GitHub y conectar Vercel**:
   ```bash
   git add .
   git commit -m "Preparado para deploy"
   git push origin main
   ```
   - Ve a [vercel.com](https://vercel.com)
   - Importa el repositorio
   - Agrega las variables de entorno
   - Deploy automático

Ver `PUSHER_SETUP.md` para instrucciones detalladas.

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
