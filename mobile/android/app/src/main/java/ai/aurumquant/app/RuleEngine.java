package ai.aurumquant.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

/**
 * Deterministic SMC-style rule engine that runs natively (no WebView, no LLM)
 * so it keeps working inside the foreground service even when the app is closed.
 *
 * STRICT by design: it returns HOLD unless there is genuine multi-factor
 * confluence for a BUY or SELL. It will never emit a weak/forced signal.
 *
 * Data source: OANDA candles if a token is configured (read from the same
 * Capacitor Preferences store the in-app Settings writes to), otherwise the
 * Twelve Data fallback.
 */
public class RuleEngine {

    public static class Decision {
        public String action = "HOLD"; // BUY | SELL | HOLD
        public double price = Double.NaN;
        public double tp = Double.NaN;
        public double sl = Double.NaN;
        public String note = "";
        public boolean dataOk = false;
    }

    private static final String PREFS = "CapacitorStorage";
    private static final String SETTINGS_KEY = "aurum_device_settings_v1";
    private static final String DEFAULT_TWELVE_KEY = "23c57edf48e541e48db2806575f58bf7";

    public static Decision evaluate(Context ctx) {
        Decision d = new Decision();
        try {
            JSONObject s = loadSettings(ctx);
            String instrument = normInstrument(s.optString("botInstrument", "XAU_USD"));
            String oandaToken = s.optString("oandaApiToken", "").trim();
            String env = s.optString("oandaEnvironment", "practice").toLowerCase();

            double[][] candles = null; // [n][4] = open,high,low,close
            if (!oandaToken.isEmpty()) {
                candles = fetchOandaCandles(oandaToken, env, instrument, "M5", 210);
            }
            if (candles == null || candles.length < 60) {
                candles = fetchTwelveCandles(collectTwelveKeys(s), instrument, "5min", 210);
            }
            if (candles == null || candles.length < 60) {
                d.note = "No market data (add OANDA/Twelve Data key in Settings).";
                return d;
            }
            d.dataOk = true;

            int n = candles.length;
            double[] close = new double[n];
            double[] high = new double[n];
            double[] low = new double[n];
            for (int i = 0; i < n; i++) {
                high[i] = candles[i][1];
                low[i] = candles[i][2];
                close[i] = candles[i][3];
            }

            double price = close[n - 1];
            d.price = price;

            double sma20 = sma(close, 20);
            double sma50 = sma(close, 50);
            double sma20prev = smaAt(close, 20, n - 4); // 3 bars ago
            double slope20 = sma20 - sma20prev;
            double atr = atr(high, low, close, 14);
            double momentum = close[n - 1] - close[n - 6]; // last 5 bars

            if (Double.isNaN(sma20) || Double.isNaN(sma50) || Double.isNaN(atr) || atr <= 0) {
                d.note = "Indicators warming up.";
                return d;
            }

            double extensionUp = price - sma20;   // >0 means above mean
            double extensionDown = sma20 - price;

            boolean trendUp = sma20 > sma50 && price > sma20 && slope20 > 0;
            boolean trendDown = sma20 < sma50 && price < sma20 && slope20 < 0;

            // STRICT confluence: trend + momentum + not over-extended (avoid chasing)
            boolean buy = trendUp && momentum > 0 && extensionUp < 1.8 * atr;
            boolean sell = trendDown && momentum < 0 && extensionDown < 1.8 * atr;

            if (buy && !sell) {
                d.action = "BUY";
                d.sl = round2(price - 1.5 * atr);
                d.tp = round2(price + 2.5 * atr);
                d.note = "Uptrend + momentum confluence";
            } else if (sell && !buy) {
                d.action = "SELL";
                d.sl = round2(price + 1.5 * atr);
                d.tp = round2(price - 2.5 * atr);
                d.note = "Downtrend + momentum confluence";
            } else {
                d.action = "HOLD";
                d.note = "No valid setup (waiting for confluence)";
            }
            d.price = round2(price);
            return d;
        } catch (Exception e) {
            d.note = "Engine error: " + e.getMessage();
            return d;
        }
    }

