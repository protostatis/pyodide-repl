# Distribution Parallel Implementation Plan

## Product Decision

The public growth object is not a notebook. It is a published insight.

The notebook remains the authoring and provenance layer. Public viewers should see a polished insight page with a title, takeaway, hero chart or table, data/source provenance, author attribution, and clear CTAs.

Primary CTA language:

- `Ask a follow-up`
- `Run this on another ticker`
- `Analyze your own CSV`
- `Remix this insight`

Avoid public-facing language like `notebook`, `cells`, or `pandas` unless the user opens `Show work`.

## Goals

- Convert shared analysis viewers into signed-in users.
- Make every published insight useful as a standalone social/SEO artifact.
- Reuse the existing Unchained auth/provider flow from `sky-search-experimental`.
- Preserve the current lightweight Pyodide notebook authoring experience.
- Enable parallel implementation without multiple agents fighting over the same files.

## Non-Goals For MVP

- Do not merge `pyodide-repl` and `searchagentsky.com` into one app UI.
- Do not make public viewers sign in to read shared content.
- Do not build a full multi-tenant SaaS dashboard before validating distribution.
- Do not expose raw saved output HTML publicly without sanitization.

## Architecture Direction

Keep app experiences independent, unify identity and distribution.

- `searchagentsky.com`: broad consumer front door for web-answer questions.
- `analytics.unchainedsky.com`: data-analysis engine and authoring workspace.
- Shared public artifact model: published answers/insights with common auth, profile, share, OG, and gallery patterns.

For this repo, implement `data_insight` first. Later, it can share infrastructure with `web_answer` from Sky Search.

## Current Repo Baseline

Relevant current files:

- `server.js`: HTTP server, OpenRouter proxy, Pyodide WebSocket relay, anonymous `/api/save`, `/api/load/:slug`, `/s/:slug`.
- `public/index.html`: landing page, notebook UI, share button, slug load/save flow.
- `docs/AUTH_FLOW.md`: auth contract already aligned with Sky Search.
- `README.md`: documents anonymous slug sharing.

Relevant Sky Search implementation to port/adapt:

- `sky-search-experimental/server/index.js`: `requireAuth`, `/auth/callback`, `/auth/dev-token`, SQLite persistence, public share pages, OG SVG, profile pages.
- `sky-search-experimental/client/index.html`: auth pill and sign-in/sign-out UX.
- `sky-search-experimental/client/agent.js`: share flow that redirects to auth and retries publish.

## MVP User Flows

### Author Publishes Insight

1. User analyzes a dataset/ticker in the current notebook UI.
2. User clicks `Publish insight`.
3. If signed out, app stores pending notebook snapshot and redirects to Unchained auth.
4. Auth callback stores `localStorage.authToken`.
5. App submits notebook snapshot to `POST /api/insights` with bearer token.
6. Server creates public insight with human-readable slug.
7. App navigates to `/i/:id-:slug` or copies the URL.

### Public Viewer Reads Insight

1. Viewer opens `/i/:id-:slug`.
2. Server renders SEO/OG-friendly HTML.
3. Viewer sees title, takeaway, hero output, bullets, provenance, and author.
4. Viewer can open `Show work` to see notebook cells.
5. Viewer CTAs route back into the app.
6. `Ask follow-up`, `Run on another ticker`, `Analyze your own CSV`, and `Remix` require sign-in or start sign-in.

### Signed-In User Remixes

1. Viewer clicks `Remix this insight`.
2. If signed out, redirect to auth with pending remix target.
3. After auth, create a private copy or load the snapshot into the notebook UI.
4. User edits/runs/publishes a new insight.

## Data Contract

Use SQLite for authenticated/public published insights. Keep file-based `slugs/` for anonymous drafts/legacy quick shares.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  user_picture TEXT,
  title TEXT NOT NULL,
  description TEXT,
  takeaway TEXT,
  body_json TEXT NOT NULL,
  notebook_json TEXT NOT NULL,
  hero_html TEXT,
  source_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  slug TEXT,
  origin_host TEXT,
  fork_of TEXT,
  view_count INTEGER DEFAULT 0,
  remix_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_user ON insights(user_sub);
