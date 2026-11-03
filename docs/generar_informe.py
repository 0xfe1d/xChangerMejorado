# Genera docs/informe-testing-despliegue.tex a partir de un inventario estructurado
# de las pruebas reales del core. Cada entrada: (nombre, fichero, requisito,
# explicación del requisito, escenario, resultado esperado).
import re, sys

OUT = sys.argv[1]

def esc(s: str) -> str:
    """Escapa texto plano para LaTeX; `...` se convierte en \\texttt{...}."""
    parts = re.split(r"(`[^`]+`)", s)
    out = []
    for p in parts:
        code = p.startswith("`") and p.endswith("`") and len(p) > 1
        t = p[1:-1] if code else p
        t = (t.replace("\\", r"\textbackslash{}")
              .replace("&", r"\&").replace("%", r"\%").replace("$", r"\$")
              .replace("#", r"\#").replace("_", r"\_").replace("{", r"\{")
              .replace("}", r"\}").replace("~", r"\textasciitilde{}")
              .replace("^", r"\textasciicircum{}")
              .replace("→", r"$\rightarrow$").replace("±", r"$\pm$")
              .replace("≤", r"$\leq$").replace("≥", r"$\geq$")
              .replace("↔", r"$\leftrightarrow$").replace("×", r"$\times$")
              .replace("§", r"\S{}"))
        if code:
            t = r"\texttt{" + t.replace("/", r"/\allowbreak{}").replace(".", r".\allowbreak{}") + "}"
        out.append(t)
    return "".join(out)

# ─────────────────────────────────────────────────────────────────────────────
# INVENTARIO. Las secciones agrupan por tipo y fichero; los nombres son los
# títulos literales de los casos de prueba.
# ─────────────────────────────────────────────────────────────────────────────
U, I, E = "Unitaria", "Integración", "E2E (Cypress)"

