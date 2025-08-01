import { nv } from "@smithy/core/serde";
import { toUtf8 } from "@smithy/util-utf8";

import {
  alloc,
  CborArgumentLength,
  CborArgumentLengthOffset,
  CborListType,
  CborMapType,
  CborOffset,
  CborUnstructuredByteStringType,
  CborValueType,
  extendedFloat16,
  extendedFloat32,
  extendedFloat64,
  extendedOneByte,
  Float32,
  majorList,
  majorMap,
  majorNegativeInt64,
  majorTag,
  majorUint64,
  majorUnstructuredByteString,
  majorUtf8String,
  minorIndefinite,
  specialFalse,
  specialNull,
  specialTrue,
  specialUndefined,
  tag,
  Uint8,
  Uint32,
  Uint64,
} from "./cbor-types";

const USE_TEXT_DECODER = typeof TextDecoder !== "undefined";
const USE_BUFFER = typeof Buffer !== "undefined";

let payload = alloc(0);
let dataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
const textDecoder = USE_TEXT_DECODER ? new TextDecoder() : null;

/**
 * This number stores the last offset of any decoded segment.
 */
let _offset: CborOffset = 0;

/**
 * @internal
 * @param bytes - to be set as the decode source.
 *
 * Sets the decode bytearray source and its data view.
 */
