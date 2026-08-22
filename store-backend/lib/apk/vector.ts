import { parseXmlTree, type XmlAttribute, type XmlNode } from './axml';

/**
 * Векторная иконка APK → SVG.
 *
 * Зачем вообще: у приложений с minSdk 26 картинки-иконки в пакете нет. Иконка
 * задана как adaptive icon — цвет фона плюс векторный контур, и растр рисует
 * сам Android при отрисовке лаунчера. Чтобы витрина показывала то же самое,
 * контуры переводятся в SVG, а растрируются уже в браузере.
 *
 * Синтаксис `android:pathData` совпадает с атрибутом `d` в SVG, поэтому
 * контуры переносятся как есть; переводить приходится только цвета,
 * трансформации групп и правило заливки.
 */

/** Идентификаторы системных атрибутов: в оптимизированных APK имён нет. */
const ATTR = {
  width: 0x01010159,
  height: 0x01010155,
  viewportWidth: 0x01010402,
  viewportHeight: 0x01010403,
  pathData: 0x01010405,
  fillColor: 0x01010404,
  fillAlpha: 0x010104cc,
  fillType: 0x0101051e,
  strokeColor: 0x01010406,
  strokeWidth: 0x01010407,
  strokeAlpha: 0x010104cb,
  translateX: 0x0101045a,
  translateY: 0x0101045b,
  scaleX: 0x01010324,
  scaleY: 0x01010325,
  rotation: 0x01010326,
  pivotX: 0x010101b5,
  pivotY: 0x010101b6,
  drawable: 0x01010199,
  color: 0x010101a5,
} as const;

const TYPE_REFERENCE = 0x01;
const TYPE_FLOAT = 0x04;
const COLOR_TYPES = new Set([0x1c, 0x1d, 0x1e, 0x1f]);

/** Откуда брать ресурсы, на которые ссылается иконка. */
export interface DrawableSource {
  /** Файл ресурса по id: путь внутри APK и содержимое. */
  file(id: number): { path: string; bytes: Uint8Array } | null;
  /** Цвет ресурса по id. */
  color(id: number): { hex: string; alpha: number } | null;
}

function attr(node: XmlNode, ids: number[], names: string[]): XmlAttribute | null {
  for (const a of node.attributes) {
    if (a.resourceId !== null && ids.includes(a.resourceId)) return a;
  }
  return node.attributes.find((a) => a.name !== null && names.includes(a.name)) ?? null;
}

