import { createHash } from 'node:crypto';
import type { GeneratedFile } from '../spring-boot';
import {
  assertArchiveFiles,
  createDeterministicSpringBootArchive,
  SpringBootExportArchiveError,
} from './spring-boot-export.archive';

function generatedFile(path: string, content: string): GeneratedFile {
  return {
    path,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

function centralDirectoryEntries(
  zip: Buffer,
): Array<{ name: string; date: number; time: number; mode: number }> {
  let endOfCentralDirectory = -1;
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) throw new Error('ZIP end of central directory is missing.');

  const entryCount = zip.readUInt16LE(endOfCentralDirectory + 10);
  let offset = zip.readUInt32LE(endOfCentralDirectory + 16);
  const entries: Array<{ name: string; date: number; time: number; mode: number }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP central directory entry is invalid.');
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      name: zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      time: zip.readUInt16LE(offset + 12),
      date: zip.readUInt16LE(offset + 14),
      mode: zip.readUInt32LE(offset + 38) >>> 16,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('deterministic Spring Boot archive', () => {
  it('produces stable bytes, ordering, timestamps and permissions across three runs', async () => {
    const files = [
      generatedFile('src/main/java/com/example/App.java', 'class App {}\n'),
      generatedFile('pom.xml', '<project />\n'),
    ];

    const first = await createDeterministicSpringBootArchive(files);
    const second = await createDeterministicSpringBootArchive(files.toReversed());
    const third = await createDeterministicSpringBootArchive(files);

    expect(first.equals(second)).toBe(true);
    expect(second.equals(third)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(third).digest('hex'),
    );
    expect(first.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(centralDirectoryEntries(first)).toEqual([
      { name: 'pom.xml', date: 33, time: 0, mode: 0o100644 },
      { name: 'src/main/java/com/example/App.java', date: 33, time: 0, mode: 0o100644 },
    ]);
  });

  it.each([
    '.env',
    '.ENV',
    'secret.txt',
    'src/../secret.txt',
    '/absolute.txt',
    'node_modules/secret.txt',
    'src/main/resources/secret.properties',
    'src/main/java/com/example/Payload.jar',
  ])('rejects unsafe archive path %s', (path) => {
    expect(() => assertArchiveFiles([generatedFile(path, 'unsafe\n')])).toThrow(
      SpringBootExportArchiveError,
    );
  });

  it('rejects duplicate paths and tampered metadata', () => {
    const file = generatedFile('pom.xml', '<project />\n');
    expect(() => assertArchiveFiles([file, file])).toThrow(SpringBootExportArchiveError);
    expect(() => assertArchiveFiles([{ ...file, sha256: '0'.repeat(64) }])).toThrow(
      SpringBootExportArchiveError,
    );
  });
});
