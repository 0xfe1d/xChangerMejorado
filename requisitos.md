Documento de requisitos general

Descripción
La finalidad de xChanger es funcionar como un software para permitir un cambio de grupos dentro de tu carrera y curso de manera eficaz y rápida.

Ámbito
El ámbito de xChanger es la Universidad de Cantabria, aunque se podría llegar a escalar a un entorno global de universidades.

Requisitos
Debe permitir crear cuentas e iniciar sesión en cuentas
Cada cuenta debe recoger nombre, email (que debe corresponder con un email institucional @alumnos.unican.es), carrera que estudia,  curso que estudia y contraseña
El nombre y carrera deben ser campos que puedan modificarse por el propio usuario.
El email del usuario será único en el sistema.
La contraseña tendrá como mínimo 8 caracteres entre los cuales uno debe ser mayúsculo, uno minúsculo, uno un número y uno un símbolo.
Para verificar el correo se utilizará una notificación en tiempo de registro mediante un código OTP con una máxima duración de 30 minutos (se usará token JWT al momento de registrarse para verificar la integridad de la información).
Una vez creada la cuenta el usuario deberá (de manera obligatoria) seleccionar las asignaturas de las que está matriculado (puede cambiarlas más adelante).
Habrá cuatro tipos de roles: bloqueado, estudiante, embajador y propietario. Cada rol se define por las acciones que puede realizar.
Habrá las siguientes acciones diferentes:
Iniciar sesión: esta acción permite iniciar sesión al usuario.
Agregar oferta: esta acción permite al usuario agregar una oferta (es decir, está interesado en realizar un cambio de grupo).
Apuntarse a una oferta: esta acción permite al usuario apuntarse a una oferta de cambio de grupo.
Editar ajustes: esta acción permite al usuario editar sus ajustes.
Agregar curso: esta acción permite al usuario agregar cursos a las carreras que se le han proporcionado como ámbito de administración
Abrir ticket: abrir un ticket para escribir a administración o tu embajada local.
Ver tickets: permite ver los tickets de los usuarios. Podrás ver todos los tickets de aquellos usuarios que se encuentren en tu ámbito de administración.
Eliminar curso: esta acción permite al usuario eliminar cursos a las carreras que se le han proporcionado como ámbito de administración. Solo permitido si esta carrera está contenida en tu ámbito.
Bloquear usuario: esta acción permite al usuario bloquear a otro usuario que se encuentre dentro de su ámbito.
Agregar carrera: esta acción permite al usuario agregar una nueva carrera al sistema. Se le añade esta carrera de manera automática al ámbito a quien la ha creado y a todo aquel con la acción de Owner.
Eliminar carrera: esta acción permite al usuario eliminar una carrera del sistema.
Auditar el log: esta acción permite al administrador auditar el log del sistema dentro del ámbito del usuario.
Agregar administrador: esta acción permite que se puedan agregar embajadores. Al momento de la creación debe indicarse el ámbito de administración que tendrá tal embajador.
Eliminar administrador: esta acción permite que se puedan eliminar embajadores.
Modificar ámbito: esta acción permite modificar el ámbito de un usuario. Solo se puede modificar el ámbito de administración a un usuario cuyo ámbito de administración esté contenido en el mío y lo podré modificar a un ámbito como mucho contenido en mi ámbito.
Realizar pago: es una acción que aún no será implementada pero se dejará como acción para cuando se decidan implementar los pagos.
Owner: acción con fines administrativos. Tienen control total sobre la administración del sistema y su ámbito de administración es total.
Toda acción que se acometa debe quedar reflejada en el log del sistema asociada a la fecha en la que se ha producido y el usuario responsable.
Se debe tener en cuenta que todo lo relacionado con los pagos irá en un log a parte y más detallado.
El ámbito de administración se refiere a la carrera que te han asignado como responsabilidad de administración: a la hora de agregar un embajador se deberá escoger la carrera sobre la que es embajador (que puede no tener nada que ver con la carrera que está estudiando el usuario). 
A un embajador se le pueden tener que poder asignar varias carreras como ámbito de administración
También se puede tener que poder reducir el ámbito de administración a solo un curso de la carrera y no la carrera completa. 
Es decir, el ámbito de administración se puede ver como el conjunto de pares (carrera, curso) sobre los que un usuario tiene poderes de administración. 
Un usuario puede ser bloqueado de manera permanente o temporal (hasta una fecha y hora determinada). Siempre que se bloquea a un usuario el administrador deberá indicar el motivo por el que se bloquea al usuario.
Una carrera tiene diferentes cursos, un curso tiene diferentes asignaturas y cada asignatura puede tener diferentes grupos de prácticas.
Los usuarios deben ser capaces de 
Se definen las acciones que dispone cada uno de los roles predefinidos:
Bloqueado: no tiene ninguna acción permitida.
Usuario: 
Iniciar sesión
Agregar oferta
Apuntarse a una oferta
Realizar pago
Abrir ticket
Editar ajustes
Embajador
Todos los de Usuario
Agregar curso
Ver tickets
Eliminar curso
Bloquear usuario
Agregar carrera
Eliminar carrera
Modificar ámbito
Propietario: todas las acciones (incluida Owner)
El sistema contará con un sistema de ticketing:
En el sistema de ticketing un usuario puede abrir un ticket, para abrir un ticket se necesitará un asunto y mensaje
Ese ticket llegará a un administrador con la capacidad de ver tickets cuyo ámbito de administración involucre al usuario.
El administrador podrá verlos desde su panel de administración que posteriormente hablaremos de él y podrá filtrar por asunto y/o usuario.
Una vez lo seleccione (el administrador dispone de una vista con todos los tickets, después se comentará) se podrá observar un chat en el que el administrador puede escribir al usuario.
El cliente también puede ver sus tickets abiertos desde su pestaña de usuario (más adelante se hablará de esta pestaña de usuario) y al seleccionarlo se le abrirá la misma pestaña de chat (solo que los mensajes y disposición serán la opuesta que para el administrador).
En el chat aparecerá el nombre del usuario en cada mensaje (tanto para el “cliente”/usuario que abre el ticket como para el administrador que lo modera ya que podría cambiar, teniendo en cuenta el ámbito de administración).
Tanto el usuario como el administrador tienen la capacidad de cerrar el ticket.
Los tickets cerrados ya no aparecerán en la sección de tickets del administrador (solo aparecen los tickets abiertos en esta sección).
Habrá una opción en la sección de ver tickets que permitirá ir a una nueva pestaña y permitirá filtrar tickets ya cerrados por asunto y/o por usuario.
Cada vez que se envía un mensaje le llegará una notificación al usuario que creó el ticket.
En el footer de la aplicación aparecerá el logo de la universidad de cantabria (se dejará en la carpeta de resources) y un aviso de que esta web no tiene ningún valor oficial ni ha sido creada por la Universidad de Cantabria, su uso tiene como objetivo simplemente coordinar al alumnado.
Al igual que habrá un footer en cada pestaña del sistema con esos requisitos habrá un navbar (excepto en las pestañas de login y registro) conformado por un símbolo de usuario en la parte derecha. Si lo presionas sin haber iniciado sesión te llevará a iniciar sesión. Si lo presionas habiendo iniciado sesión te mostrará un desplegable con las opciones: ir al panel de usuario, ir a ajustes, ir a administración (solo si tienes acciones de administrador).
La contraseña debe guardarse en la base de datos bajo un hash seguro utilizando bcrypt.
El sistema no debe ser vulnerable a inyecciones SQL ni ninguna otra vulnerabilidad del OWASP.
La página será creada utilizando Astro en el FrontEnd y NodeJS con Express en el backend. Se podrán utilizar más tecnologías a gusto del diseñador y arquitecto.
Se utilizará una base de datos SQL específicamente PostgreSQL para el desarrollo del sistema.
Habrá diferentes pestañas, como mínimo habrá:
Una pestaña de login en la que el usuario podrá iniciar sesión con el email y la contraseña.
Si no ha creado una cuenta aún, puede crearse la cuenta desde esta pestaña
Una pestaña en la que el usuario pueda registrarse con el nombre, email, contraseña (debe haber también un campo para verificar la contraseña), carrera que está estudiando (mediante un desplegable con filtro), una vez que la escoja debe escoger el curso. 
Si ya había creado una cuenta debe ser posible ir a la pestaña de iniciar sesión
Si el usuario no tiene la acción de iniciar sesión no puede iniciar sesión (significa que está bloqueado) en tal caso al intentar iniciar sesión le aparecerá un modal que le indicará que está bloqueado y no puede hacer uso de este sistema (le indicará la fecha hasta la que no puede hacer uso del sistema si es que el bloqueo es temporal y si es permanente se indicará que el bloqueo ha sido permanente) así como se indicará el motivo del bloqueo.
Una vez haya iniciado sesión exitosamente se redirige al usuario a la pestaña del usuario o panel de usuario, aquí el usuario puede hacer entre otras cosas:
El primer módulo que te encuentras en el panel de usuario es el que te permite inscribirte en un cambio de grupo. Este está formado por tres componentes UI:
Un input de texto desplegable (te permite escribir pero el contenido debe estar dentro de las opciones) para indicar la asignatura de la que deseas cambiarte.
Un input de texto desplegable (igual que el anterior) para indicar el grupo que DESEAS (no el que tienes) en esa asignatura.
Un input de texto desplegable (igual que el anterior) para indicar el grupo que TIENES (no el que deseas) en esa asignatura.
Un botón para buscar.
En caso de que no haya ninguna oferta disponible se dará la opción (siempre que tenga la acción permitida) de crear una oferta al usuario. Se creará una notificación cuando se cree una oferta informando al usuario.
En el momento en el que un usuario se inscribe exitosamente en una oferta de cambio de grupo se creará una notificación tanto para el que creó la oferta como al que se ha inscrito. En dicha notificación aparecerá el nombre y email de quien ha aceptado la oferta así como el que la ha creado para que puedan ponerse en contacto. Así mismo se reutilizará la arquitectura de chat de ticketing para que una vez aceptada la oferta (desde el panel de cliente) el usuario pueda chatear con el que ha aceptado la oferta y viceversa. Estos chats pueden ser cerrados también por cualquiera de las partes (no se pueden volver a abrir en tal caso) y una vez se envía un mensaje por cualquiera de las partes en este chat se creará una notificación a AMBAS PARTES.
Habrá un módulo en este panel de usuario que permita ver los anuncios (con su fecha y hora de creación) que están abiertos/aceptados/cerrados por el usuario. Desde este módulo el usuario puede:
Cerrar un anuncio (u ocultar anuncio si es que no lo has creado tú)
Si el anuncio ha sido aceptado (se ha inscrito alguien) se podrá chatear con esa persona (con lo dicho anteriormente).
Aparecerá cada anuncio en formato tabular con las columnas: grupo que ofrezco, grupo que deseo, estado (abierto/aceptado/cerrado, aparecerá en colores adecuados y que permitan diferenciar los estados) y acción (aquí aparecerá la opción de cerrar anuncio si su estado es abierto o de chatear si ha sido aceptado)
Los anuncios aparecerán en orden de más reciente a menos.
Habrá una pestaña de administración conformada por los siguientes módulos:
Módulo de ticketing (solo si tiene permiso para Ver Tickets)
Permite ver los tickets abiertos que están dentro del ámbito de administración del usuario.
De cada ticket aparece en esa lista: el asunto del ticket, la fecha y hora en que fue creado y el usuario que ha creado el ticket.
Al seleccionar uno de estos tickets el usuario abre un chat en el que puede hablar con el usuario que abrió el ticket (el chat no necesita que la interacción sea en tiempo real, solo que en el momento de refresco la información sea la más reciente en el sistema).
El estilo del chat debe ser similar a whatsapp con su filosofía de cajitas alineadas a la derecha para los mensajes que escribo yo y a la izquierda para los mensajes que escribe él.
En cada mensaje aparecerá el nombre del autor del mensaje (téngase en cuenta que el administrador que lleva el ticket podría cambiar aunque quien abra el ticket no cambie).
Módulo de owner: permite agregar y eliminar administradores (solo disponible si tienes las acciones correspondientes). Al seleccionar cualquiera de las dos opciones se abrirá un modal con un input de texto que se autorrellena con nombre y/o email del usuario sobre el que queremos aplicar esa acción (también aunque se autocompleta aparece una lista de los candidatos que van siendo posibles a partir del nombre y/o email escrito).
Módulo de búsqueda de carrera: permitirá escoger una carrera (por input text de autocompletado con opciones disponibles en función de tu ámbito de administración: la carrera que escojas debe estar dentro de tu ámbito aunque tu ámbito se restrinja a un solo curso de tal carrera), esto te llevará al panel de administración de la carrera.
Panel de administración de la carrera: tiene los siguientes módulos
Agregar y eliminar cursos: permitirá agregar y eliminar cursos de esta carrera solo si tienes tales acciones asignadas.
Si se elimina un curso para la que hay ofertas o referencias vinculadas se generará una notificación avisando de que la asignatura ha sido eliminado a todo usuario que se vea afectado por ello y se borrará todas las referencias vinculadas. Aun así si hay referencias a este curso aparecerá una ventana de confirmación al administrador avisándole de que hay referencias a este curso.
Hay otro módulo en el que si seleccionas el curso (mediante un input text de selección con las opciones disponibles) te aparecerá en la parte inferior las asignaturas disponibles en formato tabular con columnas: código de la asignatura (debe ser único), nombre de la asignatura, y acciones. Las acciones son administrar grupos o editar detalles de la asignatura. Si seleccionas administrar grupos te llevará al panel de administración de grupos correspondiente.
Agregar o eliminar asignatura: te permitirá agregar una asignatura (mediante el código y nombre de la asignatura) o eliminar asignatura (solo si tienes las correspondientes acciones asignadas a tu usuario).
Si se elimina una asignatura para la que hay ofertas o referencias vinculadas se generará una notificación avisando de que la asignatura ha sido eliminado a todo usuario que se vea afectado por ello y se borrará todas las referencias vinculadas. Aun así si hay referencias a este asignatura aparecerá una ventana de confirmación al administrador avisándole de que hay referencias a este asignatura.
Panel de administración de grupos:
En primer lugar tiene un módulo que permite observar todas los grupos disponibles en la asignatura de ese curso de esa carrera.
En la parte inferior habrá dos botones: agregar grupo y eliminar grupo.
Si se elimina un grupo para la que hay ofertas o referencias vinculadas se generará una notificación avisando de que la asignatura ha sido eliminado a todo usuario que se vea afectado por ello y se borrará todas las referencias vinculadas. Aun así si hay referencias a este grupo aparecerá una ventana de confirmación al administrador avisándole de que hay referencias a este grupo.
Panel para editar ajustes del usuario: desde este panel se permitirá al usuario modificar su nombre, la carrera en la que está así como su curso.
Panel del log: este panel está compuesto por un filtro en la parte superior y un log completo en el que aparezca en formato tabular con columnas: fecha y hora, usuario, acción. Al clickar encima de un log se abrirá un modal que mostrará los detalles y parámetros de la petición que se hizo para completar esa acción en formato “raw” (por ejemplo si es un agregar asignatura pues aparecerá: name, id_of_career, code_subject, etc.). Solo podrás acceder a los logs de tu ámbito de administración y solo si tienes la acción suficiente como para ver logs.
Panel de notificaciones: en este panel el usuario podrá observar en formato tabular con columnas: fecha y hora y asunto cada una de las notificaciones que ha recibido, al hacer click sobre una de ellas se desplegará un modal con los detalles de la notificación.
Todas las notificaciones se harán llegar tanto al usuario (a las que tendrá acceso por el panel de notificaciones) como por correo al correo del usuario. Para ello se utilizará una cuenta de correo (que no necesariamente tiene por qué ser una cuenta @alumnos.unican.es puede ser @gmail.com así que toda la parte de SSL puerto y dominio debe poderse configurar).
Toda la parte configurable de las credenciales de la base de datos, credenciales de la cuenta de correo, secretos se aislarán en un archivo .env (que luego pasará a formar parte de las variables de entorno del servidor).

























