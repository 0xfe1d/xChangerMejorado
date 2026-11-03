# Genera modelos-requisitos-arquitectura.tex a partir de los diagramas PlantUML
# (diagramas/*.puml, renderizados en img/) y del inventario de endpoints del core.
#   python3 docs/modelos/generar_modelos.py
import os, re, glob

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "modelos-requisitos-arquitectura.tex")


def esc(s: str) -> str:
    """Texto plano → LaTeX. `...` se compone en monoespaciado."""
    parts = re.split(r"(`[^`]+`)", s)
    res = []
    for p in parts:
        code = p.startswith("`") and p.endswith("`") and len(p) > 1
        t = p[1:-1] if code else p
        t = (t.replace("\\", r"\textbackslash{}").replace("&", r"\&").replace("%", r"\%")
              .replace("$", r"\$").replace("#", r"\#").replace("_", r"\_")
              .replace("{", r"\{").replace("}", r"\}").replace("~", r"\textasciitilde{}")
              .replace("^", r"\textasciicircum{}").replace("→", r"$\rightarrow$")
              .replace("≤", r"$\leq$").replace("≥", r"$\geq$").replace("×", r"$\times$")
              .replace("§", r"\S{}").replace("|", r"\textbar{}"))
        if code:
            t = r"\texttt{" + t.replace("/", r"/\allowbreak{}").replace(",", r",\allowbreak{}") + "}"
        res.append(t)
    return "".join(res)


# ─────────────────────────────────────────────────────────────────────────────
# Catálogo de actores
# ─────────────────────────────────────────────────────────────────────────────
ACTORES = [
    ("Visitante", "Primario", "Web", "Persona sin sesión: se registra, consulta el catálogo e inicia sesión."),
    ("Usuario registrado", "Primario", "Web", "Cualquier persona con cuenta, antes de autenticarse."),
    ("Estudiante", "Primario", "Web, Telegram", "Usuario base: expediente, ofertas, chat, tickets, notificaciones y seguridad de su cuenta."),
    ("Embajador", "Primario", "Web", "Especialización de Estudiante con ámbito (carrera, curso): administra estructura, tickets, bloqueos y auditoría."),
    ("Propietario", "Primario", "Web", "Especialización de Embajador con ámbito total: carreras, embajadores y ámbitos."),
    ("Usuario de Telegram no vinculado", "Primario", "Telegram", "Persona que habla con el bot sin identidad vinculada."),
    ("telegram-bot", "Primario (sistema)", "API de servicios", "Microservicio adaptador de canal; actúa con credencial de servicio y, en nombre del usuario, con token de canal."),
    ("mfa-service", "Secundario (sistema)", "API de servicios", "Custodio de los factores XOTP; el core lo invoca para enrolar y verificar, y él consulta el JWKS del core."),
    ("Servidor SMTP", "Secundario (sistema)", "—", "Entrega los OTP y las notificaciones por correo."),
    ("App autenticadora", "Externo (sin interacción)", "—", "Genera los códigos a partir del QR; no se comunica con el sistema."),
    ("Orquestador", "Primario (sistema)", "API de servicios", "Docker o monitorización: consulta la salud."),
]

# ─────────────────────────────────────────────────────────────────────────────
# Catálogo de casos de uso: (id, nombre, actor primario, interfaz, trazabilidad)
# ─────────────────────────────────────────────────────────────────────────────
CU = [
    ("UC-01", "Registrarse", "Visitante", "Web", "RF-AUT-01..04"),
    ("UC-02", "Verificar correo con OTP", "Visitante", "Web", "RF-AUT-05..08"),
    ("UC-03", "Consultar catálogo académico", "Visitante", "Web", "RF-ACA-08"),
    ("UC-04", "Iniciar sesión", "Usuario registrado", "Web", "RF-AUT-09..11; EP-C-19"),
    ("UC-05", "Completar segundo factor", "Usuario registrado", "Web", "RF-MFA-04..06; EP-C-24"),
    ("UC-06", "Recuperar contraseña", "Usuario registrado", "Web", "RF-AUT-14, 15"),
    ("UC-07", "Renovar sesión", "Usuario registrado", "Web", "RF-AUT-12"),
    ("UC-10", "Editar perfil", "Estudiante", "Web", "RF-PER-01"),
    ("UC-11", "Gestionar expediente", "Estudiante", "Web", "RF-PER-02..04"),
    ("UC-12", "Cambiar contraseña", "Estudiante", "Web", "RF-AUT-16"),
    ("UC-20", "Buscar ofertas complementarias", "Estudiante", "Web", "RF-OFE-04, 05"),
    ("UC-21", "Publicar oferta", "Estudiante", "Web", "RF-OFE-01..03, 06, 07"),
    ("UC-22", "Aceptar oferta", "Estudiante", "Web", "RF-OFE-08, 09"),
    ("UC-23", "Consultar mis ofertas", "Estudiante", "Web", "RF-OFE-11, 12"),
    ("UC-24", "Cerrar oferta", "Estudiante", "Web", "RF-OFE-10"),
    ("UC-25", "Chatear con la contraparte", "Estudiante", "Web", "RF-CHT-01..08"),
    ("UC-30", "Abrir ticket", "Estudiante", "Web", "RF-TIC-01"),
    ("UC-31", "Conversar en ticket", "Estudiante", "Web", "RF-TIC-02, RF-CHT-02"),
    ("UC-32", "Cerrar ticket", "Estudiante", "Web", "RF-TIC-07"),
    ("UC-33", "Consultar notificaciones", "Estudiante", "Web", "RF-NOT-03..05"),
    ("UC-34", "Configurar preferencias de notificación", "Estudiante", "Web", "EP-C-17, 18"),
    ("UC-40", "Activar MFA", "Estudiante", "Web", "RF-MFA-01..03"),
    ("UC-41", "Desactivar MFA", "Estudiante", "Web", "RF-MFA-07"),
    ("UC-42", "Regenerar códigos de recuperación", "Estudiante", "Web", "RF-MFA-08"),
    ("UC-43", "Reautenticarse", "Estudiante", "Web", "EP-C-27"),
    ("UC-44", "Aprobar vinculación de Telegram", "Estudiante", "Web", "RF-TGB-01; EP-C-04, 05"),
    ("UC-45", "Gestionar canales vinculados", "Estudiante", "Web", "RF-TGB-09; EP-C-10, 11"),
    ("UC-46", "Cerrar sesión", "Estudiante", "Web", "RF-AUT-13"),
    ("UC-50", "Atender tickets del ámbito", "Embajador", "Web", "RF-TIC-03..08"),
    ("UC-51", "Gestionar cursos", "Embajador", "Web", "RF-ACA-03, 09"),
    ("UC-52", "Gestionar asignaturas", "Embajador", "Web", "RF-ACA-03, 09"),
    ("UC-53", "Gestionar grupos", "Embajador", "Web", "RF-ACA-03, 09"),
    ("UC-54", "Confirmar eliminación con referencias", "Embajador", "Web", "RF-ACA-04..06"),
    ("UC-55", "Buscar usuarios", "Embajador", "Web", "RF-ADM-09"),
    ("UC-56", "Consultar detalle de usuario", "Embajador", "Web", "RF-ADM-10"),
    ("UC-57", "Bloquear usuario", "Embajador", "Web", "RF-BLQ-01..04"),
    ("UC-58", "Desbloquear usuario", "Embajador", "Web", "RF-BLQ-06"),
    ("UC-59", "Forzar cambio de contraseña", "Embajador", "Web", "RF-ADM-10"),
    ("UC-60", "Restablecer MFA de usuario", "Embajador", "Web", "RF-MFA-09"),
    ("UC-61", "Auditar el log", "Embajador", "Web", "RF-LOG-04, 05"),
    ("UC-70", "Gestionar carreras", "Propietario", "Web", "RF-ACA-02"),
    ("UC-71", "Promover a embajador", "Propietario", "Web", "RF-ADM-05"),
    ("UC-72", "Degradar embajador", "Propietario", "Web", "RF-ADM-06"),
    ("UC-73", "Modificar ámbito", "Propietario", "Web", "RF-ADM-07"),
    ("UC-80", "Vincular cuenta existente", "Usuario de Telegram", "Telegram", "RF-TGB-01"),
    ("UC-81", "Entrar con OTP de correo", "Usuario de Telegram", "Telegram", "RF-TGB-02"),
    ("UC-82", "Verificar segundo factor", "Usuario de Telegram", "Telegram", "RF-TGB-02, RF-MFA-04"),
    ("UC-83", "Registrarse desde el chat", "Usuario de Telegram", "Telegram", "RF-TGB-03"),
    ("UC-84", "Desvincular el bot", "Estudiante", "Telegram", "RF-TGB-09"),
    ("UC-85", "Consultar perfil y estado MFA", "Estudiante", "Telegram", "EP-R-04, EP-C-20"),
    ("UC-86", "Gestionar expediente", "Estudiante", "Telegram", "RF-TGB-04"),
    ("UC-87", "Buscar ofertas complementarias", "Estudiante", "Telegram", "RF-TGB-05"),
    ("UC-88", "Publicar oferta", "Estudiante", "Telegram", "RF-TGB-05"),
    ("UC-89", "Aceptar oferta", "Estudiante", "Telegram", "RF-TGB-05"),
    ("UC-90", "Consultar y cerrar mis ofertas", "Estudiante", "Telegram", "RF-TGB-06"),
    ("UC-91", "Enviar mensaje de chat", "Estudiante", "Telegram", "RF-TGB-07"),
    ("UC-92", "Recibir notificaciones", "Estudiante", "Telegram", "RF-TGB-08"),
    ("UC-93", "Configurar avisos por Telegram", "Estudiante", "Telegram", "EP-C-18"),
    ("UC-100", "Obtener credencial de servicio", "telegram-bot", "Servicios", "ADR-20; EP-C-01"),
    ("UC-101", "Iniciar vinculación de dispositivo", "telegram-bot", "Servicios", "EP-C-03"),
    ("UC-102", "Canjear concesión de sesión", "telegram-bot", "Servicios", "EP-C-06"),
    ("UC-103", "Solicitar OTP de inicio de sesión", "telegram-bot", "Servicios", "EP-C-07"),
    ("UC-104", "Registrar usuario desde canal", "telegram-bot", "Servicios", "EP-C-08"),
    ("UC-105", "Operar en nombre del usuario", "telegram-bot", "Servicios", "ADR-17, 21"),
    ("UC-106", "Revocar sesión de canal", "telegram-bot", "Servicios", "EP-C-09"),
    ("UC-107", "Suscribirse a eventos de dominio", "telegram-bot", "Servicios", "§11"),
    ("UC-108", "Publicar claves públicas (JWKS)", "mfa-service", "Servicios", "EP-C-02"),
    ("UC-109", "Consultar salud", "Orquestador", "Servicios", "RNF-10; EP-C-30"),
]

