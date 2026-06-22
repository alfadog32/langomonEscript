# MoneyMaker Dashboard

The dashboard is disabled by default and uses only Node built-ins. It does not enable live trading, place orders, read live secrets, or start automatically.

## Deploy on the Ubuntu server

```bash
cd /home/lango/langomonEscript

cat >> .env <<'EOF'
DASHBOARD_ENABLED=true
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=18888
DASHBOARD_PUBLIC_URL=http://192.168.100.96:18888
EOF

pm2 start ./dashboard_server.js --name langomon-dashboard --update-env
pm2 save
pm2 logs langomon-dashboard --lines 40
```

The PM2 logs will show:

```text
Dashboard URL: http://192.168.100.96:18888/?token=...
```

When `DASHBOARD_HOST=0.0.0.0` and `DASHBOARD_TOKEN` is empty, the dashboard auto-generates a token, stores it in `.dashboard_token`, and reuses that token on later starts. The `.dashboard_token` file is ignored by Git and must not be committed.

The readiness audit accepts both `langomon-dashboard` and the older `moneyMakerDashboard` PM2 name as dashboard aliases.

## Checks

```bash
npm run dashboard:check
```
