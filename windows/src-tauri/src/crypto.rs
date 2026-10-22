// The crypto pill — the Rust side of CryptoController.swift.
//
// Prices of the coins the user picked, from Coinbase or OKX public market data:
// no key and no account. The only hosts reached are the two exchanges. Prices
// are read every minute and the 24-hour hourly curve every ten minutes, and
// only while the pill is on and Peika is not paused (integrations::spawn).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::integrations::{self, IntegrationUpdate};
use crate::log;

const ID: &str = "integration_crypto";
/// How often a coin's hourly curve is fetched again.
const CURVE_EVERY: Duration = Duration::from_secs(600);
const MAX_COINS: usize = 8;
/// The longest symbol kept. A longer token is a word, not a coin.
const MAX_SYMBOL_LEN: usize = 10;
/// Hourly closes shown as the curve: the last 24 hours.
const CURVE_POINTS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exchange {
    Coinbase,
    Okx,
}

impl Exchange {
    /// "okx" is OKX; anything else reads as Coinbase, the default.
    pub fn from_setting(raw: &str) -> Self {
        if raw == "okx" {
            Exchange::Okx
        } else {
            Exchange::Coinbase
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Exchange::Coinbase => "coinbase",
            Exchange::Okx => "okx",
        }
    }
}

/// "EUR" is euros; anything else reads as dollars, the default.
pub fn currency_from_setting(raw: &str) -> &'static str {
    if raw == "EUR" {
        "EUR"
    } else {
        "USD"
    }
}

/// The coins the user typed. Split on anything that is not an ASCII letter or
/// digit, uppercased, tokens longer than 10 characters dropped, repeats dropped,
/// at most 8, in the order typed.
pub fn parse_coins(raw: &str) -> Vec<String> {
    let mut coins: Vec<String> = Vec::new();
    for token in raw.split(|c: char| !c.is_ascii_alphanumeric()) {
        if token.is_empty() || token.len() > MAX_SYMBOL_LEN {
            continue;
        }
        let symbol = token.to_ascii_uppercase();
        if coins.contains(&symbol) {
            continue;
        }
        coins.push(symbol);
        if coins.len() == MAX_COINS {
            break;
        }
    }
    coins
}

/// `BTC-USD`, except on OKX, which quotes dollars as `BTC-USDT`.
pub fn pair(exchange: Exchange, symbol: &str, currency: &str) -> String {
    let quote = match (exchange, currency) {
        (Exchange::Okx, "USD") => "USDT",
        _ => currency,
    };
    format!("{symbol}-{quote}")
}

pub fn ticker_url(exchange: Exchange, pair: &str) -> String {
    match exchange {
        Exchange::Coinbase => format!("https://api.exchange.coinbase.com/products/{pair}/stats"),
        Exchange::Okx => format!("https://www.okx.com/api/v5/market/ticker?instId={pair}"),
    }
}

pub fn candles_url(exchange: Exchange, pair: &str) -> String {
    match exchange {
        Exchange::Coinbase => {
            format!("https://api.exchange.coinbase.com/products/{pair}/candles?granularity=3600")
        }
        Exchange::Okx => {
            format!("https://www.okx.com/api/v5/market/candles?instId={pair}&bar=1H&limit=24")
        }
    }
}

/// The page where the user trades the pair. OKX's page address is lowercase.
pub fn trade_url(exchange: Exchange, pair: &str) -> String {
    match exchange {
        Exchange::Coinbase => format!("https://www.coinbase.com/advanced-trade/spot/{pair}"),
        Exchange::Okx => format!("https://www.okx.com/trade-spot/{}", pair.to_ascii_lowercase()),
    }
}

/// A number as the exchanges send it: a JSON number, or a string holding one.
fn number(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// OKX's `code`, which is "0" on success. Accepts the string or the number.
fn code_is_zero(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(s)) => s == "0",
        Some(Value::Number(n)) => n.as_i64() == Some(0),
        _ => false,
    }
}

