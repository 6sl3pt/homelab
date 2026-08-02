import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { EnvMap } from '../security';
import { logger } from '../logger';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_AUTH_SESSION_COOKIE_NAME = 'rackula_auth_session';
const DEFAULT_OIDC_SCOPES = ['openid', 'profile', 'email'];
const OIDC_DISCOVERY_PATH = '/.well-known/openid-configuration';

interface OidcDiscoveryDocument {
  issuer: string;
  jwksUri: string;
  idTokenSigningAlgs: string[];
}

const DEFAULT_ID_TOKEN_SIGNING_ALGS = ['RS256'];

const KNOWN_ASYMMETRIC_JWS_ALGS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
]);

function resolveIdTokenSigningAlgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ID_TOKEN_SIGNING_ALGS];
  }

  const algs = [
    ...new Set(
      value
        .filter((alg): alg is string => typeof alg === 'string')
        .map((alg) => alg.trim()),
    ),
  ].filter((alg) => KNOWN_ASYMMETRIC_JWS_ALGS.has(alg));

  return algs.length > 0 ? algs : [...DEFAULT_ID_TOKEN_SIGNING_ALGS];
}

interface VerifiedOidcUserInfo {
  id: string;
  name?: string;
  email: string;
  image?: string;
  emailVerified: boolean;
}