SUITES = [
# ═════════════════════════════ UNITARIAS ═════════════════════════════
(U, "Utilidades de paginación, vinculación, criptografía y formato", "test/unit/utils.test.ts", [
 ("codifica y decodifica createdAt + id de forma opaca",
  "Escalado §5.6 (paginación por cursor), EP-C-12, EP-C-13",
  "El escalado exige que los listados admitan `limit` y `cursor` opacos para clientes no web. Un cursor que expusiera identificadores internos permitiría manipular la paginación; por eso se exige que el cursor sea opaco y reversible solo por el servidor.",
  "Se codifica la posición `{createdAt, id}` de un elemento y se decodifica de nuevo.",
  "El cursor no contiene el identificador en claro y la decodificación devuelve exactamente la posición original."),
 ("devuelve null ante cursores manipulados",
  "Escalado §5.6; RV-05 (validación de identificadores)",
  "Un cursor es entrada del cliente y, por RNF-01, toda entrada debe validarse. Si un cursor alterado se aceptara, podría provocar errores internos o consultas no previstas.",
  "Se decodifican un texto que no es base64 y un JSON con tipos incorrectos.",
  "La función devuelve `null` en ambos casos; el controlador lo traduce a 400."),
 ("genera la condición \"después de\" para orden descendente estable",
  "RF-OFE-05 y RF-OFE-11 (orden de más reciente a más antigua); escalado §5.6",
  "Los requisitos originales fijan el orden descendente por fecha. Con cursor, dos ofertas creadas en el mismo instante podrían repetirse u omitirse entre páginas; el desempate por `id` garantiza un orden total.",
  "Se genera la condición de Prisma para una posición dada y para ausencia de cursor.",
  "Se obtiene `createdAt < t OR (createdAt = t AND id < i)`; sin cursor, una condición vacía."),
 ("usa 8 caracteres del alfabeto sin ambigüedades",
  "Escalado §6.4 (userCode de vinculación), EP-C-03",
  "El código que el estudiante teclea en la web debe ser legible y difícil de confundir. El diseño fija 8 caracteres de un alfabeto sin 0, 1, O ni I.",
  "Se generan 200 códigos aleatorios.",
  "Todos tienen longitud 8, pertenecen al alfabeto definido y no contienen caracteres ambiguos."),
 ("se muestra con guion y se normaliza sin distinguir mayúsculas",
  "Escalado §6.4; EP-C-04 (\"con o sin guion; insensible a mayúsculas\")",
  "EP-C-04 especifica que el `userCode` se acepta con o sin guion y sin distinguir mayúsculas, porque el usuario lo copia a mano desde Telegram.",
  "Se formatea `ABCD2345` y se normalizan entradas en minúsculas, con guion y con espacios.",
  "Se muestra `ABCD-2345` y todas las variantes se normalizan a `ABCD2345`."),
 ("rechaza longitudes o caracteres fuera del alfabeto",
  "EP-C-04 (errores 404 LINK_NOT_FOUND); RNF-01",
  "Un código mal formado no debe llegar a la base de datos; se rechaza antes para evitar consultas inútiles y respuestas ambiguas.",
  "Se normalizan un código de 7 caracteres y otro que incluye un `0`.",
  "Ambos devuelven `null`."),
 ("enmascara el email para la etiqueta XOTP",
  "Escalado §7.2.2 (campo `acc` del payload) y RNF-09 (privacidad)",
  "El QR de aprovisionamiento muestra una etiqueta de cuenta en la app autenticadora; el diseño exige que esté enmascarada para no exponer el correo completo a quien vea la pantalla.",
  "Se enmascara `ana.perez@alumnos.unican.es`.",
  "Se obtiene `a***@alumnos.unican.es`."),
 ("el hash canónico no depende del orden de claves (idempotencia)",
  "Escalado §5.6 (Idempotency-Key), EP-C-29",
  "La idempotencia compara el hash del cuerpo para distinguir \"misma petición\" de \"misma clave con otro cuerpo\" (422). Si el hash dependiera del orden de las claves JSON, un reintento legítimo se rechazaría como conflicto.",
  "Se calculan hashes de dos objetos con las mismas claves en distinto orden, y de dos objetos distintos.",
  "Los dos primeros coinciden; los distintos no."),
 ("el token opaco de refresco tiene 43 caracteres base64url (256 bits)",
  "ADR-18; §5.9 (ChannelSession con hash SHA-256); EP-C-06 (refreshToken de 43 caracteres)",
  "El diseño justifica guardar el refresh token de canal con SHA-256 (y no bcrypt) porque tiene 256 bits de entropía. Esta prueba verifica que el token cumple esa premisa y el formato del contrato.",
  "Se genera un token y se calcula su hash.",
  "El token cumple `^[A-Za-z0-9_-]{43}$` y el hash tiene 64 caracteres hexadecimales."),
 ("compara cadenas en tiempo constante",
  "RNF-01 (OWASP: fugas por tiempo); ADR-20 (secretos de cliente)",
  "La comparación del secreto de cliente de servicio no debe revelar por tiempo cuántos caracteres coinciden.",
  "Se comparan cadenas iguales y cadenas de distinta longitud.",
  "Devuelve verdadero y falso respectivamente, sin lanzar excepciones por diferencia de longitud."),
 ("escapa HTML del contenido de correos (RF-NOT-06)",
  "RF-NOT-06; desviación DV-05",
  "El documento de requisitos identificó (DV-05) que el HTML de los correos incorporaba contenido sin escapar, abriendo la puerta a inyección de HTML. Esta prueba fija la corrección.",
  "Se escapa una etiqueta `<img>` con atributo `onerror`, comillas simples y `&`.",
  "Todos los caracteres especiales quedan convertidos en entidades HTML."),
 ("valida CUID y genera ULID ordenables",
  "RV-05 (identificadores CUID); §5.9 y §11 (Outbox e id de evento ULID)",
  "RV-05 obliga a validar el formato de los identificadores antes de usarlos. Los eventos usan ULID para que el outbox se publique en orden de creación.",
  "Se validan un CUID y una cadena maliciosa; se generan dos ULID consecutivos.",
  "Solo el CUID es válido y el segundo ULID es lexicográficamente mayor que el primero."),
]),
(U, "Circuit breaker del cliente MFA", "test/unit/circuit-breaker.test.ts", [
 ("se abre tras 5 fallos consecutivos y deja pasar una prueba a los 30 s",
  "Escalado §10.3 (\"tras 5 fallos consecutivos abre 30 s\"); AR-15",
  "El login de usuarios con MFA depende del mfa-service. Si está caído, seguir llamándolo multiplicaría la latencia; el circuito abierto responde 503 de inmediato y, pasados 30 s, prueba de nuevo.",
  "Se registran 4 y luego 5 fallos con un reloj controlado; se avanza el reloj 30 s.",
  "Tras 4 fallos sigue cerrado; tras 5 se abre y no admite peticiones; a los 30 s pasa a semiabierto."),
 ("un fallo en semiabierto vuelve a abrir; un éxito lo cierra",
  "Escalado §10.3; §7.5 (disponibilidad)",
  "El estado semiabierto deja pasar una sola prueba. Si falla, el servicio sigue degradado y debe volver a abrirse; si tiene éxito, el sistema se recupera solo.",
  "Se abre el circuito, se registra un fallo en semiabierto y después un éxito.",
  "El fallo reabre el circuito; el éxito posterior lo cierra."),
 ("un éxito reinicia el contador de fallos",
  "Escalado §10.3 (fallos consecutivos)",
  "El umbral habla de fallos consecutivos: fallos aislados intercalados con éxitos no deben abrir el circuito.",
  "Se alternan 4 fallos, un éxito y otros 4 fallos.",
  "El circuito permanece cerrado."),
]),
(U, "Contrato de error homogéneo", "test/unit/error-contract.test.ts", [
 ("incluye error, code estable y requestId (eco de X-Request-Id)",
  "Escalado §5.10; §9.1 (cabecera X-Request-Id)",
  "El bot interpreta el campo `code` (estable) en lugar del mensaje; el campo `error` se mantiene por compatibilidad con el frontend. `requestId` permite correlacionar errores con logs y eventos.",
  "Un manejador lanza un `AppError(409, OFFER_ALREADY_CLOSED)` y la petición trae `X-Request-Id`.",
  "Respuesta 409 con exactamente `{error, code, requestId}` y la misma cabecera de vuelta."),
 ("asigna un code por defecto a los errores antiguos sin code",
  "Escalado §5.10 (\"progresivamente las existentes\")",
  "No todos los errores heredados declaran un código. Para que el contrato sea homogéneo sin reescribir todo el core, cada estado HTTP recibe un código por defecto.",
  "Se crea un error 404 sin código y se consulta el código por defecto de 429.",
  "Se obtienen `NOT_FOUND` y `RATE_LIMITED`."),
 ("expone details.retryAfter y la cabecera Retry-After",
  "§7.2.5 (423 con retryAfter); RNF-03 (429)",
  "Los clientes deben saber cuánto esperar tras un bloqueo de MFA o un límite de intentos.",
  "Se lanza un error 423 `MFA_LOCKED` con `retryAfter: 30`.",
  "El cuerpo incluye `details.retryAfter = 30` y la cabecera `Retry-After: 30`."),
 ("mantiene `detail` para el modal de cuenta bloqueada del frontend",
  "RF-AUT-10; RUI-03 (modal de bloqueo)",
  "El frontend actual lee el objeto `detail` del login bloqueado para mostrar motivo y fecha. El nuevo contrato no puede romper esa lectura.",
  "Se lanza un error 403 `ACCOUNT_BLOCKED` con motivo.",
  "La respuesta incluye `detail` con `blocked: true`, `permanent` y `reason`."),
 ("oculta los errores inesperados tras un 500 genérico",
  "RUI-10; RNF-01; Arquitectura §5.1 (errorHandler)",
  "Los mensajes de error no deben exponer detalles internos. Una excepción no controlada podría filtrar rutas, consultas o secretos.",
  "Un manejador lanza un `Error` cuyo mensaje contiene la palabra \"secreto\".",
  "Respuesta 500 con código `INTERNAL_ERROR` y sin el texto original."),
 ("genera un X-Request-Id si no llega o es inválido",
  "Escalado §9.1; F4 (trazas con X-Request-Id)",
  "Un identificador de petición controlado por el cliente sin validar podría inyectar contenido en logs. Si falta o es inválido se genera uno propio.",
  "Se envía `X-Request-Id: \"a b\"` (con espacio).",
  "La respuesta trae un ULID de 26 caracteres generado por el servidor."),
 ("responde 413 PAYLOAD_TOO_LARGE ante cuerpos demasiado grandes (RV-07)",
  "RV-07 (cuerpo máximo 50 KB); §9.1",
  "El límite de cuerpo mitiga el abuso de recursos. El error debe seguir el contrato homogéneo en lugar de la página por defecto de Express.",
  "Se envía un cuerpo que supera el límite configurado en la aplicación de prueba.",
  "Respuesta 413 con código `PAYLOAD_TOO_LARGE`."),
]),
(U, "Cliente HTTP del mfa-service", "test/unit/mfa-http-client.test.ts", [
 ("envía un JWT de servicio del core con aud=mfa-service y scope mfa:manage",
  "Escalado §10.2 (cabeceras comunes); ADR-20; principio de confianza cero (§3.1)",
  "Toda llamada entre servicios lleva credencial verificable aunque circule por la red privada. El mfa-service solo debe aceptar tokens emitidos para él.",
  "Se intercepta la llamada a `/v1/verify` y se valida el Bearer contra el JWKS del core.",
  "El token verifica con `iss=xchanger-core`, `aud=mfa-service` y `scope=mfa:manage`."),
 ("traduce 423 a MFA_LOCKED con retryAfter",
  "RF-MFA-06; §7.2.5 regla 6",
  "Tras 5 fallos el factor se bloquea 15 minutos; el core debe propagar el bloqueo con su tiempo de espera.",
  "El mfa-service simulado responde 423 con `retryAfter: 120`.",
  "Se lanza `MFA_LOCKED` (423) con `details.retryAfter = 120`."),
 ("devuelve el resultado inválido (REPLAYED) sin lanzar",
  "RF-MFA-05 (antirreplay); EP-M-03",
  "Un código inválido es un resultado de negocio, no un fallo de transporte: no debe contar para el circuit breaker.",
  "El servicio responde 200 con `{valid: false, reason: REPLAYED}`.",
  "El cliente devuelve el objeto tal cual."),
 ("falla cerrado con 503 MFA_SERVICE_UNAVAILABLE ante caída o 5xx",
  "ADR-23; §10.3 (\"nunca se degrada a entrar sin segundo factor\"); AR-15",
  "Es el requisito de seguridad más importante de la integración: si el mfa-service no responde, el core debe denegar, nunca aceptar.",
  "Se simulan un error de conexión y una respuesta 502.",
  "Ambos producen 503 `MFA_SERVICE_UNAVAILABLE`."),
 ("respeta el tiempo límite de la llamada",
  "Escalado §7.5 y §10.3 (tiempo límite de 2 s)",
  "Un mfa-service lento no debe bloquear indefinidamente las peticiones de login.",
  "El servicio simulado no responde nunca; el límite se fija en 50 ms.",
  "La llamada se aborta y produce 503."),
 ("abre el circuito tras 5 fallos y deja de llamar",
  "Escalado §10.3",
  "Comprueba la integración real del circuit breaker en el cliente, no solo la clase aislada.",
  "Se encadenan 6 llamadas contra un servicio que siempre responde 500.",
  "Solo se realizan 5 peticiones de red; la sexta se rechaza localmente con 503."),
 ("reintenta una vez solo las lecturas (EP-M-06)",
  "Escalado §10.3 (\"un reintento solo en operaciones de lectura\")",
  "Reintentar una verificación podría consumir dos veces un código o duplicar efectos; reintentar una lectura es inocuo.",
  "Un servicio falla la primera vez y responde bien la segunda, tanto para `getFactors` como para `verify`.",
  "La lectura hace 2 peticiones y tiene éxito; la verificación hace 1 y falla con 503."),
 ("mapea 409 de enrolamiento a MFA_ALREADY_ENABLED y 410 a ENROLLMENT_EXPIRED",
  "EP-C-21 (409 MFA_ALREADY_ENABLED); EP-C-22 (410 ENROLLMENT_EXPIRED); EP-M-01/02",
  "Los códigos internos del mfa-service deben convertirse en los códigos públicos del contrato del core.",
  "El servicio responde 409 al crear y 410 al confirmar.",
  "Se obtienen `MFA_ALREADY_ENABLED` y `ENROLLMENT_EXPIRED`."),
]),
(U, "Validación del segundo factor y sesión reciente", "test/unit/second-factor.test.ts", [
 ("tolera espacios intermedios en el código",
  "§7.2.5 regla 1 (\"se toleran espacios intermedios\")",
  "Los usuarios copian `123 456` tal como lo muestra la app.",
  "Se normaliza `123 456`.",
  "Se obtiene `123456`."),
 ("exige exactamente uno de code / recoveryCode",
  "EP-C-24, EP-C-25, EP-C-06 grant mfa (\"excluyente con code\")",
  "Enviar ambos factores o ninguno es una petición ambigua que debe rechazarse antes de llamar al mfa-service.",
  "Se valida sin factor, con ambos, solo con código y solo con código de recuperación.",
  "Los dos primeros casos lanzan error; los dos últimos son válidos."),
 ("rechaza formatos inválidos",
  "RV-04 (6 dígitos); §7.2.6 (formato XXXXX-XXXXX)",
  "Validar el formato evita llamadas inútiles al servicio y gastar intentos.",
  "Se valida un código de 5 dígitos y un código de recuperación corto.",
  "Ambos se rechazan."),
 ("acepta un login de menos de 15 min para aprobar vinculaciones",
  "Escalado §6.4 (\"Aprobar exige sesión web reciente\"); EP-C-05",
  "La aprobación de un canal es una acción sensible; una sesión recién iniciada es prueba suficiente de presencia.",
  "Se evalúa un usuario con `auth_time` de hace 60 s.",
  "El middleware deja pasar."),
 ("pide REAUTH_REQUIRED si el login tiene más de 15 min",
  "EP-C-05 (401 REAUTH_REQUIRED)",
  "Una sesión antigua podría estar en un equipo compartido; se exige reautenticación.",
  "Se evalúa un `auth_time` de hace 16 minutos.",
  "Se devuelve `REAUTH_REQUIRED`."),
 ("para activar MFA exige reautenticación explícita de menos de 10 min",
  "RF-MFA-01 (\"tras reautenticarse\"); EP-C-21; EP-C-27 (validez de 10 min)",
  "Activar el segundo factor emite un secreto; un login reciente no basta, se exige una reautenticación explícita vigente.",
  "Se evalúa un usuario solo con login reciente, uno con reautenticación de hace 1 min y otro de hace 11 min.",
  "Solo pasa el de reautenticación vigente."),
]),
(U, "Autenticación de servicios", "test/unit/service-auth.test.ts", [
 ("emite un JWT ES256 de 10 min con iss, sub, aud, scope, jti y kid",
  "ADR-20; §5.4; EP-C-01",
  "La credencial de servicio debe ser firmada, rotable, de vida corta y con scopes, verificable por terceros vía JWKS.",
  "El cliente `telegram-bot` solicita un token con su secreto.",
  "Token ES256 con `kid`, `iss`, `sub`, `aud`, `scope`, `jti` y 600 s de vida."),
 ("rechaza secreto o cliente incorrectos con 401 SERVICE_UNAUTHORIZED",
  "EP-C-01 (errores); RNF-01",
  "Sin un secreto válido no se debe emitir credencial alguna, y la respuesta no debe distinguir cliente inexistente de secreto erróneo.",
  "Se usa un secreto incorrecto y un `client_id` inexistente.",
  "Ambos producen 401 `SERVICE_UNAUTHORIZED`."),
 ("rechaza scopes no permitidos con 400 INVALID_SCOPE",
  "EP-C-01 (\"subconjunto de los permitidos\"); ADR-21 (mínimo privilegio)",
  "El bot no debe poder obtener el scope `mfa:manage`, reservado al core.",
  "El bot solicita `scope=mfa:manage`.",
  "Error 400 `INVALID_SCOPE`."),
 ("verifica el scope exigido por la ruta",
  "§5.4 (`requireService(scope)`)",
  "Un token válido de un canal no debe servir para otro canal.",
  "Se verifica un token del bot exigiendo `channel:telegram` y `channel:whatsapp`.",
  "El primero se acepta; el segundo se rechaza con 403."),
 ("no acepta como credencial del core un token dirigido al mfa-service",
  "ADR-20 (claim `aud`); confianza cero",
  "Un token emitido para otro servicio no debe reutilizarse contra el core (confusión de audiencia).",
  "Se firma un token con `aud=mfa-service` y se verifica como credencial del core.",
  "Se rechaza."),
 ("publica la clave pública en el JWKS sin material privado",
  "EP-C-02",
  "El JWKS es consultable por otros servicios; nunca debe contener el componente privado de la clave.",
  "Se obtiene el JWKS.",
  "Una clave EC P-256 con `kid`, `alg` y `use`, sin el campo `d`."),
]),
(U, "Vectores RFC 6238 del protocolo XOTP", "test/unit/totp-vectors.test.ts", [
 ("t=%d → %s (8 díg.) / %s (6 díg.) — prueba parametrizada, 4 ejecuciones",
  "Escalado §7.2.3 (vectores de prueba obligatorios); AR-23",
  "El documento exige que la app y el mfa-service superen los vectores RFC 6238 con SHA-256. El core no implementa TOTP, pero la simulación del mfa-service usada en integración y E2E sí lo hace; validarla con los vectores oficiales garantiza que las pruebas del core son fieles al protocolo.",
  "Se calcula el código para t = 59, 1111111109, 1234567890 y 2000000000 con la clave de 32 bytes.",
  "Se obtienen 46119246/119246, 68084774/084774, 91819424/819424 y 90698825/698825."),
 ("el secreto de 32 bytes ocupa 52 caracteres Base32 sin relleno y es reversible",
  "§7.2.2 (campo `sec`: \"Base32 sin relleno, 52 caracteres\")",
  "La introducción manual del secreto depende de esta codificación exacta.",
  "Se codifica y decodifica la clave de prueba.",
  "Longitud 52 y decodificación idéntica al original."),
]),

# ═════════════════════════════ INTEGRACIÓN ═════════════════════════════
(I, "Regresión de autenticación y cuenta (requisitos originales)", "test/integration/auth-legacy.test.ts", [
 ("CA-01: un correo @gmail.com devuelve 400 y no crea registro pendiente",
  "CA-01; RF-AUT-02; RA-02",
  "El acceso está limitado a la comunidad de la UC. Un dominio ajeno debe rechazarse antes de crear ningún estado.",
  "Se registra un visitante con `x@gmail.com`.",
  "400 `INVALID_EMAIL_DOMAIN` y cero registros pendientes en la base de datos."),
 ("RF-AUT-02/03: email duplicado → 409; contraseña débil → 400",
  "RF-AUT-02; RF-AUT-03; RV-03",
  "La unicidad del email y la complejidad de la contraseña se validan en servidor antes del hash.",
  "Se registra un email ya existente y, por separado, una contraseña sin mayúsculas ni símbolos.",
  "409 y 400 respectivamente."),
 ("CA-02: OTP correcto antes de 30 min crea la cuenta (rol Estudiante) e inicia sesión",
  "CA-02; RF-AUT-04 a RF-AUT-08",
  "El alta se hace en dos fases: primero un registro pendiente con el OTP guardado como hash; tras verificar, se crea el usuario Estudiante, se borra el pendiente y se inicia sesión.",
  "Se registra un email nuevo, se lee el OTP del buzón y se verifica.",
  "201; usuario con rol `ESTUDIANTE`; el hash guardado no es el código; sin pendientes; `/auth/me` responde con `mfaEnabled: false`."),
 ("CA-03: OTP tras 30 min → 410 y hay que repetir el registro",
  "CA-03; RF-AUT-05; RV-04",
  "El OTP de alta caduca a los 30 minutos.",
  "Se fuerza la caducidad del registro pendiente y se envía el OTP correcto.",
  "410 y no se crea el usuario."),
 ("el OTP de alta admite como máximo 5 intentos",
  "RNF-03; DV-08",
  "Un OTP de 6 dígitos sin límite de intentos es vulnerable a fuerza bruta.",
  "Se envían 5 códigos erróneos y después el correcto.",
  "Los 5 primeros dan 400; el correcto da 410 porque el registro se ha invalidado."),
 ("RF-AUT-09: misma respuesta genérica si el email no existe o la contraseña es errónea",
  "RF-AUT-09",
  "Respuestas distintas permitirían enumerar cuentas registradas.",
  "Se intenta entrar con un email inexistente y con una contraseña errónea.",
  "Ambos 401 con idénticos `error` y `code`."),
 ("una cuenta sin contraseña (creada por canal) recibe el mismo 401 genérico",
  "ADR-29; §5.9 (\"comparación bcrypt contra hash ficticio y 401 genérico\")",
  "Las cuentas creadas desde Telegram no tienen contraseña; el login web no debe revelarlo.",
  "Se intenta entrar con una cuenta de `passwordHash` nulo.",
  "401 `INVALID_CREDENTIALS`."),
 ("RF-AUT-10: cuenta bloqueada con credenciales correctas → 403 con motivo y fecha",
  "RF-AUT-10; RUI-03",
  "Solo tras validar las credenciales se informa del bloqueo, con motivo y fecha de fin.",
  "Se bloquea temporalmente a un usuario y este inicia sesión.",
  "403 `ACCOUNT_BLOCKED` con `detail` que incluye `permanent: false`, motivo y fecha."),
 ("RF-AUT-11/12: cookies HttpOnly; refresh solo en su ruta y almacenado con hash",
  "RF-AUT-11; RF-AUT-12; RNF-02",
  "Los tokens no deben ser accesibles desde JavaScript y el refresh token solo debe viajar al endpoint de renovación y guardarse como hash.",
  "Se inicia sesión y se inspeccionan las cookies y la base de datos.",
  "`access_token` HttpOnly; `refresh_token` con `Path=/api/auth/refresh`; hash bcrypt en la base de datos."),
 ("renueva el access token; tras logout el refresh deja de servir",
  "RF-AUT-12; RF-AUT-13",
  "El cierre de sesión debe invalidar el refresh token.",
  "Se refresca, se cierra sesión y se consulta el usuario.",
  "Refresh 200, logout 200 y `refreshTokenHash` nulo."),
 ("el refresco de un usuario bloqueado se deniega y revoca",
  "RF-AUT-12 (\"denegarse y revocarse si el usuario está bloqueado\")",
  "Un bloqueo no debe poder esquivarse renovando el token.",
  "Se bloquea a un usuario con sesión y este intenta refrescar.",
  "403 y hash de refresco anulado."),
 ("RF-AUT-17: registra LoginHistory con IP y agente",
  "RF-AUT-17; AR-02 (IP mediante trust proxy)",
  "Cada login correcto debe dejar historial con IP, ubicación y agente.",
  "Se inicia sesión con `User-Agent: jest`.",
  "Existe una fila de `LoginHistory` con ese agente."),
 ("RNF-03: el login se limita por cuenta (429 con retryAfter)",
  "RNF-03; DV-08; F0 (limitador en Redis)",
  "El login debe limitar intentos por IP y por cuenta para mitigar la fuerza bruta.",
  "Se hacen 11 intentos fallidos contra la misma cuenta.",
  "El último devuelve 429 `RATE_LIMITED` con `retryAfter` positivo."),
 ("RF-AUT-14: responde igual exista o no el email",
  "RF-AUT-14",
  "La recuperación no debe revelar si una cuenta existe.",
  "Se solicita recuperación para un email existente y otro inexistente.",
  "Respuestas idénticas; solo se envía un correo."),
 ("RF-AUT-15: el restablecimiento revoca sesiones y registra PASSWORD_RESET; sirve para fijar contraseña (ADR-29)",
  "RF-AUT-15; ADR-29",
  "El restablecimiento valida OTP y complejidad, revoca sesiones y queda auditado. Además es la vía para que una cuenta creada desde Telegram fije contraseña.",
  "Una cuenta sin contraseña solicita recuperación y fija una nueva.",
  "Login web posterior correcto y una entrada `PASSWORD_RESET` en el log."),
 ("RF-AUT-16: cambiar contraseña exige la actual",
  "RF-AUT-16",
  "Con sesión iniciada no basta para cambiar la contraseña: hace falta la actual.",
  "Se cambia con una contraseña actual errónea y luego con la correcta.",
  "401 y 204 respectivamente."),
 ("RF-PER-01: el email no es modificable desde Ajustes",
  "RF-PER-01",
  "El nombre, la carrera y el curso son editables; el email no.",
  "Se intenta enviar `email` en `PATCH /auth/me` y después solo `name`.",
  "400 en el primer caso; 200 con el nombre nuevo y el email intacto en el segundo."),
 ("/api es alias de /api/v1",
  "Escalado §5.6 (versionado)",
  "Los microservicios usan `/api/v1` y el frontend actual `/api`; ambos deben servir el mismo contrato.",
  "Se consulta `/auth/me` por ambos prefijos.",
  "Mismas respuestas."),
 ("RF-ACA-08: el catálogo de registro es público",
  "RF-ACA-08; EP-R-01; EP-R-02",
  "El formulario de registro necesita carreras y cursos sin sesión.",
  "Se consultan carreras y cursos sin cookies.",
  "200 y la carrera sembrada aparece en el listado."),
 ("GET /health devuelve estado y marca de tiempo (RNF-10, EP-C-30)",
  "RNF-10; EP-C-30",
  "El endpoint de salud debe devolver estado y hora, y desde la red interna, el estado de las dependencias.",
  "Se consulta `/health` y `/api/v1/health?deep=true` desde loopback.",
  "`status: ok`, marca de tiempo válida y `dependencies: {db, redis, mfa}` en `up`."),
]),
(I, "Ofertas, paginación y mensajería", "test/integration/offers.test.ts", [
 ("CA-04: B (tiene 2, desea 1) encuentra la oferta de A (tiene 1, desea 2)",
  "CA-04; RF-OFE-04",
  "La búsqueda complementaria es el núcleo funcional: el grupo actual de la oferta debe ser el deseado del buscador y viceversa.",
  "A publica (P1 → P2). B busca teniendo P2 y deseando P1, y luego una combinación sin coincidencias.",
  "B obtiene exactamente la oferta de A; la segunda búsqueda devuelve una lista vacía."),
 ("RF-OFE-02: grupos iguales o de otra asignatura → 400",
  "RF-OFE-02",
  "Los grupos deben pertenecer a la asignatura, no estar eliminados y ser distintos.",
  "Se crea una oferta con dos grupos iguales y otra con un grupo de otra asignatura.",
  "400 en ambos casos."),
 ("RF-PER-03: sin expediente no se puede crear ni aceptar (409 EXPEDIENTE_REQUIRED)",
  "RF-PER-03; EP-R-10 (409 EXPEDIENTE_REQUIRED)",
  "El usuario debe elegir al menos una asignatura antes de operar con ofertas. El código heredado no lo comprobaba.",
  "Un usuario sin expediente publica una oferta.",
  "409 `EXPEDIENTE_REQUIRED`."),
 ("RF-OFE-07: crear una oferta notifica al creador",
  "RF-OFE-07; RE-01",
  "Al publicar, el creador recibe una notificación. El código heredado no la generaba.",
  "Se publica una oferta.",
  "Existe una notificación de \"publicada\" para el creador."),
 ("RF-OFE-08: no se puede aceptar la propia oferta (400 OWN_OFFER)",
  "RF-OFE-08",
  "Solo un usuario distinto del creador puede aceptar.",
  "El creador acepta su propia oferta.",
  "400 `OWN_OFFER`."),
 ("CA-05: dos aceptaciones concurrentes → solo una gana; la otra recibe 409",
  "CA-05; RF-OFE-08; DV-03; AR-06",
  "La aceptación debe ser atómica. El código heredado leía y luego escribía sin condición, permitiendo la doble aceptación. Ahora es una actualización condicional sobre `status = OPEN`.",
  "Dos usuarios aceptan la misma oferta en paralelo.",
  "Estados `[200, 409]`; el perdedor recibe `OFFER_NOT_OPEN`; la oferta queda ACCEPTED con uno de los dos como aceptante."),
 ("RF-OFE-09: al aceptar se notifica a ambas partes con nombre y email de la contraparte",
  "RF-OFE-09; RE-02",
  "Cada parte debe recibir los datos de contacto de la otra para coordinar el intercambio.",
  "B acepta la oferta de A.",
  "La notificación de A contiene nombre y email de B y viceversa."),
 ("RF-OFE-10: creador, aceptante o admin cierran; cerrada no se reabre (409); terceros 403",
  "RF-OFE-10; RE-03",
  "Solo las partes o un administrador pueden cerrar, y una oferta cerrada es un estado final.",
  "Un tercero intenta cerrar; el creador cierra dos veces; otro usuario intenta aceptarla.",
  "403; 200 y luego 409 `OFFER_ALREADY_CLOSED`; 409 al aceptar."),
 ("RF-OFE-11: el panel lista ofertas propias y aceptadas, de más reciente a más antigua",
  "RF-OFE-11",
  "El panel debe mostrar tanto las ofertas creadas como las aceptadas, ordenadas.",
  "A publica una oferta y después acepta una de B.",
  "El panel de A lista la aceptada (más reciente) antes que la propia."),
 ("con limit devuelve {items, nextCursor}, excluye las propias y no repite elementos",
  "EP-C-12; escalado §5.6",
  "Para el bot, la búsqueda es paginada, excluye las ofertas del propio buscador y no expone el email del creador.",
  "Se crean 5 ofertas ajenas y una propia; se pagina con `limit=3`.",
  "Páginas de 3 y 2 elementos, `nextCursor` nulo al final, sin la propia, sin duplicados y sin email del creador."),
 ("cursor manipulado → 400",
  "Escalado §5.6; RNF-01",
  "Un cursor inválido es entrada errónea del cliente.",
  "Se envía `cursor=basura`.",
  "400."),
 ("/offers/me admite status, role y contraparte solo si ACCEPTED",
  "EP-C-13",
  "El panel del bot filtra por estado y rol y solo muestra la contraparte cuando la oferta está aceptada.",
  "A tiene una oferta aceptada por Beto y otra abierta; se filtra por estado y rol, y por un estado inexistente.",
  "La aceptada incluye `counterpart: {name: Beto}` e `isCreator: true`; la abierta, `counterpart: null`; el estado inválido da 400."),
 ("EP-C-14: grupos de una asignatura sin pasar por /admin, ordenados",
  "EP-C-14; RF-ACA-07",
  "Los grupos solo se listaban en `/admin`; el bot y el autocompletado necesitan una lectura no administrativa que respete el borrado lógico de los ancestros.",
  "Se consultan los grupos y, tras eliminar lógicamente el curso, se vuelve a consultar.",
  "Primero, P1, P2 y P3 ordenados; después, 404."),
 ("CA-06: un mensaje queda guardado, ambos reciben notificación y se publica offer.message.created",
  "CA-06; RF-CHT-03, RF-CHT-04, RF-CHT-06; §11",
  "El mensaje se persiste antes de difundirse, se recorta, notifica a ambas partes y llega al bus para el bot.",
  "Con una oferta aceptada, A envía un mensaje con espacios laterales.",
  "Contenido recortado; una notificación por parte; evento con la audiencia de ambos usuarios."),
 ("RF-CHT-01/03: solo las partes; mensajes vacíos o >2000 se rechazan",
  "RF-CHT-01; RF-CHT-03; RV-06",
  "El chat es exclusivo de creador y aceptante y los mensajes tienen entre 1 y 2000 caracteres.",
  "Se envía un mensaje vacío, uno de 2001 caracteres y uno desde un tercero.",
  "400, 400 y 403."),
 ("RF-CHT-08: un chat cerrado no acepta mensajes (409 CHAT_CLOSED) pero se lee",
  "RF-CHT-08; RF-CHT-04",
  "El chat cerrado pasa a solo lectura: no admite mensajes pero el historial sigue disponible.",
  "Se envía un mensaje, se cierra la oferta y se intenta enviar otro.",
  "409 `CHAT_CLOSED`; el detalle muestra solo el primer mensaje."),
]),
(I, "Administración, bloqueo, estructura académica y auditoría", "test/integration/admin.test.ts", [
 ("CA-07: un embajador de la carrera X no puede bloquear a un estudiante de Y (403, sin cambios)",
  "CA-07; RF-BLQ-01; RF-ADM-08; AR-05",
  "La autoridad se delega por ámbito. El bloqueo heredado no comprobaba el ámbito del usuario objetivo.",
  "Un embajador de una carrera bloquea a un estudiante de otra.",
  "403 y el rol del estudiante no cambia."),
 ("CA-08: el bloqueo pasa sus ofertas a INACTIVE, invalida la sesión y publica account.blocked",
  "CA-08; RF-BLQ-03; RF-BLQ-04; RE-04; §11",
  "El bloqueo debe revocar la capacidad de actuar en el acto, ocultar sus ofertas, emitir el evento y quedar auditado.",
  "Un estudiante con una oferta abierta es bloqueado; acto seguido usa su access token aún vigente.",
  "Oferta INACTIVE; la petición devuelve 403 `ACCOUNT_BLOCKED`; evento `account.blocked`; log `BLOCK_USER`."),
 ("CA-09: al vencer un bloqueo temporal la cuenta puede entrar sin intervención (DV-01)",
  "CA-09; RF-BLQ-05; DV-01",
  "Al llegar la fecha de fin, la cuenta debe recuperarse sola. El código heredado no lo hacía.",
  "Se fija un bloqueo con fin en el pasado y el usuario inicia sesión.",
  "200 y rol `ESTUDIANTE`."),
 ("DV-02 / RF-BLQ-02: nadie se bloquea a sí mismo ni bloquea a un Propietario; un embajador solo a estudiantes",
  "RF-BLQ-02; DV-02",
  "La desviación DV-02 permitía al Propietario bloquear a cualquiera, incluido él mismo.",
  "Un Propietario se bloquea a sí mismo y a otro Propietario; un embajador bloquea a otro embajador.",
  "403 en los tres casos."),
 ("RF-BLQ-06: desbloquear devuelve el rol Estudiante; si no estaba bloqueado → 409",
  "RF-BLQ-06; RE-09",
  "El desbloqueo solo procede sobre usuarios bloqueados y restaura el rol.",
  "Se desbloquea a un usuario activo, se le bloquea temporalmente y se le desbloquea.",
  "409; 200; 200 y rol `ESTUDIANTE`."),
 ("CA-10: eliminar una asignatura con ofertas cancela las ofertas y notifica a los afectados (RF-ACA-06)",
  "CA-10; RF-ACA-06; RF-ACA-07; RE-05",
  "Tras confirmar la eliminación, las ofertas vinculadas se cancelan y los usuarios afectados son notificados. El código heredado notificaba pero no cancelaba.",
  "Con una oferta abierta, la Propietaria elimina la asignatura.",
  "Oferta CLOSED; notificación \"Aviso del sistema\"; eventos `offer.status.changed` y `academic.changed`; la asignatura desaparece del catálogo."),
 ("AR-05: un embajador con ámbito de un curso puede gestionar grupos de ese curso y no de otro",
  "AR-05; RF-ADM-02; RF-ACA-09",
  "Un ámbito con curso concreto cubre solo ese curso. Los middleware heredados excluían por error a los embajadores de curso, y el borrado de cursos no comprobaba el ámbito.",
  "Un embajador del curso 2.º consulta grupos de su curso y de otro, y elimina otro curso.",
  "200, 403 y 403."),
 ("RF-ACA-01: unicidad de código de asignatura → 409",
  "RF-ACA-01",
  "El código de asignatura es único en todo el sistema.",
  "Se crea una asignatura con un código existente.",
  "409."),
 ("CA-11: un ticket CLOSED no admite mensajes (409)",
  "CA-11; RF-TIC-02",
  "Un ticket cerrado no admite mensajes.",
  "Se abre, se cierra y se intenta responder un ticket.",
  "409."),
 ("CA-12: un embajador de ámbito A solo ve en el log acciones de usuarios de A",
  "CA-12; RF-LOG-04",
  "La auditoría está limitada al ámbito del solicitante.",
  "Hay entradas de log de usuarios de dos carreras; consulta un embajador de una de ellas.",
  "Ve las de su carrera y no las de la otra."),
 ("RF-LOG-06: el log no guarda contraseñas, OTP ni tokens",
  "RF-LOG-06; RNF-09",
  "El log no debe contener secretos.",
  "Se realiza un restablecimiento de contraseña completo y se serializa todo el log.",
  "No aparecen ni la nueva contraseña ni el OTP."),
 ("RF-TGB-11 / matriz de roles: un estudiante no accede a /admin",
  "Tabla 6 (matriz de roles); RF-ADM-01",
  "Las acciones administrativas están vetadas al rol Estudiante.",
  "Un estudiante consulta `/admin/logs`.",
  "403."),
]),
(I, "Canal Telegram: servicio, vinculación, sesiones e idempotencia", "test/integration/channel.test.ts", [
 ("canjea client credentials por un JWT de servicio y publica el JWKS interno",
  "EP-C-01; EP-C-02; ADR-20",
  "Es la puerta de entrada de cualquier microservicio: credencial de servicio de vida corta sin caché y JWKS público para su verificación.",
  "El bot solicita token; se consulta el JWKS por HTTP.",
  "200 con `expires_in: 600`, `Cache-Control: no-store` y una clave EC ES256."),
 ("rechaza credenciales incorrectas (401 SERVICE_UNAUTHORIZED) y scopes ajenos (400 INVALID_SCOPE)",
  "EP-C-01 (errores)",
  "Verificación HTTP de los errores del contrato.",
  "Secreto erróneo y scope `mfa:manage`.",
  "401 `SERVICE_UNAUTHORIZED` y `INVALID_SCOPE`."),
 ("los endpoints S exigen credencial de servicio",
  "§5.4 (`requireService`)",
  "Los endpoints de acceso S no deben atenderse sin credencial de servicio.",
  "Se crea una solicitud de vinculación sin cabecera de servicio.",
  "401 `SERVICE_UNAUTHORIZED`."),
 ("flujo completo: código → aprobación web → canje → /misofertas funciona",
  "CA-18; RF-TGB-01; ADR-19; EP-C-03 a EP-C-06; AR-16",
  "El usuario vincula su cuenta sin introducir la contraseña en Telegram, aprobando desde la web un código mostrado por el bot.",
  "El bot crea la solicitud, sondea antes de la aprobación (dos veces seguidas), el usuario consulta y aprueba en la web, el bot canjea dos veces el `deviceCode` y consulta sus ofertas.",
  "Formato correcto del código; `AUTHORIZATION_PENDING` y luego `SLOW_DOWN`; datos de reconocimiento visibles; sesión emitida con el perfil del usuario; segundo canje `INVALID_GRANT`; `/offers/me` paginado; evento `channel.link.approved`, log `CHANNEL_LINKED` y notificación de seguridad."),
 ("rechazar la vinculación → ACCESS_DENIED al canjear",
  "EP-C-05 (decision=deny); EP-C-06 (403 ACCESS_DENIED)",
  "El usuario debe poder rechazar una solicitud que no reconoce.",
  "El usuario rechaza y el bot canjea.",
  "Respuesta `DENIED` y 403 `ACCESS_DENIED` al canjear."),
 ("aprobar exige sesión web reciente (login de más de 15 min → 401 REAUTH_REQUIRED)",
  "§6.4 (\"Aprobar exige sesión web reciente\"); EP-C-05",
  "Mitiga que alguien apruebe un código ajeno desde una sesión olvidada.",
  "Se aprueba con un access token cuyo `auth_time` tiene 20 minutos.",
  "401 `REAUTH_REQUIRED`."),
 ("una identidad de Telegram vinculada a otra cuenta → 409 CHANNEL_IDENTITY_TAKEN",
  "§5.9 (unicidad de ChannelIdentity); EP-C-05",
  "Una identidad de Telegram solo puede estar activa en una cuenta.",
  "La identidad 999 ya pertenece a A; B aprueba una solicitud de esa identidad.",
  "409 `CHANNEL_IDENTITY_TAKEN`."),
 ("una solicitud caducada → 410 LINK_EXPIRED",
  "§5.9 (caducidad de 10 min); EP-C-04",
  "Los códigos caducan a los 10 minutos.",
  "Se fuerza la caducidad y se consulta el código.",
  "410 `LINK_EXPIRED`."),
 ("límite de 5 solicitudes por externalUserId y hora",
  "EP-C-03 (\"Límite: 5 por externalUserId y hora\")",
  "Evita que se generen códigos masivamente para una misma identidad.",
  "Se crean 6 solicitudes para la misma identidad.",
  "5 respuestas 201 y una 429."),
 ("CA-21: el token de canal sin credencial de servicio → 401; en /admin → 403 CHANNEL_FORBIDDEN_ROUTE",
  "CA-21; RF-TGB-11; ADR-21; §5.5",
  "Un token de canal robado no sirve sin la credencial del servicio, y el canal solo accede a la lista blanca de rutas; ninguna ruta administrativa admite canal, aunque el usuario sea Propietario.",
  "Una Propietaria vinculada usa su token sin cabecera de servicio y luego accede a `/admin/logs`, `/tickets/me` y al cambio de contraseña.",
  "401; y 403 `CHANNEL_FORBIDDEN_ROUTE` en las tres rutas."),
 ("la credencial de servicio sola no basta (sin Bearer de canal → 401)",
  "§5.2 (ServiceChannelExtractor)",
  "El servicio no actúa nunca por cuenta propia sobre datos de usuario: necesita la sesión del usuario.",
  "Se consulta `/offers/me` solo con la cabecera de servicio.",
  "401."),
 ("cookie y cabecera de servicio a la vez → 400 AMBIGUOUS_CREDENTIALS",
  "§5.2 (CSRF; \"se rechaza con 400 AMBIGUOUS_CREDENTIALS\")",
  "Mezclar credenciales podría permitir confusión de identidad.",
  "Se envía una petición del bot con una cookie añadida.",
  "400 `AMBIGUOUS_CREDENTIALS`."),
 ("el bot reutiliza expediente, catálogo, búsqueda, oferta y aceptación (RF-TGB-04..06)",
  "RF-TGB-04 a RF-TGB-06; ADR-17; EP-R-05 a EP-R-13",
  "El bot es un cliente más de la API pública: los endpoints existentes sirven sin duplicarlos.",
  "Un usuario vinculado sin expediente añade una asignatura (dos veces), lista grupos, busca, acepta, escribe y cierra.",
  "Expediente 201 y luego 200; tres grupos; búsqueda paginada con la oferta esperada; aceptación, mensaje y cierre correctos; `/auth/me` con `mfaEnabled`."),
 ("Telegram reintenta el mismo update: una sola oferta y la misma respuesta",
  "CA-19; EP-C-29; §5.6",
  "Telegram reintenta updates; sin idempotencia se duplicarían ofertas.",
  "Se envía dos veces la misma creación con `Idempotency-Key: tg:777`.",
  "Ambas 201 con el mismo id, cabecera `Idempotent-Replayed` y una sola oferta en la base de datos."),
 ("misma clave con otro cuerpo → 422 IDEMPOTENCY_CONFLICT; sin clave desde canal → 400",
  "§5.6; §9.1 (cabecera I obligatoria en POST de creación)",
  "Reusar una clave con otro cuerpo es un error del cliente; para el canal la cabecera es obligatoria.",
  "Se reutiliza la clave con otro grupo y se omite la clave.",
  "422 `IDEMPOTENCY_CONFLICT` y 400 `IDEMPOTENCY_KEY_REQUIRED`."),
 ("en la web la cabecera es opcional (contrato actual intacto)",
  "RNF-11 (no romper contratos existentes)",
  "El frontend actual no envía la cabecera y debe seguir funcionando.",
  "Se crea una oferta por la web sin cabecera.",
  "201."),
 ("rota el refresh token; reutilizar el anterior revoca toda la familia",
  "ADR-18; EP-C-06 (\"refresh reutilizado: se revoca toda la familia\")",
  "La rotación con detección de reutilización limita el daño de un refresh token robado.",
  "Se refresca, se reutiliza el token antiguo y después se usa el nuevo.",
  "Nuevo token distinto; reutilización `INVALID_GRANT`; el nuevo también invalidado; access token revocado; evento con motivo `REUSE_DETECTED`."),
 ("un refresh de otra identidad externa → INVALID_GRANT",
  "EP-C-06 (\"Debe coincidir con el usado... si no, invalid_grant\")",
  "Un token solo es válido para la identidad que lo obtuvo.",
  "Se refresca indicando otro `externalUserId`.",
  "`INVALID_GRANT`."),
 ("caducidad absoluta superada → 410 EXPIRED_TOKEN",
  "§6.7 (caducidad absoluta de 180 días); EP-C-06",
  "Ninguna sesión de canal vive indefinidamente.",
  "Se fuerza la caducidad absoluta y se refresca.",
  "410."),
 ("RF-TGB-09: /desvincular revoca la identidad (EP-C-09 scope=identity)",
  "RF-TGB-09; EP-C-09",
  "El usuario debe poder desvincular desde el propio bot.",
  "El bot revoca con `scope=identity` y vuelve a usar el token.",
  "204; 401; ninguna identidad activa."),
 ("RF-TGB-09: también desde Ajustes web (EP-C-10 / EP-C-11)",
  "RF-TGB-09; EP-C-10; EP-C-11",
  "La desvinculación también debe ser posible desde la web, revocando las sesiones del canal.",
  "El usuario lista sus canales, elimina la identidad y repite la eliminación.",
  "Un canal listado; 204; el bot recibe 401; segundo borrado 404."),
 ("CA-20: el bloqueo revoca la sesión de canal, el bot recibe el evento y toda acción falla",
  "CA-20; RF-TGB-10",
  "El bloqueo debe extenderse a las sesiones de canal y avisar al bot.",
  "Un embajador bloquea a un usuario vinculado; el bot consulta y refresca.",
  "401; `INVALID_GRANT`; eventos `account.blocked` y `channel.session.revoked` con motivo `BLOCKED`."),
 ("EP-C-07 responde igual exista o no la cuenta (anti-enumeración)",
  "EP-C-07; RF-AUT-14 (por analogía)",
  "Pedir un OTP de login por chat no debe revelar qué correos están registrados.",
  "Se pide OTP para un email existente (en mayúsculas) y otro inexistente; se canjea el segundo.",
  "Ambos 202 con la misma forma; un solo correo enviado; el canje del inexistente da `INVALID_GRANT`."),
 ("EP-C-07 exige dominio institucional (400 INVALID_EMAIL_DOMAIN)",
  "EP-C-07; RV-02",
  "El canal mantiene la restricción institucional.",
  "Se pide OTP para `x@gmail.com`.",
  "`INVALID_EMAIL_DOMAIN`."),
 ("login por OTP de correo sin MFA emite la sesión y crea la identidad",
  "RF-TGB-02; §6.5",
  "Alternativa a la vinculación para usuarios sin navegador a mano.",
  "Se pide OTP y se canjea con `grant_type=email_otp`.",
  "Sesión emitida e identidad activa creada."),
 ("CA-22: con MFA, el OTP de correo solo da un reto; la sesión requiere el código XOTP",
  "CA-22; RF-MFA-04; RF-TGB-02; §7.2.8 (\"Saltarse el MFA por el bot\")",
  "El canal no puede ser un atajo para eludir el segundo factor.",
  "Un usuario con MFA canjea el OTP de correo, envía un código XOTP erróneo, luego uno correcto, y reutiliza el reto.",
  "`mfaRequired` sin tokens ni sesiones; 401 `MFA_INVALID_CODE` con intentos restantes; sesión con `mfaEnabled: true`; reutilización `INVALID_GRANT`."),
 ("RF-TGB-03 / ADR-29: el alta desde el bot crea la cuenta sin contraseña, con identidad y sesión",
  "RF-TGB-03; ADR-29; EP-C-08",
  "La contraseña nunca debe pasar por Telegram.",
  "El bot registra un usuario, se canjea el OTP y se intenta un login web con contraseña.",
  "202; sesión con `hasExpediente: false`; `passwordHash` nulo; login web 401."),
 ("EP-C-08 valida acceptTerms, dominio y que la identidad no esté vinculada",
  "EP-C-08; RA-12 (aviso de no oficialidad)",
  "El alta exige aceptar el aviso de no oficialidad y el tratamiento de datos, y respeta las unicidades.",
  "Se registra sin aceptar términos, con una identidad ya vinculada y con un email existente.",
  "400; `CHANNEL_IDENTITY_TAKEN`; `EMAIL_TAKEN`."),
 ("el correo no se puede desactivar; Telegram solo si está vinculado",
  "EP-C-17; EP-C-18; RF-NOT-01",
  "El correo es obligatorio; Telegram es un canal adicional que solo se configura si está vinculado.",
  "Se leen las preferencias, se intenta desactivar el correo, activar Telegram sin vincular y, tras vincular, silenciar los mensajes de chat.",
  "Valores por defecto esperados; 400; 409; preferencias actualizadas."),
 ("las notificaciones del bot: no leídas, contador y marcar leída (EP-R-14..16)",
  "EP-R-14 a EP-R-16; RF-NOT-04",
  "El bot reutiliza los endpoints de notificaciones con los parámetros compatibles nuevos.",
  "Se consulta el contador, se lista con `unread=true&limit=1` y se marca como leída una propia y una inexistente.",
  "Contador mayor que cero; un elemento; 200 y 404."),
]),
(I, "MFA en el core", "test/integration/mfa.test.ts", [
 ("activar exige reautenticación previa (401 REAUTH_REQUIRED)",
  "RF-MFA-01; EP-C-21",
  "La activación emite un secreto y exige reautenticación.",
  "Un usuario recién logueado inicia el enrolamiento.",
  "401 `REAUTH_REQUIRED`."),
 ("CA-13: escanea y confirma → MFA activo, 10 códigos de recuperación (no-store) y notificación",
  "CA-13; RF-MFA-01 a RF-MFA-03; RF-MFA-10; §7.2.4; §7.2.8",
  "El factor queda pendiente hasta confirmarse con un código válido; al confirmar se entregan 10 códigos de recuperación una sola vez, se rota la sesión y se notifica.",
  "Reautenticación con contraseña errónea y correcta; enrolamiento; estado pendiente; confirmación errónea y correcta; nuevo enrolamiento.",
  "401 y 200; URI `xchanger-otp://`, cuenta enmascarada y secreto agrupado; `pendingEnrollment`; 401 y luego 200 con 10 códigos, `no-store` y cookies rotadas; `MFA_ENABLED`, notificación y evento; `MFA_ALREADY_ENABLED`."),
 ("cancelar un enrolamiento pendiente (EP-C-23)",
  "EP-C-23",
  "El usuario puede cerrar el modal sin dejar un factor pendiente.",
  "Se inicia y se cancela un enrolamiento.",
  "204 y `pendingEnrollment` nulo."),
 ("CA-14: contraseña correcta → 200 mfaRequired, sin cookies de sesión",
  "CA-14; EP-C-19; RF-MFA-04",
  "Ninguna cookie de sesión se emite antes del segundo factor.",
  "Un usuario con MFA inicia sesión.",
  "Cuerpo exacto `mfaRequired`; sin cookies de sesión; cookie `mfa_challenge` HttpOnly, SameSite=Strict y con ruta restringida."),
 ("el segundo paso emite la sesión y la cookie de reto deja de valer",
  "EP-C-24",
  "El reto es de un solo uso.",
  "Se completa el reto y se repite.",
  "200 con el usuario y cookies de sesión; la repetición da 410."),
 ("CA-15: un código ya usado se rechaza (401 MFA_INVALID_CODE, reason REPLAYED)",
  "CA-15; RF-MFA-05; §7.2.5 regla 4",
  "Un código observado no debe poder reutilizarse.",
  "Se usa un código en un login y el mismo en otro.",
  "El segundo da 401 con motivo `REPLAYED`."),
 ("cada reto admite como máximo 5 intentos; después hay que repetir el primer factor",
  "RF-MFA-06; §7.2.5 reglas 6 y 7",
  "Limita la fuerza bruta sobre un código de 6 dígitos.",
  "Cinco códigos erróneos, uno correcto sobre el reto agotado y un login nuevo.",
  "Restantes 4, 3, 2, 1 y 0; 410 `MFA_CHALLENGE_EXPIRED`; 423 `MFA_LOCKED` con `retryAfter`."),
 ("un código de recuperación sirve una vez, se registra y se notifica (RF-MFA-10)",
  "RF-MFA-03; RF-MFA-10; §7.2.6",
  "Los códigos de recuperación son de un solo uso, su uso queda auditado y se avisa al usuario.",
  "Se usa un código en minúsculas, se reutiliza y se envía junto con un XOTP.",
  "200; 401; `MFA_RECOVERY_USED` y notificación; 400."),
 ("el bloqueo solo se revela tras ambos factores (§7.3)",
  "§7.3 (orden de comprobaciones); RF-AUT-10",
  "Revelar el bloqueo tras el primer factor confirmaría la contraseña a un atacante.",
  "Un usuario con MFA bloqueado inicia sesión y completa el reto.",
  "`mfaRequired` y después 403 `ACCOUNT_BLOCKED`."),
 ("CA-17: mfa-service caído → 503 para usuarios con MFA; los demás entran con normalidad",
  "CA-17; ADR-23; ADR-28; AR-15",
  "El sistema falla cerrado para quien tiene MFA sin afectar al resto.",
  "El servicio cae; un usuario con MFA intenta completar el reto y uno sin MFA inicia sesión y consulta su estado.",
  "503 `MFA_SERVICE_UNAVAILABLE`; login 200; estado `{enabled: false, degraded: true}`."),
 ("RF-MFA-11: recuperar la contraseña no desactiva el MFA",
  "RF-MFA-11; §7.2.8",
  "La recuperación de contraseña no debe ser un atajo para eludir el segundo factor.",
  "Un usuario con MFA restablece la contraseña e inicia sesión.",
  "`mfaRequired`."),
 ("desactivar exige contraseña y código; borra el factor y notifica",
  "RF-MFA-07; §7.2.7",
  "Desactivar exige contraseña y código, y elimina el secreto (no solo lo marca).",
  "Contraseña errónea, falta de código, petición correcta y repetición.",
  "401; 400; 204, `mfaEnabled=false` y factor borrado; 409."),
 ("regenerar los códigos de recuperación anula los anteriores",
  "RF-MFA-08",
  "Los nuevos códigos invalidan los anteriores.",
  "Se regeneran y se intenta usar uno antiguo.",
  "10 códigos nuevos; el antiguo da 401."),
 ("RF-MFA-09: un administrador con ámbito restablece el MFA con motivo y revoca sesiones",
  "RF-MFA-09; EP-C-28; AR-05",
  "Recuperación ante pérdida del móvil y de los códigos, limitada al ámbito y con motivo obligatorio.",
  "Un embajador restablece con motivo corto, a un usuario fuera de su ámbito, a uno de su ámbito y repite.",
  "400; 403; 204 con MFA desactivado, refresh web anulado, sesión de canal revocada y log `MFA_RESET`; 409."),
 ("EP-C-20: el bot puede leer el estado MFA, pero no gestionarlo",
  "EP-C-20; §9.8 (\"la gestión de MFA no está disponible por canal\")",
  "El canal solo muestra el estado.",
  "El bot lee el estado e inicia un enrolamiento.",
  "200 y 403 `CHANNEL_FORBIDDEN_ROUTE`."),
]),
(I, "Bus de eventos, outbox y notificaciones multicanal", "test/integration/events.test.ts", [
 ("el evento se persiste en el outbox y el publicador lo lleva al stream con el sobre común",
  "§5.7; §11 (sobre común); ADR-22",
  "Los eventos se guardan en la misma base de datos y un publicador los lleva a Redis Streams con un formato estable para todos los consumidores.",
  "Se publica `academic.changed` con audiencia duplicada y se vacía el outbox.",
  "Un evento con id, tipo, versión 1, productor, audiencia deduplicada y fecha válida; outbox marcado como publicado."),
 ("un evento publicado dentro de una transacción revertida nunca sale",
  "§5.7 punto 2; Arquitectura §8.4",
  "Nunca debe anunciarse algo que luego se revierte.",
  "Se publica dentro de una transacción que falla.",
  "Ningún evento llega al stream."),
 ("conserva el orden de publicación",
  "§11 (\"orden por stream\")",
  "El bot debe recibir los eventos en el orden en que ocurrieron.",
  "Se publican 5 eventos.",
  "Llegan en el mismo orden."),
 ("solo una réplica publica a la vez (lock en Redis)",
  "§5.7 punto 3",
  "Con varias réplicas del core, solo una debe publicar para preservar el orden y evitar duplicados.",
  "Otra réplica tiene el lock; se intenta vaciar el outbox y luego se libera.",
  "0 y después 1 evento publicados."),
 ("los consumidores deduplican por id (entrega al menos una vez → efecto una vez)",
  "§11 (\"los consumidores deduplican por id\"); ADR-22",
  "La garantía es al menos una vez; el efecto debe producirse una sola vez.",
  "Se reinyecta un evento ya publicado.",
  "El manejador se ejecuta una vez."),
 ("un fallo del consumidor deja el evento pendiente y se reintenta",
  "AR-10 (correo sin reintentos); §5.7 punto 5",
  "La desviación AR-10 perdía correos fallidos; ahora el consumidor reintenta.",
  "El manejador falla la primera vez.",
  "Se ejecuta dos veces y no quedan mensajes pendientes."),
 ("notification.created lleva los datos del contrato y el correo lo envía el consumidor con HTML escapado",
  "§5.8; §11; RF-NOT-01; RF-NOT-06",
  "La notificación persistida se anuncia con su contrato, sin datos personales innecesarios, y el correo se construye con escapado.",
  "Se crea una notificación con HTML en asunto y contenido y se procesa con el consumidor de correo.",
  "Evento con los campos del contrato y sin el email; correo con `&lt;script&gt;` y sin la etiqueta original."),
 ("la notificación se persiste aunque el envío de correo falle",
  "RF-NOT-02",
  "La persistencia no depende del correo.",
  "Se crea una notificación sin consumidor de correo activo.",
  "La notificación existe en la base de datos."),
 ("la app web sigue sin depender de Socket.io en los servicios (AR-04)",
  "AR-04; RNF-06",
  "Los servicios no deben emitir directamente a Socket.io; deben publicar eventos.",
  "Se inspecciona el código fuente de todos los servicios.",
  "Ninguno contiene `getIo(` ni `emitToUser(`."),
]),

# ═════════════════════════════ E2E ═════════════════════════════
(E, "Web: registro, sesión y contrato de errores", "e2e/cypress/e2e/01-web-auth.cy.js", [
 ("CA-01..02: alta con OTP de correo real (Mailpit) e inicio de sesión",
  "CA-01; CA-02; RF-AUT-01 a RF-AUT-08",
  "Verifica el alta con el core real y un servidor SMTP real (Mailpit), incluida la cookie del reto.",
  "Registro con dominio ajeno y con dominio válido; lectura del OTP del correo real; verificación.",
  "`INVALID_EMAIL_DOMAIN`; 202 con `otp_token` HttpOnly; 201; `/auth/me` con rol Estudiante."),
 ("login, refresco y logout; /api es alias de /api/v1",
  "RF-AUT-11 a RF-AUT-13; §5.6",
  "Ciclo completo de sesión desde un cliente HTTP con cookies reales.",
  "Login, comprobación de la ruta de la cookie de refresco, refresco, logout y consulta.",
  "Cookie HttpOnly, ruta del refresh acotada, 200, 200 y 401."),
 ("RF-AUT-09: respuesta genérica idéntica para email inexistente y contraseña errónea",
  "RF-AUT-09",
  "Comprobación de extremo a extremo de la anti-enumeración.",
  "Dos logins fallidos de naturaleza distinta.",
  "Mismo estado y mensaje."),
 ("§5.10: errores con code estable y eco de X-Request-Id",
  "§5.10; §9.1",
  "El contrato de error se observa en el servidor real.",
  "Petición sin sesión con `X-Request-Id`.",
  "401 con `code` y `requestId` en cuerpo y cabecera."),
 ("EP-C-30: /health con marca de tiempo y dependencias desde la red interna",
  "EP-C-30; RNF-10",
  "La salud refleja las dependencias reales: PostgreSQL, Redis y el stub del mfa-service.",
  "`GET /health?deep=true`.",
  "`{db, redis, mfa}` en `up`."),
]),
(E, "Web: ofertas y chat", "e2e/cypress/e2e/02-offers.cy.js", [
 ("CA-04 + CA-06: publicar, encontrar la complementaria, aceptar, chatear y cerrar",
  "CA-04; CA-06; RF-OFE-01 a RF-OFE-10; RF-CHT-01 a RF-CHT-08",
  "Recorrido completo del caso de uso principal entre dos estudiantes reales con sesiones independientes.",
  "Ana publica; Beto busca, acepta y escribe; Ana lee, revisa notificaciones, cierra dos veces y escribe.",
  "Búsqueda exacta; ACCEPTED; mensaje guardado; notificaciones de aceptación y mensaje; cierre 200, luego `OFFER_ALREADY_CLOSED` y `CHAT_CLOSED`."),
 ("RF-NOT-01: las notificaciones también llegan por correo (consumidor email-sender)",
  "RF-NOT-01; RA-09; §5.7",
  "Doble canal: sistema y correo, ahora a través del bus de eventos y el consumidor de correo.",
  "Ana inicia sesión y publica una oferta; se consulta Mailpit de forma reiterada.",
  "Al menos dos correos (aviso de inicio de sesión y oferta publicada)."),
]),
(E, "Canal Telegram (consumidor externo de la API)", "e2e/cypress/e2e/03-telegram-channel.cy.js", [
 ("CA-18: vincular por código y operar como el bot",
  "CA-18; RF-TGB-01; RF-TGB-04",
  "Simula exactamente las peticiones HTTP del bot frente al core real.",
  "Vinculación completa y consultas de perfil, expediente, grupos y ofertas.",
  "Email correcto, una asignatura, tres grupos y lista paginada vacía."),
 ("CA-19: un update reintentado por Telegram crea una sola oferta",
  "CA-19; EP-C-29",
  "Idempotencia sobre el servidor real con Redis real.",
  "Dos POST idénticos con `tg:123456`.",
  "Mismo id, `Idempotent-Replayed` y una sola oferta."),
 ("CA-21: sin credencial de servicio → 401; rutas de administración → 403 CHANNEL_FORBIDDEN_ROUTE",
  "CA-21; RF-TGB-11",
  "Política de canal comprobada de extremo a extremo.",
  "Una Propietaria vinculada usa el token sin servicio y contra `/admin/logs`.",
  "401 y `CHANNEL_FORBIDDEN_ROUTE`."),
 ("refresco con rotación y desvinculación desde el bot (RF-TGB-09)",
  "RF-TGB-09; ADR-18",
  "Gestión del ciclo de vida de la sesión de canal.",
  "Refresco, revocación de identidad y nueva consulta.",
  "Token rotado; 204; 401."),
 ("CA-20: un embajador bloquea al usuario y el bot deja de poder operar",
  "CA-20; RF-TGB-10",
  "El bloqueo web se propaga al canal.",
  "La Propietaria bloquea a Ana y el bot consulta.",
  "200 al bloquear y 401 en el bot."),
 ("RF-TGB-03: alta desde el bot sin contraseña, con el OTP real de correo",
  "RF-TGB-03; ADR-29",
  "Alta completa por chat con correo real.",
  "Registro desde el bot, lectura del OTP en Mailpit y canje.",
  "202 y sesión con `hasExpediente: false`."),
]),
(E, "MFA con protocolo XOTP (core como relying party)", "e2e/cypress/e2e/04-mfa.cy.js", [
 ("CA-13 + CA-14: activar y entrar con segundo factor; sin cookies de sesión antes del código",
  "CA-13; CA-14; RF-MFA-01 a RF-MFA-04",
  "Integración real core ↔ mfa-service: el stub valida el JWT del core contra su JWKS, como haría el servicio real.",
  "Reautenticación, enrolamiento, confirmación con un código TOTP real y login con reto.",
  "Respuestas `no-store`, 10 códigos, `mfaRequired` exacto, sin `access_token` antes del código y `mfaEnabled: true` al final."),
 ("CA-15: reenviar un código ya usado → 401 REPLAYED",
  "CA-15; RF-MFA-05",
  "Antirreplay a través de la red.",
  "El mismo código se usa en dos logins.",
  "Segundo intento 401 con motivo `REPLAYED`."),
 ("CA-17: mfa-service caído → 503 para usuarios con MFA; los demás entran",
  "CA-17; AR-15",
  "Caída real del servicio dependiente.",
  "Se apaga el stub; login con y sin MFA.",
  "`MFA_SERVICE_UNAVAILABLE` y login normal."),
 ("CA-22: por el bot, OTP de correo + XOTP antes de emitir la sesión",
  "CA-22; RF-TGB-02",
  "Ningún canal elude el segundo factor, verificado con correo real y TOTP real.",
  "OTP por correo, canje, código XOTP y canje final.",
  "`mfaRequired` sin `accessToken`; después 200 con `mfaEnabled: true`."),
 ("RF-MFA-09: la propietaria restablece el MFA de un estudiante",
  "RF-MFA-09",
  "Recuperación administrativa de extremo a extremo.",
  "Activación, restablecimiento por la Propietaria y login del estudiante.",
  "204 y login posterior sin segundo factor."),
]),
]