    // ---------- indicators ----------
    private static double sma(double[] a, int period) {
        return smaAt(a, period, a.length - 1);
    }
    private static double smaAt(double[] a, int period, int endIdx) {
        if (endIdx < period - 1 || endIdx >= a.length) return Double.NaN;
        double sum = 0;
        for (int i = endIdx - period + 1; i <= endIdx; i++) sum += a[i];
        return sum / period;
    }
    private static double atr(double[] high, double[] low, double[] close, int period) {
        int n = close.length;
        if (n < period + 1) return Double.NaN;
        double sum = 0;
        for (int i = n - period; i < n; i++) {
            double tr = Math.max(high[i] - low[i],
                    Math.max(Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
            sum += tr;
        }
        return sum / period;
    }
    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    // ---------- settings ----------
    private static JSONObject loadSettings(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(SETTINGS_KEY, null);
            if (raw != null && !raw.isEmpty()) return new JSONObject(raw);
        } catch (Exception ignored) {}
        return new JSONObject();
    }
    private static String normInstrument(String v) {
        if (v == null || v.trim().isEmpty()) return "XAU_USD";
        return v.trim().toUpperCase().replace("/", "_");
    }
    private static ArrayList<String> collectTwelveKeys(JSONObject s) {
        ArrayList<String> keys = new ArrayList<>();
        try {
            JSONArray arr = s.optJSONArray("twelveDataKeys");
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                String k = arr.optString(i, "").trim();
                if (!k.isEmpty() && !keys.contains(k)) keys.add(k);
            }
        } catch (Exception ignored) {}
        String single = s.optString("twelveDataKey", "").trim();
        if (!single.isEmpty() && !keys.contains(single)) keys.add(single);
        if (!keys.contains(DEFAULT_TWELVE_KEY)) keys.add(DEFAULT_TWELVE_KEY);
        return keys;
    }

    // ---------- data fetch ----------
    private static double[][] fetchOandaCandles(String token, String env, String instrument, String gran, int count) {
        try {
            String base = env.equals("live") ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
            String urlStr = base + "/v3/instruments/" + instrument + "/candles?price=M&granularity=" + gran + "&count=" + count;
            HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            if (c.getResponseCode() != 200) { c.disconnect(); return null; }
            JSONObject obj = new JSONObject(readAll(c));
            JSONArray arr = obj.optJSONArray("candles");
            if (arr == null) return null;
            ArrayList<double[]> out = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject k = arr.getJSONObject(i);
                if (!k.optBoolean("complete", true)) continue;
                JSONObject m = k.optJSONObject("mid");
                if (m == null) continue;
                out.add(new double[]{
                        m.optDouble("o"), m.optDouble("h"), m.optDouble("l"), m.optDouble("c")
                });
            }
            return out.toArray(new double[0][]);
        } catch (Exception e) {
            return null;
        }
    }

    private static double[][] fetchTwelveCandles(ArrayList<String> keys, String instrument, String interval, int count) {
        String sym = instrument.replace("_", "/");
        for (String key : keys) {
            try {
                String urlStr = "https://api.twelvedata.com/time_series?symbol=" + sym.replace("/", "%2F")
                        + "&interval=" + interval + "&outputsize=" + count + "&apikey=" + key + "&format=JSON";
                HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(12000);
                if (c.getResponseCode() != 200) { c.disconnect(); continue; }
                JSONObject obj = new JSONObject(readAll(c));
                JSONArray arr = obj.optJSONArray("values");
                if (arr == null) continue;
                // Twelve Data returns newest-first; reverse into oldest-first
                ArrayList<double[]> out = new ArrayList<>();
                for (int i = arr.length() - 1; i >= 0; i--) {
                    JSONObject v = arr.getJSONObject(i);
                    out.add(new double[]{
                            v.optDouble("open"), v.optDouble("high"), v.optDouble("low"), v.optDouble("close")
                    });
                }
                if (out.size() >= 60) return out.toArray(new double[0][]);
            } catch (Exception ignored) {}
        }
        return null;
    }

    private static String readAll(HttpURLConnection c) throws Exception {
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream()));
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        c.disconnect();
        return sb.toString();
    }
}
