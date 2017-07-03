// Estimote Nearable packet is broadcast as Manufacturer Specific Data,
// with Estimote's Company Identifier, i.e., 0x015d.
// https://www.bluetooth.com/specifications/assigned-numbers/company-identifiers

// Once you obtain the Manufacturer Specific Data, here's how to parse them into
// an Estimote Nearable packet.
function parseEstimoteNearablePacket(data) { // data is a 0-indexed byte array/buffer

  // note that depending on the BLE-scanning library you use, the Company ID
  // might or might not be part of the Manufacturer Specific Data, and might
  // instead be a separate property
  //
  // most of the time, it's simply the first two bytes of the data, and that's
  // what we're assuming here
  var companyId = data.readUInt16LE(0);
  // Company ID must be Estimote's
  if (companyId != 0x015d) { return; }

  // byte 2 is "which exactly Estimote packet this is"
  // for a Nearable packet version 1 (currently the only one), the value is 0x01
  var frameType = data.readUInt8(2);
  if (frameType != 0x01) { return; }

  // Nearable identifier, this matches the identifier you see in Estimote Cloud
  // bytes 3–10 (8 bytes total)
  var nearableId = data.toString('hex', 3, 11);

  // ***** TEMPERATURE
  // byte 13 and the first 4 bits of byte 14 is the temperature in signed,
  // fixed-point format, with 4 decimal places
  var temperatureRawValue = data.readUInt16LE(13) & 0x0fff
  if (temperatureRawValue > 2047) {
    // convert a 12-bit unsigned integer to a signed one
    temperatureRawValue = temperatureRawValue - 4096;
  }
  var temperature = temperatureRawValue / 16.0;

  // byte 15, 7th bit = is the nearable moving or not
  var isMoving = (data.readUInt8(15) & 0b01000000) == 1;

  // ***** ACCELERATION
  // byte 16 => acceleration RAW_VALUE on the X axis
  // byte 17 => acceleration RAW_VALUE on the Y axis
  // byte 18 => acceleration RAW_VALUE on the Z axis
  // RAW_VALUE is a signed (two's complement) 8-bit integer
  // RAW_VALUE * 15.625 = acceleration in milli-"g-unit" (http://www.helmets.org/g.htm)
  var acceleration = {
    x: data.readInt8(16) * 15.625,
    y: data.readInt8(17) * 15.625,
    z: data.readInt8(18) * 15.625
  };

  // ***** MOTION STATE DURATION
  // byte 19 => "current" motion state duration
  // byte 20 => "previous" motion state duration
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
  //     - 0b11 ("3") => days if NUMBER is < 32
  //                     if it's >= 32, then it's "NUMBER - 32" weeks
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
    } else if (unitCode == 3 && number < 32) {
      unit = 'days';
    } else {
      unit = 'weeks';
      number = number - 32;
    }
    return {number: number, unit: unit};
  }
  var motionStateDuration = {
    current: parseMotionStateDuration(data.readUInt8(19)),
    previous: parseMotionStateDuration(data.readUInt8(20))
  };

  return {
    nearableId,
    temperature,
    isMoving, motionStateDuration, acceleration
  };
}

// example how to scan & parse Estimote Nearable packets with noble

var noble = require('noble');

noble.on('stateChange', function(state) {
  console.log('state has changed', state);
  if (state == 'poweredOn') {
    var allowDuplicates = true;
    noble.startScanning([], allowDuplicates, function(error) {
      if (error) {
        console.log('error starting scanning', error);
      } else {
        console.log('started scanning');
      }
    });
  }
});

noble.on('discover', function(peripheral) {
  var data = peripheral.advertisement.manufacturerData;
  if (!data) { return; }

  var nearablePacket = parseEstimoteNearablePacket(data);
  if (nearablePacket) { console.log(nearablePacket); }
});
