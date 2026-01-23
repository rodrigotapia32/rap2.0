/**
 * Endpoint de autenticación para canales privados de Pusher
 * Valida las solicitudes y genera tokens de autenticación
 */

import { NextRequest, NextResponse } from 'next/server';
import Pusher from 'pusher';

// Inicializar Pusher server (solo para autenticación)
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '',
  key: process.env.NEXT_PUBLIC_PUSHER_KEY || '',
  secret: process.env.PUSHER_SECRET || '',
  cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2',
  useTLS: true,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.formData();
    const socketId = body.get('socket_id') as string;
    const channelName = body.get('channel_name') as string;

    if (!socketId || !channelName) {
      return NextResponse.json(
        { error: 'socket_id y channel_name son requeridos' },
        { status: 400 }
      );
    }

    // Validar que el canal sea privado y tenga el formato correcto
    if (!channelName.startsWith('private-room-')) {
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

    // Autenticar el canal (Pusher genera el token automáticamente)
    const auth = pusher.authorizeChannel(socketId, channelName);

    return NextResponse.json(auth);
  } catch (error: any) {
    console.error('Error en autenticación Pusher:', error);
    return NextResponse.json(
      { error: 'Error de autenticación' },
      { status: 500 }
    );
  }
}
