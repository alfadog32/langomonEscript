# MoneyMaker Telegram Diagnostics

The Telegram approval bot is a paper-only notification and approval relay. It does not execute trades, submit orders, read live trading secrets, or enable live trading.

## Env Files

Put Telegram values in one of these files:

```text
.env
.env.telegram
telegram/.env.telegram
```

Required values:

```env
TELEGRAM_BOT_TOKEN=123456:REDACTED
TELEGRAM_CHAT_ID=123456789
```

Do not commit `.env`, `.env.telegram`, or `telegram/.env.telegram`.

## Doctor

```bash
node telegram/telegram_approval_bot.js doctor
```

The doctor prints whether the bot token and chat id are present, redacts those values, lists watch paths, reports whether watched files exist, shows the state path, shows the last Telegram update id if state exists, and shows whether `test-message` is allowed.

## Test Message

```bash
TELEGRAM_TEST_ALLOW=true node telegram/telegram_approval_bot.js test-message
```

This sends one message:

```text
MoneyMaker Telegram test: bot is connected.
```

Without `TELEGRAM_TEST_ALLOW=true`, `test-message` refuses to run.

## Why Telegram May Be Silent

- Telegram bot is not running in PM2.
- Wrong env file is being used.
- Wrong Telegram chat id is configured.
- No candidates are written.
- `AUTO_LIVE_CANDIDATES_ENABLED=false`.
- Candidates are blocked before file emission.
- Watch paths do not include the file being written.
