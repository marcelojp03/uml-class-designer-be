export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthenticatedPrincipal extends SafeUser {
  sessionId: string;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  user: SafeUser;
  refreshToken: string;
  refreshExpiresAt: Date;
}
