import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './auth.constants';
import type { AuthenticatedPrincipal } from './auth.types';

type AuthenticatedRequest = Request & { user?: AuthenticatedPrincipal };

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) {
      throw new Error('Authenticated principal is missing after the access guard.');
    }
    return user;
  },
);