function readEnv(env: EnvMap, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseOidcScopes(raw: string | undefined): string[] {
  if (!raw) {
    return [...DEFAULT_OIDC_SCOPES];
  }

  const scopes = [
    ...new Set(raw.split(/[,\s]+/).map((scope) => scope.trim())),
  ].filter((scope) => scope.length > 0);

  if (scopes.length === 0) {
    return [...DEFAULT_OIDC_SCOPES];
  }

  if (!scopes.includes('openid')) {
    scopes.unshift('openid');
  }

  return scopes;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(
    'RACKULA_AUTH_SESSION_COOKIE_SECURE must be either "true" or "false" when set.',
  );
}

function parseAbsoluteUrl(value: string, envName: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${envName} must be a valid absolute URL. ${reason}`, {
      cause: error,
    });
  }
}

function resolveOidcDiscoveryUrl(env: EnvMap): string | undefined {
  const discovery = readEnv(env, 'RACKULA_OIDC_DISCOVERY_URL');
  if (discovery) {
    return parseAbsoluteUrl(discovery, 'RACKULA_OIDC_DISCOVERY_URL').toString();
  }

  const issuer = readEnv(env, 'RACKULA_OIDC_ISSUER');
  if (!issuer) {
    return undefined;
  }

  const issuerUrl = parseAbsoluteUrl(issuer, 'RACKULA_OIDC_ISSUER');
  const normalizedPath = issuerUrl.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith(OIDC_DISCOVERY_PATH)) {
    issuerUrl.pathname = normalizedPath;
    issuerUrl.search = '';
    issuerUrl.hash = '';
    return issuerUrl.toString();
  }

  issuerUrl.pathname = `${normalizedPath}${OIDC_DISCOVERY_PATH}`;
  issuerUrl.search = '';
  issuerUrl.hash = '';
  return issuerUrl.toString();
}

function normalizeIssuerUrl(value: string): string {
  const issuerUrl = new URL(value);
  issuerUrl.search = '';
  issuerUrl.hash = '';
  const normalizedPath = issuerUrl.pathname.replace(/\/+$/, '');

  // NOTE: patch for Authelia domain-only issuer (no trailing slash)
  if (normalizedPath.length === 0) {
    return issuerUrl.origin;
  }
  issuerUrl.pathname = normalizedPath;

  return issuerUrl.toString();
}

function isMicrosoftEntraCommonIssuerMatch(
  expectedIssuer: string,
  discoveryIssuer: string,
): boolean {
  try {
    const expected = new URL(expectedIssuer);
    const discovery = new URL(discoveryIssuer);
    const expectedPath = expected.pathname.replace(/\/+$/, '');
    const discoveryPath = discovery.pathname.replace(/\/+$/, '');

    if (
      expected.protocol !== discovery.protocol ||
      expected.hostname !== discovery.hostname ||
      expected.port !== discovery.port
    ) {
      return false;
    }

    if (expected.hostname !== 'login.microsoftonline.com') {
      return false;
    }

    if (!/^\/common\/v2\.0$/i.test(expectedPath)) {
      return false;
    }

    return /^\/[^/]+\/v2\.0$/i.test(discoveryPath);
  } catch {
    return false;
  }
}

function issuerMatchesExpected(
  expectedIssuer: string | undefined,
  discoveryIssuer: string,
): boolean {
  if (!expectedIssuer) {
    return true;
  }

  if (expectedIssuer === discoveryIssuer) {
    return true;
  }

  return isMicrosoftEntraCommonIssuerMatch(expectedIssuer, discoveryIssuer);
}

async function fetchOidcDiscoveryDocument(
  discoveryUrl: string,
  expectedIssuer: string | undefined,
): Promise<OidcDiscoveryDocument> {
  const response = await fetch(discoveryUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `OIDC discovery request failed (${response.status} ${response.statusText}).`,
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  const issuerValue = parsed.issuer;
  const jwksUriValue = parsed.jwks_uri;
  if (typeof issuerValue !== 'string' || issuerValue.trim().length === 0) {
    throw new Error('OIDC discovery response missing issuer.');
  }

  if (typeof jwksUriValue !== 'string' || jwksUriValue.trim().length === 0) {
    throw new Error('OIDC discovery response missing jwks_uri.');
  }

  const issuer = normalizeIssuerUrl(issuerValue);
  if (!issuerMatchesExpected(expectedIssuer, issuer)) {
    throw new Error(
      'OIDC discovery issuer does not match RACKULA_OIDC_ISSUER.',
    );
  }

  return {
    issuer,
    jwksUri: parseAbsoluteUrl(
      jwksUriValue,
      'OIDC discovery jwks_uri',
    ).toString(),
    idTokenSigningAlgs: resolveIdTokenSigningAlgs(
      parsed.id_token_signing_alg_values_supported,
    ),
  };
}

function mapVerifiedOidcPayload(
  payload: JWTPayload,
): VerifiedOidcUserInfo | null {
  const subjectValue = payload.sub;
  const emailValue = payload.email;
  const nameClaim = payload['name'];
  const preferredUsernameClaim = payload['preferred_username'];
  const pictureClaim = payload['picture'];
  const emailVerifiedClaim = payload['email_verified'];
  if (typeof subjectValue !== 'string' || subjectValue.trim().length === 0) {
    return null;
  }

  if (typeof emailValue !== 'string' || emailValue.trim().length === 0) {
    return null;
  }

  const nameValue =
    typeof nameClaim === 'string' && nameClaim.trim().length > 0
      ? nameClaim.trim()
      : typeof preferredUsernameClaim === 'string' &&
          preferredUsernameClaim.trim().length > 0
        ? preferredUsernameClaim.trim()
        : emailValue.trim();

  const imageValue =
    typeof pictureClaim === 'string' && pictureClaim.trim().length > 0
      ? pictureClaim.trim()
      : undefined;

  return {
    id: subjectValue.trim(),
    name: nameValue,
    email: emailValue.trim().toLowerCase(),
    image: imageValue,
    emailVerified: emailVerifiedClaim === true,
  };
}

function createOidcUserInfoResolver(options: {
  discoveryUrl: string;
  clientId: string;
  expectedIssuer?: string;
}) {
  let discoveryPromise: Promise<OidcDiscoveryDocument> | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  async function resolveDiscovery(): Promise<OidcDiscoveryDocument> {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        try {
          return await fetchOidcDiscoveryDocument(
            options.discoveryUrl,
            options.expectedIssuer,
          );
        } catch (error) {
          discoveryPromise = undefined;
          jwks = undefined;
          throw error;
        }
      })();
    }

    return discoveryPromise;
  }

  return async (tokens: { idToken?: string | undefined }) => {
    const idToken = tokens.idToken?.trim();
    if (!idToken) {
      return null;
    }

    try {
      const discovery = await resolveDiscovery();
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(discovery.jwksUri));
      }

      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: discovery.issuer,
        audience: options.clientId,
        algorithms: discovery.idTokenSigningAlgs,
      });

      return mapVerifiedOidcPayload(payload);
    } catch (error) {
      logger.warn({ err: error }, 'OIDC ID token validation failed');
      return null;
    }
  };
}

export function createAuth(secret: string, env: EnvMap = process.env) {
  if (!secret) {
    throw new Error(
      'Auth session secret is required. Set RACKULA_AUTH_SESSION_SECRET.',
    );
  }

  const oidcClientId = readEnv(env, 'RACKULA_OIDC_CLIENT_ID');
  const oidcClientSecret = readEnv(env, 'RACKULA_OIDC_CLIENT_SECRET');
  const oidcDiscoveryUrl = resolveOidcDiscoveryUrl(env);
  const oidcIssuer = readEnv(env, 'RACKULA_OIDC_ISSUER');
  const oidcScopes = parseOidcScopes(readEnv(env, 'RACKULA_OIDC_SCOPES'));
  const authSessionCookieName =
    readEnv(env, 'RACKULA_AUTH_SESSION_COOKIE_NAME') ||
    DEFAULT_AUTH_SESSION_COOKIE_NAME;
  const baseURL = readEnv(env, 'RACKULA_BASE_URL') || DEFAULT_BASE_URL;
  const authSessionCookieSecure =
    parseOptionalBoolean(readEnv(env, 'RACKULA_AUTH_SESSION_COOKIE_SECURE')) ??
    env.NODE_ENV === 'production';

  const plugins = [];
  if (oidcClientId && oidcClientSecret) {
    if (!oidcDiscoveryUrl) {
      throw new Error(
        'OIDC is enabled but no discovery URL is configured. Set RACKULA_OIDC_DISCOVERY_URL or RACKULA_OIDC_ISSUER.',
      );
    }

    const hasExplicitDiscoveryUrl = !!readEnv(
      env,
      'RACKULA_OIDC_DISCOVERY_URL',
    );
    if (hasExplicitDiscoveryUrl && !oidcIssuer) {
      throw new Error(
        'RACKULA_OIDC_DISCOVERY_URL requires RACKULA_OIDC_ISSUER to be set for issuer pinning. ' +
          'Without issuer validation, a compromised discovery endpoint could redirect to a malicious provider.',
      );
    }

    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: 'oidc',
            clientId: oidcClientId,
            clientSecret: oidcClientSecret,
            discoveryUrl: oidcDiscoveryUrl,
            scopes: oidcScopes,
            pkce: true,
            redirectURI: readEnv(env, 'RACKULA_OIDC_REDIRECT_URI'),
            getUserInfo: createOidcUserInfoResolver({
              discoveryUrl: oidcDiscoveryUrl,
              clientId: oidcClientId,
              expectedIssuer: oidcIssuer
                ? normalizeIssuerUrl(oidcIssuer)
                : undefined,
            }),
          },
        ],
      }),
    );
  }

  return betterAuth({
    secret,
    baseURL,
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60 * 6,
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },

    advanced: {
      useSecureCookies: authSessionCookieSecure,
      cookies: {
        session_token: {
          name: authSessionCookieName,
        },
      },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: authSessionCookieSecure,
      },
    },

    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
