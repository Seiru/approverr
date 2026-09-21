# CLAUDE.md

## Deployed environment

- Runs on **main-server** (`192.168.1.201`) as the `approverr` container in `/opt/stack/approverr/` (host net, no published port). `/opt/stack/approverr/src` is a deploy copy of this repo (canonical: `git@github.com:Seiru/approverr.git`). `src/index.js` is gitignored in `/opt/stack`, so any on-box edit must be mirrored back here or it is lost on the next redeploy.
- **This repo is public on GitHub.** `config/config.yml` (a real Overseerr API key) and `.env` (the notification gateway's publisher token) are gitignored; only `config/config.example.yml` and `.env.example` are tracked. Never commit a real value into either, and never paste one into a commit message or a comment.
- Notifications go to the house notification gateway, not to a public push topic. `NOTIFY_URL` and `NOTIFY_TOKEN` come from `/opt/stack/approverr/.env` on the box (mode 600) through the compose `env_file`.
- The `~/server_stuff` docs repo is the source of truth for the deployed environment. Deployment facts and the heartbeat-file healthcheck are in `main_server/services.md`; how approverr fits the Seerr and Recyclarr quality flow is in `main_server/services/quality.md`. Read that repo's `CLAUDE.md` first, and keep those docs in sync (commit + push there) when the deploy shape or behaviour changes.
