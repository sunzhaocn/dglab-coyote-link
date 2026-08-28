# Custom waveform format

CoyoteLink accepts custom Coyote waveform data as JSON or plain 16-hex-character frame lines.

## Frame model

For Coyote V3, one 100 ms waveform block contains four 25 ms frequency values followed by four 25 ms amplitude values.

A raw frame is represented by 8 bytes / 16 hexadecimal characters:

```text
F1 F2 F3 F4 A1 A2 A3 A4
```

CoyoteLink validates editor values as:

```text
frequency: 10..240
amplitude: 0..100
```

Example:

```text
0A0A0A0A00000000
0A0A0A0A64646464
```

The first frame uses frequency 10 for all four 25 ms slots and amplitude 0. The second uses the same frequency and amplitude 100.

## JSON import

Minimal form:

```json
{
  "name": "Pulse Test",
  "frames": [
    "0A0A0A0A00000000",
    "0A0A0A0A64646464"
  ]
}
```

An array of frame strings is also accepted by the importer when supported by the current UI parser.

## Plain-text import

One frame per line:

```text
0A0A0A0A00000000
0A0A0A0A64646464
1919191964646464
```

Whitespace around lines is ignored. Invalid-length or invalid-range entries are rejected rather than silently sent to the device.

## Editor sections

Each editor “小节” maps to one 100 ms raw frame. A section exposes eight values:

- four frequency points
- four amplitude points

Sections can be added, removed and reordered. The browser stores user presets locally; they are not uploaded to the CoyoteLink server as a persistent cloud library.

## V4 transmission

Custom frames are sent through Socket V4 `device.op` using `AppendPulseData (t=0)` and the selected A/B channel. The browser batches/paces touch and waveform traffic to avoid flooding the APP/device path.
