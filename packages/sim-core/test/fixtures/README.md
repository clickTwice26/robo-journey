# Test fixtures

Firmware here is genuine `arduino-cli` output, committed so the unit tests run without Docker.

Regenerate with:

    npm run fixtures:build -w @robo-journey/compile-service

`blink.hex` is `blink.ino` compiled for `arduino:avr:uno` with arduino-cli 1.3.1 / arduino:avr 1.8.6
(924 bytes of program storage). If the toolchain version moves, regenerate and re-run the timing
assertions — a change in the compiled delay loop is exactly the kind of drift these tests exist to
catch.
