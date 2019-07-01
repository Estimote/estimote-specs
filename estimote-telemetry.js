// Packest from the Estimote family (Telemetry, Connectivity, etc.) are
// broadcast as Service Data (per "§ 1.11. The Service Data - 16 bit UUID" from
// the BLE spec), with the Service UUID 'fe9a'.
var ESTIMOTE_SERVICE_UUID = 'fe9a';

// Once you obtain the "Estimote" Service Data, here's how to check if it's
// a Telemetry packet, and if so, how to parse it.
function parseEstimoteTelemetryPacket(data) { // data is a 0-indexed byte array/buffer

  // byte 0, lower 4 bits => frame type, for Telemetry it's always 2 (i.e., 0b0010)
  var frameType = data.readUInt8(0) & 0b00001111;
  var ESTIMOTE_FRAME_TYPE_TELEMETRY = 2;
  if (frameType != ESTIMOTE_FRAME_TYPE_TELEMETRY) { return; }

  // byte 0, upper 4 bits => Telemetry protocol version ("0", "1", "2", etc.)
  var protocolVersion = (data.readUInt8(0) & 0b11110000) >> 4;
  // this parser only understands version up to 2
  // (but at the time of this commit, there's no 3 or higher anyway :wink:)
  if (protocolVersion > 2) { return; }

  // bytes 1, 2, 3, 4, 5, 6, 7, 8 => first half of the identifier of the beacon
  var shortIdentifier = data.toString('hex', 1, 9);

  // byte 9, lower 2 bits => Telemetry subframe type
  // to fit all the telemetry data, we currently use two packets, "A" (i.e., "0")
  // and "B" (i.e., "1")
  var subFrameType = data.readUInt8(9) & 0b00000011;

  var ESTIMOTE_TELEMETRY_SUBFRAME_A = 0;
  var ESTIMOTE_TELEMETRY_SUBFRAME_B = 1;

  // ****************
  // * SUBFRAME "A" *
  // ****************
  if (subFrameType == ESTIMOTE_TELEMETRY_SUBFRAME_A) {

    // ***** ACCELERATION
    // byte 10 => acceleration RAW_VALUE on the X axis
    // byte 11 => acceleration RAW_VALUE on the Y axis
    // byte 12 => acceleration RAW_VALUE on the Z axis
    // RAW_VALUE is a signed (two's complement) 8-bit integer
    // RAW_VALUE * 2 / 127.0 = acceleration in "g-unit" (http://www.helmets.org/g.htm)
    var acceleration = {
      x: data.readInt8(10) * 2 / 127.0,
      y: data.readInt8(11) * 2 / 127.0,
      z: data.readInt8(12) * 2 / 127.0
    };

    // ***** MOTION STATE
    // byte 15, lower 2 bits
    // 0b00 ("0") when not moving, 0b01 ("1") when moving
    var isMoving = (data.readUInt8(15) & 0b00000011) == 1;

    // ***** MOTION STATE DURATION
    // byte 13 => "previous" motion state duration
    // byte 14 => "current" motion state duration
    // e.g., if the beacon is currently still, "current" will state how long
    // it's been still and "previous" will state how long it's previously been
    // in motion before it stopped moving
    //
    // motion state duration is composed of two parts:
    // - lower 6 bits is a NUMBER (unsigned 6-bit integer)
    // - upper 2 bits is a unit:
    //     - 0b00 ("0") => seconds
    //     - 0b01 ("1") => minutes
    //     - 0b10 ("2") => hours
    //     - 0b11 ("3") => days if NUMBER is <= 32
    //                     if it's > 32, then it's "NUMBER - 32" weeks
    var parseMotionStateDuration = function(byte) {
      var number = byte & 0b00111111;
      var unitCode = (byte & 0b11000000) >> 6;
      var unit;
      if (unitCode == 0) {
        unit = 'seconds';
      } else if (unitCode == 1) {
        unit = 'minutes';
      } else if (unitCode == 2) {
        unit = 'hours';
      } else if (unitCode == 3 && number <= 32) {
        unit = 'days';
      } else {
        unit = 'weeks';
        number = number - 32;
      }
      return {number: number, unit: unit};
    }
    var motionStateDuration = {
      previous: parseMotionStateDuration(data.readUInt8(13)),
      current: parseMotionStateDuration(data.readUInt8(14))
    };

    // ***** GPIO
    // byte 15, upper 4 bits => state of GPIO pins, one bit per pin
    // 0 = state "low", 1 = state "high"
    var gpio = {
      pin0: (data.readUInt8(15) & 0b00010000) >> 4 ? 'high' : 'low',
      pin1: (data.readUInt8(15) & 0b00100000) >> 5 ? 'high' : 'low',
      pin2: (data.readUInt8(15) & 0b01000000) >> 6 ? 'high' : 'low',
      pin3: (data.readUInt8(15) & 0b10000000) >> 7 ? 'high' : 'low',
    };

    // ***** ERROR CODES
    var errors;
    if (protocolVersion == 2) {
      // in protocol version "2"
      // byte 15, bits 2 & 3
      // bit 2 => firmware error
      // bit 3 => clock error (likely, in beacons without Real-Time Clock, e.g.,
      //                      Proximity Beacons, the internal clock is out of sync)
      errors = {
        hasFirmwareError: ((data.readUInt8(15) & 0b00000100) >> 2) == 1,
        hasClockError: ((data.readUInt8(15) & 0b00001000) >> 3) == 1
      };
    } else if (protocolVersion == 1) {
      // in protocol version "1"
      // byte 16, lower 2 bits
      // bit 0 => firmware error
      // bit 1 => clock error
      errors = {
        hasFirmwareError: (data.readUInt8(16) & 0b00000001) == 1,
        hasClockError: ((data.readUInt8(16) & 0b00000010) >> 1) == 1
      };
    } else if (protocolVersion == 0) {
      // in protocol version "0", error codes are in subframe "B" instead
    }

    // ***** ATMOSPHERIC PRESSURE
    var pressure;
    if (protocolVersion == 2) {
      // added in protocol version "2"
      // bytes 16, 17, 18, 19 => atmospheric pressure RAW_VALUE
      // RAW_VALUE is an unsigned 32-bit integer, little-endian encoding,
      //   i.e., least-significant byte comes first
      //   e.g., if bytes are 16th = 0xFC, 17th = 0x98, 18th = 0x88, 19th = 0x01
      //         then the value is 0x018898FC = 25729276
      // RAW_VALUE / 256.0 = atmospheric pressure in pascals (Pa)
      // note that unlike what you see on the weather forecast, this value is
      // not normalized to the sea level!
      pressure = data.readUInt32LE(16) / 256.0;
    }

    return {
      shortIdentifier,
      frameType: 'Estimote Telemetry', subFrameType: 'A', protocolVersion,
      acceleration, isMoving, motionStateDuration, pressure, gpio, errors
    };

  // ****************
  // * SUBFRAME "B" *
  // ****************
  } else if (subFrameType == ESTIMOTE_TELEMETRY_SUBFRAME_B) {

    // ***** MAGNETIC FIELD
    // byte 10 => normalized magnetic field RAW_VALUE on the X axis
    // byte 11 => normalized magnetic field RAW_VALUE on the Y axis
    // byte 12 => normalized magnetic field RAW_VALUE on the Z axis
    // RAW_VALUE is a signed (two's complement) 8-bit integer
    // RAW_VALUE / 128.0 = normalized value, between -1 and 1
    // the value will be 0 if the sensor hasn't been calibrated yet
    var magneticField = {
      x: data.readInt8(10) / 128.0,
      y: data.readInt8(11) / 128.0,
      z: data.readInt8(12) / 128.0
    };

    // ***** AMBIENT LIGHT
    // byte 13 => ambient light level RAW_VALUE
    // the RAW_VALUE byte is split into two halves
    // pow(2, RAW_VALUE_UPPER_HALF) * RAW_VALUE_LOWER_HALF * 0.72 = light level in lux (lx)
    var ambientLightUpper = (data.readUInt8(13) & 0b11110000) >> 4;
    var ambientLightLower = data.readUInt8(13) & 0b00001111;
    var ambientLightLevel = Math.pow(2, ambientLightUpper) * ambientLightLower * 0.72;

    // ***** BEACON UPTIME
    // byte 14 + 6 lower bits of byte 15 (i.e., 14 bits total)
    // - the lower 12 bits (i.e., byte 14 + lower 4 bits of byte 15) are
    //   a 12-bit unsigned integer
    // - the upper 2 bits (i.e., bits 4 and 5 of byte 15) denote the unit:
    //   0b00 = seconds, 0b01 = minutes, 0b10 = hours, 0b11 = days
    var uptimeUnitCode = (data.readUInt8(15) & 0b00110000) >> 4;
    var uptimeUnit;
    switch (uptimeUnitCode) {
      case 0: uptimeUnit = 'seconds'; break;
      case 1: uptimeUnit = 'minutes'; break;
      case 2: uptimeUnit = 'hours'; break;
      case 3: uptimeUnit = 'days'; break;
    }
    var uptime = {
      number: ((data.readUInt8(15) & 0b00001111) << 8) | data.readUInt8(14),
      unit: uptimeUnit
    };

    // ***** AMBIENT TEMPERATURE
    // upper 2 bits of byte 15 + byte 16 + lower 2 bits of byte 17
    // => ambient temperature RAW_VALUE, signed (two's complement) 12-bit integer
    // RAW_VALUE / 16.0 = ambient temperature in degrees Celsius
    var temperatureRawValue =
      ((data.readUInt8(17) & 0b00000011) << 10) |
       (data.readUInt8(16)               <<  2) |
      ((data.readUInt8(15) & 0b11000000) >>  6);
    if (temperatureRawValue > 2047) {
      // a simple way to convert a 12-bit unsigned integer to a signed one (:
      temperatureRawValue = temperatureRawValue - 4096;
    }
    temperature = temperatureRawValue / 16.0;

    // ***** BATTERY VOLTAGE
    // upper 6 bits of byte 17 + byte 18 => battery voltage in mini-volts (mV)
    //                                      (unsigned 14-bit integer)
    // if all bits are set to 1, it means it hasn't been measured yet
    var batteryVoltage =
       (data.readUInt8(18)               << 6) |
      ((data.readUInt8(17) & 0b11111100) >> 2);
    if (batteryVoltage == 0b11111111111111) { batteryVoltage = undefined; }

    // ***** ERROR CODES
    // byte 19, lower 2 bits
    // see subframe A documentation of the error codes
    // starting in protocol version 1, error codes were moved to subframe A,
    // thus, you will only find them in subframe B in Telemetry protocol ver 0
    var errors;
    if (protocolVersion == 0) {
      errors = {
        hasFirmwareError: (data.readUInt8(19) & 0b00000001) == 1,
        hasClockError: ((data.readUInt8(19) & 0b00000010) >> 1) == 1
      };
    }

    // ***** BATTERY LEVEL
    // byte 19 => battery level, between 0% and 100%
    // if all bits are set to 1, it means it hasn't been measured yet
    // added in protocol version 1
    var batteryLevel;
    if (protocolVersion >= 1) {
      batteryLevel = data.readUInt8(19);
      if (batteryLevel == 0b11111111) { batteryLevel = undefined; }
    }

    return {
      shortIdentifier,
      frameType: 'Estimote Telemetry', subFrameType: 'B', protocolVersion,
      magneticField, ambientLightLevel, temperature,
      uptime, batteryVoltage, batteryLevel, errors
    };
  }
}

// example how to scan & parse Estimote Telemetry packets with noble

var noble = process.platform === 'darwin' ? require('noble-mac') : require('noble');

noble.on('stateChange', function(state) {
  console.log('state has changed', state);
  if (state == 'poweredOn') {
    var serviceUUIDs = [ESTIMOTE_SERVICE_UUID]; // Estimote Service
    var allowDuplicates = true;
    noble.startScanning(serviceUUIDs, allowDuplicates, function(error) {
      if (error) {
        console.log('error starting scanning', error);
      } else {
        console.log('started scanning');
      }
    });
  }
});

noble.on('discover', function(peripheral) {
  var serviceData = peripheral.advertisement.serviceData.find(function(el) {
    return el.uuid == ESTIMOTE_SERVICE_UUID;
  });
  if (serviceData === undefined) { return; }
  var data = serviceData.data;

  var telemetryPacket = parseEstimoteTelemetryPacket(data);
  if (telemetryPacket) { console.log(telemetryPacket); }
});
