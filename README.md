
# DriveDen GPS v3 — with Manual Mode

New:
- Manual Mode (tap to set Tee / Front / Middle / Back, save/load locally).
- GI API mode kept (search may return [] until GI enables catalog).
- Healthcheck `/healthz`, Railway-ready.

## Deploy
- Set env: GI_BASE, GI_CLIENT_ID, GI_API_TOKEN (and optional PORT=8080).
- Healthcheck path: /healthz
