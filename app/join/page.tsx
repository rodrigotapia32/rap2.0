'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState, Suspense } from 'react';
import styles from '../page.module.css';

function JoinRoomContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const nickname = searchParams.get('nickname') || '';
  const [roomId, setRoomId] = useState('');

  const handleJoin = () => {
    const trimmedRoomId = roomId.trim().toUpperCase();
    if (!trimmedRoomId) {
      alert('Ingresa el código de sala');
      return;
    }
    // Validar que sea alfanumérico y de 6 caracteres
    if (!/^[A-Z0-9]{6}$/.test(trimmedRoomId)) {
      alert('El código de sala debe tener 6 caracteres alfanuméricos');
      return;
    }
    router.push(`/room/${trimmedRoomId}?nickname=${encodeURIComponent(nickname)}&isHost=false`);
  };

  if (!nickname) {
    router.push('/');
    return null;
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Unirse a sala</h1>
      
      <div className={styles.form}>
        <input
          type="text"
          placeholder="Código de sala (ej: ABC123)"
          value={roomId}
          onChange={(e) => {
            // Solo permitir caracteres alfanuméricos
            const value = e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
            setRoomId(value.slice(0, 6));
          }}
          className={styles.input}
          maxLength={6}
          style={{ textAlign: 'center', letterSpacing: '0.2em', fontSize: '1.5rem' }}
        />

        <button onClick={handleJoin} className={styles.button}>
          Entrar
        </button>
      </div>
    </div>
  );
}

export default function JoinRoom() {
  return (
    <Suspense fallback={<div className={styles.container}>Cargando...</div>}>
      <JoinRoomContent />
    </Suspense>
  );
}
