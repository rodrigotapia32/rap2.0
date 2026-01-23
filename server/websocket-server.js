/**
 * Servidor WebSocket simple para signaling
 * Ejecutar con: node server/websocket-server.js
 * Para producción, usar un servicio WebSocket real o implementar en Vercel con Serverless Functions
 */

const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3001 });

// Almacenar conexiones por sala
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const userId = url.searchParams.get('userId');
  const nickname = url.searchParams.get('nickname');

  if (!roomId || !userId || !nickname) {
    ws.close();
    return;
  }

  console.log(`Usuario ${nickname} (${userId}) se unió a la sala ${roomId}`);

  // Inicializar sala si no existe
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  const room = rooms.get(roomId);
  room.set(userId, { ws, nickname, userId });

  // Notificar a otros usuarios en la sala
  room.forEach((user, id) => {
    if (id !== userId) {
      user.ws.send(
        JSON.stringify({
          type: 'user-joined',
          userId,
          nickname,
        })
      );
      // Notificar al nuevo usuario sobre usuarios existentes
      ws.send(
        JSON.stringify({
          type: 'user-joined',
          userId: id,
          nickname: user.nickname,
        })
      );
    }
  });

  // Manejar mensajes
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Reenviar mensaje a otros usuarios en la sala
      room.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === WebSocket.OPEN) {
          user.ws.send(JSON.stringify(data));
        }
      });
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  });

  // Manejar desconexión
  ws.on('close', () => {
    console.log(`Usuario ${nickname} (${userId}) dejó la sala ${roomId}`);
    room.delete(userId);

    // Notificar a otros usuarios
    room.forEach((user) => {
      if (user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(
          JSON.stringify({
            type: 'user-left',
            userId,
          })
        );
      }
    });

    // Eliminar sala si está vacía
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

console.log('Servidor WebSocket corriendo en puerto 3001');
