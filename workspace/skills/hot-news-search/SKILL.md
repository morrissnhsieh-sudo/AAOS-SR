---
name: hot-news-search
description: Fetch and present top news headlines by topic, category, or keyword from public news sources. Use when the user asks for news, headlines, or what is happening in the world.
allowed-tools: bash_exec think
version: 2.0.0
---

# Hot News Search

Fetch the top news headlines without requiring any API key by using freely accessible news sources.

## Method 1 — Google News RSS (no API key, always works)

Call `bash_exec` with curl to fetch Google News RSS for the requested topic:

**General top news:**
```bash
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --max-time 10 "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" | grep -o "<title>[^<]*</title>" | sed "s/<[^>]*>//g" | tail -n +2 | head -10
```

**Topic-specific (replace TOPIC with the search term, URL-encode spaces as +):**
```bash
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --max-time 10 "https://news.google.com/rss/search?q=TOPIC&hl=en-US&gl=US&ceid=US:en" | grep -o "<title>[^<]*</title>" | sed "s/<[^>]*>//g" | tail -n +2 | head -10
```

Parse the output — each line is one headline. Present the top 3–5 as a numbered list.

## Method 2 — Hacker News top stories (for tech news)

```bash
curl -s "https://hacker-news.firebaseio.com/v0/topstories.json" | tr ',' '\n' | head -5 | while read id; do curl -s "https://hacker-news.firebaseio.com/v0/item/${id}.json" | grep -oP '"title":"[^"]+' | sed 's/"title":"//'; done
```

## Method 3 — NewsAPI (if NEWS_API_KEY is set)

Only attempt this if Methods 1 and 2 fail AND the user has explicitly provided a key. Check first:
```bash
echo $NEWS_API_KEY
```
If the variable is set, call:
```bash
curl -s -A "Mozilla/5.0" "https://newsapi.org/v2/top-headlines?country=us&pageSize=5&apiKey=$NEWS_API_KEY"
```

## Execution rules

1. Call `think` first to determine: what topic is the user asking about? Which method to use?
2. **Always try Method 1 first** — it requires no API key and always returns results.
3. Parse the response and present headlines as a clean numbered list:
   ```
   1. **Headline title** — Source
   2. **Headline title** — Source
   3. **Headline title** — Source
   ```
4. Do NOT show raw XML, JSON, or curl output to the user.
5. Do NOT ask the user to set any environment variable — find another source if one fails.
6. If curl fails (no internet, timeout), say "Could not reach news sources — check your internet connection" and stop.
