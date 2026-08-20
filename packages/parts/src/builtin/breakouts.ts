/**
 * Bus-connected breakout boards.
 *
 * These are the parts the register-file archetypes were built for: the host writes a register
 * address and reads bytes back, and a register backed by a state variable is how a simulated sensor
 * returns a value the user chose. Where a part's real output needs arithmetic the register file
 * cannot do -- a factory calibration curve, a BCD clock -- that is said plainly in `unresolved`
 * rather than approximated into something that looks plausible and is not.
 *
 * Everything on the wire is real: the address, the ACK, the mode, the clock rate, the pull-ups. A
 * module at the wrong address stays silent here exactly as it does on the bench.
 */
import type { ComponentManifest } from '../manifest.js';
import { builtin, digitalIn, digitalOut, ground, headerModule, i2c, power, reg, row, spi } from './kit.js';

/**
 * The MPU-6050, the accelerometer everybody starts with.
 *
 * Its registers are big-endian -- high byte first -- which is what the multi-byte register model
 * here produces, so a sketch reading it the standard way gets the axes the right way round.
 */
export const MPU6050: ComponentManifest = {
  schemaVersion: 1,
  id: 'mpu6050',
  name: 'MPU-6050 Accelerometer + Gyro',
  manufacturer: 'InvenSense',
  partNumber: 'GY-521',
  category: 'sensor',
  description: '6-axis IMU on I2C. 3-axis accelerometer and 3-axis gyroscope.',
  package: headerModule(8, 15.2),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5, iQuiescent: 0.0038 }), description: 'Supply, regulated on board' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'SCL', model: digitalIn(3.3), description: 'I2C clock' },
      { name: 'SDA', model: digitalIn(3.3), description: 'I2C data' },
      { name: 'XDA', model: digitalIn(3.3), description: 'Auxiliary I2C data' },
      { name: 'XCL', model: digitalIn(3.3), description: 'Auxiliary I2C clock' },
      { name: 'AD0', model: digitalIn(3.3, { pull: 'down', pullOhms: 4700 }), description: 'Address select: low is 0x68' },
      { name: 'INT', model: digitalOut({ sourceMaxA: 0.004, sinkMaxA: 0.004 }), description: 'Interrupt output' },
    ],
    12,
  ),
  state: [
    { name: 'ax', label: 'X acceleration', unit: 'g', min: -2, max: 2, default: 0, step: 0.01 },
    { name: 'ay', label: 'Y acceleration', unit: 'g', min: -2, max: 2, default: 0, step: 0.01 },
    { name: 'az', label: 'Z acceleration', unit: 'g', min: -2, max: 2, default: 1, step: 0.01 },
    { name: 'gx', label: 'X rotation', unit: 'deg/s', min: -250, max: 250, default: 0, step: 1 },
    { name: 'gy', label: 'Y rotation', unit: 'deg/s', min: -250, max: 250, default: 0, step: 1 },
    { name: 'gz', label: 'Z rotation', unit: 'deg/s', min: -250, max: 250, default: 0, step: 1 },
    { name: 'temperatureC', label: 'Die temperature', unit: 'C', min: -40, max: 85, default: 30, step: 1 },
  ],
  behavior: i2c(0x68, [
    // 16384 counts per g in the default +/-2 g range, 131 per degree per second at +/-250 dps.
    reg(0x3b, 'ACCEL_XOUT', { access: 'r', fromState: 'ax', scale: 16384, bytes: 2 }),
    reg(0x3d, 'ACCEL_YOUT', { access: 'r', fromState: 'ay', scale: 16384, bytes: 2 }),
    reg(0x3f, 'ACCEL_ZOUT', { access: 'r', fromState: 'az', scale: 16384, bytes: 2 }),
    // The datasheet's own conversion, rearranged: raw = (degrees - 36.53) * 340.
    reg(0x41, 'TEMP_OUT', { access: 'r', fromState: 'temperatureC', scale: 340, offset: -12420, bytes: 2 }),
    reg(0x43, 'GYRO_XOUT', { access: 'r', fromState: 'gx', scale: 131, bytes: 2 }),
    reg(0x45, 'GYRO_YOUT', { access: 'r', fromState: 'gy', scale: 131, bytes: 2 }),
    reg(0x47, 'GYRO_ZOUT', { access: 'r', fromState: 'gz', scale: 131, bytes: 2 }),
    reg(0x6b, 'PWR_MGMT_1', { reset: 0x40 }),
    reg(0x75, 'WHO_AM_I', { reset: 0x68, access: 'r' }),
  ]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The measurement ranges are fixed at the power-on defaults. Writing ACCEL_CONFIG or ' +
      'GYRO_CONFIG to select a wider range will not change the scaling of the readings.',
    'AD0 is modelled as an ordinary input; pulling it high does not move the part to 0x69.',
    'The breakout carries a 3.3 V regulator and level shifting, which is why VCC accepts 5 V.',
  ]),
};

