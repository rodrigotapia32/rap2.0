'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState('');

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
    router.push(`/room/${trimmedRoomId}?nickname=${encodeURIComponent(nickname)}&isHost=false`);
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

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Rap 2.0</h1>
      <p className={styles.subtitle}>Freestyle 1v1</p>

      <div className={styles.form}>
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
      </div>
    </div>
  );
}
