/**
 * Request/correlation ID resolution for HTTP events.
 *
 * The raw request is treated as untrusted: header values are accepted only
 * when they match a strict format; otherwise a fresh UUID is generated.
 * Request headers, cookies, and bodies are never logged (docs/SECURITY_MODEL.md).
 */
import { cryptoIdGenerator, type IdGenerator } from '../../shared/ids/id';
import { isValidRequestId, REQUEST_ID_PATTERN } from '../../shared/ids/request-id';

export { REQUEST_ID_PATTERN, isValidRequestId };

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestIdResolution {
  readonly requestId: string;
  readonly source: 'header' | 'generated';
}

export function resolveRequestId(
  request: Request,
  idGenerator: IdGenerator = cryptoIdGenerator,
): RequestIdResolution {
  const raw = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (raw !== undefined && raw !== '' && isValidRequestId(raw)) {
    return { requestId: raw, source: 'header' };
  }
  return { requestId: idGenerator.newId(), source: 'generated' };
}
