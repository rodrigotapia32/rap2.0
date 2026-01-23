'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import styles from '../page.module.css';

function CreateRoomContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const nickname = searchParams.get('nickname') || '';
  const roomId = searchParams.get('roomId') || '';
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (!nickname || !roomId) {
      router.push('/');
      return;
    }
    // Validar roomId
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      router.push('/');
      return;
    }
  }, [nickname, roomId, router]);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (error) {
      console.error('Error copiando código:', error);
      // Fallback: seleccionar el texto
      const textArea = document.createElement('textarea');
      textArea.value = roomId;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
      } catch (err) {
        alert('No se pudo copiar el código. Código: ' + roomId);
      }
      document.body.removeChild(textArea);
    }
  };

  const handleCopyLink = async () => {
    // Link de invitación que incluye el código pero no el nickname
    const link = `${window.location.origin}/?roomId=${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Error copiando link:', error);
      // Fallback: seleccionar el texto
      const textArea = document.createElement('textarea');
      textArea.value = link;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        alert('No se pudo copiar el link. Link: ' + link);
      }
      document.body.removeChild(textArea);
    }
  };

  const handleEnterRoom = () => {
    router.push(`/room/${roomId}?nickname=${encodeURIComponent(nickname)}&isHost=true`);
  };

  if (!nickname || !roomId) {
    return null;
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Sala creada</h1>
      
      <div className={styles.form}>
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ color: '#888', marginBottom: '0.5rem' }}>Código de sala:</p>
          <div
            onClick={handleCopyCode}
            style={{
              padding: '1rem',
              background: '#1a1a1a',
              borderRadius: '8px',
              fontSize: '2rem',
              fontWeight: 'bold',
              textAlign: 'center',
              letterSpacing: '0.2em',
              cursor: 'pointer',
              border: '2px solid #333',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#667eea';
              e.currentTarget.style.background = '#222';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#333';
              e.currentTarget.style.background = '#1a1a1a';
            }}
          >
            {copiedCode ? '✓ Copiado!' : roomId}
          </div>
          <p style={{ color: '#666', fontSize: '0.85rem', marginTop: '0.5rem', textAlign: 'center' }}>
            Click para copiar el código
          </p>
        </div>

        <button
          onClick={handleCopyLink}
          className={styles.button}
          style={{ marginBottom: '1rem', background: '#333' }}
        >
          {copied ? '✓ Link copiado' : 'Copiar link completo'}
        </button>

        <button onClick={handleEnterRoom} className={styles.button}>
          Entrar a la sala
        </button>
      </div>
    </div>
  );
}

export default function CreateRoom() {
  return (
    <Suspense fallback={<div className={styles.container}>Cargando...</div>}>
      <CreateRoomContent />
    </Suspense>
  );
}
