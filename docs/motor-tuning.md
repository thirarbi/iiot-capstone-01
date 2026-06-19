# Motor Tuning

All motor behaviour — speed, direction, travel, and hold timing — lives in one
file: [`config/motors.json`](../config/motors.json). It is the single source of
truth for **every** way a motor moves:

- Manual key **taps** (`robot/nada`)
- Manual **press-and-hold** (`robot/hold`)
- Full songs played from `note-reader/main.py` (`robot/score`)

All three paths go through the bridge's `settingsFor(note)`
([`src/nxt_bridge.js`](../src/nxt_bridge.js)), so whatever you tune here applies
identically whether you press a key by hand or `main.py` plays a score.

## Live tuning workflow

1. Start the broker + bridge as usual (`npm run broker`, `npm run bridge`).
2. Open the Web UI and press keys to move the motors.
3. Edit `config/motors.json`, change a value, and **save**.
4. The bridge **hot-reloads** the file (you'll see `🎛️  Motor config loaded`
   in the bridge terminal) — no restart needed.
5. Press the key again to feel the change. Repeat.

If `config/motors.json` is missing or a value is left out, the bridge falls back
to `BUILTIN_DEFAULTS`, which are the **original hard-coded values** — so the
system behaves exactly as before until you deliberately override something.

## Structure

```json
{
  "defaults": { "power": 75, "direction": 1, "pressDegrees": 30,
                "returnDegrees": 30, "pressSettleMs": 250,
                "holdMs": 200, "reversePower": 75, "maxHoldMs": 5000 },
  "motors": {
    "DO": {},                       // inherits everything from defaults
    "RE": { "power": 60 },          // RE presses softer
    "MI": { "direction": -1 }       // MI's motor is mounted backwards
    // ... FA, SOL, LA, SI, DO_TINGGI
  }
}
```

Resolution order (later wins): `BUILTIN_DEFAULTS` → `defaults` → per-motor
override. Put a key under a motor in `motors` only when it should differ from
`defaults`.

## Parameters

| Key             | Meaning                                                                 | Original |
|-----------------|-------------------------------------------------------------------------|----------|
| `power`         | Press speed / "rpm", 0–100.                                             | `75`     |
| `direction`     | `1` = normal, `-1` = flip a motor that's wired/mounted backwards.       | `1`      |
| `pressDegrees`  | **Max press rotation** — tacho limit the motor spins to press ("max spin"). | `30`     |
| `returnDegrees` | **Max return rotation** — tacho limit the motor spins back to retract. **Defaults to `pressDegrees`** when unset, so the return travels exactly as far as the press did (original behaviour). Set it to make the return shorter/longer than the press. | `30` (= `pressDegrees`) |
| `pressSettleMs` | How long the press is locked in before *any* retract is allowed — the time it needs to reach its press rotation. Until it elapses, a key lift/release is **deferred**, so a slow or late press still travels all the way out and never rolls back from a partial position. | `250`    |
| `holdMs`        | Dwell at the press position after it settles, then the retract→stop delay. | `200`    |
| `reversePower`  | Retract speed, 0–100.                                                   | `75`     |
| `maxHoldMs`     | Safety: auto-release a *held* motor after this long (in case a release event is missed). | `5000` |

`power` and `reversePower` are magnitudes (0–100); `direction` decides which way
those magnitudes turn. Press uses `+power × direction` over `pressDegrees`,
retract uses `−reversePower × direction` over `returnDegrees`.

### Press wins until it reaches its rotation

A press is sent as a tacho-limited move: the NXT itself drives the motor to
`pressDegrees` and then brakes. The only thing that used to cut it short was the
bridge sending the **retract** before the press had finished travelling — so a
press that was slow to get going would be yanked back from a partial position and
roll back too far. The bridge now **never** schedules the retract until at least
`pressSettleMs` has passed, so the press always reaches `pressDegrees` first; the
return then starts from a known position and `returnDegrees` lands it back at
rest. This applies to taps, held keys, score notes, **and** physical touch
buttons. (This is as positional as the NXT Direct-Command protocol gets without
polling `GETOUTPUTSTATE` for the live tacho count — `pressSettleMs` is the
time-based stand-in for "has it arrived yet?". Raise it if a motor still rolls
back; lower it for snappier taps. A genuinely stalled/jammed bar is the one case
time can't catch — see [nxt-strike-confirmation.md](nxt-strike-confirmation.md).)

## Press-and-hold vs. click

- **Click** (`robot/nada`, score notes, physical touch buttons): press → wait
  for it to reach its press rotation (`pressSettleMs`) → dwell `holdMs` → retract
  → stop. A re-tap while a press is still travelling is ignored.
- **Hold** (`robot/hold`): press once and **stay parked** at the press position
  for as long as the key is held; retract only on `release` (or after
  `maxHoldMs` as a safety net). This is why a held key no longer oscillates in
  and out — the bridge ignores repeat presses while a note is already held. If
  the key is lifted before the press has reached its rotation, the retract is
  deferred until it does (see "Press wins…" above).
