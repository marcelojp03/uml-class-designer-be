export type XmiErrorCode =
  | 'XMI_BINARY_CONTENT'
  | 'XMI_DOCTYPE_FORBIDDEN'
  | 'XMI_DUPLICATE_ID'
  | 'XMI_INVALID_CONTENT_TYPE'
  | 'XMI_INVALID_ENCODING'
  | 'XMI_INVALID_HASH'
  | 'XMI_INVALID_REQUEST'
  | 'XMI_LIMIT_EXCEEDED'
  | 'XMI_MALFORMED'
  | 'XMI_MISSING_REFERENCE'
  | 'XMI_UNACKNOWLEDGED_WARNINGS'
  | 'XMI_UNSUPPORTED_FEATURE'
  | 'XMI_UNSUPPORTED_PROFILE';

export class XmiInteroperabilityError extends Error {
  constructor(
    readonly code: XmiErrorCode,
    message: string,
    readonly status: 400 | 408 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = 'XmiInteroperabilityError';
  }
}

export function throwXmiHttpError(error: unknown): never {
  if (!(error instanceof XmiInteroperabilityError)) {
    throw error;
  }

  const response = { code: error.code, message: error.message };
  if (error.status === 408) throw new RequestTimeoutException(response);
  if (error.status === 413) throw new PayloadTooLargeException(response);
  if (error.status === 415) throw new UnsupportedMediaTypeException(response);
  throw new BadRequestException(response);
}
import {
  BadRequestException,
  PayloadTooLargeException,
  RequestTimeoutException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
