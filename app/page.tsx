'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');

  const handleCreateRoom = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    // Generar código de sala único
    const roomId = generateRoomId();
    router.push(`/create?nickname=${encodeURIComponent(nickname)}&roomId=${roomId}`);
  };

  const handleJoinRoom = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    router.push(`/join?nickname=${encodeURIComponent(nickname)}`);
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
        />

        <div className={styles.buttons}>
          <button onClick={handleCreateRoom} className={styles.button}>
            Crear sala
          </button>
          <button onClick={handleJoinRoom} className={styles.button}>
            Unirse a sala
          </button>
        </div>
      </div>
    </div>
  );
}
