'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import styles from './page.module.css';

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState('');
  const [roomIdFromUrl, setRoomIdFromUrl] = useState(false);
  const [showJoinForm, setShowJoinForm] = useState(false);
  
  // Cargar nickname y roomId desde localStorage al montar
  useEffect(() => {
    const savedNickname = localStorage.getItem('rap2.0_nickname');
    if (savedNickname) setNickname(savedNickname);
    
    const urlRoomId = searchParams.get('roomId');
    if (!urlRoomId) {
      const savedRoomId = localStorage.getItem('rap2.0_lastRoomId');
      if (savedRoomId && /^[A-Z0-9]{6}$/.test(savedRoomId)) setRoomId(savedRoomId);
    }
  }, [searchParams]);
  
  // Verificar si hay un roomId en la URL (link compartido) - tiene prioridad sobre localStorage
  useEffect(() => {
    const urlRoomId = searchParams.get('roomId');
    if (urlRoomId) {
      const trimmedRoomId = urlRoomId.trim().toUpperCase();
      // Validar que sea un código válido
      if (/^[A-Z0-9]{6}$/.test(trimmedRoomId)) {
        setRoomId(trimmedRoomId);
        setRoomIdFromUrl(true);
      }
    } else {
      setRoomIdFromUrl(false);
    }
  }, [searchParams]);
  
  useEffect(() => {
    if (nickname.trim()) localStorage.setItem('rap2.0_nickname', nickname.trim());
  }, [nickname]);

  const handleCreateRoom = () => {
    if (!nickname.trim()) {
      alert('Ingresa un nickname');
      return;
    }
    // Generar código de sala único
    const newRoomId = generateRoomId();
    localStorage.setItem('rap2.0_lastRoomId', newRoomId);
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
    localStorage.setItem('rap2.0_lastRoomId', trimmedRoomId);
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
  const hasRoomIdFromUrl = roomIdFromUrl && roomId && /^[A-Z0-9]{6}$/.test(roomId);

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
          // Vista normal: nickname + dos acciones (Crear sala / Unirse a sala)
          <>
            <input
              type="text"
              placeholder="Tu nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className={styles.input}
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nickname.trim() && !showJoinForm) {
                  handleCreateRoom();
                }
              }}
            />

            <div className={styles.actionButtons}>
              <button
                type="button"
                onClick={handleCreateRoom}
                className={styles.primaryButton}
              >
                Crear sala
              </button>
              <button
                type="button"
                onClick={() => setShowJoinForm(true)}
                className={styles.primaryButton}
              >
                Unirse a sala
              </button>
            </div>

            {showJoinForm && (
              <div className={styles.joinExpand}>
                <input
                  type="text"
                  placeholder="Código de sala (ej: ABC123)"
                  value={roomId}
                  onChange={(e) => {
                    const value = e.target.value.toUpperCase();
                    if (/^[A-Z0-9]*$/.test(value) || value === '') {
                      setRoomId(value);
                    }
                  }}
                  className={styles.input}
                  maxLength={6}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nickname.trim() && roomId.trim()) {
                      handleJoinRoom();
                    }
                  }}
                />
                <div className={styles.joinExpandActions}>
                  <button
                    type="button"
                    onClick={handleJoinRoom}
                    className={styles.primaryButton}
                  >
                    Entrar
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowJoinForm(false)}
                    className={styles.cancelButton}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
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