export const ADS1115: ComponentManifest = {
  schemaVersion: 1,
  id: 'ads1115',
  name: 'ADS1115 16-bit ADC',
  manufacturer: 'Texas Instruments',
  partNumber: 'ADS1115',
  category: 'sensor',
  description: '4-channel 16-bit ADC on I2C. What you add when the Uno\'s 10 bits are not enough.',
  package: headerModule(10, 17.8),
  pins: row(
    [
      { name: 'VDD', model: power(5, { vMin: 2, vMax: 5.5, iQuiescent: 1.5e-4 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'SCL', model: digitalIn(5), description: 'I2C clock' },
      { name: 'SDA', model: digitalIn(5), description: 'I2C data' },
      { name: 'ADDR', model: digitalIn(5, { pull: 'down', pullOhms: 10_000 }), description: 'Address select: ground is 0x48' },
      { name: 'ALRT', model: digitalOut({ openDrain: true, sinkMaxA: 0.01 }), description: 'Comparator output, open drain' },
      { name: 'A0', model: { kind: 'analog-in', impedanceOhms: 6e6 }, description: 'Channel 0' },
      { name: 'A1', model: { kind: 'analog-in', impedanceOhms: 6e6 }, description: 'Channel 1' },
      { name: 'A2', model: { kind: 'analog-in', impedanceOhms: 6e6 }, description: 'Channel 2' },
      { name: 'A3', model: { kind: 'analog-in', impedanceOhms: 6e6 }, description: 'Channel 3' },
    ],
    14,
  ),
  state: [{ name: 'volts', label: 'Input voltage', unit: 'V', min: -4.096, max: 4.096, default: 1, step: 0.001 }],
  behavior: i2c(0x48, [
    // 8000 counts per volt: the +/-4.096 V default range over a signed 16-bit result.
    reg(0x00, 'CONVERSION', { access: 'r', fromState: 'volts', scale: 8000, bytes: 2 }),
    reg(0x01, 'CONFIG', { reset: 0x8583, bytes: 2 }),
    reg(0x02, 'LO_THRESH', { reset: 0x8000, bytes: 2 }),
    reg(0x03, 'HI_THRESH', { reset: 0x7fff, bytes: 2 }),
  ]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 2, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The conversion register returns the "Input voltage" control, not the voltage on A0-A3. The ' +
      'analog inputs are real loads on the circuit but are not sampled.',
    'One reading serves every channel and every gain setting; the multiplexer and PGA bits in ' +
      'CONFIG are stored and ignored.',
  ]),
};

export const DS3231: ComponentManifest = {
  schemaVersion: 1,
  id: 'ds3231',
  name: 'DS3231 Real-Time Clock',
  manufacturer: 'Maxim',
  partNumber: 'DS3231SN',
  category: 'module',
  description: 'Temperature-compensated RTC with a battery backup. The accurate one.',
  package: headerModule(6, 22),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 2.3, vMax: 5.5, iQuiescent: 2e-4 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'SDA', model: digitalIn(5), description: 'I2C data' },
      { name: 'SCL', model: digitalIn(5), description: 'I2C clock' },
      { name: 'SQW', model: digitalOut({ openDrain: true, sinkMaxA: 0.003 }), description: 'Square wave / alarm, open drain' },
      { name: '32K', model: digitalOut({ openDrain: true, sinkMaxA: 0.003 }), description: '32 kHz output, open drain' },
    ],
    18,
  ),
  state: [
    { name: 'temperatureC', label: 'Die temperature', unit: 'C', min: -40, max: 85, default: 25, step: 1 },
  ],
  behavior: i2c(0x68, [
    reg(0x00, 'SECONDS'),
    reg(0x01, 'MINUTES'),
    reg(0x02, 'HOURS'),
    reg(0x03, 'DAY', { reset: 0x01 }),
    reg(0x04, 'DATE', { reset: 0x01 }),
    reg(0x05, 'MONTH', { reset: 0x01 }),
    reg(0x06, 'YEAR'),
    reg(0x0e, 'CONTROL', { reset: 0x1c }),
    reg(0x0f, 'STATUS', { reset: 0x88 }),
    // The one register here that is genuinely live: whole degrees in the MSB.
    reg(0x11, 'TEMP_MSB', { access: 'r', fromState: 'temperatureC' }),
  ]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 2.3, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The clock does not run. Time registers hold whatever was written to them, in whatever ' +
      'encoding was written -- the real part stores BCD and increments every second.',
    'A common counterfeit uses an ordinary DS1307 die inside a DS3231 marking, which drifts. ' +
      'Nothing about the bus traffic distinguishes them, here or on the bench.',
  ]),
};