function floatOf(a: XmlAttribute | null): number | null {
  if (!a) return null;
  if (a.type === TYPE_FLOAT) return new DataView(Uint32Array.of(a.data).buffer).getFloat32(0, true);
  if (a.stringValue) {
    const parsed = Number.parseFloat(a.stringValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function colorOf(a: XmlAttribute | null, source: DrawableSource): { hex: string; alpha: number } | null {
  if (!a) return null;
  if (COLOR_TYPES.has(a.type)) {
    const alpha = ((a.data >>> 24) & 0xff) / 255;
    return { hex: `#${(a.data & 0xffffff).toString(16).padStart(6, '0')}`, alpha };
  }
  if (a.type === TYPE_REFERENCE) return source.color(a.data);
  return null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Один `<path>` или `<group>` векторного drawable. */
function renderNode(node: XmlNode, source: DrawableSource): string {
  const pathData = attr(node, [ATTR.pathData], ['pathData'])?.stringValue;

  if (pathData) {
    const fill = colorOf(attr(node, [ATTR.fillColor], ['fillColor']), source);
    const stroke = colorOf(attr(node, [ATTR.strokeColor], ['strokeColor']), source);
    const strokeWidth = floatOf(attr(node, [ATTR.strokeWidth], ['strokeWidth']));
    const evenOdd = attr(node, [ATTR.fillType], ['fillType'])?.stringValue === 'evenOdd';

    const fillAlpha = floatOf(attr(node, [ATTR.fillAlpha], ['fillAlpha'])) ?? 1;
    const strokeAlpha = floatOf(attr(node, [ATTR.strokeAlpha], ['strokeAlpha'])) ?? 1;

    const parts = [`d="${escapeAttribute(pathData)}"`];
    parts.push(fill ? `fill="${fill.hex}"` : 'fill="none"');
    const fillOpacity = (fill?.alpha ?? 1) * fillAlpha;
    if (fill && fillOpacity < 1) parts.push(`fill-opacity="${fillOpacity.toFixed(3)}"`);
    if (evenOdd) parts.push('fill-rule="evenodd"');
    if (stroke) {
      parts.push(`stroke="${stroke.hex}"`);
      if (strokeWidth) parts.push(`stroke-width="${strokeWidth}"`);
      const strokeOpacity = stroke.alpha * strokeAlpha;
      if (strokeOpacity < 1) parts.push(`stroke-opacity="${strokeOpacity.toFixed(3)}"`);
    }
    return `<path ${parts.join(' ')}/>`;
  }

  const children = node.children.map((child) => renderNode(child, source)).join('');
  if (!children) return '';

  const tx = floatOf(attr(node, [ATTR.translateX], ['translateX'])) ?? 0;
  const ty = floatOf(attr(node, [ATTR.translateY], ['translateY'])) ?? 0;
  const sx = floatOf(attr(node, [ATTR.scaleX], ['scaleX'])) ?? 1;
  const sy = floatOf(attr(node, [ATTR.scaleY], ['scaleY'])) ?? 1;
  const rotation = floatOf(attr(node, [ATTR.rotation], ['rotation'])) ?? 0;
  const px = floatOf(attr(node, [ATTR.pivotX], ['pivotX'])) ?? 0;
  const py = floatOf(attr(node, [ATTR.pivotY], ['pivotY'])) ?? 0;

  const transform: string[] = [];
  if (tx || ty) transform.push(`translate(${tx} ${ty})`);
  if (rotation) transform.push(`rotate(${rotation} ${px} ${py})`);
  if (sx !== 1 || sy !== 1) transform.push(`translate(${px} ${py}) scale(${sx} ${sy}) translate(${-px} ${-py})`);

  return transform.length > 0 ? `<g transform="${transform.join(' ')}">${children}</g>` : children;
}

interface Layer {
  /** Содержимое слоя в координатах его собственного viewport. */
  body: string;
  viewportWidth: number;
  viewportHeight: number;
}

/** Векторный drawable → слой с контурами. */
function vectorLayer(bytes: Uint8Array, source: DrawableSource): Layer | null {
  const root = parseXmlTree(bytes);
  if (!root) return null;

  const viewportWidth = floatOf(attr(root, [ATTR.viewportWidth], ['viewportWidth'])) ?? 24;
  const viewportHeight = floatOf(attr(root, [ATTR.viewportHeight], ['viewportHeight'])) ?? 24;
  const body = root.children.map((child) => renderNode(child, source)).join('');
  if (!body) return null;

  return { body, viewportWidth, viewportHeight };
}

/** Растровый слой — вкладываем прямо в SVG, чтобы отдать одну картинку. */
function rasterLayer(path: string, bytes: Uint8Array): Layer {
  const mime = /\.webp$/i.test(path) ? 'image/webp' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return {
    body: `<image href="data:${mime};base64,${base64}" x="0" y="0" width="108" height="108" preserveAspectRatio="none"/>`,
    viewportWidth: 108,
    viewportHeight: 108,
  };
}

function layerFor(id: number, source: DrawableSource): Layer | null {
  const file = source.file(id);
  if (!file) {
    const color = source.color(id);
    if (!color) return null;
    return {
      body: `<rect x="0" y="0" width="108" height="108" fill="${color.hex}" fill-opacity="${color.alpha.toFixed(3)}"/>`,
      viewportWidth: 108,
      viewportHeight: 108,
    };
  }
  if (/\.xml$/i.test(file.path)) return vectorLayer(file.bytes, source);
  return rasterLayer(file.path, file.bytes);
}

/** Слой в общей системе координат 108×108. */
function placeLayer(layer: Layer): string {
  const scale = 108 / Math.max(layer.viewportWidth, layer.viewportHeight);
  return scale === 1 ? layer.body : `<g transform="scale(${scale})">${layer.body}</g>`;
}

/**
 * Иконка приложения в виде SVG.
 *
 * Adaptive icon собирается по правилам Android: слои рисуются в поле 108×108,
 * видимой остаётся центральная часть 72×72, а края срезает маска — поэтому
 * viewBox начинается с 18. Обычный вектор показывается целиком.
 */
export function iconToSvg(iconRef: number, source: DrawableSource): string | null {
  const file = source.file(iconRef);
  if (!file || !/\.xml$/i.test(file.path)) return null;

  const root = parseXmlTree(file.bytes);
  if (!root) return null;

  const refs = root.children
    .map((child) => attr(child, [ATTR.drawable, ATTR.color], ['drawable', 'color']))
    .map((a) => (a && a.type === TYPE_REFERENCE ? a.data : null));

  // Есть вложенные слои — это adaptive icon. Порядок тегов в файле:
  // background, foreground, monochrome; имена в оптимизированных APK вырезаны,
  // поэтому третий слой (монохромный) просто отбрасываем.
  if (refs.length >= 2 && refs[0] !== null && refs[1] !== null) {
    const background = layerFor(refs[0], source);
    const foreground = layerFor(refs[1], source);
    if (!foreground) return null;

    const body = [background, foreground]
      .filter((layer): layer is Layer => layer !== null)
      .map(placeLayer)
      .join('');

    return svg(body, 18, 18, 72, 72, true);
  }

  const single = vectorLayer(file.bytes, source);
  if (!single) return null;
  return svg(single.body, 0, 0, single.viewportWidth, single.viewportHeight, false);
}

function svg(
  body: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rounded: boolean,
): string {
  const radius = rounded ? Math.min(width, height) * 0.22 : 0;
  const clip = rounded
    ? `<clipPath id="mask"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></clipPath>`
    : '';
  const open = rounded ? '<g clip-path="url(#mask)">' : '';
  const close = rounded ? '</g>' : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="512" height="512">` +
    `${clip}${open}${body}${close}</svg>`
  );
}
