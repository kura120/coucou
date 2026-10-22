// The Crypto pill's card (src/views/integrations.ts): the rows, the price and
// change formatting, the sparkline, the "Not found" line and the one click that
// opens a page. The prices come from Rust (integration_crypto); the settings
// that choose them are plain settings, not keys.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import {
  cryptoChange, cryptoPrice, hasIntegrationData, isCryptoTradeUrl, renderIntegrationCard,
} from "../src/views/integrations.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

const CRYPTO = "integration_crypto";
const COINBASE_BTC = "https://www.coinbase.com/advanced-trade/spot/BTC-USD";

const quote = (over = {}) => ({
  symbol: "BTC", price: 62140.4, open24h: 61000, changePct: 1.87,
  spark: [60000, 61000, 62140.4], tradeUrl: COINBASE_BTC, ...over,
});

function setCrypto(data, over = {}) {
  State.integrations[CRYPTO] = {
    data: { exchange: "coinbase", currency: "USD", quotes: [], missing: [], ...data },
    error: null, loaded: true, configured: true, ...over,
  };
}

const task = () => ({
  id: CRYPTO, name: "Crypto", color: "#F7931A", state: "idle", stepIndex: 0, steps: [], source: "n8n", isIntegration: true,
});
const hooks = { detailOpen: false, openDetail() {}, closeDetail() {}, openSettings() {} };
const card = () => renderIntegrationCard(task(), hooks);
const rowsOf = (el) => el.find(".int-row");

beforeEach(() => {
  setLanguage("en");
  calls.length = 0;
  for (const id of Object.keys(State.integrations)) delete State.integrations[id];
  State.settings = { ...DEFAULT_SETTINGS };
});

// ── Settings and data ─────────────────────────────────────────────────────────

test("the Crypto settings default to Coinbase, USD and three coins", () => {
  assert.equal(DEFAULT_SETTINGS.cryptoExchange, "coinbase");
  assert.equal(DEFAULT_SETTINGS.cryptoCurrency, "USD");
  assert.equal(DEFAULT_SETTINGS.cryptoCoins, "BTC, ETH, SOL");
});

test("the Crypto pill has a card once a quote is in", () => {
  assert.equal(hasIntegrationData(CRYPTO), false, "nothing reported yet");
  setCrypto({ quotes: [] });
  assert.equal(hasIntegrationData(CRYPTO), false, "no quotes");
  setCrypto({ quotes: [quote()] });
  assert.equal(hasIntegrationData(CRYPTO), true);
  State.integrations[CRYPTO].error = "Coinbase did not answer";
  assert.equal(hasIntegrationData(CRYPTO), false, "an error shows the idle card");
});

// ── Rows ──────────────────────────────────────────────────────────────────────

test("one row per quote, in order, three at most, the first one highlighted", () => {
  setCrypto({ quotes: ["BTC", "ETH", "SOL", "XRP"].map((symbol) => quote({ symbol })) });
  const list = rowsOf(card());
  assert.deepEqual(list.map((row) => row.find("b")[0].textContent), ["BTC", "ETH", "SOL"]);
  assert.equal(list[0].classList.contains("first"), true);
  assert.equal(list[1].classList.contains("first"), false);
});

// ── Price formatting ──────────────────────────────────────────────────────────

test("prices: whole units from 1000 up, two decimals from 1, four below", () => {
  assert.equal(cryptoPrice(62140.4, "USD"), "$62,140");
  assert.equal(cryptoPrice(1000, "USD"), "$1,000");
  assert.equal(cryptoPrice(999.5, "USD"), "$999.50");
  assert.equal(cryptoPrice(1.5, "USD"), "$1.50");
  assert.equal(cryptoPrice(0.5, "USD"), "$0.5000");
  assert.equal(cryptoPrice(1234.4, "EUR"), "€1,234");
});

test("the card shows the price in the quote's currency", () => {
  setCrypto({ currency: "EUR", quotes: [quote({ price: 1234.4 }), quote({ symbol: "SOL", price: 142.256 })] });
  const [btc, sol] = rowsOf(card());
  assert.equal(btc.find(".int-amount")[0].textContent, "€1,234");
  assert.equal(sol.find(".int-amount")[0].textContent, "€142.26");
});