/// (last price, price 24 hours ago), or `None` when the reply does not hold
/// both. OKX replies with a `code` that must be "0".
pub fn parse_ticker(exchange: Exchange, json: &Value) -> Option<(f64, f64)> {
    match exchange {
        Exchange::Coinbase => Some((number(json.get("last"))?, number(json.get("open"))?)),
        Exchange::Okx => {
            if !code_is_zero(json.get("code")) {
                return None;
            }
            let row = json.get("data")?.as_array()?.first()?;
            Some((number(row.get("last"))?, number(row.get("open24h"))?))
        }
    }
}

/// The closes of the last 24 hourly candles, oldest first. The exchanges send
/// the newest first; the first 24 rows are taken, the rows whose close is not a
/// number are skipped, and the rest reversed. Empty when the reply is not a list.
pub fn parse_candles(exchange: Exchange, json: &Value) -> Vec<f64> {
    let rows = match exchange {
        Exchange::Coinbase => json.as_array(),
        Exchange::Okx if json.get("code").is_some() && !code_is_zero(json.get("code")) => None,
        Exchange::Okx => json.get("data").and_then(Value::as_array),
    };
    let Some(rows) = rows else { return Vec::new() };
    // Index 4 is the close on both exchanges: [time, low, high, open, close, …]
    // on Coinbase and [ts, open, high, low, close, …] on OKX.
    let mut closes: Vec<f64> = rows
        .iter()
        .take(CURVE_POINTS)
        .filter_map(|row| number(row.as_array()?.get(4)))
        .collect();
    closes.reverse();
    closes
}

/// Percent change from the price 24 hours ago. Zero when that price is zero.
pub fn change_pct(price: f64, open24h: f64) -> f64 {
    if open24h == 0.0 {
        return 0.0;
    }
    let pct = (price - open24h) / open24h * 100.0;
    if pct.is_finite() {
        pct
    } else {
        0.0
    }
}

/// One entry of the card's `quotes`.
pub fn quote_json(
    exchange: Exchange,
    currency: &str,
    symbol: &str,
    price: f64,
    open24h: f64,
    spark: &[f64],
) -> Value {
    let pair = pair(exchange, symbol, currency);
    json!({
        "symbol": symbol,
        "price": price,
        "open24h": open24h,
        "changePct": change_pct(price, open24h),
        "spark": spark,
        "tradeUrl": trade_url(exchange, &pair),
    })
}

// ── The poll ──────────────────────────────────────────────────────────────────

/// Why one coin's request gave no answer. The first one of a poll that left
/// every coin unanswered is the card's error line.
#[derive(Debug)]
enum Failure {
    /// No answer at all: the network, a timeout.
    Connection(String),
    /// An answer that is not HTTP 200.
    Status(u16),
    /// An HTTP 200 whose body is not what the exchange documents.
    Unreadable,
}

impl Failure {
    /// The card's error line, worded as the other pollers word theirs.
    fn message(&self) -> String {
        match self {
            Failure::Connection(error) => {
                crate::i18n::tf("No connection: {error}", &[("error", error.as_str())])
            }
            Failure::Status(code) => {
                crate::i18n::tf("API error {code}", &[("code", &code.to_string())])
            }
            Failure::Unreadable => {
                crate::i18n::tf("No connection: {error}", &[("error", "unexpected reply")])
            }
        }
    }
}

/// One GET, answered only by HTTP 200.
async fn get_json(http: &reqwest::Client, url: &str) -> Result<Value, Failure> {
    let response = http
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| Failure::Connection(e.to_string()))?;
    let status = response.status();
    if status != StatusCode::OK {
        return Err(Failure::Status(status.as_u16()));
    }
    response.json::<Value>().await.map_err(|_| Failure::Unreadable)
}

/// What one coin's fetch brought back.
struct Fetched {
    ticker: Result<(f64, f64), Failure>,
    /// `None` when the curve was not due this time.
    curve: Option<Result<Vec<f64>, Failure>>,
}

async fn fetch_coin(
    http: reqwest::Client,
    exchange: Exchange,
    currency: &'static str,
    symbol: String,
    want_curve: bool,
) -> Fetched {
    let pair = pair(exchange, &symbol, currency);
    let ticker = match get_json(&http, &ticker_url(exchange, &pair)).await {
        Ok(json) => parse_ticker(exchange, &json).ok_or(Failure::Unreadable),
        Err(failure) => Err(failure),
    };
    // A coin with no price has no curve drawn for it either.
    let curve = if want_curve && ticker.is_ok() {
        Some(
            get_json(&http, &candles_url(exchange, &pair))
                .await
                .map(|json| parse_candles(exchange, &json)),
        )
    } else {
        None
    };
    Fetched { ticker, curve }
}

