export interface TokenProvider {
  /** Short-lived token that only opens the sync channel; not the user's ordinary session. */
  getStreamToken(): Promise<string | null>;
  refreshStreamToken(): Promise<string | null>;
  /** Sent as the Authorization header on business API calls. */
  getApplicativeToken(): Promise<string | null>;
  refreshApplicativeToken(): Promise<string | null>;
}
