import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfiguration } from '../../config/app.config';
import { AUTH_INTENT_HEADER, AUTH_INTENT_VALUE } from './auth.constants';

@Injectable()
export class AuthIntentGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers[AUTH_INTENT_HEADER] !== AUTH_INTENT_VALUE) {
      throw new ForbiddenException('Authentication intent header is required.');
    }

    const origin = request.headers.origin;
    if (origin) {
      const config = this.configService.getOrThrow<AppConfiguration>('app');
      if (!config.corsOrigins.includes(origin)) {
        throw new ForbiddenException('Request origin is not allowed.');
      }
    }

    return true;
  }
}