# ─────────────────────────────────────────────────────────────────────────────

def render_test(n, t, kind):
    name, req, why, scen, exp = t
    return rf"""
\begin{{pruebabox}}{{{n}}}{{{esc(name)}}}
\begin{{tabularx}}{{\linewidth}}{{@{{}}>{{\bfseries}}p{{2.9cm}}X@{{}}}}
Tipo & {kind} \\
Requisito & {esc(req)} \\
Justificación & {esc(why)} \\
Escenario & {esc(scen)} \\
Resultado esperado & {esc(exp)} \\
\end{{tabularx}}
\end{{pruebabox}}
"""

def count(kind):
    c = 0
    for k, _, _, tests in SUITES:
        if k == kind:
            for t in tests:
                c += 4 if "4 ejecuciones" in t[0] else 1
    return c

nu, ni, ne = count(U), count(I), count(E)
total = nu + ni + ne
assert (nu, ni, ne) == (47, 102, 18), (nu, ni, ne)

body = []
n = 0
current = None
for kind, title, path, tests in SUITES:
    if kind != current:
        current = kind
        label = {U: "Pruebas unitarias", I: "Pruebas de integración", E: "Pruebas extremo a extremo (Cypress)"}[kind]
        intro = {
            U: "Verifican la lógica aislada del core sin base de datos ni red: utilidades, contrato de error, autenticación de servicios, cliente del mfa-service y reglas de validación. Se ejecutan con \\texttt{npm test} en aproximadamente un segundo.",
            I: "Ejercen la aplicación Express completa con Supertest contra PostgreSQL 15 y Redis 7 reales, levantados con \\texttt{docker-compose.test.yml}. El SMTP se sustituye por un buzón en memoria y el mfa-service por una simulación que implementa el contrato EP-M y supera los vectores RFC 6238. Antes de cada caso se vacían todas las tablas y Redis. Se ejecutan en serie con \\texttt{npm run test:integration}.",
            E: "Cypress actúa como cliente HTTP externo, igual que el navegador o el bot, contra el core arrancado como proceso real (\\texttt{src/server.ts}), con publicador de outbox y consumidores activos, un servidor SMTP real (Mailpit) y un stub HTTP del mfa-service que valida el JWT de servicio del core contra su JWKS (EP-C-02). Se ejecutan con \\texttt{npm run test:e2e}.",
        }[kind]
        body.append(rf"\section{{{label}}}" + "\n" + intro + "\n")
    body.append(rf"\subsection{{{esc(title)}}}" + "\n" + rf"\noindent\textit{{Fichero:}} \texttt{{{esc(path)}}}\par\medskip" + "\n")
    for t in tests:
        n += 1
        body.append(render_test(n, t, kind))