// ── Change: sign, minus and colour ────────────────────────────────────────────

test("a change carries its sign, with U+2212 for a minus and two decimals", () => {
  assert.equal(cryptoChange(1.87), "+1.87 %");
  assert.equal(cryptoChange(0), "+0.00 %");
  assert.equal(cryptoChange(-0.42), "−0.42 %");
  assert.equal(cryptoChange(-0.42).charCodeAt(0), 0x2212);
});

test("the change is green from zero up and red below", () => {
  setCrypto({ quotes: [quote({ symbol: "BTC", changePct: 1.87 }), quote({ symbol: "ETH", changePct: -0.42 }), quote({ symbol: "SOL", changePct: 0 })] });
  const [up, down, flat] = rowsOf(card());
  assert.equal(up.find(".crypto-change")[0].textContent, "+1.87 %");
  assert.equal(up.find(".crypto-change")[0].getAttribute("style"), "color:#22C55E");
  assert.equal(down.find(".crypto-change")[0].textContent, "−0.42 %");
  assert.equal(down.find(".crypto-change")[0].getAttribute("style"), "color:#F4505E");
  assert.equal(flat.find(".crypto-change")[0].getAttribute("style"), "color:#22C55E");
});

// ── Sparkline ─────────────────────────────────────────────────────────────────

test("a sparkline only with two or more closes, a plain line through them", () => {
  setCrypto({ quotes: [quote({ symbol: "BTC", spark: [1, 2, 3] }), quote({ symbol: "ETH", spark: [5] }), quote({ symbol: "SOL", spark: [] })] });
  const [btc, eth, sol] = rowsOf(card());
  assert.equal(btc.find(".crypto-spark").length, 1);
  const line = btc.find("polyline")[0];
  assert.equal(line.getAttribute("points"), "0.0,14.0 24.0,7.0 48.0,0.0");
  assert.equal(line.getAttribute("fill"), "none");
  assert.equal(line.getAttribute("stroke"), "#22C55E");
  assert.equal(eth.find(".crypto-spark").length, 0);
  assert.equal(sol.find(".crypto-spark").length, 0);
});

// ── Not found ─────────────────────────────────────────────────────────────────

test("coins that were not found are named on a last, dim line", () => {
  setCrypto({ quotes: [quote()], missing: ["XYZ", "FOO"] });
  const el = card();
  const lines = el.find(".int-empty");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, "Not found: XYZ, FOO");
  const list = el.find(".int-rows")[0];
  assert.equal(list.children.at(-1), lines[0]);
});

test("no Not found line when every coin was found", () => {
  setCrypto({ quotes: [quote()], missing: [] });
  assert.equal(card().find(".int-empty").length, 0);
});

// ── Clicks ────────────────────────────────────────────────────────────────────

test("trade links open only on coinbase.com and okx.com", () => {
  assert.equal(isCryptoTradeUrl(COINBASE_BTC), true);
  assert.equal(isCryptoTradeUrl("https://www.coinbase.com/"), true);
  assert.equal(isCryptoTradeUrl("https://www.okx.com/trade-spot/eth-usdt"), true);
  assert.equal(isCryptoTradeUrl("https://www.coinbase.com.evil.example/"), false);
  assert.equal(isCryptoTradeUrl("http://www.coinbase.com/"), false);
  assert.equal(isCryptoTradeUrl("https://coinbase.com/"), false);
  assert.equal(isCryptoTradeUrl("javascript:alert(1)"), false);
  assert.equal(isCryptoTradeUrl(undefined), false);
});

test("a click opens the row's page, and a row with any other address opens nothing", async () => {
  setCrypto({
    quotes: [
      quote({ symbol: "BTC" }),
      quote({ symbol: "ETH", tradeUrl: "https://www.okx.com/trade-spot/eth-usdt" }),
      quote({ symbol: "SOL", tradeUrl: "https://evil.example/sol" }),
    ],
  });
  const [btc, eth, sol] = rowsOf(card());
  btc.fire("click");
  eth.fire("click");
  sol.fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent("open_url"), [{ url: COINBASE_BTC }, { url: "https://www.okx.com/trade-spot/eth-usdt" }]);
  assert.equal(calls.filter(([name]) => name === "open_url").length, 2);
});
