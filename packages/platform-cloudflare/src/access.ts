export interface AccessIdentity {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly authentication_method: "cloudflare_access" | "service_token";
  readonly expires_at: string;
}

export interface AccessVerifier {
  verify(request: Request): Promise<AccessIdentity>;
}

export const AUTHORIZATION_HEADER_NEVER_LOGGED = true as const;
