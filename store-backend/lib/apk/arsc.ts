/**
 * Минимальный разбор resources.arsc — таблицы ресурсов APK.
 *
 * Зачем: в AndroidManifest.xml `android:label` и `android:icon` почти всегда
 * ссылки на ресурсы (`@string/app_name`, `@mipmap/ic_launcher`). Без таблицы
 * название приходится вводить руками, а иконку — подбирать файлом.
 *
 * Реализовано ровно столько формата, сколько нужно: значения по идентификатору
 * ресурса во всех конфигурациях, с плотностью экрана — чтобы выбрать самую
 * крупную иконку. Сопоставление конфигураций (язык, ориентация) не делается.
 */

const CHUNK_TABLE = 0x0002;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_PACKAGE = 0x0200;
const CHUNK_TYPE = 0x0201;

const FLAG_UTF8 = 1 << 8;
const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;
const ENTRY_FLAG_COMPLEX = 0x0001;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;

const NO_ENTRY = 0xffffffff;

export interface ResourceValue {
  /** Строковое значение: текст названия либо путь к файлу внутри APK. */
  value: string;
  /** Плотность из конфигурации ресурса: 0 — «любая». */
  density: number;
}

function readStringPool(view: DataView, start: number): string[] {
  const stringCount = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const isUtf8 = (flags & FLAG_UTF8) !== 0;
  const decoder = new TextDecoder(isUtf8 ? 'utf-8' : 'utf-16le');
  const strings: string[] = [];

  for (let i = 0; i < stringCount; i++) {
    const offset = start + stringsStart + view.getUint32(start + 28 + i * 4, true);
    if (offset >= view.byteLength) {
      strings.push('');
      continue;
    }

    if (isUtf8) {
      let cursor = offset;
      const skip = () => {
        cursor += view.getUint8(cursor) & 0x80 ? 2 : 1;
      };
      skip(); // длина в символах — не нужна
      const first = view.getUint8(cursor);
      let length: number;
      if (first & 0x80) {
        length = ((first & 0x7f) << 8) | view.getUint8(cursor + 1);
        cursor += 2;
      } else {
        length = first;
        cursor += 1;
      }
      strings.push(decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor, length)));
    } else {
      let cursor = offset;
      let length = view.getUint16(cursor, true);
      cursor += 2;
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | view.getUint16(cursor, true);
        cursor += 2;
      }
      strings.push(decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor, length * 2)));
    }
  }

  return strings;
}

/** Таблица ресурсов: только то, что нужно для поиска значений по id. */
export class ResourceTable {
  private constructor(
    private readonly strings: string[],
    /** id ресурса → значения во всех конфигурациях. */
    private readonly entries: Map<number, ResourceValue[]>,
  ) {}

  static parse(bytes: Uint8Array): ResourceTable | null {
    try {
      return ResourceTable.parseUnsafe(bytes);
    } catch {
      // Битая или незнакомая таблица не должна ломать загрузку APK целиком.
      return null;
    }
  }

  private static parseUnsafe(bytes: Uint8Array): ResourceTable | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== CHUNK_TABLE) return null;

    const strings: string[] = [];
    const entries = new Map<number, ResourceValue[]>();

    let offset = view.getUint16(2, true);
    while (offset + 8 <= view.byteLength) {
      const type = view.getUint16(offset, true);
      const size = view.getUint32(offset + 4, true);
      if (size <= 0) break;

      if (type === CHUNK_STRING_POOL && strings.length === 0) {
        strings.push(...readStringPool(view, offset));
      } else if (type === CHUNK_PACKAGE) {
        ResourceTable.parsePackage(view, offset, size, entries);
      }

      offset += size;
    }

    return new ResourceTable(strings, entries);
  }

  private static parsePackage(
    view: DataView,
    start: number,
    size: number,
    entries: Map<number, ResourceValue[]>,
  ): void {
    const headerSize = view.getUint16(start + 2, true);
    const packageId = view.getUint32(start + 8, true);

    let offset = start + headerSize;
    const end = start + size;

    while (offset + 8 <= end) {
      const type = view.getUint16(offset, true);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkSize <= 0) break;

      if (type === CHUNK_TYPE) {
        ResourceTable.parseType(view, offset, packageId, entries);
      }

      offset += chunkSize;
    }
  }

  private static parseType(
    view: DataView,
    start: number,
    packageId: number,
    entries: Map<number, ResourceValue[]>,
  ): void {
    const headerSize = view.getUint16(start + 2, true);
    const typeId = view.getUint8(start + 8);
    const flags = view.getUint8(start + 9);
    const entryCount = view.getUint32(start + 12, true);
    const entriesStart = view.getUint32(start + 16, true);
    // ResTable_config идёт следом: плотность лежит по смещению 14 внутри него.
    const density = view.getUint16(start + 20 + 14, true);

    const sparse = (flags & FLAG_SPARSE) !== 0;
    const offset16 = (flags & FLAG_OFFSET16) !== 0;
    const offsetsStart = start + headerSize;

    for (let index = 0; index < entryCount; index++) {
      let entryIndex = index;
      let entryOffset: number;

      if (sparse) {
        entryIndex = view.getUint16(offsetsStart + index * 4, true);
        entryOffset = view.getUint16(offsetsStart + index * 4 + 2, true) * 4;
      } else if (offset16) {
        const raw = view.getUint16(offsetsStart + index * 2, true);
        if (raw === 0xffff) continue;
        entryOffset = raw * 4;
      } else {
        entryOffset = view.getUint32(offsetsStart + index * 4, true);
        if (entryOffset === NO_ENTRY) continue;
      }

      const entry = start + entriesStart + entryOffset;
      if (entry + 8 > view.byteLength) continue;

      const entryFlags = view.getUint16(entry + 2, true);
      if (entryFlags & ENTRY_FLAG_COMPLEX) continue; // массивы и стили нам не нужны

      const entrySize = view.getUint16(entry, true);
      const valueOffset = entry + entrySize;
      if (valueOffset + 8 > view.byteLength) continue;

      const dataType = view.getUint8(valueOffset + 3);
      const data = view.getUint32(valueOffset + 4, true);
      if (dataType !== TYPE_STRING) continue;

      const id = (packageId << 24) | (typeId << 16) | entryIndex;
      const list = entries.get(id) ?? [];
      list.push({ value: String(data), density });
      entries.set(id, list);
    }
  }

  /** Все строковые значения ресурса, от самой крупной плотности к мелкой. */
  resolve(id: number): ResourceValue[] {
    const raw = this.entries.get(id) ?? [];
    return raw
      .map(({ value, density }) => ({ value: this.strings[Number(value)] ?? '', density }))
      .filter((entry) => entry.value.length > 0)
      .sort((a, b) => b.density - a.density);
  }

  /** Первое строковое значение: годится для названия приложения. */
  resolveString(id: number): string | null {
    // Для строк плотность не важна, а вот пустые значения пропускаем.
    return this.resolve(id).sort((a, b) => a.density - b.density)[0]?.value ?? null;
  }
}

export { TYPE_REFERENCE };
