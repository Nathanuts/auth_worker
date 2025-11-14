// wrangler.toml should have "compatibility_date" set (e.g. 2023-09-01)
// Example Worker: OIDC JWT validation + authorization

// Found in Okta (Security > API > Authorization Servers > default)
const OIDC_ISSUER = "https://integrator-2817162.okta.com/oauth2/default"; // Default auth server
const API_BACKEND = "https://api.internal.example.com"; // Your API endpoint

// Cache JWKS at the edge
let jwksCache = null;
let jwksFetchedAt = 0;

async function getJWKS() {
  // Refresh every 10 minutes
  const now = Date.now();
  if (jwksCache && now - jwksFetchedAt < 10 * 60 * 1000) {
    return jwksCache;
  }

  const oidcConfigUrl = `${OIDC_ISSUER}/.well-known/openid-configuration`;
  const cfg = await fetch(oidcConfigUrl).then(r => r.json());
  const jwksUri = cfg.jwks_uri;

  const jwks = await fetch(jwksUri).then(r => r.json());
  jwksCache = jwks;
  jwksFetchedAt = now;
  return jwks;
}

async function validateJWT(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(atob(headerB64));
  const payload = JSON.parse(atob(payloadB64));

  // Fetch JWKS
  const jwks = await getJWKS();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("No matching JWK");

  // Import JWK
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    false,
    ["verify"]
  );

  // Verify signature
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  if (!valid) throw new Error("Invalid signature");

  // Verify standard claims
  if (payload.iss !== OIDC_ISSUER) throw new Error("Invalid issuer");
  if (payload.exp * 1000 < Date.now()) throw new Error("Token expired");
  
  return payload;
}

export default {
  async fetch(req) {
    try {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return new Response("Missing Authorization header", { status: 401 });
      }

      const token = auth.substring(7);
      const claims = await validateJWT(token);

      // ---- Authorization logic here ----
      // For demo: just check that we have a valid token with basic claims
      if (!claims.sub) {
        return new Response("Forbidden: Invalid token claims", { status: 403 });
      }
      
      // Optional: Add more specific authorization logic here
      // Example: check user roles, groups, or other claims

      // Forward request to backend
      const backendResp = await fetch(API_BACKEND + new URL(req.url).pathname, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return backendResp;

    } catch (err) {
      return new Response(`Unauthorized: ${err.message}`, { status: 401 });
    }
  }
};