export const BMP280: ComponentManifest = {
  schemaVersion: 1,
  id: 'bmp280',
  name: 'BMP280 Pressure Sensor',
  manufacturer: 'Bosch',
  partNumber: 'GY-BMP280',
  category: 'sensor',
  description: 'Barometric pressure and temperature on I2C. Altitude to about a metre.',
  package: headerModule(6, 11.4),
  pins: row(
    [
      { name: 'VCC', model: power(3.3, { vMin: 1.71, vMax: 5, iQuiescent: 3e-6 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'SCL', model: digitalIn(3.3), description: 'I2C clock' },
      { name: 'SDA', model: digitalIn(3.3), description: 'I2C data' },
      { name: 'CSB', model: digitalIn(3.3, { pull: 'up', pullOhms: 10_000 }), description: 'Chip select: high selects I2C' },
      { name: 'SDO', model: digitalIn(3.3, { pull: 'down', pullOhms: 10_000 }), description: 'Address select: low is 0x76' },
    ],
    8,
  ),
  state: [
    { name: 'temperatureC', label: 'Temperature', unit: 'C', min: -40, max: 85, default: 22, step: 0.1 },
    { name: 'pressurePa', label: 'Pressure', unit: 'Pa', min: 30000, max: 110000, default: 101325, step: 10 },
  ],
  behavior: i2c(0x76, [
    reg(0xd0, 'ID', { reset: 0x58, access: 'r' }),
    reg(0xf4, 'CTRL_MEAS'),
    reg(0xf5, 'CONFIG'),
    reg(0xf7, 'PRESS', { access: 'r', fromState: 'pressurePa', scale: 16, bytes: 3 }),
    reg(0xfa, 'TEMP', { access: 'r', fromState: 'temperatureC', scale: 5120, bytes: 3 }),
  ]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 1.71, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The factory calibration registers at 0x88-0xA1 are not populated, so a driver library will ' +
      'read zeros for them and compute nonsense from perfectly good raw values. Reading PRESS and ' +
      'TEMP directly gives the numbers the controls are set to.',
    'Raw values use the datasheet\'s nominal scaling -- 1/16 Pa and 1/5120 C per count -- rather ' +
      'than a compensated curve.',
  ]),
};

/**
 * The ADXL345, chosen as the reference `register`-addressed SPI part.
 *
 * It also happens to be the best demonstration of why SPI mode is worth checking: it needs mode 3,
 * and the Arduino SPI library defaults to mode 0. Wired perfectly and clocked in the default mode
 * it returns nothing but zeros, which is a bug with no visible cause on a scope.
 */
export const ADXL345: ComponentManifest = {
  schemaVersion: 1,
  id: 'adxl345',
  name: 'ADXL345 Accelerometer',
  manufacturer: 'Analog Devices',
  partNumber: 'ADXL345',
  category: 'sensor',
  description: '3-axis digital accelerometer, +/-16 g, SPI mode 3.',
  package: headerModule(6, 20.3),
  pins: row(
    [
      { name: 'VCC', model: power(3.3, { vMin: 2, vMax: 3.6, iQuiescent: 1.4e-4 }), description: 'Supply, 2.0 to 3.6 V' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'CS', model: digitalIn(3.3), description: 'Chip select, active low' },
      { name: 'SDO', model: digitalOut({ sourceMaxA: 0.004, sinkMaxA: 0.004 }), description: 'Serial data out -- wire to MISO' },
      { name: 'SDA', model: digitalIn(3.3), description: 'Serial data in -- wire to MOSI' },
      { name: 'SCL', model: digitalIn(3.3), description: 'Serial clock -- wire to SCK' },
    ],
    18,
  ),
  state: [
    { name: 'ax', label: 'X acceleration', unit: 'g', min: -16, max: 16, default: 0, step: 0.1 },
    { name: 'ay', label: 'Y acceleration', unit: 'g', min: -16, max: 16, default: 0, step: 0.1 },
    { name: 'az', label: 'Z acceleration', unit: 'g', min: -16, max: 16, default: 1, step: 0.1 },
  ],
  behavior: spi({
    mosiPin: 'SDA',
    misoPin: 'SDO',
    sckPin: 'SCL',
    csPin: 'CS',
    mode: 3,
    maxClockHz: 5e6,
    registers: [
      reg(0x00, 'DEVID', { reset: 0xe5, access: 'r' }),
      reg(0x2d, 'POWER_CTL'),
      reg(0x31, 'DATA_FORMAT'),
      // 3.9 mg per count in the default +/-2 g range, so 256 counts per g.
      reg(0x32, 'DATAX', { access: 'r', fromState: 'ax', scale: 256, bytes: 2 }),
      reg(0x34, 'DATAY', { access: 'r', fromState: 'ay', scale: 256, bytes: 2 }),
      reg(0x36, 'DATAZ', { access: 'r', fromState: 'az', scale: 256, bytes: 2 }),
    ],
  }),
  limits: { vccMaxVolts: 3.9, vccMinVolts: 2, pinMaxAmps: 0.01 },
  provenance: builtin([
    'Acceleration registers are big-endian here; the real part is little-endian. Sketches using ' +
      'the standard library will read the axes byte-swapped.',
    'The measurement range is fixed at +/-2 g scaling regardless of what DATA_FORMAT is set to.',
  ]),
};

export const BREAKOUTS: readonly ComponentManifest[] = [MPU6050, ADS1115, DS3231, BMP280, ADXL345];
