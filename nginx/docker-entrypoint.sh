#!/bin/sh
set -e

mkdir -p /var/www/certbot /etc/nginx/conf.d

# Sustituye solo ${NGINX_HOST}; las variables nginx ($host, $scheme…) se conservan intactas
substitute() {
  envsubst '${NGINX_HOST}' < "$1" > /etc/nginx/conf.d/default.conf
}

# Siempre arrancamos en HTTP: sirve la app y el challenge ACME mientras esperamos certs
substitute /etc/nginx/templates/http.conf.template

if [ "${ENABLE_HTTPS}" != "true" ]; then
  exec nginx -g "daemon off;"
fi

# Modo HTTPS: nginx en background en HTTP; esperamos a que certbot escriba los certs
nginx -g "daemon off;" &
NGINX_PID=$!

CERT="/etc/letsencrypt/live/${NGINX_HOST}/fullchain.pem"
echo "[nginx] Esperando certificados en ${CERT}..."

until [ -f "${CERT}" ]; do
  sleep 5
done

echo "[nginx] Certs encontrados. Activando HTTPS..."
substitute /etc/nginx/templates/https.conf.template
nginx -s reload
echo "[nginx] HTTPS activo en ${NGINX_HOST}"

# Mantenemos el proceso en primer plano
wait $NGINX_PID
