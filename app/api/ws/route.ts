import { NextRequest } from 'next/server';

// Para Vercel, necesitamos usar Server-Sent Events o upgrade manual
// Esta es una implementación básica que funciona con el cliente WebSocket

export async function GET(request: NextRequest) {
  // En producción con Vercel, necesitarías usar un servicio externo de WebSocket
  // o implementar Server-Sent Events
  // Por ahora, retornamos un mensaje indicando que se debe usar un servidor WebSocket externo
  return new Response('WebSocket endpoint - usar cliente WebSocket directo', {
    status: 200,
  });
}
