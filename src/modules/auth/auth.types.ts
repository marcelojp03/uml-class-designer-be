export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthenticatedPrincipal extends SafeUser {
  sessionId: string;
  accessTokenExpiresAt: number;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
  exp: number;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  user: SafeUser;
  refreshToken: string;
  refreshExpiresAt: Date;
}
