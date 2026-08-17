/**
 * Минимальный разбор бинарного AndroidManifest.xml (формат AXML).
 *
 * Нужен, чтобы браузер мог прочитать packageName/versionCode/versionName без
 * Android SDK: aapt2 в вебе недоступен. Реализовано ровно столько формата,
 * сколько требуется витрине.
 *
 * Формат: заголовок RES_XML_TYPE, затем чанки — пул строк, карта ресурсов и
 * теги. Значения атрибутов бывают строкой (индекс в пуле), числом или ссылкой
 * на ресурс (@string/app_name) — ссылку без resources.arsc не развернуть,
 * поэтому такие значения возвращаются как null и запрашиваются у пользователя.
 */

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_TAG = 0x0102;

const UTF8_FLAG = 1 << 8;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

/** Идентификаторы системных атрибутов — на случай, если имена вырезаны из пула. */
const ATTR_ID = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  label: 0x01010001,
  icon: 0x01010002,
} as const;

export interface ApkManifestInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
  /** null, если label — ссылка на ресурс: развернуть её без resources.arsc нельзя. */
  label: string | null;
}

class StringPool {
  private readonly strings: string[];

  constructor(strings: string[]) {
    this.strings = strings;
  }

  at(index: number): string | null {
    if (index < 0 || index >= this.strings.length) return null;
    return this.strings[index];
  }
}

function readStringPool(view: DataView, start: number): StringPool {
  const stringCount = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const strings: string[] = [];
  const decoder = new TextDecoder(isUtf8 ? 'utf-8' : 'utf-16le');

  for (let i = 0; i < stringCount; i++) {
    const offset = start + stringsStart + view.getUint32(start + 28 + i * 4, true);

    if (isUtf8) {
      // Две длины подряд: в символах и в байтах, каждая 1–2 байта.
      let cursor = offset;
      const skipLength = () => {
        const first = view.getUint8(cursor);
        cursor += first & 0x80 ? 2 : 1;
      };
      skipLength();
      const lengthByte = view.getUint8(cursor);
      let byteLength: number;
      if (lengthByte & 0x80) {
        byteLength = ((lengthByte & 0x7f) << 8) | view.getUint8(cursor + 1);
        cursor += 2;
      } else {
        byteLength = lengthByte;
        cursor += 1;
      }
      strings.push(decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor, byteLength)));
    } else {
      let cursor = offset;
      let charLength = view.getUint16(cursor, true);
      cursor += 2;
      if (charLength & 0x8000) {
        charLength = ((charLength & 0x7fff) << 16) | view.getUint16(cursor, true);
        cursor += 2;
      }
      strings.push(
        decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor, charLength * 2)),
      );
    }
  }

  return new StringPool(strings);
}

interface Attribute {
  name: string | null;
  resourceId: number | null;
  stringValue: string | null;
  intValue: number | null;
  isReference: boolean;
}

/** Разбирает AndroidManifest.xml из APK. Бросает Error на неподдерживаемом файле. */
export function parseAndroidManifest(bytes: Uint8Array): ApkManifestInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 8 || view.getUint16(0, true) !== 0x0003) {
    throw new Error('AndroidManifest.xml не в формате AXML');
  }

  let pool: StringPool | null = null;
  let resourceMap: number[] = [];
  let manifestAttributes: Attribute[] | null = null;
  let applicationAttributes: Attribute[] | null = null;

  let offset = view.getUint16(2, true); // размер заголовка файла
  while (offset + 8 <= view.byteLength) {
    const type = view.getUint16(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size <= 0) break;

    if (type === CHUNK_STRING_POOL) {
      pool = readStringPool(view, offset);
    } else if (type === CHUNK_RESOURCE_MAP) {
      const count = (size - 8) / 4;
      resourceMap = [];
      for (let i = 0; i < count; i++) resourceMap.push(view.getUint32(offset + 8 + i * 4, true));
    } else if (type === CHUNK_START_TAG && pool) {
      // ResXMLTree_node: header(8) + lineNumber(4) + comment(4) = 16 байт,
      // дальше ResXMLTree_attrExt, и attributeStart отсчитывается от НЕГО.
      const attrExt = offset + 16;
      const nameIndex = view.getUint32(attrExt + 4, true);
      const tagName = pool.at(nameIndex);
      const attributeStart = view.getUint16(attrExt + 8, true);
      const attributeSize = view.getUint16(attrExt + 10, true) || 20;
      const attributeCount = view.getUint16(attrExt + 12, true);

      if (tagName === 'manifest' || tagName === 'application') {
        const attributes: Attribute[] = [];
        for (let i = 0; i < attributeCount; i++) {
          const base = attrExt + attributeStart + i * attributeSize;
          const attrNameIndex = view.getUint32(base + 4, true);
          const rawValueIndex = view.getInt32(base + 8, true);
          const dataType = view.getUint8(base + 15);
          const data = view.getUint32(base + 16, true);

          const name = pool.at(attrNameIndex) || null;
          const resourceId = attrNameIndex < resourceMap.length ? resourceMap[attrNameIndex] : null;

          let stringValue: string | null = null;
          let intValue: number | null = null;
          if (dataType === TYPE_STRING) {
            stringValue = pool.at(data);
          } else if (rawValueIndex >= 0) {
            stringValue = pool.at(rawValueIndex);
          }
          if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX || dataType === TYPE_INT_BOOLEAN) {
            intValue = data;
          }

          attributes.push({
            name: name && name.length > 0 ? name : null,
            resourceId,
            stringValue,
            intValue,
            isReference: dataType === TYPE_REFERENCE,
          });
        }

        if (tagName === 'manifest') manifestAttributes = attributes;
        else applicationAttributes = attributes;
      }
    }

    offset += size;
    if (manifestAttributes && applicationAttributes) break;
  }

  if (!manifestAttributes) throw new Error('в APK не найден тег <manifest>');

  const find = (attributes: Attribute[], key: keyof typeof ATTR_ID | 'package') => {
    const byName = attributes.find((a) => a.name === key);
    if (byName) return byName;
    if (key === 'package') return undefined;
    return attributes.find((a) => a.resourceId === ATTR_ID[key]);
  };

  const packageAttr = find(manifestAttributes, 'package');
  const versionCodeAttr = find(manifestAttributes, 'versionCode');
  const versionNameAttr = find(manifestAttributes, 'versionName');
  const labelAttr = applicationAttributes ? find(applicationAttributes, 'label') : undefined;

  const packageName = packageAttr?.stringValue ?? '';
  if (!packageName) throw new Error('в APK не удалось прочитать packageName');

  const versionCode = versionCodeAttr?.intValue ?? Number(versionCodeAttr?.stringValue ?? NaN);
  if (!Number.isFinite(versionCode) || versionCode <= 0) {
    throw new Error('в APK не удалось прочитать versionCode');
  }

  const versionName = versionNameAttr?.stringValue ?? '';
  if (!versionName) throw new Error('в APK не удалось прочитать versionName');

  const label = labelAttr && !labelAttr.isReference ? labelAttr.stringValue : null;

  return { packageName, versionCode, versionName, label };
}
