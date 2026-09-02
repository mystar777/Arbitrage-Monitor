# ARBI Monitor

Read-only multichain DEX gap monitor with simulation reports and threshold alerts.

## Features

- DEX Screener discovery across stablecoin and selected major-asset pools.
- Cross-chain and same-chain pool comparison with conservative liquidity, fee, slippage, bridge, and gas estimates.
- Heuristic incident signals for sharp price or liquidity dislocations. These signals are not proof of an exploit and require manual verification.
- Telegram digest alerts when a live gap is at or above `ALERT_GAP_THRESHOLD_PCT` (default: 5%). Alerts include pool links, classification, modeled economics, and a review procedure.
- Historical incident replay is clearly separated from live scanner output.

## Telegram setup

Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`. The target user must start the bot first. If username resolution is unavailable, set the numeric `TELEGRAM_CHAT_ID` for the private chat. Secrets are ignored by Git; never commit `.env`.

## GitHub topics

Recommended repository topics: `blockchain`, `crypto`, `defi`, `arbitrage`, `dex`, `cross-chain`, `cctp`, `mev-research`, `onchain-analytics`, `telegram-bot`, `nodejs`, `javascript`, `web3`, `solidity`.

This project is a monitoring and simulation system. It does not sign or submit transactions.
