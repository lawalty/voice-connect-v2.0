export type ClipboardContent = { kind: 'text'; text: string } | { kind: 'image'; blob: Blob };
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];

// Read paste-event data synchronously: browsers discard it after the handler returns.
// Prefer image bytes over alternate HTML/text representations of the same image.
export function pastedContent(data: DataTransfer): ClipboardContent {
  const files = Array.from(data.files);
  if (files.length) {
    if (files.length !== 1) throw new Error('Paste one image at a time.');
    return { kind: 'image', blob: files[0]! };
  }
  const text = data.getData('text/plain');
  if (!text.trim()) throw new Error('Copy some text or a PNG, JPEG, or WebP image, then paste here.');
  return { kind: 'text', text };
}

// Call only from the clipboard button's user gesture, never during initialization.
export async function readClipboard(): Promise<ClipboardContent> {
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    const images = items.filter(item => item.types.some(type => type.startsWith('image/')));
    if (images.length > 1) throw new Error('Paste one image at a time.');
    if (images.length) {
      const type = imageTypes.find(type => images[0]!.types.includes(type));
      if (!type) throw new Error('Use a PNG, JPEG, or WebP image.');
      return { kind: 'image', blob: await images[0]!.getType(type) };
    }
    const item = items.find(item => item.types.includes('text/plain'));
    if (item) return { kind: 'text', text: await (await item.getType('text/plain')).text() };
    throw new Error('Copy some text or an image first.');
  }
  if (navigator.clipboard?.readText) return { kind: 'text', text: await navigator.clipboard.readText() };
  throw new Error('Clipboard access is unavailable. Paste into the field below instead.');
}

export async function validateClipboard(content: ClipboardContent): Promise<ClipboardContent> {
  if (content.kind === 'text') {
    if (!content.text.trim()) throw new Error('Copy some text or an image first.');
    if (content.text.length > 20000) throw new Error('Copied text is too long. Copy up to 20,000 characters at a time.');
  } else {
    if (!imageTypes.includes(content.blob.type)) throw new Error('Use a PNG, JPEG, or WebP image.');
    if (content.blob.size > 5 * 1024 * 1024) throw new Error('Use an image smaller than 5 MB.');
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(content.blob); }
    catch { throw new Error('This image could not be opened. Copy the image again.'); }
    const pixels = bitmap.width * bitmap.height; bitmap.close();
    if (pixels > 40_000_000) throw new Error('Use an image smaller than 40 megapixels.');
  }
  return content;
}

export function clipboardMessage(content: ClipboardContent, caption: string): string {
  const note = caption.trim();
  const text = content.kind === 'text' ? (note ? `${note}\n\n${content.text}` : content.text) : note;
  if (text.length > 20000) throw new Error('The copied text and caption together must be under 20,000 characters.');
  return text;
}
