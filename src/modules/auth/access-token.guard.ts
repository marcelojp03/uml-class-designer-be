import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './auth.constants';
import type { AuthenticatedPrincipal } from './auth.types';
import { AccessTokenVerifierService } from './access-token-verifier.service';

type AuthenticatedRequest = Request & { user?: AuthenticatedPrincipal };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokenVerifier: AccessTokenVerifierService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    request.user = await this.accessTokenVerifier.verify(token);
    return true;
  }

  private extractBearerToken(request: Request): string {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication is required.');
    }

    const token = authorization.slice('Bearer '.length);
    if (!token || token.length > 4096 || token.includes(' ')) {
      throw new UnauthorizedException('Authentication is required.');
    }
    return token;
  }
}
