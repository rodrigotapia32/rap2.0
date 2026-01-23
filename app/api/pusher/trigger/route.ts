/**
 * Endpoint para enviar mensajes a través del servidor de Pusher
 * Esto evita el límite de 10 client events/minuto del plan gratis
 */

import { NextRequest, NextResponse } from 'next/server';
import Pusher from 'pusher';

// Inicializar Pusher server
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '',
  key: process.env.NEXT_PUBLIC_PUSHER_KEY || '',
  secret: process.env.PUSHER_SECRET || '',
  cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2',
  useTLS: true,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { channel, event, data } = body;

    if (!channel || !event || !data) {
      return NextResponse.json(
        { error: 'channel, event y data son requeridos' },
        { status: 400 }
      );
    }

    // Validar que el canal sea privado y tenga el formato correcto
    if (!channel.startsWith('private-room-')) {
      return NextResponse.json(
        { error: 'Canal no autorizado' },
        { status: 403 }
      );
    }

    // Validar que tenemos las credenciales necesarias
    if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_SECRET) {
      console.error('⚠️ PUSHER_APP_ID o PUSHER_SECRET no están configurados');
      return NextResponse.json(
        { error: 'Configuración del servidor incompleta' },
        { status: 500 }
      );
    }

    // Enviar mensaje a través del servidor (sin límite de client events)
    await pusher.trigger(channel, event, data);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error en trigger Pusher:', error);
    return NextResponse.json(
      { error: 'Error enviando mensaje' },
      { status: 500 }
    );
  }
}
