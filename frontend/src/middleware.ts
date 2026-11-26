import { defineMiddleware } from 'astro:middleware';

/**
 * Cuando una página redirige a /login por no tener sesión, se añade ?next=<ruta>
 * para que la página de login, tras renovar la sesión con la cookie de refresco
 * ("Recordar inicio de sesión") o tras iniciar sesión, devuelva al usuario allí.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const { pathname, search } = context.url;
  if (
    response.status >= 300 && response.status < 400 &&
    response.headers.get('location') === '/login' &&
    pathname !== '/login' && pathname !== '/'
  ) {
    return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`, response.status as 302);
  }
  return response;
});
