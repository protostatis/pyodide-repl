# External Auth Flow

This document defines the pyodide-repl side of the Unchained external auth flow
to use if notebook save/share becomes authenticated.

The current app supports anonymous shareable slugs. Any future auth-gated share
or publish flow must use the one-time-code contract below rather than receiving
bearer tokens in callback URLs.

## Actors

- **pyodide-repl client**: browser UI served by `analytics.unchainedsky.com`.
- **pyodide-repl server**: Node.js app that would serve `/auth/callback` and
  protect authenticated save/share endpoints.
- **Unchained auth provider**: `AUTH_PROVIDER_URL`, defaulting to
  `https://unchainedsky.com`.

## Redirect Origins

Production redirect URI:

- `https://analytics.unchainedsky.com/auth/callback`

Development redirect URIs:

- `http://localhost:3000/auth/callback`
- `http://127.0.0.1:3000/auth/callback`

The Unchained provider should only allow development redirect URIs when the
provider itself is running locally or when an explicit dev-only allow flag is
enabled. A production-hosted auth provider must reject localhost redirect URIs.

## Client Start

When a user starts an auth-gated share or publish action and no valid local auth
token is available:

1. Generate a random `state` value with at least 128 bits of entropy.
2. Persist the state locally with the pending notebook/share context.
3. Redirect to the Unchained provider:

```text
GET {AUTH_PROVIDER_URL}/auth/login
  ?redirect_uri={encodeURIComponent(location.origin + "/auth/callback")}
  &scope=share
  &state={encodeURIComponent(state)}
```

The callback URL must use the current origin so the same code works in
production and local development.

## Provider Callback

After a successful Unchained login, the provider redirects back to pyodide-repl:

```text
302 Location: {redirect_uri}?code={one_time_code}&state={state}
```

Rules:

- `code` is opaque to pyodide-repl.
- `code` must be short-lived, preferably 60-120 seconds.
- `code` must be single-use.
- `code` must be bound to the exact `redirect_uri` used when login started.
- `state` must be echoed unchanged.
- The callback URL must not contain `token`, `id_token`, `access_token`, or any
  bearer credential.

## Code Exchange

The server-side `/auth/callback` handler validates the returned `state`, then
exchanges the code with the provider:

```http
POST {AUTH_PROVIDER_URL}/auth/token
Content-Type: application/json
Accept: application/json

{
  "grant_type": "authorization_code",
  "code": "{one_time_code}",
  "redirect_uri": "{location.origin}/auth/callback"
}
```

Expected success response:

```json
{
  "access_token": "jwt-or-provider-token",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "share"
}
```

The server may return a shorter `expires_in`; pyodide-repl should treat the
value as authoritative. The provider can include user profile fields, but
pyodide-repl must not depend on them for saving or sharing notebooks.

Expected error response:

```json
{
  "error": "invalid_grant",
  "error_description": "Code expired, already used, or redirect_uri mismatch."
}
```

pyodide-repl must fail closed when the exchange fails. It should render a retry
path instead of saving or sharing; the callback page should clear the pending
state.

## Share Completion

After the exchange succeeds:

1. Store `access_token` as the local auth token.
2. Remove the one-time auth `state` and pending auth metadata.
3. Complete the pending save/share request with:

```http
Authorization: Bearer {access_token}
```

4. Redirect to the generated share URL when save/share succeeds.
5. If the protected endpoint returns `401`, remove the local auth token and
   restart auth on the next share attempt.

The authorization code itself must never be stored beyond the callback exchange.

## Legacy Transition

A direct-token callback is not supported for new work:

```text
/auth/callback?token={jwt}
```

That form is deprecated because bearer tokens in query strings can leak through
browser history, access logs, and referrers. The supported contract is the
`code` plus `state` flow above.

If temporary legacy support is ever needed during rollout, pyodide-repl should
immediately remove the token-bearing URL from browser history before completing
the pending action:

```js
window.history.replaceState(null, "", "/auth/callback");
```

## Security Invariants

- Never put bearer tokens in callback query strings.
- Require an exact redirect URI match during code exchange.
- Require and verify `state` for CSRF protection.
- Accept localhost redirect URIs only in local development.
- Do the code exchange from the pyodide-repl server. If a browser-side fallback
  is ever added, call the provider with `credentials: "omit"` because the code is
  the credential for that step.
- Mark one-time codes as consumed before returning a token from the provider.
- Verify protected save/share bearer tokens on the pyodide-repl server with the
  shared `JWT_SECRET`.

## Implementation Checklist

- Share flow generates and persists `state`.
- Share flow redirects to `/auth/login` with `redirect_uri`, `scope=share`, and
  `state`.
- `/auth/callback` accepts `code` and rejects missing or mismatched `state`.
- `/auth/callback` exchanges `code` through the provider token endpoint.
- `/auth/callback` stores only the returned `access_token`.
- `/auth/callback` completes the pending save/share action after exchange.
- Tests cover successful exchange, state mismatch, missing code, exchange
  failure, and the absence of bearer tokens in callback URLs.
