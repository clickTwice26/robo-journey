# arduino-cli with the AVR core preinstalled.
#
# The core is baked into the image rather than downloaded at runtime so that compilation is
# hermetic and offline: the same image produces the same .hex forever, which is what makes the
# golden-firmware tests meaningful. This is also the exact binary the Tauri desktop build will
# bundle later, so dev and production compile identically.
FROM debian:bookworm-slim

ARG ARDUINO_CLI_VERSION=1.3.1
ARG AVR_CORE_VERSION=1.8.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR=/usr/local/bin sh -s ${ARDUINO_CLI_VERSION} \
 && arduino-cli version

ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user

RUN arduino-cli core update-index \
 && arduino-cli core install arduino:avr@${AVR_CORE_VERSION} \
 && arduino-cli core list

WORKDIR /sketch
ENTRYPOINT ["arduino-cli"]
