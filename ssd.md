DOCUMENTO DE DISEÑO DE SISTEMA (SDD) - xChanger
I. Arquitectura del Sistema
El sistema implementará una arquitectura de Monolito Modular basada en el patrón de diseño Capas (Controlador-Servicio-Repositorio), asegurando la separación de responsabilidades y facilitando el mantenimiento.

Frontend: Astro (Framework principal, priorizando renderizado en servidor SSR y componentes estáticos).


Backend: Node.js con Express.js.


Capa de Datos: PostgreSQL con Prisma ORM para tipado estricto y abstracción de consultas.


Gestión de Conexiones: PgBouncer (Connection Pooling) para soportar picos de tráfico con una latencia de lectura estricta < 300ms.


Tiempo Real: Socket.io para la unificación de WebSockets (Ticketing, Chats de Ofertas y Notificaciones).


II. Modelos de Datos (Esquema Conceptual Prisma)
Todo el modelado implementa Soft Delete (deleted_at nullable) para mantener la integridad referencial de logs, auditorías y chats históricos.

Entidad
Campos Clave
Relaciones y Lógica
User
id, email (único, @alumnos.unican.es), password_hash, role (Enum), deleted_at
Roles: ESTUDIANTE, EMBAJADOR, PROPIETARIO, BLOQUEADO.
Administracion_Scope
id, userId, carreraId, cursoId (nullable)
Define el ámbito. Si cursoId es nulo, el ámbito abarca toda la Carrera.
Carrera / Curso / Asignatura
id, nombre, codigo (en Asignatura), deleted_at
Jerarquía estricta. Relaciones 1:N entre ellas.
Grupo
id, nombre, asignaturaId, deleted_at
Identifica los grupos de prácticas/teoría.
Offer
id, userId, asignaturaId, grupoDeseadoId, grupoActualId, status, deleted_at
Estados: OPEN, ACCEPTED, CLOSED, INACTIVE (si usuario es bloqueado).
Ticket
id, userId, asunto, status (OPEN, CLOSED), adminId, deleted_at
adminId puede cambiar dependiendo de la disponibilidad y ámbito.
Message
id, authorId, ticketId (nullable), offerId (nullable), content, timestamp
Reutilizable para chats de tickets y de ofertas aceptadas.
Notification
id, userId, asunto, contenido, is_read, timestamp
Reflejo persistente de las notificaciones enviadas por Email/Sockets.
Log
id, timestamp, userId, action, payload (JSON)
Registro inmutable de acciones. Inmune a Soft Delete.


III. Contratos de API Principales
El diseño de la API RESTful seguirá convenciones estrictas. Las rutas de administración estarán protegidas por un middleware que validará el cruce entre la acción solicitada y la tabla Administracion_Scope.

Endpoint
Método
Propósito y Detalles
/api/auth/register
POST
Inicia registro. Retorna JWT de 30 min (flujo OTP).
/api/auth/verify-otp
POST
Valida OTP. Genera registro físico y cookies de sesión.
/api/auth/login
POST
Autenticación. Retorna Access/Refresh Tokens en cookies.
/api/offers
GET
Lista ofertas activas. Soporta query params de filtrado.
/api/offers/:id/accept
POST
Transiciona oferta a ACCEPTED e inicializa sala de chat Socket.io.
/api/admin/degrees
POST
Crea carrera. Auto-asigna acceso solo si el actor es PROPIETARIO.
/api/admin/logs
GET
Recupera logs paginados. Filtra estrictamente por el ámbito del requester.


Eventos de WebSockets (Socket.io):

join_room: Une a un usuario a la sala del ticket u oferta (validando pertenencia).
send_message: Emite mensaje y notifica al cliente si la contraparte está offline.
receive_notification: Canal global de usuario para alertas de sistema (eliminaciones lógicas, nuevas ofertas).


