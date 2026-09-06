# CLAUDE.md

## Deployed environment

- Runs on **main-server** (`192.168.1.201`) as the `approverr` container in `/opt/stack/approverr/` (host net, no published port). `/opt/stack/approverr/src` is a deploy copy of this repo (canonical: `git@github.com:Seiru/approverr.git`). `src/index.js` is gitignored in `/opt/stack`, so any on-box edit must be mirrored back here or it is lost on the next redeploy.
- The `~/server_stuff` docs repo is the source of truth for the deployed environment. Deployment facts and the heartbeat-file healthcheck are in `main_server/services.md`; how approverr fits the Seerr and Recyclarr quality flow is in `main_server/services/quality.md`. Read that repo's `CLAUDE.md` first, and keep those docs in sync (commit + push there) when the deploy shape or behaviour changes.