TEX = r"""\documentclass[11pt,a4paper]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[spanish,es-noshorthands]{babel}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage[a4paper,margin=2.3cm,headheight=14pt]{geometry}
\usepackage{xcolor}
\usepackage{booktabs}
\usepackage{amssymb}
\usepackage{tabularx}
\usepackage{array}
\usepackage{longtable}
\usepackage{titlesec}
\usepackage{fancyhdr}
\usepackage{enumitem}
\usepackage[most]{tcolorbox}
\usepackage[hidelinks,bookmarksnumbered]{hyperref}

\definecolor{marca}{HTML}{8B1E3F}
\definecolor{tinta}{HTML}{1F2933}
\definecolor{suave}{HTML}{F4F1F2}

\titleformat{\chapter}[display]{\normalfont\bfseries\color{marca}}{\large\MakeUppercase{\chaptertitlename}\ \thechapter}{4pt}{\Huge}
\titlespacing*{\chapter}{0pt}{-10pt}{18pt}
\titleformat{\section}{\normalfont\Large\bfseries\color{tinta}}{\thesection}{0.8em}{}
\titleformat{\subsection}{\normalfont\large\bfseries\color{marca}}{\thesubsection}{0.8em}{}

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{gray}xChanger --- Informe de Testing y Despliegue}
\fancyhead[R]{\small\color{gray}v1.0}
\fancyfoot[C]{\small\thepage}
\renewcommand{\headrulewidth}{0.4pt}

\newtcolorbox{pruebabox}[2]{enhanced,breakable,colback=white,colframe=marca!55,colbacktitle=suave,
  coltitle=tinta,fonttitle=\bfseries\small,title={P-#1\quad #2},boxrule=0.5pt,arc=1.5pt,
  left=5pt,right=5pt,top=3pt,bottom=3pt,before skip=6pt,after skip=6pt,fontupper=\small}

\setlength{\parskip}{0.45em}
\setlength{\parindent}{0pt}

\begin{document}

\begin{titlepage}
\centering
\vspace*{3cm}
{\color{marca}\rule{\linewidth}{1pt}}\\[0.6cm]
{\Huge\bfseries xChanger\\[0.3cm]}
{\LARGE Informe Oficial de Testing y Despliegue\\[0.3cm]}
{\large Core (API REST) tras el escalado: canal Telegram y MFA con XOTP v1}\\[0.4cm]
{\color{marca}\rule{\linewidth}{1pt}}\\[2cm]
\begin{tabular}{@{}ll@{}}
\toprule
Proyecto & xChangerMejorado \\
Ámbito & Core (backend Express, Prisma, Socket.io) \\
Fases cubiertas & F0 (preparación del core), F1 (MFA), F2 (bot MVP) \\
Documentos de referencia & Requisitos v1.0; Arquitectura v1.0; Escalado v1.0 \\
Fecha & Noviembre de 2026 \\
Versión & 1.0 \\
\bottomrule
\end{tabular}
\vfill
{\small Las referencias del tipo RF-, RA-, RNF-, CA-, DV-, AR- pertenecen al documento de Requisitos v1.0 y al de Arquitectura v1.0; las del tipo EP-, ADR-16 en adelante, RF-TGB-, RF-MFA- y CA-13 en adelante, al documento de Escalado.}
\end{titlepage}

\tableofcontents

%════════════════════════════════════════════════════════════════════
\chapter{Resumen ejecutivo}

El core de xChanger se ha ampliado para servir a dos clientes nuevos, el bot de Telegram y el mfa-service, sin romper el contrato existente con el frontend. Este informe documenta la verificación completa de esa evolución y la arquitectura con la que se despliega.

\begin{center}
\begin{tabular}{@{}lrrl@{}}
\toprule
Nivel & Casos & Resultado & Herramienta \\
\midrule
Unitarias & """ + str(nu) + r""" & """ + str(nu) + r""" superados & Jest + ts-jest \\
Integración & """ + str(ni) + r""" & """ + str(ni) + r""" superados & Jest + Supertest + PostgreSQL + Redis \\
Extremo a extremo & """ + str(ne) + r""" & """ + str(ne) + r""" superados & Cypress 13 + Mailpit + stub HTTP del mfa-service \\
\midrule
\textbf{Total} & \textbf{""" + str(total) + r"""} & \textbf{""" + str(total) + r""" superados} & \\
\bottomrule
\end{tabular}
\end{center}

\textbf{Cobertura de aceptación.} Los 22 escenarios de aceptación (CA-01 a CA-12 del documento original y CA-13 a CA-22 del escalado) están automatizados; los de mayor riesgo se verifican en dos niveles (integración y E2E).

\textbf{Desviaciones corregidas y blindadas por pruebas.} DV-01 (vencimiento de bloqueos), DV-02 (autobloqueo y bloqueo de Propietarios), DV-03 (doble aceptación), DV-05 (HTML sin escapar), DV-08 (sin límite de intentos), AR-04 (acoplamiento a Socket.io), AR-05 (cobertura de ámbito por curso), AR-06 (transiciones no atómicas) y AR-10 (correos sin reintento). Durante el trabajo se detectaron y corrigieron además dos defectos no inventariados: la eliminación de nodos académicos no cancelaba las ofertas (RF-ACA-06) y el borrado de cursos no comprobaba el ámbito (RF-ACA-09).

\textbf{Fuera de alcance de esta entrega.} El mfa-service y el bot de Telegram son microservicios independientes; en las pruebas se sustituyen por dobles que respetan sus contratos. Quedan pendientes EP-C-15 y EP-C-16 (fase F3), la comprobación de ámbito en tickets (DV-04) y la confirmación de borrado en servidor (DV-06).

%════════════════════════════════════════════════════════════════════
\chapter{Testing}

\section{Estrategia}

La estrategia sigue una pirámide de tres niveles alineada con los métodos de verificación del documento de requisitos (§11.1: los RF y RI se verifican con test automático).

\begin{description}[style=nextline,leftmargin=1.2cm]
\item[Unitarias] Lógica pura: sin red ni base de datos. Detectan regresiones en milisegundos.
\item[Integración] El core completo frente a sus dependencias reales (PostgreSQL y Redis). Es el nivel con más casos porque la mayoría de los requisitos dependen de la base de datos: transacciones, borrado lógico, unicidades, ámbito y concurrencia.
\item[Extremo a extremo] El proceso del core tal como se despliega, consumido por HTTP desde fuera, con correo real y con un mfa-service por red. Valida los contratos entre servicios y los flujos que atraviesan varios componentes.
\end{description}

\subsection{Principios de diseño de las pruebas}
\begin{itemize}[leftmargin=*]
\item \textbf{Trazabilidad:} cada caso cita en su título el requisito o escenario que valida; la columna \emph{Requisito} de este informe lo amplía.
\item \textbf{Aislamiento:} antes de cada caso de integración se vacían las 21 tablas y Redis; la ejecución es en serie para que ningún caso observe datos de otro.
\item \textbf{Dependencias reales donde importan:} la concurrencia (CA-05), la idempotencia y el bus de eventos solo pueden comprobarse con PostgreSQL y Redis reales; por eso no se simulan.
\item \textbf{Dobles fieles al contrato:} la simulación del mfa-service implementa ventana $\pm1$, antirreplay, bloqueo tras 5 fallos y códigos de recuperación de un solo uso, y supera los vectores RFC 6238 obligatorios (§7.2.3). Su reloj es inyectable para obtener pasos TOTP posteriores sin esperar 30 segundos.
\item \textbf{El cliente externo no se implementa:} el bot y la app XOTP quedan fuera del alcance; las pruebas reproducen sus peticiones HTTP según los contratos de los §9 y §10 del escalado.
\end{itemize}

\subsection{Entorno de ejecución}
\begin{center}
\begin{tabularx}{\linewidth}{@{}lX@{}}
\toprule
Componente & Configuración \\
\midrule
PostgreSQL 15 & Contenedor efímero en \texttt{tmpfs}, puerto 55432; migraciones aplicadas por \texttt{globalSetup}. \\
Redis 7 & Contenedor efímero, puerto 56379. \\
Mailpit & SMTP en 51025 y API en 58025; Cypress lee de ahí los OTP reales. \\
mfa-service & Integración: \texttt{FakeMfaGateway} en proceso. E2E: \texttt{test/stubs/mfa-stub.ts} por HTTP en 58081, que valida el JWT de servicio contra el JWKS del core. \\
Core & Integración: \texttt{createApp()} sin abrir puerto. E2E: \texttt{src/server.ts} en el puerto 3100 con el outbox y los consumidores activos. \\
\bottomrule
\end{tabularx}
\end{center}

\subsection{Ejecución}
\begin{center}
\begin{tabular}{@{}ll@{}}
\toprule
Orden & Qué ejecuta \\
\midrule
\texttt{npm test} & Unitarias \\
\texttt{npm run test:integration} & Levanta la infraestructura y ejecuta integración en serie \\
\texttt{npm run test:e2e} & Levanta infraestructura, stub y core; ejecuta Cypress \\
\texttt{npm run test:all} & Los tres niveles en orden \\
\bottomrule
\end{tabular}
\end{center}

\subsection{Matriz de escenarios de aceptación}
\begin{center}
\small
\begin{longtable}{@{}lp{6.2cm}cc@{}}
\toprule
Escenario & Descripción & Integración & E2E \\
\midrule
\endhead
CA-01 & Registro con dominio ajeno & \checkmark & \checkmark \\
CA-02 & OTP correcto crea la cuenta & \checkmark & \checkmark \\
CA-03 & OTP caducado & \checkmark & \\
CA-04 & Búsqueda complementaria & \checkmark & \checkmark \\
CA-05 & Aceptación concurrente & \checkmark & \\
CA-06 & Mensaje y notificaciones & \checkmark & \checkmark \\
CA-07 & Bloqueo fuera de ámbito & \checkmark & \\
CA-08 & Bloqueo: ofertas inactivas y sesión inválida & \checkmark & \\
CA-09 & Vencimiento de bloqueo temporal & \checkmark & \\
CA-10 & Eliminación con referencias & \checkmark & \\
CA-11 & Mensaje en ticket cerrado & \checkmark & \\
CA-12 & Log limitado al ámbito & \checkmark & \\
CA-13 & Activación de MFA & \checkmark & \checkmark \\
CA-14 & Login con MFA sin cookies previas & \checkmark & \checkmark \\
CA-15 & Código reutilizado & \checkmark & \checkmark \\
CA-16 & QR con firma alterada & \multicolumn{2}{c}{Responsabilidad de la app XOTP} \\
CA-17 & mfa-service caído & \checkmark & \checkmark \\
CA-18 & Vinculación por código & \checkmark & \checkmark \\
CA-19 & Update reintentado & \checkmark & \checkmark \\
CA-20 & Bloqueo de usuario vinculado & \checkmark & \checkmark \\
CA-21 & Token de canal fuera de política & \checkmark & \checkmark \\
CA-22 & Login por bot con MFA & \checkmark & \checkmark \\
\bottomrule
\end{longtable}
\end{center}
CA-16 verifica la firma Ed25519 en la aplicación autenticadora, que queda fuera del core por la restricción de alcance; el core no genera ni verifica la firma del QR (lo hace el mfa-service, ADR-25).

\section*{Catálogo detallado de pruebas}
\addcontentsline{toc}{section}{Catálogo detallado de pruebas}
A continuación se documenta cada prueba con su tipo, el requisito validado y su justificación, el escenario y el resultado esperado. La numeración P-\emph{n} es correlativa en todo el informe.

""" + "".join(body) + r"""

%════════════════════════════════════════════════════════════════════
\chapter{Despliegue}

\section{Visión general}
El sistema se despliega como un conjunto de contenedores orquestados con Docker Compose en una máquina virtual de Microsoft Azure. Cloudflare actúa como borde: resuelve el dominio, termina TLS frente al usuario y reenvía el tráfico al origen cifrado. En la máquina virtual, Nginx es el único proceso que escucha en la red pública.

\begin{center}
\small
\begin{tabular}{@{}c@{}}
Navegador / Telegram \\ $\downarrow$ HTTPS (certificado de borde de Cloudflare) \\
\fbox{Cloudflare: DNS proxificado, TLS, WAF} \\ $\downarrow$ HTTPS (modo \emph{Full (strict)}, certificado de origen) \\
\fbox{VM de Azure: NSG con 443 abierto solo a rangos de Cloudflare} \\ $\downarrow$ \\
\fbox{Nginx} $\rightarrow$ \fbox{Frontend Astro} \quad \fbox{Core Express + Socket.io} \\ $\downarrow$ red Docker privada \\
\fbox{PostgreSQL 15} \quad \fbox{Redis 7} \\
\end{tabular}
\end{center}

\section{Orquestación con Docker Compose}
\begin{center}
\begin{tabularx}{\linewidth}{@{}llX@{}}
\toprule
Servicio & Imagen & Comportamiento \\
\midrule
db & postgres:15-alpine & Volumen persistente; comprobación de salud con \texttt{pg\_isready}; sin puerto publicado. \\
redis & redis:7-alpine & AOF activado y volumen persistente; comprobación con \texttt{redis-cli ping}; sin puerto publicado. Soporta el bus de eventos, el limitador, la idempotencia y el adaptador de Socket.io. \\
backend & node:20, dos etapas & Espera a \texttt{db} y \texttt{redis} sanos; aplica las migraciones pendientes al arrancar (RCF-06) y valida el entorno con Zod (RCF-02). El puerto 3000 ya no se publica (AR-02). \\
frontend & node:20, dos etapas & Astro SSR; llama al core por la red interna. \\
nginx & nginx:1.27-alpine & Único punto de entrada. Encamina \texttt{/api} y \texttt{/socket.io} al core y el resto al frontend; devuelve 404 para \texttt{/api/(v1/)service-auth} y \texttt{/api/(v1/)internal} (escalado §12.2). \\
\bottomrule
\end{tabularx}
\end{center}

El orden de arranque forma una cadena con condición de salud, de modo que ningún contenedor recibe tráfico antes de poder atenderlo. El core comprueba la base de datos y Redis antes de abrir el puerto y se cierra limpiamente ante \texttt{SIGTERM} (RNF-05).

\paragraph{Procedimiento de despliegue.}
\begin{enumerate}[leftmargin=*,itemsep=0pt]
\item Actualizar el código en la VM (\texttt{git pull} o descarga de imágenes versionadas, RCF-07).
\item Revisar \texttt{.env} y \texttt{backend/.env}; las variables nuevas obligatorias son \texttt{JWT\_CHANNEL\_SECRET}, \texttt{SERVICE\_JWT\_PRIVATE\_KEY} y \texttt{SERVICE\_CLIENTS}.
\item \texttt{docker compose up -d --build}; las migraciones se aplican solas.
\item Verificar \texttt{GET /health} desde fuera y \texttt{GET /health?deep=true} desde la red interna.
\end{enumerate}
\textbf{Reversión:} volver a la etiqueta anterior y repetir el paso 3. Las migraciones del escalado solo añaden tablas, columnas nulables e índices, por lo que la versión anterior del core sigue funcionando sobre el esquema nuevo.

\section{Infraestructura en Microsoft Azure}
\begin{itemize}[leftmargin=*,itemsep=2pt]
\item \textbf{Máquina virtual Linux} con Docker Engine y el plugin de Compose. Los datos de PostgreSQL y Redis residen en volúmenes con nombre sobre el disco gestionado de la VM.
\item \textbf{Grupo de seguridad de red (NSG):} entrada permitida solo al puerto 443 (y 80 si se mantiene la redirección), restringida a los rangos IP publicados por Cloudflare; SSH limitado a direcciones de administración. Ningún otro puerto es accesible.
\item \textbf{Copias de seguridad:} instantáneas del disco gestionado y volcados periódicos de PostgreSQL fuera de la VM.
\item \textbf{Secretos:} nunca forman parte de la imagen; se inyectan por los ficheros \texttt{.env} de la VM (RCF-01). La evolución prevista (F4) es Azure Key Vault para la clave de firma de servicios.
\end{itemize}

\section{TLS y red con Cloudflare}
\begin{itemize}[leftmargin=*,itemsep=2pt]
\item \textbf{DNS proxificado:} el registro del dominio apunta a la IP pública de la VM con el proxy de Cloudflare activo, de modo que la IP de origen no queda expuesta.
\item \textbf{Cifrado de extremo a extremo:} modo SSL/TLS \emph{Full (strict)}. Cloudflare presenta su certificado al usuario y valida en el origen un certificado de origen emitido por Cloudflare e instalado en Nginx. Se fuerza HTTPS y se activa HSTS, lo que resuelve AR-01 y permite las cookies \texttt{Secure}.
\item \textbf{Autenticación del origen:} \emph{Authenticated Origin Pulls} o la restricción del NSG a los rangos de Cloudflare impiden saltarse el borde.
\item \textbf{IP real del cliente:} Nginx toma la IP de \texttt{CF-Connecting-IP} solo cuando la petición procede de rangos de Cloudflare; el core usa \texttt{trust proxy} y \texttt{req.ip} (AR-02), de lo que dependen el limitador de intentos y el historial de accesos.
\item \textbf{WebSocket:} Cloudflare reenvía la actualización de protocolo de \texttt{/socket.io}; Nginx mantiene las cabeceras \texttt{Upgrade} y \texttt{Connection}.
\item \textbf{Webhook del bot (cuando se despliegue):} \texttt{POST /telegram/webhook} pasará por el mismo borde; Telegram exige HTTPS válido, que Cloudflare proporciona.
\end{itemize}

\section{Variables de entorno nuevas}
\begin{center}
\small
\begin{tabularx}{\linewidth}{@{}lX@{}}
\toprule
Variable & Uso \\
\midrule
\texttt{REDIS\_URL} & Bus de eventos, límites, idempotencia y adaptador de sockets. \\
\texttt{JWT\_CHANNEL\_SECRET} & Firma de tokens de canal (al menos 32 caracteres). \\
\texttt{SERVICE\_JWT\_PRIVATE\_KEY}, \texttt{SERVICE\_JWT\_KID} & Clave ES256 de los JWT de servicio; obligatoria en producción. \\
\texttt{SERVICE\_CLIENTS} & Clientes de servicio con el SHA-256 de su secreto y sus scopes. \\
\texttt{CHANNEL\_*} & Caducidades de sesión de canal y URL de la página de aprobación. \\
\texttt{MFA\_SERVICE\_URL}, \texttt{MFA\_TIMEOUT\_MS} & Cliente del mfa-service. \\
\texttt{TRUST\_PROXY\_HOPS}, \texttt{OUTBOX\_POLL\_MS} & Proxy de confianza e intervalo del publicador. \\
\bottomrule
\end{tabularx}
\end{center}

\end{document}
"""

open(OUT, "w").write(TEX)
print(f"OK: {n} bloques, {total} ejecuciones -> {OUT}")
