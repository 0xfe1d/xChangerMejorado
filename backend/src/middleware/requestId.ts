import { Request, Response, NextFunction } from 'express';
import { newUlid } from '../utils/ids';
import { requestContext } from '../utils/request-context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Propaga X-Request-Id (o genera un ULID) hacia log, eventos y errores. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && VALID_ID.test(incoming) ? incoming : newUlid();
  res.setHeader('X-Request-Id', req.requestId);
  requestContext.run({ requestId: req.requestId }, next);
}
