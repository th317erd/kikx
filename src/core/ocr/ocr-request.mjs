'use strict';

const IMAGE_PATH_PATTERN = /(?:^|[\s"'`])((?:\/|\.{1,2}\/|~\/)?[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|pdf))(?=$|[\s"'`,;])/gi;

export const OCR_AGENT_SYSTEM_PROMPT = [
  'You are an OCR worker. Use the provided tools to inspect the image(s) and run OCR when needed.',
  'Return only the OCR text plus a concise description of the image/layout. Do not emit progress tags, plans, tool XML, or commentary about your internal process.',
  'If the image cannot be read, return a short explicit failure. Do not invent text or claim work the tool output does not show.',
].join(' ');

export function normalizeOcrImages(value) {
  let list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];

  let images = [];
  for (let item of list) {
    let image = typeof item === 'string' ? item.trim() : '';
    if (image && !images.includes(image))
      images.push(image);
  }
  return images;
}

export function extractOcrImages(text, explicit = []) {
  let images = normalizeOcrImages(explicit);
  let source = String(text || '');
  let match;
  IMAGE_PATH_PATTERN.lastIndex = 0;
  while ((match = IMAGE_PATH_PATTERN.exec(source))) {
    let image = match[1];
    if (!images.includes(image))
      images.push(image);
  }
  return images;
}

export function buildOcrPrompt({ images = [], prompt = '' } = {}) {
  let normalizedImages = normalizeOcrImages(images);
  let instruction = String(prompt || '').trim();
  let lines = [ 'OCR request.' ];
  if (normalizedImages.length > 0)
    lines.push('Images:', ...normalizedImages.map((image) => `- ${image}`));
  if (instruction)
    lines.push('Instruction:', instruction);
  lines.push('Return the OCR text exactly and do not invent content that is not visible.');
  return lines.join('\n');
}

export function normalizeOcrResult(value, fallback = {}) {
  if (typeof value === 'string')
    return { ...fallback, text: value };

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...fallback, text: String(value ?? '') };

  return {
    ...fallback,
    ...value,
    text: typeof value.text === 'string' ? value.text : String(value.text ?? ''),
  };
}