# ─────────────────────────────────────────────────────────────────────────────
# API. Cada endpoint:
#  (método, ruta, acceso, [(param, dónde, tipo, oblig., descripción)], lógica, [(código, significado)])
# Acceso: P público · W sesión web (cookie) · S credencial de servicio ·
#         S+U servicio + token de canal · Adm embajador/propietario con ámbito ·
#         Prop propietario · I Idempotency-Key admitida (obligatoria para canal)
# ─────────────────────────────────────────────────────────────────────────────
CUID = "cuid"
G = []  # (título de grupo, introducción, [endpoints])

G.append(("Autenticación web", "Rutas bajo `/auth`. El access token (15 min) y el refresh token (7 días) viajan en cookies HttpOnly; el refresh solo se envía a la ruta de renovación del prefijo usado.", [
 ("POST", "/auth/register", "P", [
   ("name", "cuerpo", "string", "Sí", "2–100 caracteres (RV-01)."),
   ("email", "cuerpo", "string", "Sí", "Formato válido y dominio `@alumnos.unican.es` (RV-02)."),
   ("password", "cuerpo", "string", "Sí", "≥ 8; mayúscula, minúscula, número y símbolo (RV-03)."),
   ("carreraId", "cuerpo", CUID, "Sí", "Carrera existente y no eliminada."),
   ("cursoId", "cuerpo", CUID, "Sí", "Curso de esa carrera.")],
  "Crea un registro pendiente con el hash de la contraseña y del OTP, envía el OTP por correo y deja el reto en la cookie `otp_token` (30 min). No crea la cuenta.",
  [("202", "OTP enviado"), ("400", "VALIDATION_ERROR, INVALID_EMAIL_DOMAIN, WEAK_PASSWORD"), ("409", "EMAIL_TAKEN"), ("429", "RATE_LIMITED")]),
 ("POST", "/auth/verify-otp", "P", [
   ("otp_token", "cookie", "JWT", "Sí", "Reto emitido por el registro."),
   ("otpCode", "cuerpo", "string", "Sí", "Exactamente 6 dígitos.")],
  "Comprueba el reto y el código (máximo 5 intentos), crea el usuario con rol Estudiante, borra el pendiente e inicia sesión.",
  [("201", "Cuenta creada y cookies de sesión"), ("400", "INVALID_OTP"), ("401", "INVALID_TOKEN"), ("404", "Sin registro pendiente"), ("410", "EXPIRED_TOKEN")]),
 ("POST", "/auth/login", "P", [
   ("email", "cuerpo", "string", "Sí", "Email."),
   ("password", "cuerpo", "string", "Sí", "Contraseña.")],
  "Valida credenciales con respuesta genérica. Sin MFA: emite la sesión, registra el acceso y notifica. Con MFA: no emite sesión; devuelve `mfaRequired` y la cookie `mfa_challenge` (5 min, SameSite=Strict, ruta del reto).",
  [("200", "Sesión iniciada, o `{mfaRequired, methods, expiresIn}`"), ("401", "INVALID_CREDENTIALS"), ("403", "ACCOUNT_BLOCKED con `detail` (motivo, fin)"), ("429", "RATE_LIMITED")]),
 ("POST", "/auth/mfa/challenge", "P (cookie de reto)", [
   ("mfa_challenge", "cookie", "JWT", "Sí", "Reto vigente y no consumido."),
   ("code", "cuerpo", "string", "Cond.", "Código XOTP de 6 dígitos."),
   ("recoveryCode", "cuerpo", "string", "Cond.", "`XXXXX-XXXXX`; excluyente con `code`.")],
  "Verifica el segundo factor contra el mfa-service (máximo 5 intentos por reto); después comprueba el bloqueo y emite la sesión. El uso de un código de recuperación se audita y se notifica.",
  [("200", "`{user, warnings?}` y cookies de sesión"), ("400", "VALIDATION_ERROR"), ("401", "MFA_INVALID_CODE (`remainingAttempts`, `reason`)"), ("403", "ACCOUNT_BLOCKED"), ("410", "MFA_CHALLENGE_EXPIRED"), ("423", "MFA_LOCKED (`retryAfter`)"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("POST", "/auth/refresh", "P (cookie)", [
   ("refresh_token", "cookie", "JWT", "Sí", "Debe coincidir con el hash guardado.")],
  "Emite un nuevo access token conservando el momento del login original. Si el usuario está bloqueado, revoca la sesión.",
  [("200", "Token renovado"), ("401", "INVALID_TOKEN, SESSION_REVOKED"), ("403", "ACCOUNT_BLOCKED")]),
 ("POST", "/auth/forgot-password", "P", [("email", "cuerpo", "string", "Sí", "Email.")],
  "Si existe la cuenta, sustituye cualquier solicitud anterior y envía un OTP de 15 min. La respuesta no revela la existencia.",
  [("200", "Respuesta genérica"), ("429", "RATE_LIMITED")]),
 ("POST", "/auth/reset-password", "P", [
   ("email", "cuerpo", "string", "Sí", "Email."),
   ("otpCode", "cuerpo", "string", "Sí", "6 dígitos."),
   ("newPassword", "cuerpo", "string", "Sí", "Complejidad RV-03.")],
  "Fija la nueva contraseña, revoca la sesión web, consume la solicitud y registra `PASSWORD_RESET`. No altera el MFA. Sirve para que una cuenta creada por canal fije contraseña.",
  [("200", "Contraseña actualizada"), ("400", "INVALID_OTP, WEAK_PASSWORD, sin solicitud"), ("410", "EXPIRED_TOKEN")]),
 ("POST", "/auth/logout", "W", [], "Anula el hash del refresh token y borra las cookies.", [("200", "Sesión cerrada")]),
 ("GET", "/auth/me", "W, S+U", [], "Devuelve el perfil del usuario autenticado.",
  [("200", "`{id, email, role, name, carreraId, cursoId, mfaEnabled}`")]),
 ("PATCH", "/auth/me", "W", [
   ("name", "cuerpo", "string", "No", "2–100 caracteres."),
   ("carreraId", "cuerpo", "cuid | null", "No", "Carrera."),
   ("cursoId", "cuerpo", "cuid | null", "No", "Curso de la carrera.")],
  "Actualiza el perfil. Cualquier otro campo (por ejemplo `email`) se rechaza (RF-PER-01).",
  [("200", "Perfil actualizado"), ("400", "Campo no permitido o curso incoherente")]),
 ("PATCH", "/auth/settings/password", "W", [
   ("currentPassword", "cuerpo", "string", "Sí", "Contraseña actual."),
   ("newPassword", "cuerpo", "string", "Sí", "Complejidad RV-03.")],
  "Cambia la contraseña tras verificar la actual.",
  [("204", "Cambiada"), ("400", "WEAK_PASSWORD"), ("401", "INVALID_CREDENTIALS"), ("409", "PASSWORD_NOT_SET (cuenta sin contraseña)")]),
 ("POST", "/auth/reauthenticate", "W", [
   ("password", "cuerpo", "string", "Cond.", "Obligatoria si la cuenta tiene contraseña."),
   ("code", "cuerpo", "string", "Cond.", "XOTP si hay MFA; OTP de correo en el segundo paso de `email_otp`."),
   ("method", "cuerpo", "enum", "No", "`password` (defecto) o `email_otp` (cuentas sin contraseña ni MFA).")],
  "Prueba de presencia reciente: rota el access token con la marca de reautenticación, válida 10 minutos.",
  [("200", "Identidad verificada"), ("202", "OTP de correo enviado (primer paso de `email_otp`)"), ("401", "INVALID_CREDENTIALS, MFA_REQUIRED, MFA_INVALID_CODE"), ("423", "MFA_LOCKED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
]))

G.append(("Segundo factor (MFA)", "El core actúa como parte confiante: el navegador nunca habla con el mfa-service. Las respuestas con secretos o códigos llevan `Cache-Control: no-store`.", [
 ("GET", "/auth/mfa", "W, S+U", [],
  "Estado del factor. Si el mfa-service no responde y el usuario no tiene MFA, responde con el estado del core marcado `degraded`.",
  [("200", "`{enabled, method, enabledAt, recoveryCodesRemaining, pendingEnrollment}`"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("POST", "/auth/mfa/enrollments", "W (reautenticado)", [],
  "Crea un enrolamiento pendiente (10 min) en el mfa-service y devuelve la URI XOTP firmada y los datos de introducción manual. En producción exige HTTPS.",
  [("201", "`{enrollmentId, provisioningUri, manualEntry, expiresAt}`"), ("401", "REAUTH_REQUIRED"), ("403", "HTTPS_REQUIRED"), ("409", "MFA_ALREADY_ENABLED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("POST", "/auth/mfa/enrollments/{enrollmentId}/confirm", "W", [
   ("enrollmentId", "ruta", "string", "Sí", "Enrolamiento propio pendiente."),
   ("code", "cuerpo", "string", "Sí", "Código generado por la app.")],
  "Activa el factor, marca el MFA en el usuario, registra `MFA_ENABLED`, notifica y rota las cookies de sesión. Los códigos de recuperación se devuelven una sola vez.",
  [("200", "`{enabled: true, recoveryCodes[10]}`"), ("401", "MFA_INVALID_CODE"), ("404", "No encontrado"), ("409", "MFA_ALREADY_ENABLED"), ("410", "ENROLLMENT_EXPIRED"), ("423", "MFA_LOCKED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("DELETE", "/auth/mfa/enrollments/{enrollmentId}", "W", [("enrollmentId", "ruta", "string", "Sí", "Enrolamiento propio pendiente.")],
  "Cancela un enrolamiento pendiente.", [("204", "Cancelado")]),
 ("POST", "/auth/mfa/disable", "W", [
   ("password", "cuerpo", "string", "Cond.", "Obligatoria si la cuenta tiene contraseña."),
   ("code", "cuerpo", "string", "Cond.", "XOTP."),
   ("recoveryCode", "cuerpo", "string", "Cond.", "Excluyente con `code`.")],
  "Verifica contraseña y factor, borra el factor en el mfa-service, desactiva el MFA, registra `MFA_DISABLED` y notifica.",
  [("204", "Desactivado"), ("400", "Falta el factor"), ("401", "INVALID_CREDENTIALS, MFA_INVALID_CODE"), ("409", "MFA_NOT_ENABLED"), ("423", "MFA_LOCKED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("POST", "/auth/mfa/recovery-codes", "W", [("code", "cuerpo", "string", "Sí", "XOTP válido.")],
  "Regenera los 10 códigos de recuperación y anula los anteriores; registra `MFA_RECOVERY_REGENERATED`.",
  [("200", "`{recoveryCodes[10]}`"), ("401", "MFA_INVALID_CODE"), ("409", "MFA_NOT_ENABLED"), ("423", "MFA_LOCKED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
]))

G.append(("Catálogo público y perfil", "Lecturas sin sesión para el registro y recursos del propio usuario bajo `/me`.", [
 ("GET", "/public/careers", "P", [], "Carreras no eliminadas.", [("200", "Lista de carreras")]),
 ("GET", "/public/careers/{carreraId}/courses", "P", [("carreraId", "ruta", CUID, "Sí", "Carrera.")], "Cursos no eliminados de la carrera.", [("200", "Lista de cursos")]),
 ("GET", "/public/subjects/search", "P", [("q", "consulta", "string", "No", "Texto en código o nombre; máximo 100 caracteres.")],
  "Asignaturas activas (sin ancestro eliminado), con sus grupos y su curso; máximo 20.", [("200", "Lista de asignaturas")]),
 ("GET", "/subjects/{asignaturaId}/groups", "W, S+U", [("asignaturaId", "ruta", CUID, "Sí", "Asignatura activa.")],
  "Grupos de la asignatura ordenados por nombre, sin pasar por la administración (EP-C-14).", [("200", "`[{id, nombre}]`"), ("400", "Identificador inválido"), ("404", "NOT_FOUND")]),
 ("GET", "/me/expediente", "W, S+U", [], "Asignaturas activas del expediente con grupos y curso.", [("200", "Lista de asignaturas")]),
 ("POST", "/me/expediente", "W, S+U · I", [("asignaturaId", "cuerpo", CUID, "Sí", "Asignatura activa.")],
  "Añade la asignatura al expediente; si ya estaba, no cambia nada.", [("201", "Añadida"), ("200", "Ya estaba"), ("404", "Asignatura inexistente"), ("422", "IDEMPOTENCY_CONFLICT")]),
 ("DELETE", "/me/expediente/{asignaturaId}", "W, S+U", [("asignaturaId", "ruta", CUID, "Sí", "Asignatura.")],
  "Quita la asignatura del expediente.", [("200", "Eliminada"), ("400", "Identificador inválido")]),
 ("GET", "/me/notification-preferences", "W, S+U", [], "Preferencias por canal.",
  [("200", "`{email: {enabled, editable: false}, telegram: {enabled, linked, chatMessages}, web: {enabled}}`")]),
 ("PATCH", "/me/notification-preferences", "W, S+U", [
   ("email.enabled", "cuerpo", "boolean", "No", "Solo se admite `true`."),
   ("telegram.enabled", "cuerpo", "boolean", "No", "Activa o silencia la entrega por Telegram."),
   ("telegram.chatMessages", "cuerpo", "boolean", "No", "Si es `false`, no se retransmite cada mensaje de chat.")],
  "Actualiza las preferencias; Telegram requiere identidad vinculada.",
  [("200", "Preferencias resultantes"), ("400", "EMAIL_CHANNEL_REQUIRED"), ("409", "CHANNEL_NOT_LINKED")]),
 ("GET", "/me/channels", "W", [], "Identidades de canal activas del usuario.",
  [("200", "`[{identityId, channel, displayName, linkedAt, lastUsedAt}]`")]),
 ("DELETE", "/me/channels/{identityId}", "W (sesión reciente)", [("identityId", "ruta", CUID, "Sí", "Identidad propia.")],
  "Revoca la identidad y sus sesiones; publica `channel.session.revoked` y registra `CHANNEL_UNLINKED`.",
  [("204", "Desvinculada"), ("401", "REAUTH_REQUIRED"), ("404", "NOT_FOUND")]),
]))

G.append(("Ofertas y chat", "Sin `limit` ni canal, los listados conservan el formato de array de la web; con `limit` (o desde un canal) devuelven `{items, nextCursor}`.", [
 ("GET", "/offers", "W, S+U", [
   ("asignaturaId", "consulta", CUID, "No", "Asignatura de la búsqueda."),
   ("grupoActualId", "consulta", CUID, "No", "Grupo que tiene el buscador."),
   ("grupoDeseadoId", "consulta", CUID, "No", "Grupo que quiere; distinto del actual."),
   ("limit", "consulta", "entero", "No", "1–50; 10 por defecto para canal."),
   ("cursor", "consulta", "string", "No", "Opaco, devuelto como `nextCursor`.")],
  "Ofertas OPEN complementarias, sin entidades eliminadas, de más reciente a más antigua (RF-OFE-04, 05). En modo paginado excluye las propias y no expone el email del creador.",
  [("200", "Array, o `{items, nextCursor}`"), ("400", "Parámetros o cursor inválidos")]),
 ("GET", "/offers/me", "W, S+U", [
   ("status", "consulta", "lista de enum", "No", "OPEN, ACCEPTED, CLOSED, INACTIVE separados por comas."),
   ("role", "consulta", "enum", "No", "`creator`, `acceptor` o `any`."),
   ("limit", "consulta", "entero", "No", "1–50."),
   ("cursor", "consulta", "string", "No", "Opaco.")],
  "Ofertas creadas o aceptadas por el usuario. En modo paginado incluye `isCreator` y la contraparte solo si la oferta está ACCEPTED.",
  [("200", "Array, o `{items, nextCursor}`"), ("400", "Parámetros inválidos")]),
 ("GET", "/offers/{id}", "W", [("id", "ruta", CUID, "Sí", "Oferta.")],
  "Detalle con el historial de mensajes en orden cronológico; solo para creador y aceptante.",
  [("200", "Oferta con mensajes"), ("403", "No es parte"), ("404", "No encontrada")]),
 ("POST", "/offers", "W, S+U · I", [
   ("asignaturaId", "cuerpo", CUID, "Sí", "Asignatura activa."),
   ("grupoActualId", "cuerpo", CUID, "Sí", "Grupo de esa asignatura."),
   ("grupoDeseadoId", "cuerpo", CUID, "Sí", "Grupo de esa asignatura, distinto del actual.")],
  "Publica la oferta OPEN, registra `CREATE_OFFER` y notifica al creador (RF-OFE-07). Exige expediente no vacío.",
  [("201", "Oferta creada"), ("400", "Grupos inválidos o iguales"), ("403", "ACCOUNT_BLOCKED"), ("409", "EXPEDIENTE_REQUIRED"), ("422", "IDEMPOTENCY_CONFLICT")]),
 ("POST", "/offers/{id}/accept", "W, S+U · I", [("id", "ruta", CUID, "Sí", "Oferta OPEN de otro usuario.")],
  "Transición atómica OPEN → ACCEPTED mediante actualización condicional; publica `offer.status.changed` en la misma transacción y notifica a ambas partes con los datos de la contraparte.",
  [("200", "Oferta aceptada"), ("400", "OWN_OFFER"), ("403", "ACCOUNT_BLOCKED"), ("404", "No encontrada"), ("409", "OFFER_NOT_OPEN, EXPEDIENTE_REQUIRED")]),
 ("POST", "/offers/{id}/messages", "W, S+U · I", [
   ("id", "ruta", CUID, "Sí", "Oferta ACCEPTED de la que el usuario es parte."),
   ("content", "cuerpo", "string", "Sí", "1–2000 caracteres tras recortar espacios.")],
  "Revalida pertenencia y estado, persiste el mensaje antes de difundirlo (`offer.message.created`) y notifica a ambas partes.",
  [("201", "`{id, content, timestamp, authorId, author}`"), ("400", "Longitud inválida"), ("403", "No es parte"), ("404", "No encontrada"), ("409", "CHAT_CLOSED")]),
 ("PATCH", "/offers/{id}/close", "W, S+U", [("id", "ruta", CUID, "Sí", "Oferta del creador o del aceptante; o cualquiera para administradores.")],
  "Cierre condicional; publica `offer.status.changed` y registra `CLOSE_OFFER`. Un estado CLOSED es final.",
  [("200", "Oferta cerrada"), ("403", "Sin permiso"), ("404", "No encontrada"), ("409", "OFFER_ALREADY_CLOSED")]),
]))

G.append(("Tickets de soporte", "Solo interfaz web.", [
 ("POST", "/tickets", "W", [
   ("asunto", "cuerpo", "string", "Sí", "3–200 caracteres."),
   ("mensaje", "cuerpo", "string", "No", "Mensaje inicial, 1–2000 caracteres.")],
  "Abre un ticket OPEN y registra `OPEN_TICKET`.", [("201", "Ticket creado"), ("400", "Validación")]),
 ("GET", "/tickets/me", "W", [], "Tickets propios, abiertos y cerrados.", [("200", "Lista")]),
 ("GET", "/tickets/{id}", "W", [("id", "ruta", CUID, "Sí", "Ticket.")], "Detalle y mensajes; para el creador o administradores.", [("200", "Ticket"), ("403", "Sin acceso"), ("404", "No encontrado")]),
 ("PATCH", "/tickets/{id}/close", "W", [("id", "ruta", CUID, "Sí", "Ticket OPEN.")], "Cierra el ticket (creador o administrador); publica `ticket.closed`.",
  [("200", "Ticket cerrado"), ("403", "Sin permiso"), ("404", "No encontrado"), ("409", "Ya cerrado")]),
 ("POST", "/tickets/{id}/messages", "W", [("id", "ruta", CUID, "Sí", "Ticket OPEN."), ("content", "cuerpo", "string", "Sí", "1–2000 caracteres.")],
  "Añade el mensaje; si responde un administrador distinto, pasa a ser el asignado. Notifica a la contraparte.",
  [("201", "Mensaje"), ("403", "Sin acceso"), ("404", "No encontrado"), ("409", "Ticket cerrado")]),
 ("GET", "/tickets/admin/list", "Adm", [
   ("status", "consulta", "enum", "No", "OPEN o CLOSED."),
   ("asuntoFilter", "consulta", "string", "No", "Filtro por asunto."),
   ("userFilter", "consulta", "string", "No", "Filtro por nombre o email.")],
  "Tickets de usuarios del ámbito del administrador (el Propietario, todos).", [("200", "Lista"), ("403", "Sin rol")]),
]))

G.append(("Notificaciones", "Accesibles desde la web y el canal.", [
 ("GET", "/notifications", "W, S+U", [
   ("unread", "consulta", "boolean", "No", "Solo no leídas."),
   ("limit", "consulta", "entero", "No", "1–50."),
   ("cursor", "consulta", "string", "No", "Opaco.")],
  "Notificaciones de más reciente a más antigua. Se mantiene el array; el siguiente cursor viaja en la cabecera `X-Next-Cursor`.",
  [("200", "`[{id, asunto, contenido, isRead, timestamp}]`"), ("400", "Parámetros inválidos")]),
 ("GET", "/notifications/unread-count", "W, S+U", [], "Número de no leídas.", [("200", "`{count}`")]),
 ("PATCH", "/notifications/read-all", "W, S+U", [], "Marca todas como leídas.", [("200", "Hecho")]),
 ("PATCH", "/notifications/{id}/read", "W, S+U", [("id", "ruta", CUID, "Sí", "Notificación propia.")], "Marca una como leída.", [("200", "Hecho"), ("404", "No encontrada")]),
]))

G.append(("Administración", "Requieren sesión web y rol Embajador o Propietario; ninguna ruta admite canal (RF-TGB-11). El ámbito se resuelve desde la jerarquía almacenada, nunca desde datos del cliente.", [
 ("GET", "/admin/careers", "Adm", [], "Carreras.", [("200", "Lista")]),
 ("POST", "/admin/careers", "Prop", [("nombre", "cuerpo", "string", "Sí", "2–200; único.")],
  "Crea la carrera, asigna su ámbito a todos los Propietarios y publica `academic.changed`.", [("201", "Carrera"), ("409", "Nombre duplicado")]),
 ("DELETE", "/admin/careers/{id}", "Prop", [("id", "ruta", CUID, "Sí", "Carrera.")],
  "Borrado lógico; si hay ofertas OPEN o ACCEPTED, las cancela y notifica a los afectados. Registra `DELETE_CARRERA`.",
  [("200", "`{carrera, hasReferences, affectedUsers}`"), ("404", "No encontrada")]),
 ("GET", "/admin/careers/{carreraId}/courses", "Adm (ámbito)", [("carreraId", "ruta", CUID, "Sí", "Carrera del ámbito.")], "Cursos de la carrera.", [("200", "Lista"), ("403", "Fuera de ámbito")]),
 ("POST", "/admin/courses", "Adm (ámbito)", [("carreraId", "cuerpo", CUID, "Sí", "Carrera del ámbito."), ("nombre", "cuerpo", "string", "Sí", "1–100; único en la carrera.")],
  "Crea el curso.", [("201", "Curso"), ("403", "Fuera de ámbito"), ("404", "Carrera inexistente"), ("409", "Duplicado")]),
 ("DELETE", "/admin/courses/{id}", "Adm (ámbito)", [("id", "ruta", CUID, "Sí", "Curso del ámbito.")],
  "Borrado lógico con cancelación de ofertas y notificación si hay referencias.", [("200", "`{curso, hasReferences, affectedUsers}`"), ("403", "Fuera de ámbito"), ("404", "No encontrado")]),
 ("GET", "/admin/courses/{cursoId}/subjects", "Adm (ámbito)", [("cursoId", "ruta", CUID, "Sí", "Curso del ámbito.")], "Asignaturas del curso.", [("200", "Lista"), ("403", "Fuera de ámbito")]),
 ("POST", "/admin/subjects", "Adm (ámbito)", [
   ("cursoId", "cuerpo", CUID, "Sí", "Curso del ámbito."),
   ("nombre", "cuerpo", "string", "Sí", "2–200."),
   ("codigo", "cuerpo", "string", "Sí", "1–20; único global.")],
  "Crea la asignatura.", [("201", "Asignatura"), ("403", "Fuera de ámbito"), ("409", "Código duplicado")]),
 ("DELETE", "/admin/subjects/{id}", "Adm (ámbito)", [("id", "ruta", CUID, "Sí", "Asignatura.")],
  "Borrado lógico con cancelación de ofertas y notificación si hay referencias.", [("200", "`{asignatura, hasReferences, affectedUsers}`"), ("403", "Fuera de ámbito"), ("404", "No encontrada")]),
 ("GET", "/admin/subjects/{asignaturaId}/groups", "Adm (ámbito)", [("asignaturaId", "ruta", CUID, "Sí", "Asignatura.")], "Grupos.", [("200", "Lista"), ("403", "Fuera de ámbito")]),
 ("POST", "/admin/groups", "Adm (ámbito)", [("asignaturaId", "cuerpo", CUID, "Sí", "Asignatura."), ("nombre", "cuerpo", "string", "Sí", "1–50; único en la asignatura.")],
  "Crea el grupo.", [("201", "Grupo"), ("403", "Fuera de ámbito"), ("409", "Duplicado")]),
 ("DELETE", "/admin/groups/{id}", "Adm (ámbito)", [("id", "ruta", CUID, "Sí", "Grupo.")],
  "Borrado lógico con cancelación de ofertas y notificación si hay referencias.", [("200", "`{grupo, hasReferences, affectedUsers}`"), ("403", "Fuera de ámbito"), ("404", "No encontrado")]),
 ("GET", "/admin/users/search", "Adm", [("q", "consulta", "string", "Sí", "Nombre o email; sin distinguir mayúsculas.")],
  "Usuarios del ámbito; máximo 20 (RF-ADM-09).", [("200", "`[{id, name, email, role}]`"), ("400", "Falta `q`")]),
 ("GET", "/admin/users/{userId}/details", "Adm (ámbito)", [("userId", "ruta", CUID, "Sí", "Usuario del ámbito.")],
  "Perfil, últimas 50 acciones y últimos 20 accesos.", [("200", "`{user, logs, loginHistory}`"), ("403", "Fuera de ámbito"), ("404", "No encontrado")]),
 ("GET", "/admin/users/{userId}/logs", "Adm (ámbito)", [
   ("userId", "ruta", CUID, "Sí", "Usuario del ámbito."),
   ("page", "consulta", "entero", "No", "≥ 1; 1 por defecto."),
   ("pageSize", "consulta", "entero", "No", "1–100; 25 por defecto."),
   ("actionFilter", "consulta", "string", "No", "Acción."),
   ("dateFrom, dateTo", "consulta", "fecha", "No", "Rango.")],
  "Log paginado de un usuario.", [("200", "`{logs, total, page, pageSize, totalPages}`"), ("403", "Fuera de ámbito")]),
 ("POST", "/admin/users/block", "Adm (ámbito)", [
   ("targetId", "cuerpo", CUID, "Sí", "Usuario objetivo."),
   ("reason", "cuerpo", "string", "Sí", "3–500 caracteres."),
   ("blockedUntil", "cuerpo", "ISO 8601 | null", "No", "Futura; ausente = permanente.")],
  "Nadie se bloquea a sí mismo ni a un Propietario; un Embajador solo bloquea Estudiantes de su ámbito. En una transacción: rol Bloqueado, revocación del refresh, ofertas OPEN → INACTIVE y evento `account.blocked`. Después revoca las sesiones de canal y registra `BLOCK_USER`.",
  [("200", "Bloqueado"), ("400", "Fecha no futura"), ("403", "No permitido o fuera de ámbito"), ("404", "No encontrado")]),
 ("PATCH", "/admin/users/{id}/unblock", "Adm", [("id", "ruta", CUID, "Sí", "Usuario bloqueado.")],
  "Restaura el rol Estudiante, borra los datos de bloqueo, publica `account.unblocked` y registra `UNBLOCK_USER`.",
  [("200", "Desbloqueado"), ("404", "No encontrado"), ("409", "No estaba bloqueado")]),
 ("PATCH", "/admin/users/{userId}/password", "Adm (ámbito)", [("userId", "ruta", CUID, "Sí", "Usuario."), ("newPassword", "cuerpo", "string", "Sí", "Complejidad RV-03.")],
  "Fuerza la contraseña, revoca la sesión web y lo registra.", [("200", "Actualizada"), ("400", "WEAK_PASSWORD"), ("403", "Fuera de ámbito")]),
 ("POST", "/admin/users/{id}/mfa/reset", "Adm (ámbito)", [("id", "ruta", CUID, "Sí", "Estudiante del ámbito."), ("reason", "cuerpo", "string", "Sí", "10–500 caracteres.")],
  "Borra el factor en el mfa-service, desactiva el MFA, revoca sesiones web y de canal, registra `MFA_RESET` y notifica.",
  [("204", "Restablecido"), ("400", "Motivo inválido"), ("403", "No permitido o fuera de ámbito"), ("404", "No encontrado"), ("409", "MFA_NOT_ENABLED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("GET", "/admin/ambassadors", "Prop", [], "Embajadores con sus ámbitos.", [("200", "Lista")]),
 ("POST", "/admin/ambassadors", "Prop", [("targetId", "cuerpo", CUID, "Sí", "Usuario a promover."), ("scopes", "cuerpo", "array", "Sí", "≥ 1 par `{carreraId, cursoId?}`.")],
  "Promueve a Embajador con su ámbito; registra `PROMOTE_EMBAJADOR`.", [("200", "Promovido"), ("400", "Validación"), ("403", "Objetivo Propietario")]),
 ("DELETE", "/admin/ambassadors/{id}", "Prop", [("id", "ruta", CUID, "Sí", "Embajador.")],
  "Degrada a Estudiante y elimina sus ámbitos; registra `DEMOTE_EMBAJADOR`.", [("200", "Degradado"), ("404", "No encontrado")]),
 ("PATCH", "/admin/ambassadors/scope", "Prop", [("targetId", "cuerpo", CUID, "Sí", "Embajador."), ("scopes", "cuerpo", "array", "Sí", "Nuevo conjunto de pares.")],
  "Reemplaza el ámbito; registra `UPDATE_SCOPE`.", [("200", "Actualizado"), ("400", "Validación")]),
 ("GET", "/admin/logs", "Adm", [
   ("actionFilter", "consulta", "string", "No", "Acción."),
   ("userFilter", "consulta", "string", "No", "Nombre o email."),
   ("dateFrom, dateTo", "consulta", "fecha", "No", "Rango."),
   ("page", "consulta", "entero", "No", "≥ 1."),
   ("pageSize", "consulta", "entero", "No", "1–200; 50 por defecto.")],
  "Log paginado limitado al ámbito del solicitante (RF-LOG-04).", [("200", "`{logs, total, page, pageSize, totalPages}`")]),
]))

G.append(("Canales externos y servicios", "Consumidos por el bot de Telegram (S, S+U) y por la página de aprobación de la web (W). `/service-auth` e `/internal` no se publican en Nginx.", [
 ("POST", "/service-auth/token", "Interno", [
   ("grant_type", "cuerpo", "literal", "Sí", "`client_credentials`."),
   ("client_id", "cuerpo", "string", "Sí", "Cliente registrado."),
   ("client_secret", "cuerpo", "string", "Sí", "≥ 32 caracteres; el core guarda solo su SHA-256."),
   ("scope", "cuerpo", "string", "No", "Subconjunto de los permitidos, separados por espacios.")],
  "Emite un JWT de servicio ES256 de 10 min con `iss`, `sub`, `aud`, `scope`, `jti` y `kid`.",
  [("200", "`{access_token, token_type, expires_in: 600, scope}`"), ("400", "INVALID_SCOPE"), ("401", "SERVICE_UNAUTHORIZED"), ("429", "RATE_LIMITED")]),
 ("GET", "/internal/.well-known/jwks.json", "Interno", [], "Claves públicas del core para verificar JWT de servicio.", [("200", "`{keys: [JWK]}`")]),
 ("POST", "/channel-auth/link-requests", "S", [
   ("channel", "cuerpo", "enum", "Sí", "`telegram`; debe coincidir con el scope."),
   ("externalUserId", "cuerpo", "string", "Sí", "`from.id` decimal, 1–20 dígitos."),
   ("displayName", "cuerpo", "string", "Sí", "1–100, sin caracteres de control."),
   ("username", "cuerpo", "string", "No", "5–32 caracteres.")],
  "Crea una solicitud de vinculación de 10 min (hash del `deviceCode`, `userCode` sin caracteres ambiguos). Límite: 5 por identidad y hora.",
  [("201", "`{deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn: 600, interval: 5}`"), ("400", "VALIDATION_ERROR"), ("401, 403", "Credencial de servicio"), ("429", "RATE_LIMITED")]),
 ("GET", "/channel-links/{userCode}", "W", [("userCode", "ruta", "string", "Sí", "8 caracteres, con o sin guion, sin distinguir mayúsculas.")],
  "Datos para que el usuario reconozca la solicitud.", [("200", "`{channel, displayName, username, requestedAt, expiresAt, status}`"), ("404", "LINK_NOT_FOUND"), ("409", "LINK_ALREADY_DECIDED"), ("410", "LINK_EXPIRED")]),
 ("POST", "/channel-links/{userCode}/decision", "W (sesión reciente)", [("userCode", "ruta", "string", "Sí", "Como en la consulta."), ("decision", "cuerpo", "enum", "Sí", "`approve` o `deny`.")],
  "Al aprobar, revoca la identidad previa del usuario en el canal, crea la nueva, publica `channel.link.approved`, registra `CHANNEL_LINKED` y avisa por correo.",
  [("200", "`{status: APPROVED | DENIED}`"), ("401", "REAUTH_REQUIRED"), ("404", "LINK_NOT_FOUND"), ("409", "LINK_ALREADY_DECIDED, CHANNEL_IDENTITY_TAKEN"), ("410", "LINK_EXPIRED")]),
 ("POST", "/channel-auth/token", "S", [
   ("grant_type", "cuerpo", "enum", "Sí", "`link_code`, `email_otp`, `registration_otp`, `mfa`, `refresh_token`."),
   ("channel", "cuerpo", "enum", "Sí", "`telegram`."),
   ("externalUserId", "cuerpo", "string", "Sí", "Debe coincidir con el de la solicitud o el reto."),
   ("deviceCode", "cuerpo", "string", "Cond.", "Para `link_code`."),
   ("challengeToken", "cuerpo", "string", "Cond.", "Para `email_otp`, `registration_otp` y `mfa`."),
   ("code", "cuerpo", "string", "Cond.", "OTP de 6 dígitos o código XOTP."),
   ("recoveryCode", "cuerpo", "string", "Cond.", "Para `mfa`; excluyente con `code`."),
   ("refreshToken", "cuerpo", "string", "Cond.", "Para `refresh_token`; 43 caracteres base64url.")],
  "Endpoint único de emisión y renovación de sesiones de canal. Si la cuenta tiene MFA, `email_otp` solo devuelve un reto. El refresco rota el token; reutilizar uno rotado revoca toda la familia.",
  [("200", "Sesión `{accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresIn, session, user}`, o `{mfaRequired, challengeToken, expiresIn, methods}`"),
   ("400", "AUTHORIZATION_PENDING, SLOW_DOWN, INVALID_GRANT"), ("401", "MFA_INVALID_CODE"), ("403", "ACCESS_DENIED, ACCOUNT_BLOCKED"), ("409", "CHANNEL_IDENTITY_TAKEN"), ("410", "EXPIRED_TOKEN"), ("423", "MFA_LOCKED"), ("503", "MFA_SERVICE_UNAVAILABLE")]),
 ("POST", "/channel-auth/email-otp", "S", [
   ("channel", "cuerpo", "enum", "Sí", "`telegram`."),
   ("externalUserId", "cuerpo", "string", "Sí", "`from.id`."),
   ("email", "cuerpo", "string", "Sí", "Dominio institucional; se normaliza a minúsculas.")],
  "Crea un reto de 10 min (5 intentos) y envía el OTP si la cuenta existe; la respuesta es idéntica en ambos casos. Límites: 3 por email y 15 min; 5 por identidad y hora.",
  [("202", "`{challengeToken, expiresIn: 600, codeLength: 6}`"), ("400", "INVALID_EMAIL_DOMAIN"), ("429", "RATE_LIMITED")]),
 ("POST", "/channel-auth/register", "S · I", [
   ("channel", "cuerpo", "enum", "Sí", "`telegram`."),
   ("externalUserId", "cuerpo", "string", "Sí", "No vinculado."),
   ("name", "cuerpo", "string", "Sí", "2–100."),
   ("email", "cuerpo", "string", "Sí", "Institucional y único."),
   ("carreraId", "cuerpo", CUID, "Sí", "Carrera activa."),
   ("cursoId", "cuerpo", CUID, "Sí", "Curso de la carrera."),
   ("acceptTerms", "cuerpo", "boolean", "Sí", "Debe ser `true`.")],
  "Reutiliza el alta pendiente con origen TELEGRAM y sin contraseña; el canje posterior (`registration_otp`) crea usuario, identidad y sesión.",
  [("202", "`{challengeToken, expiresIn: 1800, codeLength: 6}`"), ("400", "VALIDATION_ERROR, INVALID_EMAIL_DOMAIN"), ("409", "EMAIL_TAKEN, CHANNEL_IDENTITY_TAKEN"), ("422", "IDEMPOTENCY_CONFLICT"), ("429", "RATE_LIMITED")]),
 ("POST", "/channel-auth/revoke", "S+U", [("scope", "cuerpo", "enum", "No", "`session` (defecto) o `identity`.")],
  "Revoca la sesión actual o desvincula la identidad con todas sus sesiones; publica `channel.session.revoked`.",
  [("204", "Revocada"), ("401", "Sesión no válida")]),
 ("GET", "/health", "P", [("deep", "consulta", "boolean", "No", "Desde la red interna incluye dependencias.")],
  "Estado y marca de tiempo (la app XOTP la usa para detectar deriva de reloj). Disponible también en `/api/v1/health`.",
  [("200", "`{status, timestamp, dependencies?: {db, redis, mfa}}`")]),
]))


def endpoint_block(m, ruta, acceso, params, logica, resp):
    color = {"GET": "verbget", "POST": "verbpost", "PATCH": "verbpatch", "DELETE": "verbdelete"}[m]
    s = [r"\begin{apiendpoint}{\verbo{%s}{%s}\ \texttt{%s}}{%s}" % (color, m, esc(ruta).replace("/", r"/\allowbreak{}"), esc(acceso))]
    if params:
        s.append(r"\begin{tabularx}{\linewidth}{@{}>{\ttfamily\raggedright}p{3.0cm}p{1.35cm}p{1.9cm}p{0.9cm}X@{}}")
        s.append(r"\toprule \normalfont\bfseries Parámetro & \bfseries Dónde & \bfseries Tipo & \bfseries Obl. & \bfseries Descripción y validación\\ \midrule")
        for (n, d, t, o, desc) in params:
            s.append(r"%s & %s & %s & %s & %s\\" % (esc(n), esc(d), esc(t), esc(o), esc(desc)))
        s.append(r"\bottomrule\end{tabularx}")
    else:
        s.append(r"\textit{Sin parámetros.}")
    s.append(r"\par\smallskip\textbf{Lógica.} " + esc(logica))
    s.append(r"\par\smallskip\textbf{Respuestas.} " + "; ".join(r"\textbf{%s} %s" % (esc(c), esc(d)) for c, d in resp) + ".")
    s.append(r"\end{apiendpoint}")
    return "\n".join(s)


api_parts = []
n_ep = 0
resumen = []
for titulo, intro, eps in G:
    api_parts.append(r"\subsection{%s}" % esc(titulo) + "\n" + esc(intro) + "\n")
    for e in eps:
        n_ep += 1
        api_parts.append(endpoint_block(*e))
        resumen.append((e[0], e[1], e[2], titulo))

resumen_rows = "\n".join(r"%s & \texttt{%s} & %s & %s\\" % (m, esc(r).replace("/", r"/\allowbreak{}"), esc(a), esc(t)) for m, r, a, t in resumen)
actores_rows = "\n".join(r"%s & %s & %s & %s\\" % tuple(esc(x) for x in a) for a in ACTORES)
cu_rows = "\n".join(r"%s & %s & %s & %s & %s\\" % tuple(esc(x) for x in c) for c in CU)


def fig(name, caption, width=r"\linewidth", rotate=False):
    if rotate:
        return (r"\begin{sidewaysfigure}\centering\includegraphics[width=\textheight,height=0.85\textwidth,keepaspectratio]{img/%s.png}" % name
                + r"\caption{%s}\label{fig:%s}\end{sidewaysfigure}" % (caption, name))
    return (r"\begin{figure}[H]\centering\includegraphics[width=%s,height=0.80\textheight,keepaspectratio]{img/%s.png}" % (width, name)
            + r"\caption{%s}\label{fig:%s}\end{figure}" % (caption, name))


fuentes = []
for path in sorted(glob.glob(os.path.join(BASE, "diagramas", "*.puml"))):
    name = os.path.basename(path)
    fuentes.append(r"\subsection*{\texttt{%s}}" % esc(name) + "\n" + r"\lstinputlisting[language=plantuml]{diagramas/%s}" % name)
fuentes.insert(0, r"\subsection*{\texttt{\_estilo.iuml}}" + "\n" + r"\lstinputlisting[language=plantuml]{diagramas/_estilo.iuml}")

TEX = r"""\documentclass[11pt,a4paper]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[spanish,es-noshorthands,es-tabla]{babel}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage[a4paper,margin=2.2cm,headheight=14pt]{geometry}
\usepackage{graphicx}
\usepackage{float}
\usepackage{rotating}
\usepackage{xcolor}
\usepackage{booktabs}
\usepackage{amssymb}
\usepackage{tabularx}
\usepackage{longtable}
\usepackage{array}
\usepackage{titlesec}
\usepackage{fancyhdr}
\usepackage{enumitem}
\usepackage{listings}
\usepackage{caption}
\usepackage[most]{tcolorbox}
\usepackage[hidelinks,bookmarksnumbered]{hyperref}

\definecolor{marca}{HTML}{8B1E3F}
\definecolor{tinta}{HTML}{1F2933}
\definecolor{suave}{HTML}{F7F2F4}
\definecolor{verbget}{HTML}{1F6F43}
\definecolor{verbpost}{HTML}{1D4E89}
\definecolor{verbpatch}{HTML}{8A5A00}
\definecolor{verbdelete}{HTML}{9B1C1C}

\titleformat{\chapter}[display]{\normalfont\bfseries\color{marca}}{\large\MakeUppercase{\chaptertitlename}\ \thechapter}{4pt}{\Huge}
\titlespacing*{\chapter}{0pt}{-10pt}{16pt}
\titleformat{\section}{\normalfont\Large\bfseries\color{tinta}}{\thesection}{0.8em}{}
\titleformat{\subsection}{\normalfont\large\bfseries\color{marca}}{\thesubsection}{0.8em}{}

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{gray}xChanger --- Modelos de Requisitos y Arquitectura}
\fancyhead[R]{\small\color{gray}v1.0}
\fancyfoot[C]{\small\thepage}

\captionsetup{font=small,labelfont=bf}
\setlength{\parskip}{0.45em}
\setlength{\parindent}{0pt}

\newcommand{\verbo}[2]{\colorbox{#1}{\textcolor{white}{\ttfamily\bfseries\small #2}}}
\newtcolorbox{apiendpoint}[2]{enhanced,breakable,colback=white,colframe=marca!45,colbacktitle=suave,
  coltitle=tinta,fonttitle=\small,title={#1\hfill\textnormal{\footnotesize Acceso: #2}},
  boxrule=0.5pt,arc=1.5pt,left=5pt,right=5pt,top=4pt,bottom=4pt,before skip=7pt,after skip=7pt,fontupper=\small}

% PlantUML en listings (con caracteres españoles y guillemets)
\lstdefinelanguage{plantuml}{
  morekeywords={@startuml,@enduml,actor,participant,database,usecase,rectangle,package,class,enum,component,interface,node,note,end,alt,else,opt,loop,par,group,autonumber,title,left,right,top,bottom,of,as,state,skinparam,hide,include},
  sensitive=true, morecomment=[l]{'}, morestring=[b]"}
\lstset{basicstyle=\ttfamily\scriptsize,keywordstyle=\color{marca}\bfseries,commentstyle=\color{gray},
  stringstyle=\color{verbpost},breaklines=true,columns=fullflexible,frame=single,rulecolor=\color{gray!40},
  backgroundcolor=\color{suave},extendedchars=true,
  literate={á}{{\'a}}1 {é}{{\'e}}1 {í}{{\'i}}1 {ó}{{\'o}}1 {ú}{{\'u}}1 {ñ}{{\~n}}1
           {Á}{{\'A}}1 {É}{{\'E}}1 {Í}{{\'I}}1 {Ó}{{\'O}}1 {Ú}{{\'U}}1 {Ñ}{{\~N}}1 {ü}{{\"u}}1
           {«}{{\guillemotleft}}1 {»}{{\guillemotright}}1 {—}{{---}}1 {–}{{--}}1 {×}{{$\times$}}1
           {¿}{{?`}}1 {¡}{{!`}}1 {§}{{\S}}1 {→}{{$\rightarrow$}}1 {↔}{{$\leftrightarrow$}}1}

\begin{document}

\begin{titlepage}
\centering
\vspace*{3cm}
{\color{marca}\rule{\linewidth}{1pt}}\\[0.6cm]
{\Huge\bfseries xChanger\\[0.3cm]}
{\LARGE Modelos de Requisitos y Arquitectura\\[0.3cm]}
{\large Casos de uso, dominio, acciones, componentes y especificación de la API}\\[0.4cm]
{\color{marca}\rule{\linewidth}{1pt}}\\[2cm]
\begin{tabular}{@{}ll@{}}
\toprule
Proyecto & xChangerMejorado \\
Notación & UML 2.5 (diagramas generados con PlantUML), OCL 2.4 para restricciones \\
Documentos base & Requisitos v1.0; Arquitectura v1.0; Escalado v1.0 \\
Alcance de la API & Core: """ + str(n_ep) + r""" endpoints de \texttt{/api/v1} \\
Fecha & Noviembre de 2026 \\
Versión & 1.0 \\
\bottomrule
\end{tabular}
\vfill
{\small Este documento complementa la Especificación de Requisitos: no repite los requisitos, los modela. Los identificadores RF-, RA-, RNF-, CA- remiten a Requisitos v1.0; ADR-16+, EP-, RF-TGB- y RF-MFA- al documento de Escalado.}
\end{titlepage}

\tableofcontents

%════════════════════════════════════════════════════════════════════
\chapter{Introducción}

\section{Propósito y alcance}
Este documento reúne los modelos que el equipo necesita para construir y mantener xChanger: qué hace el sistema para cada actor y por cada interfaz, qué información maneja, cómo se comporta como caja negra en los flujos críticos, cómo se descompone en componentes y cómo colaboran estos, y el contrato completo de la API del core.

El sistema modelado es la plataforma xChanger tras el escalado: el \emph{core} (monolito modular Express + Prisma + Socket.io), el frontend Astro, y dos microservicios satélite, el bot de Telegram y el mfa-service. Los modelos de requisitos tratan la plataforma como una unidad; los de arquitectura la abren.

\section{Convenciones de notación}
\begin{itemize}[leftmargin=*,itemsep=1pt]
\item \textbf{Casos de uso.} El rectángulo es el sujeto (el sistema). Los actores primarios están a la izquierda y los secundarios (estereotipo \guillemotleft sistema\guillemotright) a la derecha. Las asociaciones actor–caso de uso no tienen dirección. \guillemotleft include\guillemotright{} apunta del caso base al incluido; \guillemotleft extend\guillemotright{} apunta del caso extensor al base e indica su condición entre llaves.
\item \textbf{Clases.} Modelo conceptual: sin claves foráneas ni detalles de persistencia. Composición (rombo relleno) cuando la parte no existe sin el todo; asociación navegable cuando solo interesa un sentido. Las restricciones que el diagrama no puede expresar se escriben en OCL.
\item \textbf{Secuencia.} Los diagramas de sistema (DSS) muestran \texttt{:xChanger} como una sola línea de vida. Los internos (DSI) usan instancias anónimas de componentes (\texttt{:Nombre}). Los mensajes asíncronos usan punta abierta; los fragmentos \texttt{alt}, \texttt{opt}, \texttt{loop}, \texttt{par} y \texttt{group} siguen UML 2.5.
\item \textbf{Componentes.} Interfaz proporcionada: piruleta unida al componente. Interfaz requerida: dependencia \guillemotleft use\guillemotright{} hacia la interfaz. \guillemotleft delegate\guillemotright{} conecta un subcomponente con la interfaz que expone su contenedor.
\end{itemize}
Las fuentes PlantUML de todos los diagramas están en el Apéndice~\ref{ap:fuentes}.

%════════════════════════════════════════════════════════════════════
\chapter{Modelos de requisitos}

\section{Modelo de casos de uso}

\subsection{Actores}
\begin{center}\small
\begin{tabularx}{\linewidth}{@{}p{3.6cm}p{2.6cm}p{2.3cm}X@{}}
\toprule
Actor & Tipo & Interfaz & Descripción \\
\midrule
""" + actores_rows + r"""
\bottomrule
\end{tabularx}
\end{center}
La generalización Estudiante $\leftarrow$ Embajador $\leftarrow$ Propietario hace que cada actor herede los casos de uso de su ancestro, de acuerdo con la matriz de roles (Tabla 6 de Requisitos). El rol Bloqueado no es un actor: es un estado del Estudiante que le impide iniciar cualquier caso de uso.

\subsection{Interfaz web: visitante y acceso}
""" + fig("uc01-web-visitante", "Casos de uso de acceso desde la web.", r"0.75\linewidth") + r"""

\subsection{Interfaz web: estudiante}
""" + fig("uc02-web-estudiante", "Casos de uso del estudiante en la web.", r"0.68\linewidth") + r"""

\subsection{Interfaz web: administración}
""" + fig("uc03-web-administracion", "Casos de uso de administración. Un Propietario hereda todos los del Embajador.", r"0.70\linewidth") + r"""

\subsection{Interfaz Telegram}
""" + fig("uc04-telegram", "Casos de uso por el bot de Telegram. UC-44 se realiza en la web, por eso aparece incluido.", r"0.62\linewidth") + r"""

\subsection{Interfaz de servicios (máquina a máquina)}
""" + fig("uc05-api-servicios", "Casos de uso de la API de servicios. El sujeto es el core.", r"0.75\linewidth") + r"""

\subsection{Catálogo de casos de uso}
\begin{center}\small
\begin{longtable}{@{}lp{6.0cm}p{3.2cm}p{1.7cm}p{3.0cm}@{}}
\toprule
ID & Caso de uso & Actor primario & Interfaz & Trazabilidad \\
\midrule
\endhead
""" + cu_rows + r"""
\bottomrule
\end{longtable}
\end{center}

\section{Modelo de dominio}
El modelo se divide en tres vistas que comparten las clases \texttt{Usuario}, \texttt{Carrera} y \texttt{Curso}. Los atributos usan tipos conceptuales (\texttt{Email}, \texttt{Hash}, \texttt{FechaHora}); los identificadores se omiten porque toda clase tiene identidad propia.

""" + fig("dom01-academico-ofertas", "Estructura académica (composición estricta Carrera ◆ Curso ◆ Asignatura ◆ Grupo), expediente, ofertas y mensajería.".replace("◆", r"$\blacklozenge$")) + r"""

\paragraph{Decisiones de modelado.}
\begin{itemize}[leftmargin=*,itemsep=1pt]
\item La jerarquía académica es \textbf{composición}: un grupo no existe fuera de su asignatura. El borrado es lógico, pero conceptualmente el ciclo de vida de las partes depende del todo (RF-ACA-04).
\item \texttt{Mensaje} es compartido por \texttt{Oferta} y \texttt{Ticket}; UML no puede expresar gráficamente que exactamente uno de los dos sea el todo, así que se declara con OCL (\texttt{unSoloPadre}).
\item El expediente es una asociación muchos a muchos sin atributos propios relevantes, por lo que no se eleva a clase.
\item \texttt{Oferta} se asocia dos veces con \texttt{Grupo} con roles distintos; la pertenencia de ambos a la asignatura de la oferta es una restricción OCL.
\end{itemize}

""" + fig("dom02-identidad-seguridad", "Identidad, ámbito de administración, notificaciones y auditoría.") + r"""
""" + fig("dom03-canales-eventos", "Canales externos, retos, eventos y el factor XOTP custodiado por el mfa-service.", r"0.92\linewidth") + r"""

\paragraph{Frontera de datos.} El paquete \emph{Custodiado por mfa-service} se muestra por completitud, pero sus clases no pertenecen al sistema de información del core (principio \emph{cada servicio es dueño de sus datos}). El core solo conoce el estado \texttt{mfaActivo} del usuario (ADR-28) y se relaciona con el factor mediante una dependencia por identificador (\texttt{subjectId}).

""" + fig("dom04-enumeraciones", "Enumeraciones del dominio.", r"0.45\linewidth") + r"""
""" + fig("st01-oferta", "Máquina de estados del ciclo de vida de una oferta.", r"0.85\linewidth") + r"""

\section{Modelo de acciones (diagramas de secuencia del sistema)}
Cada diagrama trata xChanger como caja negra y muestra solo los mensajes que cruzan su frontera. Se han elegido los flujos con mayor riesgo funcional o de seguridad.

""" + fig("ssd01-registro", "DSS-01: registro con verificación OTP.", r"0.72\linewidth") + r"""
""" + fig("ssd02-login-mfa", "DSS-02: inicio de sesión con segundo factor.", r"0.80\linewidth") + r"""
""" + fig("ssd03-intercambio", "DSS-03: búsqueda, aceptación y chat de una oferta.", r"0.82\linewidth") + r"""
""" + fig("ssd04-bloqueo", "DSS-04: bloqueo de un usuario y su efecto inmediato.", r"0.80\linewidth") + r"""
""" + fig("ssd05-vinculacion", "DSS-05: vinculación de Telegram por código de dispositivo.", r"0.70\linewidth") + r"""
""" + fig("ssd06-activar-mfa", "DSS-06: activación del segundo factor.", r"0.80\linewidth") + r"""

%════════════════════════════════════════════════════════════════════
\chapter{Arquitectura del sistema}

\section{Modelo de componentes}
""" + fig("comp01-sistema", "Componentes del sistema, interfaces proporcionadas y requeridas.") + r"""

\begin{center}\small
\begin{tabularx}{\linewidth}{@{}p{3.4cm}p{3.2cm}X@{}}
\toprule
Interfaz & Proveedor & Consumidores y contrato \\
\midrule
API REST \texttt{/api/v1} & Core & Frontend (navegador y SSR), telegram-bot (S+U). Capítulo~\ref{cap:api}. \\
Socket.io & Core & Navegador: salas \texttt{user:}, \texttt{offer:}, \texttt{ticket:} (RE-WS). \\
Autenticación de servicios & Core & telegram-bot: \texttt{client\_credentials} → JWT ES256. \\
JWKS interno & Core & mfa-service: valida los JWT del core. \\
Streams & Redis & Core (productor del outbox), bot y consumidores internos (grupos de consumo). \\
API XOTP (EP-M) & mfa-service & Core: enrolar, verificar, recuperar, revocar. \\
Webhook Telegram & telegram-bot & Telegram Bot API, a través de Nginx. \\
\bottomrule
\end{tabularx}
\end{center}

""" + fig("comp02-core", "Estructura interna del core por capas.") + r"""

\paragraph{Reglas de dependencia.} Las flechas \guillemotleft use\guillemotright{} solo descienden de capa. Los servicios dependen de las interfaces \texttt{Repositorio}, \texttt{EventPublisher} y \texttt{MfaGateway}, no de sus implementaciones; esto permite sustituir el cliente del mfa-service por un doble en las pruebas y que ningún servicio conozca Socket.io (AR-04).

\section{Interacción de componentes}
""" + fig("seq01-aceptar-oferta", "DSI-01: aceptación atómica de una oferta y difusión por el bus de eventos.", rotate=True) + r"""
""" + fig("seq02-login-mfa", "DSI-02: inicio de sesión web con segundo factor.", rotate=True) + r"""
""" + fig("seq03-peticion-bot", "DSI-03: petición del bot en nombre del usuario, con política de canal e idempotencia.", rotate=True) + r"""
""" + fig("seq04-vinculacion", "DSI-04: vinculación por autorización de dispositivo.", rotate=True) + r"""
""" + fig("seq05-refresco-canal", "DSI-05: refresco de sesión de canal con rotación y detección de reutilización.", r"0.85\linewidth") + r"""
""" + fig("seq06-bloqueo", "DSI-06: bloqueo de usuario, con la revocación antes del aviso.", rotate=True) + r"""

%════════════════════════════════════════════════════════════════════
\chapter{Especificación completa de la API}\label{cap:api}

\section{Convenciones comunes}
\begin{itemize}[leftmargin=*,itemsep=1pt]
\item \textbf{Base.} Todas las rutas cuelgan de \texttt{/api/v1}; \texttt{/api} es un alias para el frontend actual. \texttt{Content-Type: application/json}; cuerpo máximo 50~KB.
\item \textbf{Acceso.} P: público. W: sesión web por cookie. S: credencial de servicio en \texttt{X-Service-Authorization: Bearer}. S+U: servicio más \texttt{Authorization: Bearer} con token de canal. Adm: Embajador o Propietario, con comprobación de ámbito cuando se indica. Prop: solo Propietario. I: admite \texttt{Idempotency-Key} (UUID o \texttt{tg:<update\_id>}), obligatoria para clientes de canal.
\item \textbf{Política de canal.} Una ruta solo admite clientes de canal si su acceso incluye S+U; si no, responde 403 \texttt{CHANNEL\_FORBIDDEN\_ROUTE}. Enviar cookie y cabecera de servicio a la vez da 400 \texttt{AMBIGUOUS\_CREDENTIALS}.
\item \textbf{Identificadores.} Los \texttt{*Id} son CUID y se validan antes de usarse.
\item \textbf{Paginación.} Cursor opaco por \texttt{(createdAt, id)} descendente.
\item \textbf{Trazabilidad.} \texttt{X-Request-Id} se devuelve siempre y se propaga a log y eventos.
\end{itemize}

\paragraph{Contrato de error.} Todas las respuestas de error tienen la forma:
\begin{lstlisting}[language={},basicstyle=\ttfamily\small]
{ "error": "Mensaje legible en español",
  "code": "CODIGO_ESTABLE",
  "requestId": "01JC9...",
  "details": { "retryAfter": 30, "remainingAttempts": 3 } }
\end{lstlisting}
\paragraph{Respuestas comunes.} Además de las indicadas en cada endpoint, cualquiera puede devolver: 400 \texttt{VALIDATION\_ERROR} (esquema), 401 \texttt{UNAUTHORIZED}/\texttt{TOKEN\_EXPIRED}/\texttt{INVALID\_TOKEN} (rutas autenticadas), 403 \texttt{ACCOUNT\_BLOCKED} o \texttt{FORBIDDEN}, 413 \texttt{PAYLOAD\_TOO\_LARGE}, 429 \texttt{RATE\_LIMITED} con \texttt{Retry-After}, y 500 \texttt{INTERNAL\_ERROR} sin detalles internos.

\section{Resumen de endpoints}
\begin{center}\small
\begin{longtable}{@{}lp{7.3cm}p{2.8cm}p{3.4cm}@{}}
\toprule
Método & Ruta & Acceso & Grupo \\
\midrule
\endhead
""" + resumen_rows + r"""
\bottomrule
\end{longtable}
\end{center}

\section{Detalle por endpoint}
""" + "\n".join(api_parts) + r"""

%════════════════════════════════════════════════════════════════════
\appendix
\chapter{Fuentes PlantUML de los diagramas}\label{ap:fuentes}
Los diagramas se generan con PlantUML 1.2024.7 a partir de estas fuentes (carpeta \texttt{docs/modelos/diagramas}). Para regenerarlos:
\begin{lstlisting}[language={},basicstyle=\ttfamily\small]
docker run --rm -e PLANTUML_LIMIT_SIZE=8192 -v "$PWD":/data -w /data \
  plantuml/plantuml:1.2024.7 -tpng -o /data/img "diagramas/*.puml"
\end{lstlisting}
""" + "\n".join(fuentes) + r"""

\end{document}
"""

with open(OUT, "w") as f:
    f.write(TEX)
print(f"OK: {n_ep} endpoints, {len(CU)} casos de uso -> {OUT}")
