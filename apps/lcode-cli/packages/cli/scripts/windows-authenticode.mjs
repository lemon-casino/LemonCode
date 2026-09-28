import { readFile, writeFile } from "node:fs/promises";

const DOS_MAGIC = 0x5a4d;
const DOS_PE_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE = 0x00004550;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const COFF_OPTIONAL_HEADER_SIZE_OFFSET = 16;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const PE32_NUMBER_OF_DIRECTORIES_OFFSET = 92;
const PE32_DATA_DIRECTORIES_OFFSET = 96;
const PE32_PLUS_NUMBER_OF_DIRECTORIES_OFFSET = 108;
const PE32_PLUS_DATA_DIRECTORIES_OFFSET = 112;
const SECURITY_DIRECTORY_INDEX = 4;
const DATA_DIRECTORY_ENTRY_SIZE = 8;
const SECURITY_DIRECTORY_VALUE_SIZE = 4;
const EMPTY_DIRECTORY_VALUE = 0;

const assertRange = ({ length, offset, size, subject }) => {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0) {
    throw new Error(`Invalid PE ${subject}: offset and size must be non-negative integers`);
  }

  if (offset + size > length) {
    throw new Error(`Invalid PE ${subject}: range ${offset}..${offset + size} exceeds ${length}`);
  }
};

const optionalHeaderLayout = (contents, optionalHeaderOffset) => {
  const magic = contents.readUInt16LE(optionalHeaderOffset);

  if (magic === PE32_MAGIC) {
    return {
      dataDirectoriesOffset: PE32_DATA_DIRECTORIES_OFFSET,
      numberOfDirectoriesOffset: PE32_NUMBER_OF_DIRECTORIES_OFFSET,
    };
  }

  if (magic === PE32_PLUS_MAGIC) {
    return {
      dataDirectoriesOffset: PE32_PLUS_DATA_DIRECTORIES_OFFSET,
      numberOfDirectoriesOffset: PE32_PLUS_NUMBER_OF_DIRECTORIES_OFFSET,
    };
  }

  throw new Error(`Invalid PE optional header magic: 0x${magic.toString(16)}`);
};

export const readWindowsAuthenticodeDirectory = (contents) => {
  assertRange({
    length: contents.length,
    offset: 0,
    size: DOS_PE_POINTER_OFFSET + SECURITY_DIRECTORY_VALUE_SIZE,
    subject: "DOS header",
  });

  if (contents.readUInt16LE(0) !== DOS_MAGIC) {
    throw new Error("Invalid PE binary: missing MZ header");
  }

  const peOffset = contents.readUInt32LE(DOS_PE_POINTER_OFFSET);
  assertRange({
    length: contents.length,
    offset: peOffset,
    size: PE_SIGNATURE_SIZE + COFF_HEADER_SIZE,
    subject: "PE header",
  });

  if (contents.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error("Invalid PE binary: missing PE signature");
  }

  const coffHeaderOffset = peOffset + PE_SIGNATURE_SIZE;
  const optionalHeaderSize = contents.readUInt16LE(
    coffHeaderOffset + COFF_OPTIONAL_HEADER_SIZE_OFFSET,
  );
  const optionalHeaderOffset = coffHeaderOffset + COFF_HEADER_SIZE;
  assertRange({
    length: contents.length,
    offset: optionalHeaderOffset,
    size: optionalHeaderSize,
    subject: "optional header",
  });

  const layout = optionalHeaderLayout(contents, optionalHeaderOffset);
  const numberOfDirectoriesOffset = optionalHeaderOffset + layout.numberOfDirectoriesOffset;
  assertRange({
    length: contents.length,
    offset: numberOfDirectoriesOffset,
    size: SECURITY_DIRECTORY_VALUE_SIZE,
    subject: "data directory count",
  });

  const numberOfDirectories = contents.readUInt32LE(numberOfDirectoriesOffset);
  if (numberOfDirectories <= SECURITY_DIRECTORY_INDEX) {
    return {
      certificateOffset: 0,
      certificateSize: 0,
      securityDirectoryEntryOffset: null,
      signed: false,
    };
  }

  const securityDirectoryEntryOffset =
    optionalHeaderOffset +
    layout.dataDirectoriesOffset +
    SECURITY_DIRECTORY_INDEX * DATA_DIRECTORY_ENTRY_SIZE;
  assertRange({
    length: contents.length,
    offset: securityDirectoryEntryOffset,
    size: DATA_DIRECTORY_ENTRY_SIZE,
    subject: "security directory",
  });

  const certificateOffset = contents.readUInt32LE(securityDirectoryEntryOffset);
  const certificateSize = contents.readUInt32LE(
    securityDirectoryEntryOffset + SECURITY_DIRECTORY_VALUE_SIZE,
  );
  const signed = certificateOffset !== 0 || certificateSize !== 0;

  if (!signed) {
    return {
      certificateOffset,
      certificateSize,
      securityDirectoryEntryOffset,
      signed,
    };
  }

  if (certificateOffset === 0 || certificateSize === 0) {
    throw new Error("Invalid PE security directory: incomplete certificate table location");
  }

  assertRange({
    length: contents.length,
    offset: certificateOffset,
    size: certificateSize,
    subject: "certificate table",
  });

  return {
    certificateOffset,
    certificateSize,
    securityDirectoryEntryOffset,
    signed,
  };
};

export const removeWindowsAuthenticodeSignatureFromBuffer = (contents) => {
  const signature = readWindowsAuthenticodeDirectory(contents);

  if (!signature.signed) {
    return {
      buffer: contents,
      certificateOffset: 0,
      certificateSize: 0,
      removed: false,
      truncated: false,
    };
  }

  const certificateEnd = signature.certificateOffset + signature.certificateSize;
  const truncatedSize =
    certificateEnd === contents.length ? signature.certificateOffset : contents.length;
  const output = Buffer.from(contents.subarray(0, truncatedSize));

  output.writeUInt32LE(EMPTY_DIRECTORY_VALUE, signature.securityDirectoryEntryOffset);
  output.writeUInt32LE(
    EMPTY_DIRECTORY_VALUE,
    signature.securityDirectoryEntryOffset + SECURITY_DIRECTORY_VALUE_SIZE,
  );

  return {
    buffer: output,
    certificateOffset: signature.certificateOffset,
    certificateSize: signature.certificateSize,
    removed: true,
    truncated: output.length !== contents.length,
  };
};

export const removeWindowsAuthenticodeSignature = async (binaryPath) => {
  const contents = await readFile(binaryPath);
  const result = removeWindowsAuthenticodeSignatureFromBuffer(contents);

  if (result.removed) {
    await writeFile(binaryPath, result.buffer);
  }

  return {
    certificateOffset: result.certificateOffset,
    certificateSize: result.certificateSize,
    removed: result.removed,
    truncated: result.truncated,
  };
};