/// What the last poll left: the market it was for, and each coin's curve with
/// the time it was fetched.
#[derive(Default)]
struct Cache {
    key: String,
    curves: HashMap<String, (Instant, Vec<f64>)>,
}

impl Cache {
    /// For each coin, whether its curve is to be fetched now. A different
    /// exchange, currency or coin list forgets every curve: they were another
    /// market's.
    fn due(&mut self, key: &str, coins: &[String], now: Instant) -> Vec<bool> {
        if self.key != key {
            self.key = key.to_string();
            self.curves.clear();
        }
        coins
            .iter()
            .map(|coin| curve_due(self.curves.get(coin).map(|(at, _)| *at), now))
            .collect()
    }
}

/// Due when it was never fetched, or was fetched `CURVE_EVERY` or more ago.
fn curve_due(fetched_at: Option<Instant>, now: Instant) -> bool {
    match fetched_at {
        None => true,
        Some(at) => now.saturating_duration_since(at) >= CURVE_EVERY,
    }
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

/// The crypto settings as the user left them.
struct Request {
    exchange: Exchange,
    currency: &'static str,
    coins: Vec<String>,
}

impl Request {
    /// Names the market the curves are fetched for.
    fn key(&self) -> String {
        format!("{}|{}|{}", self.exchange.id(), self.currency, self.coins.join(","))
    }
}

fn read_request(app: &AppHandle) -> Option<Request> {
    let shared = app.try_state::<crate::Shared>()?;
    let settings = shared.settings.lock().unwrap();
    Some(Request {
        exchange: Exchange::from_setting(&settings.crypto_exchange),
        currency: currency_from_setting(&settings.crypto_currency),
        coins: parse_coins(&settings.crypto_coins),
    })
}

/// One poll: the price of every coin, the curves when they are due, then the card.
pub async fn poll(app: AppHandle) {
    let Some(request) = read_request(&app) else { return };
    let due = CACHE.lock().unwrap().due(&request.key(), &request.coins, Instant::now());

    let http = integrations::client();
    let tasks: Vec<_> = request
        .coins
        .iter()
        .zip(due)
        .map(|(coin, want_curve)| {
            tauri::async_runtime::spawn(fetch_coin(
                http.clone(),
                request.exchange,
                request.currency,
                coin.clone(),
                want_curve,
            ))
        })
        .collect();
    let mut fetched = Vec::with_capacity(tasks.len());
    for task in tasks {
        fetched.push(task.await.unwrap_or_else(|e| Fetched {
            ticker: Err(Failure::Connection(e.to_string())),
            curve: None,
        }));
    }

    let mut quotes = Vec::new();
    let mut missing = Vec::new();
    let mut first_error: Option<String> = None;
    {
        let mut cache = CACHE.lock().unwrap();
        for (coin, fetch) in request.coins.iter().zip(fetched) {
            match fetch.curve {
                Some(Ok(closes)) => {
                    cache.curves.insert(coin.clone(), (Instant::now(), closes));
                }
                Some(Err(failure)) => log::line(format!("crypto {coin} curve: {failure:?}")),
                None => {}
            }
            match fetch.ticker {
                Ok((price, open24h)) => {
                    // A failed curve keeps the one it had, if any.
                    let spark: &[f64] = match cache.curves.get(coin) {
                        Some((_, closes)) => closes.as_slice(),
                        None => &[],
                    };
                    quotes.push(quote_json(
                        request.exchange,
                        request.currency,
                        coin,
                        price,
                        open24h,
                        spark,
                    ));
                }
                Err(failure) => {
                    log::line(format!("crypto {coin}: {failure:?}"));
                    first_error.get_or_insert_with(|| failure.message());
                    missing.push(coin.clone());
                }
            }
        }
    }

    // Not one coin answered: the network is down, or the exchange refused them all.
    let error = if quotes.is_empty() && !request.coins.is_empty() {
        first_error
    } else {
        None
    };
    let data = json!({
        "exchange": request.exchange.id(),
        "currency": request.currency,
        "quotes": quotes,
        "missing": missing,
    });
    integrations::emit(&app, IntegrationUpdate { id: ID, data, error, event: None });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `n` Coinbase candles, newest first. Candle i closes at 2000 - i, so the
    /// curve of the last 24 runs 1977 … 2000.
    fn coinbase_rows(n: usize) -> Value {
        Value::Array(
            (0..n)
                .map(|i| {
                    json!([1_700_000_000u64 - 3600 * i as u64, 1.0, 2.0, 1.5, 2000.0 - i as f64, 3.0])
                })
                .collect(),
        )
    }

    /// The same as `coinbase_rows`, in OKX's shape, with the numbers as strings.
    fn okx_rows(n: usize) -> Value {
        Value::Array(
            (0..n)
                .map(|i| {
                    json!([
                        (1_700_000_000_000u64 - 3_600_000 * i as u64).to_string(),
                        "1", "2", "1.5",
                        (2000 - i).to_string(),
                        "3", "3", "3", "1"
                    ])
                })
                .collect(),
        )
    }

    // ── Coins ─────────────────────────────────────────────────────────────────

    #[test]
    fn coins_are_split_on_anything_but_letters_and_digits_and_uppercased() {
        assert_eq!(parse_coins("btc, Eth;sol"), ["BTC", "ETH", "SOL"]);
        assert_eq!(parse_coins("doge/ada.xrp\nlink"), ["DOGE", "ADA", "XRP", "LINK"]);
        assert_eq!(parse_coins(" \t\n "), Vec::<String>::new());
        assert_eq!(parse_coins(""), Vec::<String>::new());
    }

    #[test]
    fn a_coin_typed_twice_is_listed_once_where_it_first_appears() {
        assert_eq!(parse_coins("eth, btc, ETH, btc"), ["ETH", "BTC"]);
    }

    #[test]
    fn a_token_longer_than_ten_characters_is_not_a_coin() {
        assert_eq!(parse_coins("btc, abcdefghijk, eth"), ["BTC", "ETH"]);
        assert_eq!(parse_coins("abcdefghij"), ["ABCDEFGHIJ"]);
    }

    #[test]
    fn at_most_eight_coins_are_kept_and_repeats_do_not_use_up_the_room() {
        assert_eq!(
            parse_coins("a1 a2 a3 a4 a5 a6 a7 a8 a9 a10"),
            ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
        );
        assert_eq!(
            parse_coins("a1 a1 a2 a3 a4 a5 a6 a7 a8 a9"),
            ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
        );
    }

    #[test]
    fn unknown_settings_read_as_coinbase_and_dollars() {
        assert_eq!(Exchange::from_setting("okx"), Exchange::Okx);
        assert_eq!(Exchange::from_setting("coinbase"), Exchange::Coinbase);
        assert_eq!(Exchange::from_setting("kraken"), Exchange::Coinbase);
        assert_eq!(Exchange::from_setting(""), Exchange::Coinbase);
        assert_eq!(currency_from_setting("EUR"), "EUR");
        assert_eq!(currency_from_setting("USD"), "USD");
        assert_eq!(currency_from_setting("GBP"), "USD");
    }

    // ── Pairs and URLs ────────────────────────────────────────────────────────

    #[test]
    fn okx_quotes_dollars_in_usdt_and_coinbase_does_not() {
        assert_eq!(pair(Exchange::Coinbase, "BTC", "USD"), "BTC-USD");
        assert_eq!(pair(Exchange::Okx, "BTC", "USD"), "BTC-USDT");
        assert_eq!(pair(Exchange::Okx, "ETH", "EUR"), "ETH-EUR");
        assert_eq!(pair(Exchange::Coinbase, "SOL", "EUR"), "SOL-EUR");
    }

    #[test]
    fn the_endpoints_are_the_documented_ones() {
        assert_eq!(
            ticker_url(Exchange::Coinbase, "BTC-USD"),
            "https://api.exchange.coinbase.com/products/BTC-USD/stats"
        );
        assert_eq!(
            candles_url(Exchange::Coinbase, "BTC-USD"),
            "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600"
        );
        assert_eq!(
            ticker_url(Exchange::Okx, "BTC-USDT"),
            "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"
        );
        assert_eq!(
            candles_url(Exchange::Okx, "BTC-USDT"),
            "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=24"
        );
    }

    #[test]
    fn the_trade_page_is_lowercase_on_okx_and_as_is_on_coinbase() {
        assert_eq!(
            trade_url(Exchange::Okx, "BTC-USDT"),
            "https://www.okx.com/trade-spot/btc-usdt"
        );
        assert_eq!(
            trade_url(Exchange::Coinbase, "BTC-USD"),
            "https://www.coinbase.com/advanced-trade/spot/BTC-USD"
        );
    }

    // ── Tickers ───────────────────────────────────────────────────────────────

    #[test]
    fn coinbase_ticker_reads_last_and_open_whether_strings_or_numbers() {
        let recorded = json!({
            "open": "61000.00", "high": "63000.0", "low": "60100.1",
            "volume": "1234.5", "last": "62140.5", "volume_30day": "9.9"
        });
        assert_eq!(parse_ticker(Exchange::Coinbase, &recorded), Some((62140.5, 61000.0)));
        let numbers = json!({ "open": 61000, "last": 62140.5 });
        assert_eq!(parse_ticker(Exchange::Coinbase, &numbers), Some((62140.5, 61000.0)));
    }

    #[test]
    fn coinbase_ticker_without_both_numbers_is_none() {
        assert_eq!(parse_ticker(Exchange::Coinbase, &json!({ "last": "1" })), None);
        assert_eq!(parse_ticker(Exchange::Coinbase, &json!({ "last": "x", "open": "1" })), None);
        assert_eq!(parse_ticker(Exchange::Coinbase, &json!({ "message": "NotFound" })), None);
    }

    #[test]
    fn okx_ticker_is_read_from_its_first_row_when_the_code_is_zero() {
        let recorded = json!({
            "code": "0",
            "msg": "",
            "data": [{
                "instType": "SPOT", "instId": "BTC-USDT", "last": "62140.5",
                "open24h": "61000.0", "high24h": "63000", "vol24h": "1"
            }]
        });
        assert_eq!(parse_ticker(Exchange::Okx, &recorded), Some((62140.5, 61000.0)));
        let numbers = json!({ "code": "0", "data": [{ "last": 62140.5, "open24h": 61000 }] });
        assert_eq!(parse_ticker(Exchange::Okx, &numbers), Some((62140.5, 61000.0)));
    }

    #[test]
    fn okx_ticker_with_a_code_other_than_zero_is_none() {
        let unknown = json!({
            "code": "51001", "msg": "Instrument ID doesn't exist", "data": []
        });
        assert_eq!(parse_ticker(Exchange::Okx, &unknown), None);
        let row = json!({ "code": "1", "data": [{ "last": "1", "open24h": "1" }] });
        assert_eq!(parse_ticker(Exchange::Okx, &row), None);
        let no_code = json!({ "data": [{ "last": "1", "open24h": "1" }] });
        assert_eq!(parse_ticker(Exchange::Okx, &no_code), None);
    }

    // ── Curves ────────────────────────────────────────────────────────────────

    #[test]
    fn coinbase_curve_is_the_last_24_closes_oldest_first() {
        let curve = parse_candles(Exchange::Coinbase, &coinbase_rows(30));
        assert_eq!(curve.len(), 24);
        assert_eq!(curve.first(), Some(&1977.0));
        assert_eq!(curve.last(), Some(&2000.0));
        assert!(curve.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn okx_curve_is_the_last_24_closes_oldest_first() {
        let reply = json!({ "code": "0", "msg": "", "data": okx_rows(30).as_array().unwrap().clone() });
        let curve = parse_candles(Exchange::Okx, &reply);
        assert_eq!(curve.len(), 24);
        assert_eq!(curve.first(), Some(&1977.0));
        assert_eq!(curve.last(), Some(&2000.0));
        assert!(curve.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn a_short_curve_is_kept_whole() {
        let curve = parse_candles(Exchange::Coinbase, &coinbase_rows(5));
        assert_eq!(curve, [1996.0, 1997.0, 1998.0, 1999.0, 2000.0]);
    }

    #[test]
    fn candle_closes_may_be_strings_and_short_or_broken_rows_are_skipped() {
        let rows = json!([
            [1, 1.0, 1.0, 1.0, 5.0],
            [2, 1.0, 1.0, 1.0],
            [3, 1.0, 1.0, 1.0, "x"],
            [4, 1.0, 1.0, 1.0, "7.5"],
            "not a row"
        ]);
        assert_eq!(parse_candles(Exchange::Coinbase, &rows), [7.5, 5.0]);
    }

    #[test]
    fn an_okx_reply_with_another_code_or_no_rows_has_no_curve() {
        let refused = json!({ "code": "50011", "msg": "Rate limit", "data": [] });
        assert!(parse_candles(Exchange::Okx, &refused).is_empty());
        let refused_with_rows = json!({ "code": "1", "data": okx_rows(3) });
        assert!(parse_candles(Exchange::Okx, &refused_with_rows).is_empty());
        assert!(parse_candles(Exchange::Coinbase, &json!({ "message": "NotFound" })).is_empty());
    }

    // ── The card ──────────────────────────────────────────────────────────────

    #[test]
    fn change_is_the_percentage_from_the_price_24_hours_ago() {
        assert!((change_pct(110.0, 100.0) - 10.0).abs() < 1e-9);
        assert!((change_pct(90.0, 100.0) + 10.0).abs() < 1e-9);
        assert_eq!(change_pct(5.0, 0.0), 0.0);
    }

    #[test]
    fn a_quote_carries_its_pair_s_trade_page() {
        let quote = quote_json(Exchange::Okx, "USD", "BTC", 62140.5, 61000.0, &[1.0, 2.0]);
        assert_eq!(quote["symbol"], json!("BTC"));
        assert_eq!(quote["price"], json!(62140.5));
        assert_eq!(quote["open24h"], json!(61000.0));
        assert_eq!(quote["spark"], json!([1.0, 2.0]));
        assert_eq!(quote["tradeUrl"], json!("https://www.okx.com/trade-spot/btc-usdt"));
        assert!((quote["changePct"].as_f64().unwrap() - 1.8697).abs() < 1e-3);

        let eur = quote_json(Exchange::Coinbase, "EUR", "ETH", 2000.0, 2000.0, &[]);
        assert_eq!(eur["tradeUrl"], json!("https://www.coinbase.com/advanced-trade/spot/ETH-EUR"));
        assert_eq!(eur["changePct"], json!(0.0));
    }

    #[test]
    fn a_curve_is_due_when_never_fetched_and_again_after_ten_minutes() {
        let t0 = Instant::now();
        assert!(curve_due(None, t0));
        assert!(!curve_due(Some(t0), t0 + Duration::from_secs(599)));
        assert!(curve_due(Some(t0), t0 + Duration::from_secs(600)));
    }

    #[test]
    fn a_curve_is_kept_between_polls_and_forgotten_when_the_market_changes() {
        let t0 = Instant::now();
        let later = t0 + Duration::from_secs(60);
        let coins = vec!["BTC".to_string(), "ETH".to_string()];
        let mut cache = Cache::default();

        assert_eq!(cache.due("coinbase|USD|BTC,ETH", &coins, t0), [true, true]);
        cache.curves.insert("BTC".into(), (t0, vec![1.0]));
        cache.curves.insert("ETH".into(), (t0, vec![2.0]));
        assert_eq!(cache.due("coinbase|USD|BTC,ETH", &coins, later), [false, false]);
        assert_eq!(cache.curves["BTC"].1, [1.0]);

        // Another exchange, currency or coin list: no curve is kept.
        assert_eq!(cache.due("okx|USD|BTC,ETH", &coins, later), [true, true]);
        assert!(cache.curves.is_empty());
    }

    #[test]
    fn a_coin_added_later_is_fetched_while_the_others_wait() {
        let t0 = Instant::now();
        let later = t0 + Duration::from_secs(60);
        let mut cache = Cache::default();
        let one = vec!["BTC".to_string()];
        cache.due("coinbase|USD|BTC", &one, t0);
        cache.curves.insert("BTC".into(), (t0, vec![1.0]));

        // Adding a coin changes the market key, so every curve is fetched once more.
        let two = vec!["BTC".to_string(), "SOL".to_string()];
        assert_eq!(cache.due("coinbase|USD|BTC,SOL", &two, later), [true, true]);
    }
}
