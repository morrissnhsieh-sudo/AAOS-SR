---
name: weather
description: "Get current weather and forecasts via wttr.in. Use when: user asks about weather, temperature, or forecasts for any location. No API key needed."
allowed-tools: bash_exec
version: 1.0.0
---

Get the weather for the location the user specified: $ARGUMENTS

## Steps

1. Extract the location from the user's message. Replace spaces with `+` (e.g. "New York" → `New+York`, "Taichung" → `Taichung`).

2. Call `bash_exec` with this command to fetch current conditions:
   ```
   curl -s "wttr.in/{location}?format=%l:+%c+%t+(feels+like+%f),+%w+wind,+%h+humidity"
   ```

3. If the user asks for a forecast, call `bash_exec` with:
   ```
   curl -s "wttr.in/{location}?format=v2"
   ```

4. Present the output as a clean, readable response — do NOT show the curl command to the user.

## Format codes reference
- `%c` — condition emoji  `%t` — temperature  `%f` — feels like
- `%w` — wind            `%h` — humidity     `%p` — precipitation
- `%l` — location name

## Notes
- No API key required
- Works for cities, regions, airport codes (e.g. `TPE`, `LAX`)
- For rain queries use: `curl -s "wttr.in/{location}?format=%l:+%c+%p"`
