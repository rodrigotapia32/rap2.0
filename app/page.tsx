'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import styles from './page.module.css';

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState('');
  
  // Verificar si hay un roomId en la URL (link compartido)
  useEffect(() => {
    const urlRoomId = searchParams.get('roomId');
    if (urlRoomId) {
      const trimmedRoomId = urlRoomId.trim().toUpperCase();
      // Validar que sea un código válido
      if (/^[A-Z0-9]{6}$/.test(trimmedRoomId)) {
        setRoomId(trimmedRoomId);
      }
    }
  }, [searchParams]);

  const handleCreateRoom = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    // Generar código de sala único
    const newRoomId = generateRoomId();
    router.push(`/create?nickname=${encodeURIComponent(nickname)}&roomId=${newRoomId}`);
  };

  const handleJoinRoom = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    const trimmedRoomId = roomId.trim().toUpperCase();
    if (!trimmedRoomId) {
      alert('Ingresa el código de sala');
      return;
    }
    if (!/^[A-Z0-9]{6}$/.test(trimmedRoomId)) {
      alert('El código de sala debe ser de 6 caracteres alfanuméricos (ej: ABC123)');
      return;
    }
    // Si hay un código en la URL, entrar automáticamente
    router.push(`/room/${trimmedRoomId}?nickname=${encodeURIComponent(nickname)}&isHost=false`);
  };
  
  // Si hay un roomId en la URL, entrar automáticamente cuando se ingrese el nickname
  const handleAutoJoin = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    if (roomId && /^[A-Z0-9]{6}$/.test(roomId)) {
      router.push(`/room/${roomId}?nickname=${encodeURIComponent(nickname)}&isHost=false`);
    }
  };

  // Genera un código de 6 caracteres alfanuméricos
  const generateRoomId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  // Si hay un roomId en la URL (link compartido), mostrar solo el input de nickname
  const hasRoomIdFromUrl = roomId && /^[A-Z0-9]{6}$/.test(roomId);

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Rap 2.0</h1>
      <p className={styles.subtitle}>Freestyle 1v1</p>

      <div className={styles.form}>
        {hasRoomIdFromUrl ? (
          // Vista simplificada cuando hay un código en la URL
          <>
            <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
              <p style={{ color: '#888', marginBottom: '0.5rem' }}>Código de sala:</p>
              <p style={{ 
                fontSize: '1.5rem', 
                fontWeight: 'bold', 
                letterSpacing: '0.2em',
                color: '#667eea'
              }}>
                {roomId}
              </p>
            </div>
            <input
              type="text"
              placeholder="Tu nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className={styles.input}
              maxLength={20}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nickname.trim()) {
                  handleAutoJoin();
                }
              }}
            />
            <button onClick={handleAutoJoin} className={styles.button}>
              Entrar a la sala
            </button>
          </>
        ) : (
          // Vista normal cuando no hay código en la URL
          <>
            <input
              type="text"
              placeholder="Tu nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className={styles.input}
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nickname.trim()) {
                  handleCreateRoom();
                }
              }}
            />

            <div className={styles.joinSection}>
              <input
                type="text"
                placeholder="Código de sala (ej: ABC123)"
                value={roomId}
                onChange={(e) => {
                  const value = e.target.value.toUpperCase();
                  // Permitir solo caracteres alfanuméricos
                  if (/^[A-Z0-9]*$/.test(value) || value === '') {
                    setRoomId(value);
                  }
                }}
                className={styles.input}
                maxLength={6}
                style={{ textAlign: 'center', letterSpacing: '0.2em', fontSize: '1.2rem' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nickname.trim() && roomId.trim()) {
                    handleJoinRoom();
                  }
                }}
              />
              <button onClick={handleJoinRoom} className={styles.joinButton}>
                Unirse
              </button>
            </div>

            <div className={styles.divider}>
              <span>o</span>
            </div>

            <button onClick={handleCreateRoom} className={styles.button}>
              Crear sala
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className={styles.container}>Cargando...</div>}>
      <HomeContent />
    </Suspense>
  );
}
