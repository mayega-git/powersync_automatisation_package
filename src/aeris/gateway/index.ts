/** AERIS Sync Gateway (Node.js server side). */
export { createGateway, startGatewayFromConfig, type Gateway, type GatewayDependencies } from './server.js';
export { loadGatewayConfig, type AuthConfig, type GatewayConfig } from './config.js';
export { AuthenticationError, sessionResolver, type SessionClaims, type SessionResolver } from './auth.js';
export { instantText, ProjectionReader, rawTypes, toWire } from './data.js';
export { Reconciler, type BackendAnswer, type BackendCall, type BackendClient } from './reconcile.js';
export { setupSql, SEQUENCE_LOCK } from './sql.js';