CREATE INDEX IF NOT EXISTS idx_insights_visibility_created ON insights(visibility, created_at);
```

`body_json` should be structured enough to render the public page without trusting arbitrary HTML:

```json
{
  "bullets": ["..."],
  "method": "...",
  "generatedSummary": "..."
}
```

`notebook_json` should contain cells:

```json
{
  "cells": [
    {
      "type": "code|ask",
      "code": "...",
      "outputText": "...",
      "outputHtml": "sanitized-or-empty",
      "summary": "..."
    }
  ],
  "dataset": {
    "kind": "ticker|url|upload|curated",
    "label": "NVDA",
    "source": "Yahoo Finance"
  }
}
```

Visibility:

- `public`: indexable if quality rules pass.
- `unlisted`: accessible by URL, `noindex`.

## API Contract

Auth:

- `GET /auth/callback?code=...&state=...`
- `GET /auth/dev-token?intent=signin|publish|remix` in development only.
- Bearer token storage remains `localStorage.authToken` for parity with Sky Search.

Insights:

- `POST /api/insights` authenticated. Creates published insight.
- `GET /api/insights/:id` public JSON for client use.
- `POST /api/insights/:id/remix` authenticated. Creates/logs a remix copy or returns notebook payload to load.
- `DELETE /api/insights/:id` authenticated owner-only unpublish/delete.
- `GET /api/me/insights` authenticated. Lists current user's insights.
- `GET /api/recent-insights` public. Feeds gallery/landing modules.

Public pages:

- `GET /i/:idslug` public HTML page.
- `GET /i/:idslug/og.svg` public SVG social card.
- `GET /insights` public gallery.
- `GET /u/:sub` public author profile.
- `GET /me` signed-in client-rendered owner page.

Legacy:

- Keep `POST /api/save`, `GET /api/load/:slug`, and `/s/:slug` until `/i/` is validated.
- Optionally rename the UI button from `Share` to `Publish insight`, but keep anonymous save behavior available as `Copy notebook link` if needed.

## Parallel Workstreams

### Track A: Auth And Identity

Owner: Auth/server agent.

Files likely touched:

- `package.json`
- `package-lock.json`
- `server.js`
- `public/index.html`
- `docs/AUTH_FLOW.md`

Inputs:

- Existing `docs/AUTH_FLOW.md`.
- Sky Search `requireAuth`, `/auth/callback`, and `/auth/dev-token` patterns.

Outputs:

- JWT verification via `JWT_SECRET`.
- Server-side auth callback code exchange using `AUTH_PROVIDER_URL`.
- Dev token route in non-production.
- Header auth pill with sign in/sign out.
- `window.__startSignIn(intent)` helper for other client flows.

Acceptance criteria:

- Signed-out header shows `Sign in`.
- Signed-in header shows user name/avatar and sign out.
- Local dev token works with `JWT_SECRET` set.
- Protected route rejects missing/invalid tokens with `401`.
- Callback never receives bearer tokens in query params.

Tests:

- Add unit tests for callback page not leaking token in URL where feasible.
- Add route tests for missing token and malformed bearer token.

Parallel notes:

- This track should expose `requireAuth` and token assumptions early.
- Avoid changing publish UI beyond a reusable `startSignIn` helper.

### Track B: Insight Storage And API

Owner: Persistence/API agent.

Files likely touched:

- `package.json`
- `package-lock.json`
- `server.js`
- New tests such as `test_insights_api.js`

Inputs:

- Data/API contracts in this document.
- Auth middleware from Track A, or a temporary stub if Track A is not merged yet.

Outputs:

- SQLite database `published_insights.db` or configurable path.
- `insights` table and idempotent migrations.
- `generateInsightId`, `generateSlug`, `sanitizeMeta`, `rowToInsight`, `loadInsight`.
- Authenticated `POST /api/insights`.
- Public `GET /api/insights/:id`.
- Owner `GET /api/me/insights`.
- Owner delete/unpublish endpoint.
- View/remix count helpers.

Acceptance criteria:

- Valid bearer token can create an insight.
- Missing title falls back to generated title/takeaway from snapshot.
- Public insight can be loaded by id.
- Owner-only endpoints reject non-owner users.
- Public/unlisted visibility is validated.

Tests:

- Create insight success.
- Missing auth returns `401`.
- Invalid payload returns `400`.
- Slug canonicalizes common title text.
- Owner delete rejects other users.

Parallel notes:

- Keep public HTML rendering out of this track.
- Define response shape before client work begins.

### Track C: Public Insight Page, SEO, And OG

Owner: Public/rendering agent.

Files likely touched:

- `server.js`
- New tests such as `test_insight_pages.js`

Inputs:

- `loadInsight`/row shape from Track B.
- Sky Search public result page and OG SVG patterns.

Outputs:

- `GET /i/:idslug` server-rendered public insight page.
- Canonical redirect from `/i/:id` to `/i/:id-:slug`.
- Open Graph/Twitter metadata.
- `GET /i/:idslug/og.svg` social card.
- Basic JSON-LD if content quality is sufficient.
- `robots` rules: public insights indexable, unlisted noindex.
- `Show work` collapsed notebook/provenance section.

Acceptance criteria:

- Social crawlers receive useful title/description/image without JS.
- Public page is understandable without notebook context.
- Public page has CTAs: `Ask a follow-up`, `Run this on another ticker`, `Analyze your own CSV`, `Remix this insight`.
- Raw notebook output HTML is escaped or sanitized before rendering.

Tests:

- `/i/:id` redirects to canonical slug.
- `/i/:id-slug` includes `og:title`, `og:image`, canonical URL.
- Unlisted page includes `noindex`.
- Page escapes unsafe HTML.

Parallel notes:

- Coordinate URL format with Track B before implementation.
- Avoid changing the notebook editor in this track.

### Track D: Client Publish UX

Owner: Client/product UX agent.

Files likely touched:

- `public/index.html`
- `test_client_assets.js`

Inputs:

- Track A `window.__startSignIn` and token storage.
- Track B `POST /api/insights` response shape.

Outputs:

- Rename primary share CTA to `Publish insight`.
- Add publish dialog for title, takeaway, visibility, and optional description.
- Extract current notebook snapshot into a structured payload.
- Persist pending publish in `sessionStorage` before auth redirect.
- After auth callback/sign-in, resume pending publish.
- Copy URL and show social-share buttons after publish.

Acceptance criteria:

- Signed-out publish starts auth without losing notebook state.
- Signed-in publish creates `/i/:id-slug`.
- Failed/expired token clears token and retries auth.
- Button copy avoids notebook jargon.
- Existing anonymous `/s/:slug` load flow still works.

Tests:

- Asset tests assert root-relative assets still work.
- Static tests assert `Publish insight`, pending publish storage, and `/api/insights` call exist.

Parallel notes:

- This is the highest-conflict track because `public/index.html` is large.
- Other tracks should avoid editing `public/index.html` except Track A's small auth helper.

### Track E: Remix And Follow-Up Routing

Owner: Activation agent.

Files likely touched:

- `server.js`
- `public/index.html`

Inputs:

- Track B insight APIs.
- Track C public page CTAs.
- Track A auth helper.

Outputs:

- `POST /api/insights/:id/remix` authenticated route.
- `/ ?remix=:id` or `/remix/:id` client flow that loads notebook snapshot.
- `?ticker=NVDA` or `?q=...` entry path to start a new analysis from CTA.
- Remix count increment.

Acceptance criteria:

- Public viewer can click `Remix` and land in an editable analysis after auth.
- `Run this on another ticker` can prefill a ticker or question.
- Remix does not mutate original insight.

Tests:

- Remix endpoint requires auth.
- Remix endpoint increments/remembers source id.
- Client route loads snapshot safely.

Parallel notes:

- Start after Tracks B and C establish URL/API contracts.
- Can initially implement CTAs as links only, then add authenticated remix.

### Track F: Gallery, Profiles, And Content Network

Owner: Discovery agent.

Files likely touched:

- `server.js`
- `public/index.html` only if adding homepage module.

Inputs:

- Track B `GET /api/recent-insights` and profile data.
- Track C page components.

Outputs:

- `/insights` public gallery.
- `/u/:sub` public profile page.
- `/me` signed-in owner page.
- Recent/featured insights module for landing page.

Acceptance criteria:

- Gallery is indexable and lists public insights.
- User profile shows public insights only.
- `/me` shows public and unlisted owned insights and delete/unpublish actions.

Tests:

- Public profile does not expose unlisted insights.
- `/me` requires client token/API auth.

Parallel notes:

- Can start after Track B table/API stabilizes.
- Avoid blocking MVP launch if public page distribution is ready first.

### Track G: Analytics And Distribution Ops

Owner: Growth instrumentation agent.

Files likely touched:

- `server.js`
- `README.md`
- New doc such as `docs/CONTENT_SEEDING_PLAN.md`

Inputs:

- Track B insight ids.
- Track C public page CTA locations.

Outputs:

- View count increments.
- Simple event endpoint for CTA clicks: `POST /api/events`.
- Metrics table for `view`, `share_click`, `cta_followup`, `cta_ticker`, `cta_upload`, `remix_start`, `publish_success`.
- Content seeding plan for Reddit, X/FinTwit, LinkedIn, HN, Stocktwits.

Acceptance criteria:

- Every public insight increments views.
- CTA clicks are countable by insight id and event type.
- No sensitive user data is logged in events.
- Content plan includes subreddit-specific rules and post templates.

Tests:

- Event endpoint rejects oversized payloads.
- Event endpoint accepts only known event types.

Parallel notes:

- Can be implemented after `/i/:id` pages exist, but planning can happen immediately.

### Track H: Security And Hardening

Owner: Security/testing agent.

Files likely touched:

- `server.js`
- `public/index.html`
- Test files

Inputs:

- Existing XSS risk from saved HTML.
- Current SSRF/routing tests.

Outputs:

- Request size limits for JSON endpoints.
- Safe rendering helpers for saved output.
- Validation caps for cells, code length, title, description, output text.
- Tests around XSS, oversized saves, path handling, and auth failures.

Acceptance criteria:

- Public pages do not render arbitrary script/event-handler HTML.
- `/api/save` and `/api/insights` enforce size limits.
- Tests cover malicious notebook output.
- Existing tests still pass.

Parallel notes:

- Security agent should review Track C rendering before merge.
- Do not wait until launch to fix raw `innerHTML` usage on public pages.

## Suggested Branches For Subagents

- `feature/auth-identity`
- `feature/insight-api`
- `feature/public-insight-pages`
- `feature/client-publish-insight`
- `feature/remix-followup`
- `feature/insight-gallery-profiles`
- `feature/analytics-growth-events`
- `feature/security-hardening`

Integration branch:

- `feature/distribution-plan`

Merge order:

1. Track H request-size helpers if small and independent.
2. Track A auth middleware/callback.
3. Track B insight storage/API.
4. Track C public insight pages.
5. Track D client publish UX.
6. Track E remix/follow-up.
7. Track F gallery/profile.
8. Track G analytics/content ops.
9. Track H final security review.

## Subagent Prompts

### Prompt: Auth And Identity

Implement Track A from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Port the Sky Search auth provider flow into this repo with minimal changes: `JWT_SECRET`, `AUTH_PROVIDER_URL`, `requireAuth`, `/auth/callback`, and non-production `/auth/dev-token`. Add a small header auth UI in `public/index.html` and expose `window.__startSignIn(intent)`. Preserve existing anonymous notebook behavior. Add focused tests for protected route behavior if needed. Do not implement insight publishing in this task.

### Prompt: Insight Storage And API

Implement Track B from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add SQLite-backed `insights` persistence, id/slug generation, validation, authenticated `POST /api/insights`, public `GET /api/insights/:id`, owner `GET /api/me/insights`, and owner delete. Reuse `requireAuth` if present; otherwise isolate your changes so it can be wired in later. Do not modify the client publish UI or public HTML pages beyond what is needed for tests.

### Prompt: Public Insight Pages

Implement Track C from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add server-rendered `/i/:idslug` and `/i/:idslug/og.svg` using the insight loader/API shape. Render the public artifact as a polished insight page, not a notebook. Include OG/Twitter/canonical/robots metadata, CTAs, and collapsed `Show work`. Escape or sanitize all saved output. Do not modify the notebook editor.

### Prompt: Client Publish UX

Implement Track D from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Rename the primary share action to `Publish insight`, add a publish dialog, collect structured notebook snapshot data, handle signed-out auth redirect without losing state, submit to `POST /api/insights`, copy the resulting URL, and preserve existing `/s/:slug` load behavior. Keep edits localized to `public/index.html` and asset tests.

### Prompt: Remix And Follow-Up

Implement Track E from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add authenticated remix flow and follow-up/ticker routing from public insight CTAs into the notebook app. Ensure remix creates a separate editable copy and increments remix metrics without mutating the original insight.

### Prompt: Gallery And Profiles

Implement Track F from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add `/insights`, `/u/:sub`, and `/me` pages using the insight persistence layer. Public pages should only expose public insights. Owner page should include unlisted insights and delete/unpublish controls.

### Prompt: Analytics And Growth Ops

Implement Track G from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add minimal event tracking for public insight views and CTA clicks, plus a content seeding playbook for stock subreddits, X/FinTwit, LinkedIn, HN, and Stocktwits. Keep payloads non-sensitive and rate/size limited.

### Prompt: Security Hardening

Implement Track H from `docs/DISTRIBUTION_PARALLEL_PLAN.md`. Add request-size limits, payload validation caps, safe rendering helpers, and tests for XSS/oversized payloads/auth failures. Review public insight rendering and current anonymous slug HTML handling. Preserve existing tests.

## Content Seeding Plan

Initial wedge: stock and AI infrastructure communities.

Primary topic cluster:

- AI capex demand from SEC XBRL facts.
- NVDA revenue versus hyperscaler capex.
- Oracle backlog and AI infrastructure demand.
- Vertiv and power/cooling as AI infrastructure beneficiaries.
- Broadcom, Micron, NVIDIA, and supplier demand signals.

Priority channels:

- Reddit: `r/stocks`, `r/investing`, `r/SecurityAnalysis`, `r/ValueInvesting`, `r/StockMarket`, ticker-specific communities where rules allow.
- X/FinTwit: chart-first posts with one clear takeaway.
- LinkedIn: business/data angle, especially primary SEC filing provenance.
- Hacker News: technical launch angle, not stock-pick angle.
- Stocktwits: ticker-specific traffic, lower signal but high intent.

Post rules:

- Lead with the insight, not the product.
- Use one chart and one plain-English takeaway.
- Disclose if linking to a tool you built.
- Include a financial-disclaimer line.
- Do not repeat the same link across many subreddits in one day.
- Participate in comments manually.

Example post framing:

```text
I pulled recent SEC XBRL filings for AI infrastructure names and normalized capex, backlog, revenue, cash, and supplier demand signals. The thing that surprised me is that the demand signal looks broader than just NVDA revenue.

Takeaway: hyperscaler capex and supplier backlog are still moving together, but the pressure is shifting toward power/cooling and networking suppliers.

Chart: [image]
Full source-backed analysis: [insight URL]

Curious if people read this as durable AI infrastructure demand or just peak-cycle spending.

Not financial advice.
```

## Launch Checklist

- Public insight page renders without JS.
- OG cards work in Slack/iMessage/X preview debuggers where possible.
- Signed-out reading works.
- Signed-out publish/remix resumes after auth.
- Public output is sanitized/escaped.
- Analytics track views and CTA clicks.
- First 10 high-quality insights are published before external posting.
- README documents auth/env requirements.
- Existing `npm test` passes.

## Open Product Questions

- Should anonymous users still be able to create `/s/:slug` raw notebook shares, or should the UI hide that behind an advanced menu?
- Should public insight URLs be `/i/` or `/insights/`? `/i/` is short for sharing, `/insights/` is clearer for SEO.
- Should follow-up questions run in `pyodide-repl` only, or route ambiguous web questions to SearchAgentSky later?
- Should published insights have a manual editor before publishing, or rely on generated title/takeaway first?
