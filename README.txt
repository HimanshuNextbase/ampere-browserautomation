Ampere stealth-proxy handoff bundle

Main backend repo: ampere-infra
Feature name: stealth-proxy
Installed skill dir in instances: camoufox-browser
DB key/state: stealthProxy

Core doc:
- ampere-infra/docs/STEALTH-PROXY.md

Network path:
- desktop app -> portal websocket -> Caddy /browser/<instance> -> unix socket -> container browser-server on 127.0.0.1:9222