IV. Seguridad y Autenticación
La seguridad asume un modelo de confianza cero (Zero Trust) a nivel de endpoints y eventos WebSocket.
Gestión de Sesiones: Empleo estricto de cookies HttpOnly y Secure. Access Token con vida útil de 15 minutos; Refresh Token con vida útil de 7 días. Prevención total contra ataques XSS mediante el bloqueo de acceso al token desde JavaScript del lado del cliente.
Criptografía: Contraseñas gestionadas con bcrypt (mínimo factor de coste 10). Requisitos de complejidad (8 caracteres, mayúscula, minúscula, número, símbolo) validados en backend antes del hash.
Autorización (Mínimo Privilegio): Middleware iterativo. Primero verifica el JWT; segundo, verifica que el User.role != BLOQUEADO; tercero, verifica el ámbito en Administracion_Scope contra los parámetros de la request (carreraId, cursoId).


V. Flujos de Estado y Bloqueos
Las máquinas de estado del sistema reaccionarán de forma determinista a los cambios de rol de los usuarios.

Transición de Rol a BLOQUEADO:
Disparador: Un administrador con permisos suficientes invoca la acción "Bloquear".
Impacto en Ofertas: Todas las ofertas OPEN del usuario cambian inmediatamente a INACTIVE (ocultas en la UI pública).
Impacto en Tickets y Chats: El backend intercepta cualquier intento de emitir send_message por parte del usuario bloqueado. La UI se renderiza en "solo lectura".
Impacto en Sesión: Al expirar el Access Token (máximo 15 minutos), el endpoint del Refresh Token denegará la renovación, forzando un cierre de sesión. El intento de nuevo login mostrará un modal con el motivo y la fecha (si es temporal).


Flujo de Borrado Lógico (Soft Delete):

Disparador: Administrador elimina un Curso.
Impacto: Curso.deleted_at recibe el timestamp actual.
Cascada Lógica: Las Asignaturas y Grupos dependientes mantienen sus registros, pero las consultas (repositorios Prisma) excluirán automáticamente cualquier entidad cuyo padre tenga un deleted_at no nulo.
Notificaciones: Se dispara el evento asíncrono para notificar (Email + Sistema) a los usuarios matriculados en dicho curso o con ofertas vinculadas.


VI. Apéndice: Estrategia de Despliegue, Contenedores y CI/CD
Para garantizar un entorno reproducible y un despliegue sin fricciones, el sistema adoptará una infraestructura inmutable y automatizada.

1. Contenedorización (Docker):
El entorno completo se orquestará mediante docker-compose, segmentado en tres servicios principales:
Servicio db: Contenedor basado en la imagen oficial de PostgreSQL (postgres:15-alpine), configurado junto a un contenedor sidecar de PgBouncer para el pooling de conexiones. Los datos persistirán mediante volúmenes Docker.
Servicio backend: Contenedor basado en node:20-alpine. Expondrá el puerto de Express y WebSockets. En el proceso de build, generará los artefactos de Prisma Client.
Servicio frontend: Contenedor basado en node:20-alpine que ejecutará la build final de Astro en modo SSR, sirviendo las vistas pre-renderizadas e interactuando con el backend a través de la red interna de Docker.
2. Flujo de Integración y Despliegue Continuos (GitHub Actions):
Se configurará un pipeline de CI/CD que interceptará los cambios en el repositorio.
Fase CI (On Pull Request a main):
Ejecución de Linter (ESLint/Prettier) para mantener el estándar de código.
Validación de esquemas de base de datos (npx prisma validate).
Ejecución de pruebas unitarias y de integración (Jest/Supertest). El pipeline fallará si la cobertura de código crítico no es superada o si alguna prueba falla.


Fase CD (On Merge a main):
Construcción de las imágenes Docker (Frontend y Backend).
Publicación de las imágenes versionadas en un Container Registry (ej. GitHub Container Registry o Docker Hub).
Ejecución vía SSH (o Webhook) en el servidor de producción (VPS/Cloud) de un script de despliegue que ejecute docker-compose pull y docker-compose up -d --build, aplicando migraciones de Prisma pendientes (npx prisma migrate deploy) de manera desatendida.


