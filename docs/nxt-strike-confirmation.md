# NXT Strike Confirmation (closed loop)

Previously the bridge published `robot/strike` **optimistically** — the instant
it wrote the motor command to the serial port, whether or not the NXT received
or acted on it. That had two problems:

1. The **latency panel** could never measure anything real (command and "strike"
   happened at the same instant on the bridge), and in *compiled* mode it stayed
   empty entirely because there was no per-note MQTT command to pair against.
2. A `robot/strike` didn't actually prove the brick did anything.

## The fix: ask the NXT to confirm

The NXT Direct Command protocol supports **reply-required** commands. The command
type byte selects this:

| Byte   | Meaning                              |
|--------|--------------------------------------|
| `0x80` | Direct command, **no** reply         |
| `0x00` | Direct command, **reply required**   |

The bridge now sends the **press** stroke with `0x00`. The brick responds with a
short status telegram once it has received and accepted the command:

```
press   →  [0C 00] 00 04 port power 01 00 00 20 <tacho×4>     (reply required)
reply   ←  [03 00] 02 04 status                               (status 0x00 = OK)
```

The retract and stop strokes still use `0x80` (no reply) to keep the return
traffic to exactly one telegram per strike.

## How it flows through the bridge

1. On each press the bridge pushes `{ note, port, ts }` onto a per-NXT FIFO
   queue and writes the reply-required command.
2. The serial reader (shared with the touch-sensor polling) reassembles reply
   telegrams and routes them by the command-echo byte: `0x07` → touch sensor,
   `0x04` → **motor ack**.
3. On a motor ack the bridge dequeues the oldest pending strike for that NXT
   (the brick replies in the order it received commands — there is no port
   number in a `SETOUTPUTSTATE` reply, so matching is FIFO), measures
   `now − ts`, and publishes:
   - `robot/strike` — the note (drives highlight, Now Playing, heatmap)
   - `robot/latency` — `{ note, nxt, port, ms, confirmed: true }`
4. A 250 ms sweep times out any pending strike with no reply after
   `ACK_TIMEOUT_MS` (1200 ms), emitting it as `confirmed: false` so the FIFO
   never de-syncs and the UI still reflects the attempt (e.g. when running with
   no brick attached).

See [../src/nxt_bridge.js](../src/nxt_bridge.js) (`makeRunPacket` `wantReply`,
`pendingStrikes`, `handleMotorAck`, `handleFrame`).

## What the latency now means

`robot/latency.ms` is the **command → ack round trip over Bluetooth serial** at
9600 baud — i.e. how long the NXT took to confirm the press. Because it's
measured at the bridge, it is identical in shape for both delivery modes, which
is exactly why the panel finally populates under *compiled*. Under bursty
*compiled* playback you'll also see the figure rise as same-brick commands queue
on the serial link — a real picture of the actuation bottleneck. See
[score-delivery-modes.md](score-delivery-modes.md).

## Going further: confirm physical movement

A reply confirms the brick **received and accepted** the command. To confirm the
motor *physically moved*, poll `GETOUTPUTSTATE` (`0x06`) after the press and
check that the tacho count advanced. That costs an extra round trip per note and
isn't implemented yet — the receipt ack is the lightweight, real confirmation.
