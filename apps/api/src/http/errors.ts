import { domainError, DomainException, HTTP_STATUS, type DomainError } from '@team-finder/domain';
import type { FastifyError, FastifyInstance } from 'fastify';
import { isDbUnavailableError } from '../db/client.ts';

function send(reply: import('fastify').FastifyReply, error: DomainError) {
  const status = HTTP_STATUS[error.code];
  if (error.code === 'RATE_LIMITED') reply.header('retry-after', String(error.details.retryAfterSeconds));
  return reply.status(status).send(error);
}

/**
 * One place that turns failures into the `{ code, message, details, hint }` envelope. DomainErrors
 * are logged at warn with their code; unexpected errors at error with route and org.
 */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof DomainException) {
      request.log.warn({ code: err.error.code, orgId: request.actor?.orgId }, err.message);
      return send(reply, err.error);
    }
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return send(reply, domainError('UNSUPPORTED_MEDIA_TYPE', {}));
    }
    if (isDbUnavailableError(err)) {
      request.log.error({ err, route: request.routeOptions.url }, 'database unavailable');
      return send(reply, domainError('DB_UNAVAILABLE', {}));
    }
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify's own client errors: malformed JSON, empty JSON body, body too large...
      return send(reply, domainError('VALIDATION', { issues: [{ path: '', message: err.message }] }));
    }
    request.log.error({ err, route: request.routeOptions.url, orgId: request.actor?.orgId }, 'unexpected error');
    return send(reply, domainError('INTERNAL', { requestId: String(request.id) }));
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, domainError('NOT_FOUND', { resource: `route ${request.method} ${request.url.split('?')[0]}` })),
  );
}
