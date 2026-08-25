import { io, type Socket } from 'socket.io-client';

// Este módulo solo se ejecuta en el navegador
let socket: Socket | null = null;

/**
 * Devuelve la instancia singleton del socket.
 * Las cookies HttpOnly se envían automáticamente por el navegador
 * al conectar (withCredentials: true).
 */
export function getSocket(): Socket {
  if (!socket) {
    // PUBLIC_API_URL está disponible en tiempo de build/cliente
    const url = import.meta.env.PUBLIC_API_URL ?? window.location.origin;

    socket = io(url, {
      withCredentials: true,
      // El access_token viaja en la cookie; no necesitamos auth manual
      autoConnect: false,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socket.on('connect_error', (err) => {
      console.warn('[socket] error de conexión:', err.message);
    });
  }

  return socket;
}

/** Conecta (si no estaba conectado) y devuelve el socket */
export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

/** Desconecta y destruye la instancia (ej. al hacer logout) */
export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