export function setPayload(bytes: Uint8Array) {
  payload = bytes;
  dataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * @internal
 * Decodes the data between the two indices.
 */
export function decode(at: Uint32, to: Uint32): CborValueType {
  if (at >= to) {
    throw new Error("unexpected end of (decode) payload.");
  }

  const major = (payload[at] & 0b1110_0000) >> 5;
  const minor = payload[at] & 0b0001_1111;

  switch (major) {
    case majorUint64:
    case majorNegativeInt64:
    case majorTag:
      let unsignedInt: number | Uint64;
      let offset: number;

      if (minor < 24) {
        unsignedInt = minor;
        offset = 1;
      } else {
        switch (minor) {
          case extendedOneByte:
          case extendedFloat16:
          case extendedFloat32:
          case extendedFloat64:
            const countLength: CborArgumentLength = minorValueToArgumentLength[minor];
            const countOffset = (countLength + 1) as CborArgumentLengthOffset;
            offset = countOffset;

            if (to - at < countOffset) {
              throw new Error(`countLength ${countLength} greater than remaining buf len.`);
            }
            const countIndex = at + 1;
            if (countLength === 1) {
              unsignedInt = payload[countIndex];
            } else if (countLength === 2) {
              unsignedInt = dataView.getUint16(countIndex);
            } else if (countLength === 4) {
              unsignedInt = dataView.getUint32(countIndex);
            } else {
              unsignedInt = dataView.getBigUint64(countIndex);
            }
            break;
          default:
            throw new Error(`unexpected minor value ${minor}.`);
        }
      }

      if (major === majorUint64) {
        _offset = offset;
        return castBigInt(unsignedInt);
      } else if (major === majorNegativeInt64) {
        let negativeInt: bigint | number;
        if (typeof unsignedInt === "bigint") {
          negativeInt = BigInt(-1) - unsignedInt;
        } else {
          negativeInt = -1 - unsignedInt;
        }
        _offset = offset;
        return castBigInt(negativeInt);
      } else {
        /* major === majorTag */
        if (minor === 2 || minor === 3) {
          const length = decodeCount(at + offset, to);

          let b = BigInt(0);
          const start = at + offset + _offset;
          for (let i = start; i < start + length; ++i) {
            b = (b << BigInt(8)) | BigInt(payload[i]);
          }
          // the new offset is the sum of:
          // 1. the local major offset (1)
          // 2. the offset of the decoded count of the bigInteger
          // 3. the length of the data bytes of the bigInteger
          _offset = offset + _offset + length;
          return minor === 3 ? -b - BigInt(1) : b;
        } else if (minor === 4) {
          const decimalFraction = decode(at + offset, to);
          const [exponent, mantissa] = decimalFraction;
          const normalizer = mantissa < 0 ? -1 : 1;
          const mantissaStr = "0".repeat(Math.abs(exponent) + 1) + String(BigInt(normalizer) * BigInt(mantissa));

          let numericString: string;
          const sign = mantissa < 0 ? "-" : "";

          numericString =
            exponent === 0
              ? mantissaStr
              : mantissaStr.slice(0, mantissaStr.length + exponent) + "." + mantissaStr.slice(exponent);
          numericString = numericString.replace(/^0+/g, "");
          if (numericString === "") {
            numericString = "0";
          }
          if (numericString[0] === ".") {
            numericString = "0" + numericString;
          }
          numericString = sign + numericString;

          // the new offset is the sum of:
          // 1. the local major offset (1)
          // 2. the offset of the decoded exponent mantissa pair
          _offset = offset + _offset;
          return nv(numericString);
        } else {
          const value = decode(at + offset, to);
          const valueOffset = _offset;

          _offset = offset + valueOffset;
          return tag({ tag: castBigInt(unsignedInt), value });
        }
      }
    case majorUtf8String:
    case majorMap:
    case majorList:
    case majorUnstructuredByteString:
      if (minor === minorIndefinite) {
        switch (major) {
          case majorUtf8String:
            return decodeUtf8StringIndefinite(at, to);
          case majorMap:
            return decodeMapIndefinite(at, to);
          case majorList:
            return decodeListIndefinite(at, to);
          case majorUnstructuredByteString:
            return decodeUnstructuredByteStringIndefinite(at, to);
        }
      } else {
        switch (major) {
          case majorUtf8String:
            return decodeUtf8String(at, to);
          case majorMap:
            return decodeMap(at, to);
          case majorList:
            return decodeList(at, to);
          case majorUnstructuredByteString:
            return decodeUnstructuredByteString(at, to);
        }
      }
    default:
      return decodeSpecial(at, to);
  }
}

function bytesToUtf8(bytes: Uint8Array, at: number, to: number): string {
  if (USE_BUFFER && bytes.constructor?.name === "Buffer") {
    return (bytes as Buffer).toString("utf-8", at, to);
  }
  if (textDecoder) {
    return textDecoder!.decode(bytes.subarray(at, to));
  }
  return toUtf8(bytes.subarray(at, to));
}

function demote(bigInteger: bigint): number {
  // cast is safe for string and array lengths, which do not
  // exceed safe integer range.
  const num = Number(bigInteger);
  if (num < Number.MIN_SAFE_INTEGER || Number.MAX_SAFE_INTEGER < num) {
    console.warn(new Error(`@smithy/core/cbor - truncating BigInt(${bigInteger}) to ${num} with loss of precision.`));
  }
  return num;
}

const minorValueToArgumentLength = {
  [extendedOneByte]: 1,
  [extendedFloat16]: 2,
  [extendedFloat32]: 4,
  [extendedFloat64]: 8,
} as const;

/**
 * @internal
 */
export function bytesToFloat16(a: Uint8, b: Uint8): Float32 {
  const sign = a >> 7;
  const exponent = (a & 0b0111_1100) >> 2;
  const fraction = ((a & 0b0000_0011) << 8) | b;

  const scalar = sign === 0 ? 1 : -1;

  let exponentComponent: number;
  let summation: number;

  if (exponent === 0b00000) {
    if (fraction === 0b00000_00000) {
      return 0;
    } else {
      exponentComponent = Math.pow(2, 1 - 15);
      summation = 0;
    }
  } else if (exponent === 0b11111) {
    if (fraction === 0b00000_00000) {
      return scalar * Infinity;
    } else {
      return NaN;
    }
  } else {
    exponentComponent = Math.pow(2, exponent - 15);
    summation = 1;
  }

  summation += fraction / 1024;
  return scalar * (exponentComponent * summation);
}

function decodeCount(at: Uint32, to: Uint32): number {
  const minor = payload[at] & 0b0001_1111;

  if (minor < 24) {
    _offset = 1;
    return minor;
  }

  if (
    minor === extendedOneByte ||
    minor === extendedFloat16 ||
    minor === extendedFloat32 ||
    minor === extendedFloat64
  ) {
    const countLength: CborArgumentLength = minorValueToArgumentLength[minor];
    _offset = (countLength + 1) as CborArgumentLengthOffset;
    if (to - at < _offset) {
      throw new Error(`countLength ${countLength} greater than remaining buf len.`);
    }
    const countIndex = at + 1;

    if (countLength === 1) {
      return payload[countIndex];
    } else if (countLength === 2) {
      return dataView.getUint16(countIndex);
    } else if (countLength === 4) {
      return dataView.getUint32(countIndex);
    }
    return demote(dataView.getBigUint64(countIndex));
  }

  throw new Error(`unexpected minor value ${minor}.`);
}

function decodeUtf8String(at: Uint32, to: Uint32): string {
  const length = decodeCount(at, to);
  const offset = _offset;
  at += offset;
  if (to - at < length) {
    throw new Error(`string len ${length} greater than remaining buf len.`);
  }
  const value = bytesToUtf8(payload, at, at + length);
  _offset = offset + length;
  return value;
}

function decodeUtf8StringIndefinite(at: Uint32, to: Uint32): string {
  at += 1;
  const vector = [];
  for (const base = at; at < to; ) {
    if (payload[at] === 0b1111_1111) {
      const data = alloc(vector.length);
      data.set(vector, 0);
      _offset = at - base + 2;
      return bytesToUtf8(data, 0, data.length);
    }
    const major = (payload[at] & 0b1110_0000) >> 5;
    const minor = payload[at] & 0b0001_1111;
    if (major !== majorUtf8String) {
      throw new Error(`unexpected major type ${major} in indefinite string.`);
    }
    if (minor === minorIndefinite) {
      throw new Error("nested indefinite string.");
    }
    const bytes = decodeUnstructuredByteString(at, to);
    const length = _offset;
    at += length;
    for (let i = 0; i < bytes.length; ++i) {
      vector.push(bytes[i]);
    }
  }
  throw new Error("expected break marker.");
}

function decodeUnstructuredByteString(at: Uint32, to: Uint32): CborUnstructuredByteStringType {
  const length = decodeCount(at, to);
  const offset = _offset;

  at += offset;
  if (to - at < length) {
    throw new Error(`unstructured byte string len ${length} greater than remaining buf len.`);
  }

  const value = payload.subarray(at, at + length);
  _offset = offset + length;
  return value;
}

function decodeUnstructuredByteStringIndefinite(at: Uint32, to: Uint32): CborUnstructuredByteStringType {
  at += 1;
  const vector = [];

  for (const base = at; at < to; ) {
    if (payload[at] === 0b1111_1111) {
      const data = alloc(vector.length);
      data.set(vector, 0);
      _offset = at - base + 2;
      return data;
    }

    const major = (payload[at] & 0b1110_0000) >> 5;
    const minor = payload[at] & 0b0001_1111;
    if (major !== majorUnstructuredByteString) {
      throw new Error(`unexpected major type ${major} in indefinite string.`);
    }
    if (minor === minorIndefinite) {
      throw new Error("nested indefinite string.");
    }

    const bytes = decodeUnstructuredByteString(at, to);
    const length = _offset;
    at += length;
    for (let i = 0; i < bytes.length; ++i) {
      vector.push(bytes[i]);
    }
  }
  throw new Error("expected break marker.");
}

function decodeList(at: Uint32, to: Uint32): CborListType {
  const listDataLength = decodeCount(at, to);
  const offset = _offset;
  at += offset;
  const base = at;
  // perf: pre-allocate array length.
  const list = Array(listDataLength);
  for (let i = 0; i < listDataLength; ++i) {
    const item = decode(at, to);
    const itemOffset = _offset;
    list[i] = item;
    at += itemOffset;
  }
  _offset = offset + (at - base);
  return list;
}

function decodeListIndefinite(at: Uint32, to: Uint32): CborListType {
  at += 1;
  const list = [] as CborListType;
  for (const base = at; at < to; ) {
    if (payload[at] === 0b1111_1111) {
      _offset = at - base + 2;
      return list;
    }
    const item = decode(at, to);
    const n = _offset;
    at += n;
    list.push(item);
  }
  throw new Error("expected break marker.");
}

function decodeMap(at: Uint32, to: Uint32): CborMapType {
  const mapDataLength = decodeCount(at, to);
  const offset = _offset;
  at += offset;
  const base = at;
  const map = {} as CborMapType;
  for (let i = 0; i < mapDataLength; ++i) {
    if (at >= to) {
      throw new Error("unexpected end of map payload.");
    }
    const major = (payload[at] & 0b1110_0000) >> 5;
    if (major !== majorUtf8String) {
      throw new Error(`unexpected major type ${major} for map key at index ${at}.`);
    }
    const key = decode(at, to);
    at += _offset;
    const value = decode(at, to);
    at += _offset;
    map[key] = value;
  }
  _offset = offset + (at - base);
  return map;
}

function decodeMapIndefinite(at: Uint32, to: Uint32): CborMapType {
  at += 1;
  const base = at;
  const map = {} as CborMapType;
  for (; at < to; ) {
    if (at >= to) {
      throw new Error("unexpected end of map payload.");
    }
    if (payload[at] === 0b1111_1111) {
      _offset = at - base + 2;
      return map;
    }
    const major = (payload[at] & 0b1110_0000) >> 5;
    if (major !== majorUtf8String) {
      throw new Error(`unexpected major type ${major} for map key.`);
    }
    const key = decode(at, to);
    at += _offset;
    const value = decode(at, to);
    at += _offset;
    map[key] = value;
  }
  throw new Error("expected break marker.");
}

function decodeSpecial(at: Uint32, to: Uint32): CborValueType {
  const minor = payload[at] & 0b0001_1111;
  switch (minor) {
    case specialTrue:
    case specialFalse:
      _offset = 1;
      return minor === specialTrue;
    case specialNull:
      _offset = 1;
      return null;
    case specialUndefined:
      // Note: the Smithy spec requires that undefined is
      // instead deserialized to null.
      _offset = 1;
      return null;
    case extendedFloat16:
      if (to - at < 3) {
        throw new Error("incomplete float16 at end of buf.");
      }
      _offset = 3;
      return bytesToFloat16(payload[at + 1], payload[at + 2]);
    case extendedFloat32:
      if (to - at < 5) {
        throw new Error("incomplete float32 at end of buf.");
      }
      _offset = 5;
      return dataView.getFloat32(at + 1);
    case extendedFloat64:
      if (to - at < 9) {
        throw new Error("incomplete float64 at end of buf.");
      }
      _offset = 9;
      return dataView.getFloat64(at + 1);
    default:
      throw new Error(`unexpected minor value ${minor}.`);
  }
}

function castBigInt(bigInt: bigint | number): number | bigint {
  if (typeof bigInt === "number") {
    return bigInt;
  }
  const num = Number(bigInt);
  if (Number.MIN_SAFE_INTEGER <= num && num <= Number.MAX_SAFE_INTEGER) {
    return num;
  }
  return bigInt;
}
