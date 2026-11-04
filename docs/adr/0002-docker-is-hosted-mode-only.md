# ADR 0002: Docker runs hosted mode only

- Status: accepted
- Date: 2026-10-15

## Context

Local mode must refuse to start unless bound to a loopback address. Inside a
container, a loopback bind is unreachable through Docker port publishing, so
"local mode in Docker" would require weakening that rule (e.g. an escape-hatch
flag) or host networking (not reliable on macOS).

## Decision

- The Docker image and `docker-compose.yml` run **hosted mode only**
  (`BUDD_MODE=hosted`, `HOST=0.0.0.0` inside the container).
- Compose publishes the port on the **host's loopback only**
  (`127.0.0.1:8787:8787`); public exposure is via a TLS reverse proxy or tunnel (e.g. Caddy, nginx or a Cloudflare tunnel).
- **Local mode runs with `npm start`** on the host. The loopback rule has no
  exceptions.

## Consequences

- The Phase 0 "docker compose up serves a health endpoint" check runs in hosted
  mode, which needs `.env` (copy `.env.example`; placeholders suffice for /health).
- Local-mode users need Node 22+ installed rather than Docker (Node 24.11+ since 0.0.5).
